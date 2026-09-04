import { renameSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { Address, scValToNative } from '@stellar/stellar-sdk';
import type { rpc, xdr } from '@stellar/stellar-sdk';
import {
  DELIVERY_ATTEMPTS_WHEN_QUIET,
  DELIVERY_BACKOFF_CEILING_MS,
  DELIVERY_BACKOFF_MS,
  EVENT_PAGE_LIMIT,
  EVENT_POLL_INTERVAL_MS,
  RPC_INVALID_REQUEST,
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
  readonly cursor: string;
  /** The event that a receiver refused, when one did. */
  readonly stuckOn: string | null;
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

/**
 * Whether the network refused the request because the cursor aged out.
 *
 * The network throws a plain object with a code and a message. It is not an
 * `Error`, so this guard inspects the fields rather than the type. The listener
 * sends one shape of request, and only the cursor in it can age. This code
 * therefore carries that one meaning here.
 */
export function isCursorTooOld(caught: unknown): boolean {
  if (caught === null || typeof caught !== 'object') return false;
  const fields: Record<string, unknown> = { ...caught };
  return fields['code'] === RPC_INVALID_REQUEST;
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
 * Write the position, so that a crash leaves either the old one or the new one.
 *
 * A plain write can stop halfway and leave a truncated file. A truncated
 * cursor and a corrupt cursor look the same to a reader. Both send the
 * listener back to a configured ledger, and both repeat days of redemptions.
 * The write therefore lands in a temporary file, and the rename replaces the
 * old file in one step.
 */
export function writePosition(path: string, position: Position): void {
  const temporary = `${path}.writing`;
  writeFileSync(temporary, `${JSON.stringify(position)}\n`);
  renameSync(temporary, path);
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
      return {
        read: page.events.length,
        delivered,
        cursor: position ?? '',
        stuckOn: message.event_id,
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
  return { read: page.events.length, delivered, cursor: page.cursor, stuckOn: null };
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
    // An empty page means the feed holds nothing newer, which is what caught
    // up means.
    if (until === 'quiet' && result.read === 0) return { polls, delivered, stuckOn: null };
    await rest(until === 'quiet' ? 0 : EVENT_POLL_INTERVAL_MS);
  }
}
