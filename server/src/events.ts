import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { Address, scValToNative } from '@stellar/stellar-sdk';
import type { rpc, xdr } from '@stellar/stellar-sdk';
import {
  DELIVERY_ATTEMPTS_WHEN_QUIET,
  DELIVERY_BACKOFF_CEILING_MS,
  DELIVERY_BACKOFF_MS,
  EVENT_PAGE_LIMIT,
  EVENT_POLL_INTERVAL_MS,
} from './constants.js';

/**
 * The redemption feed.
 *
 * The contract publishes one event for every redemption. A Soroban transaction
 * carries no memo, so that event is the only channel that a merchant
 * reconciles against. This module reads the feed, turns each event into one
 * message, and remembers how far it delivered.
 *
 * Delivery is at least once. The listener writes its position after each event
 * that the receiver accepts, so a restart repeats an undelivered event and
 * never repeats a delivered one. A consumer removes duplicates on `event_id`.
 */

/** The event that the contract publishes. Its name on the wire is lower case. */
export const REDEEMED_TOPIC = 'redeemed';

/** One redemption, as the webhook carries it. */
export interface RedemptionMessage {
  /**
   * The identifier that the payer and the merchant share.
   *
   * A voucher identifier is a 64 bit number, and an amount is a 128 bit
   * number. Neither one fits in a JSON number without a loss, so both travel
   * as decimal text.
   */
  readonly voucher_id: string;
  /** The account that signed the voucher. */
  readonly payer: string;
  /**
   * The account that received the funds.
   *
   * A payer voids a voucher when the payer redeems it to their own address, so
   * `recipient` equal to `payer` is a void. The contract publishes the same
   * event for both, because at the contract level both are one redemption. A
   * consumer that treats a void differently compares these two fields.
   */
  readonly recipient: string;
  /** The amount in stroops, as decimal text. */
  readonly amount: string;
  /** The ledger after which the contract refuses the voucher. */
  readonly expire_at: number;
  /** The transaction that carried the redemption. */
  readonly tx_hash: string;
  /** The ledger that closed with the transaction in it. */
  readonly ledger: number;
  /** When that ledger closed. */
  readonly ledger_closed_at: string;
  /**
   * The identifier of the event on the feed.
   *
   * Delivery is at least once, so a receiver can meet the same message twice.
   * This value identifies one redemption exactly, and a consumer removes
   * duplicates on it.
   */
  readonly event_id: string;
}

/** Where the listener resumes from. */
export interface Position {
  /** The identifier of the last event that the receiver accepted. */
  readonly cursor: string;
}

/** What one poll did. */
export interface PollResult {
  readonly read: number;
  readonly delivered: number;
  /** Where the listener stands, which is nothing before its first delivery. */
  readonly cursor: string | null;
  /** The event that a receiver refused, when one did. */
  readonly stuckOn: string | null;
  /**
   * The ledger that this poll scanned as far as.
   *
   * One request scans a span of ledgers and answers. This value says how far
   * the listener read. It says nothing about how many events it found.
   */
  readonly scannedTo: number | null;
  /** The head of the chain, as the same response reported it. */
  readonly latestLedger: number;
}

/** A receiver, which accepts a message or refuses it. */
export type Deliver = (message: RedemptionMessage) => Promise<boolean>;

/** A number that arrives as text, or as a value too wide for a JSON number. */
function decimal(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  return null;
}

/** Read a string field from a value of unknown shape. */
function text(fields: Record<string, unknown>, key: string): string | null {
  return decimal(fields[key]);
}

/**
 * An address, whether the signer is a key or a contract.
 *
 * A payer with an ed25519 key appears as a `G` address. A payer with a passkey
 * appears as the `C` address of their smart account. Both are real, and a
 * reader that accepts only one of them drops half the feed.
 */
function address(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Address) return value.toString();
  return null;
}

/**
 * Turn one event into one message, or give nothing.
 *
 * The reader inspects what the network sent rather than what the contract
 * promises. A change to the event that this reader does not know produces
 * nothing. A caller reports that, and no message goes out that lacks a field.
 */
export function readRedemption(event: rpc.Api.EventResponse): RedemptionMessage | null {
  const topics: readonly xdr.ScVal[] = event.topic;
  const first = topics[0];
  const second = topics[1];
  if (first === undefined || second === undefined) return null;
  if (scValToNative(first) !== REDEEMED_TOPIC) return null;

  const voucherId = decimal(scValToNative(second));
  const body: unknown = scValToNative(event.value);
  if (voucherId === null || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const fields: Record<string, unknown> = { ...body };
  const payer = address(fields['payer']);
  const recipient = address(fields['recipient']);
  const amount = text(fields, 'amount');
  const expireAt = fields['expire_at'];
  if (payer === null || recipient === null || amount === null) return null;
  if (typeof expireAt !== 'number') return null;

  return {
    voucher_id: voucherId,
    payer,
    recipient,
    amount,
    expire_at: expireAt,
    tx_hash: event.txHash,
    ledger: event.ledger,
    ledger_closed_at: event.ledgerClosedAt,
    event_id: event.id,
  };
}

/** The proof that the listener's position aged out of the network's history. */
export interface AgedOut {
  /** The ledger that the next poll asks from. */
  readonly ledger: number;
  /** The oldest ledger that the network still keeps, by the rule below. */
  readonly oldestKept: number;
}

/**
 * Ask the RPC whether the listener's position aged out, after a poll failed.
 *
 * The answer comes from the ledger range that the RPC reports, and never from
 * the code of the refusal. The RPC gives one code, -32600, to three faults:
 *
 * - a start ledger that is older than the range that the RPC holds;
 * - a start ledger that is newer than the head of the instance that answers;
 * - a failed read of the RPC's own store.
 *
 * Only the first fault is permanent. A cursor names the head of the instance
 * that issued it. An answer from an instance with a lower head therefore meets
 * the second fault, although the cursor is only seconds old. On 23 September
 * 2026 the listener wrote a cursor at the head, and two seconds later it
 * stopped for good on this code.
 *
 * The RPC documents that a full window holds `ledgerRetentionWindow` ledgers
 * up to the head. An instance can hold fewer, because the option that fills
 * the window at start is off by default. The position therefore counts as
 * aged out only when it is older than both bounds. One instance with a short
 * history then cannot stop the listener.
 *
 * A range question that fails proves nothing, so it gives nothing. The caller
 * then treats the failure as one that a restart can clear.
 */
export async function findAgedOut(
  server: Pick<rpc.Server, 'getHealth'>,
  statePath: string,
  firstLedger: number,
): Promise<AgedOut | null> {
  const held = readPosition(statePath);
  const ledger = held === null ? firstLedger : ledgerOfCursor(held.cursor);
  if (ledger === null) return null;
  let range: rpc.Api.GetHealthResponse;
  try {
    range = await server.getHealth();
  } catch {
    return null;
  }
  const oldestKept = Math.min(
    range.oldestLedger,
    range.latestLedger - range.ledgerRetentionWindow + 1,
  );
  return ledger < oldestKept ? { ledger, oldestKept } : null;
}

/**
 * The ledger that a cursor names.
 *
 * A cursor is a transaction identifier and an event index, joined by a dash.
 * The identifier packs the ledger sequence into its top 32 bits, so a shift
 * recovers it. A measurement against the network confirms this. A cursor at
 * the head reports the same ledger that the same response calls
 * `latestLedger`.
 *
 * The listener needs this because an empty page does not mean the end of the
 * feed. One request scans about ten thousand ledgers and then answers, so an
 * empty page means only that nothing matched inside that span.
 */
export function ledgerOfCursor(cursor: string): number | null {
  const head = cursor.split('-')[0];
  if (head === undefined || !/^[0-9]+$/.test(head)) return null;
  return Number(BigInt(head) >> 32n);
}

/** The listener's position on disk, or nothing when it never ran. */
export function readPosition(path: string): Position | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const cursor = text({ ...parsed }, 'cursor');
    return cursor === null ? null : { cursor };
  } catch {
    // A truncated file reads as no position, and the caller starts from the
    // configured ledger rather than from a cursor that it cannot trust.
    return null;
  }
}

/**
 * Write the state file, so that a crash leaves either the old one or the new.
 *
 * A plain write can stop halfway and leave a truncated file. A truncated
 * cursor and a corrupt cursor look the same to a reader. Both send the
 * listener back to a configured ledger, and both repeat days of redemptions.
 * The write therefore lands in a temporary file, and the rename replaces the
 * old file in one step.
 */
function writeState(path: string, state: object): void {
  const temporary = `${path}.writing`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`);
  renameSync(temporary, path);
}

/** Write the position that the listener reached. */
export function writePosition(path: string, position: Position): void {
  // No stuck field, which is how a reader learns that nothing is stuck. The
  // clearing needs no separate step and nobody has to remember it.
  writeState(path, { cursor: position.cursor });
}

/**
 * Write that a receiver refused an event. The position does not move.
 *
 * The cursor stays where it was, so this changes nothing about delivery. What
 * it buys is a distinction that a reader cannot otherwise make.
 *
 * A stuck listener rewrites this file on every retry, so the file stays fresh
 * while nothing moves. A stopped listener writes nothing, so its file goes
 * stale. Without this write both look the same: a frozen file and a growing
 * lag. A reader would then report that the listener is not running, while the
 * listener runs and the receiver is the broken part. An operator would go to
 * the wrong process while redemptions pile up behind the refusal.
 *
 * A refusal on the first event of a first run has no cursor to keep, and the
 * file then carries the stuck event alone. A reader that finds no cursor
 * resumes from the configured ledger, which is correct, because nothing was
 * ever delivered.
 */
export function writeStall(path: string, cursor: string | null, stuckOn: string): void {
  writeState(path, cursor === null ? { stuckOn } : { cursor, stuckOn });
}

/** What one listener needs to run. */
export interface ListenerParts {
  readonly server: Pick<rpc.Server, 'getEvents'>;
  readonly contractId: string;
  readonly statePath: string;
  readonly deliver: Deliver;
}

/**
 * Read one page of the feed and deliver every event in it.
 *
 * The position moves one event at a time, and it moves again when the batch
 * ends. The listener keeps both rules, because they answer different faults.
 *
 * One event at a time is what a measurement of the network supports: an
 * event's own identifier works as a cursor and resumes strictly after it. A
 * refusal halfway through a batch therefore repeats no event that the receiver
 * already accepted.
 *
 * A poll that matches nothing still returns a cursor, because the network
 * reports how far it read rather than what it found. A rule that persisted
 * only after a delivery would hold a position still through a quiet period
 * while the network moved on. The retained history is about seven days. A week
 * of silence would put the stored cursor outside that window, and the next
 * poll would fail at the start of the next burst.
 *
 * A refused delivery persists nothing and moves nothing, so the next poll
 * reads the same event again. The feed stops rather than skips, because a
 * skipped redemption is a payment that nobody hears about.
 */
export async function pollOnce(
  parts: ListenerParts,
  from: Position | { startLedger: number },
): Promise<PollResult> {
  const filters = [{ type: 'contract' as const, contractIds: [parts.contractId] }];
  const page =
    'cursor' in from
      ? await parts.server.getEvents({ cursor: from.cursor, filters, limit: EVENT_PAGE_LIMIT })
      : await parts.server.getEvents({
          startLedger: from.startLedger,
          filters,
          limit: EVENT_PAGE_LIMIT,
        });

  let delivered = 0;
  let position = 'cursor' in from ? from.cursor : null;
  for (const event of page.events) {
    const message = readRedemption(event);
    if (message !== null && !(await parts.deliver(message))) {
      // The position does not move. The file is rewritten anyway, so that a
      // reader can tell a listener that is stuck from one that has stopped.
      writeStall(parts.statePath, position, message.event_id);
      return {
        read: page.events.length,
        delivered,
        cursor: position,
        stuckOn: message.event_id,
        scannedTo: position === null ? null : ledgerOfCursor(position),
        latestLedger: page.latestLedger,
      };
    }
    if (message !== null) delivered += 1;
    // The position moves one event at a time, so a refusal later in the batch
    // never repeats an event that the receiver already accepted.
    position = event.id;
    writePosition(parts.statePath, { cursor: position });
  }

  // The batch finished, so the page's own cursor stands. An empty batch reaches
  // here too, which is what keeps the position moving through a quiet week.
  writePosition(parts.statePath, { cursor: page.cursor });
  return {
    read: page.events.length,
    delivered,
    cursor: page.cursor,
    stuckOn: null,
    scannedTo: ledgerOfCursor(page.cursor),
    latestLedger: page.latestLedger,
  };
}

/**
 * Post one message, and treat only an accepted answer as delivery.
 *
 * The answer decides whether the position moves, so it must mean that the
 * receiver holds the message. A receiver that answers before it writes turns
 * an accepted message into a lost one, and nothing sends it again. This side
 * therefore counts a 2xx and nothing else, and it counts a refused connection
 * as a refusal rather than as an error to raise.
 */
export function postToWebhook(url: string): Deliver {
  return async (message) => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      return response.ok;
    } catch {
      // A receiver that is down is a receiver that refused. The listener holds
      // its position and asks again.
      return false;
    }
  };
}

/** How long a listener runs. */
export type RunUntil = 'quiet' | 'forever';

/** What one run did. */
export interface RunOutcome {
  readonly polls: number;
  readonly delivered: number;
  /** The event that no receiver would take, when the run ended on one. */
  readonly stuckOn: string | null;
}

/** Wait, so that a refused delivery does not become a busy loop. */
function rest(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Run the listener until it catches up, or for ever.
 *
 * `quiet` reads to the end of the feed and returns. A person who follows the
 * written path runs that mode. Every step of the path is then a command that
 * ends. A reader who must leave a process alive loses it when they close a
 * terminal, and then meets a merchant screen that never confirms. `forever` is
 * what the service unit runs.
 *
 * One function serves both modes, so a reader runs what the service runs.
 */
export async function runListener(
  parts: ListenerParts,
  until: RunUntil,
  firstLedger: number,
  attemptsWhenQuiet = DELIVERY_ATTEMPTS_WHEN_QUIET,
): Promise<RunOutcome> {
  let polls = 0;
  let delivered = 0;
  let refusals = 0;
  let wait = DELIVERY_BACKOFF_MS;
  let target: number | null = null;

  for (;;) {
    const held = readPosition(parts.statePath);
    const from = held ?? { startLedger: firstLedger };
    const result = await pollOnce(parts, from);
    polls += 1;
    delivered += result.delivered;

    if (result.stuckOn !== null) {
      refusals += 1;
      // A run that must end cannot wait for ever. It stops, and it moves no
      // position, so the event that it could not deliver is still the next.
      if (until === 'quiet' && refusals >= attemptsWhenQuiet) {
        return { polls, delivered, stuckOn: result.stuckOn };
      }
      await rest(wait);
      wait = Math.min(wait * 2, DELIVERY_BACKOFF_CEILING_MS);
      continue;
    }

    refusals = 0;
    wait = DELIVERY_BACKOFF_MS;

    // Caught up means the listener read as far as the head of the chain. It
    // does not mean that a page came back empty.
    //
    // One request scans about ten thousand ledgers and then answers. An empty
    // page says only that nothing matched inside that span. A run that stopped
    // on an empty page reported success from thirty thousand ledgers behind.
    // Thirteen redemptions sat in that gap, and it delivered none of them.
    // That is the worst failure of this mode. A person who follows the written
    // path reads `caught up`, and then meets a screen that confirms nothing.
    //
    // The first poll sets the head. The chain keeps closing ledgers while this
    // runs, so a target that moved would never arrive.
    if (target === null) target = result.latestLedger;
    if (until === 'quiet' && result.scannedTo !== null && result.scannedTo >= target) {
      return { polls, delivered, stuckOn: null };
    }
    await rest(until === 'quiet' ? 0 : EVENT_POLL_INTERVAL_MS);
  }
}

/** What the state file says, for a reader that watches rather than resumes. */
export interface ListenerState {
  readonly cursor: string | null;
  /** The event that a receiver refuses, when the listener is stuck on one. */
  readonly stuckOn: string | null;
  /** How long ago the listener wrote the file, in milliseconds. */
  readonly ageMs: number | null;
}

/**
 * Read the state file as an observer, and not as a listener that resumes.
 *
 * The age comes from the file's own modification time, which the kernel
 * recorded. It does not come from a stamp inside the file. A stamp is a claim
 * that a process makes about itself. A process whose writer is stuck could
 * still refresh a stamp that it holds in memory.
 *
 * A file that no listener wrote gives nothing in every field, and a reader
 * reports that as a listener that never ran.
 */
export function readListenerState(path: string): ListenerState {
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch {
    return { cursor: null, stuckOn: null, ageMs: null };
  }
  let held: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      held = { ...parsed };
    }
  } catch {
    // A truncated file still has an age, which is the fact that matters most.
  }
  const cursor = held['cursor'];
  const stuckOn = held['stuckOn'];
  return {
    cursor: typeof cursor === 'string' ? cursor : null,
    stuckOn: typeof stuckOn === 'string' ? stuckOn : null,
    ageMs: Math.max(0, Date.now() - stat.mtimeMs),
  };
}
