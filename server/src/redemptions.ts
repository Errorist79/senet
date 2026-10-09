import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { rpc } from '@stellar/stellar-sdk';
import { EVENT_PAGE_LIMIT } from './constants.js';
import { readRedemption } from './events.js';
import type { RedemptionMessage } from './events.js';

/**
 * The redemptions that a merchant screen confirms from.
 *
 * A merchant screen once said `paid` because a submission returned. This store
 * holds what the chain published instead, so the screen confirms from the
 * contract's own event.
 *
 * Nothing here trusts the caller. A post carries a pointer to an event. The
 * service reads that event from the chain, and it stores what the chain said.
 * A caller that sends a well formed lie stores nothing. No later reader has to
 * disbelieve a record.
 *
 * The store is a file. A store in memory would lose a confirmation on a
 * restart, and nothing would refill it. The listener re-delivers only what a
 * receiver never accepted. A merchant would keep a payment that the chain
 * took, and a screen that can never confirm it.
 */

/** What one caller claims, which is a pointer and nothing more. */
export interface RedemptionClaim {
  /** The event on the feed. The service reads the truth from this. */
  readonly eventId: string;
  /** The ledger that holds it, which bounds the lookup to one ledger. */
  readonly ledger: number;
}

/** Everything that the store holds. */
interface Stored {
  readonly redemptions: readonly RedemptionMessage[];
}

/** Read the store, or nothing when no file exists yet. */
export function readStore(path: string): readonly RedemptionMessage[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const fields: Record<string, unknown> = { ...parsed };
    const held: unknown = fields['redemptions'];
    if (!Array.isArray(held)) return [];
    const kept: RedemptionMessage[] = [];
    for (const one of held) {
      const message = readStoredMessage(one);
      if (message !== null) kept.push(message);
    }
    return kept;
  } catch {
    // A truncated store reads as empty. The listener re-delivers nothing that
    // it already delivered, so an operator repairs this rather than the code.
    return [];
  }
}

/** One stored message, when the value on disk still fits the shape. */
function readStoredMessage(value: unknown): RedemptionMessage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields: Record<string, unknown> = { ...value };
  const text = (key: string): string | null => {
    const held = fields[key];
    return typeof held === 'string' ? held : null;
  };
  const count = (key: string): number | null => {
    const held = fields[key];
    return typeof held === 'number' ? held : null;
  };
  const voucherId = text('voucher_id');
  const payer = text('payer');
  const recipient = text('recipient');
  const amount = text('amount');
  const txHash = text('tx_hash');
  const closedAt = text('ledger_closed_at');
  const eventId = text('event_id');
  const expireAt = count('expire_at');
  const ledger = count('ledger');
  if (
    voucherId === null ||
    payer === null ||
    recipient === null ||
    amount === null ||
    txHash === null ||
    closedAt === null ||
    eventId === null ||
    expireAt === null ||
    ledger === null
  ) {
    return null;
  }
  return {
    voucher_id: voucherId,
    payer,
    recipient,
    amount,
    expire_at: expireAt,
    tx_hash: txHash,
    ledger,
    ledger_closed_at: closedAt,
    event_id: eventId,
  };
}

/**
 * Add one redemption, and give back what the store now holds for it.
 *
 * Delivery is at least once, so the same redemption arrives more than once and
 * that is normal rather than a fault. The event identifier names one
 * redemption exactly, so a second arrival changes nothing and answers the same
 * way as the first.
 */
export function addRedemption(
  path: string,
  message: RedemptionMessage,
): { held: readonly RedemptionMessage[]; added: boolean } {
  const held = readStore(path);
  if (held.some((one) => one.event_id === message.event_id)) {
    return { held, added: false };
  }
  const next: Stored = { redemptions: [...held, message] };
  const temporary = `${path}.writing`;
  writeFileSync(temporary, `${JSON.stringify(next)}\n`);
  renameSync(temporary, path);
  return { held: next.redemptions, added: true };
}

/** Read the event for one voucher in the specified transaction. */
export function findRedemption(
  path: string,
  voucherId: string,
  txHash: string,
): RedemptionMessage | null {
  return readStore(path).find((one) => one.voucher_id === voucherId && one.tx_hash === txHash) ?? null;
}

/**
 * Read one redemption from the chain, given a pointer to it.
 *
 * The lookup covers one ledger, because the pointer names it. The service
 * returns what the contract published, and a pointer that names no such event
 * returns nothing.
 *
 * This is what makes a confirmation true because the chain says so, rather
 * than true because a service that we trust said so. The difference is the
 * whole claim of the merchant screen.
 */
export async function readFromChain(
  server: Pick<rpc.Server, 'getEvents'>,
  contractId: string,
  claim: RedemptionClaim,
): Promise<RedemptionMessage | null> {
  const page = await server.getEvents({
    startLedger: claim.ledger,
    // The end of the window is exclusive, so one ledger is [N, N + 1). With
    // both bounds at N the window holds nothing. Every confirmation then
    // fails, and the listener holds its cursor on the first redemption that it
    // tries to deliver. Measured against this contract: a window ending at the
    // itself returns no events, and one ending at the next returns the event.
    endLedger: claim.ledger + 1,
    filters: [{ type: 'contract', contractIds: [contractId] }],
    limit: EVENT_PAGE_LIMIT,
  });
  const found = page.events.find((one) => one.id === claim.eventId);
  return found === undefined ? null : readRedemption(found);
}
