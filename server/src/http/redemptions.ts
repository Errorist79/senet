import { addRedemption, findRedemption, readFromChain } from '../redemptions.js';
import type { RedemptionMessage } from '../events.js';
import type { RouteContext } from './router.js';
import { badRequest, requireParameter, requireString } from './transport.js';

/**
 * The feed that the merchant screen confirms from.
 *
 * One route takes a pointer to an event and stores what the chain published at
 * it. The other answers what the store holds for one voucher.
 *
 * Nothing here trusts a caller's account of a redemption. The claim carries an
 * event identifier and the ledger that holds it, and the service reads that
 * event itself. A caller therefore cannot put a payment on a merchant's screen
 * that never happened. The screen's confirmation is true because the chain
 * says so, and not because a service that we trust said so.
 *
 * That is why there is no shared secret between the listener and this route.
 * A secret would make the confirmation depend on the transport rather than on
 * the fact. A secret between two of our own services also decays. It reaches a
 * log, a deployment script or a developer's notes, in the ordinary life of a
 * project. Verification does not decay.
 *
 * A secret would add one thing: a bound on a caller that fills the store with
 * rubbish. Nothing rubbish is ever stored, because the store keeps only what
 * the chain returned. The lookup still costs something, so this route carries
 * the tighter request budget.
 */

/** What the feed answers for one voucher. */
export interface FeedReply {
  readonly voucherId: string;
  /** The redemption, or nothing when the chain has published none yet. */
  readonly redemption: RedemptionMessage | null;
}

/** What the service answers when it takes a claim. */
export interface AcceptReply {
  readonly stored: boolean;
  /** True when this event was already in the store, which is not a fault. */
  readonly repeat: boolean;
  readonly redemption: RedemptionMessage;
}

/**
 * Take one pointer to a redemption, read it from the chain, and store it.
 *
 * The service reads none of the caller's other fields. A pointer is all that
 * the service needs, and a pointer is all that it believes.
 */
export async function acceptRedemptionRoute(
  context: RouteContext,
  body: Record<string, unknown>,
): Promise<AcceptReply> {
  const eventId = requireString(body, 'event_id');
  const ledger = body['ledger'];
  if (typeof ledger !== 'number' || !Number.isSafeInteger(ledger) || ledger <= 0) {
    throw badRequest('MISSING_FIELD', 'ledger names the ledger that holds the event');
  }

  const fromChain = await readFromChain(context.server, context.config.voucher.contractId, {
    eventId,
    ledger,
  });
  if (fromChain === null) {
    throw badRequest(
      'NO_SUCH_EVENT',
      `the chain publishes no redemption ${eventId} in ledger ${ledger}`,
    );
  }

  const { added } = addRedemption(context.config.redemptionStorePath, fromChain);
  return { stored: true, repeat: !added, redemption: fromChain };
}

/** What the store holds for one voucher. */
export function feedRoute(context: RouteContext, url: URL): FeedReply {
  const voucherId = requireParameter(url, 'voucherId');
  return {
    voucherId,
    redemption: findRedemption(context.config.redemptionStorePath, voucherId),
  };
}
