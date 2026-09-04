import { xdr } from '@stellar/stellar-sdk';
import { VoucherError } from '@senet/core';
import type { SubmitResult } from '../feepayer.js';
import type { RouteContext } from './router.js';
import { badRequest, requireString } from './transport.js';

/**
 * What the service answers for one redeem.
 *
 * The voucher terms come back beside the outcome. They come out of the signed
 * entry, and the client cannot read them from the payload alone.
 */
export interface RedeemReply extends SubmitResult {
  readonly voucherId: string;
  readonly amountStroops: string;
  readonly payer: string;
  readonly recipient: string;
}

/**
 * Redeem one voucher.
 *
 * The terms come out of the signed entry and never out of the request. A
 * request that also carried an amount could disagree with the entry, and the
 * payer signed the entry. The caller supplies only the recipient, which the
 * entry deliberately omits.
 *
 * The library runs the credential and the deadline invariants inside
 * `readVoucher`, which the fee-payer calls before it touches the network. This
 * route turns the typed refusal into a typed reply, and it repeats no check.
 */
export async function redeemRoute(
  context: RouteContext,
  body: Record<string, unknown>,
): Promise<RedeemReply> {
  const entryXdr = requireString(body, 'entryXdr');
  const recipient = requireString(body, 'recipient');

  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
  } catch {
    throw badRequest('MALFORMED_ENTRY', 'entryXdr is not a base64 authorization entry');
  }

  try {
    const { voucher, ...result } = await context.feePayer.redeem(entry, recipient);
    return {
      ...result,
      voucherId: voucher.voucherId.toString(),
      amountStroops: voucher.amount.toString(),
      payer: voucher.payer,
      recipient,
    };
  } catch (caught) {
    // A library refusal names its own class, and that name is the code that a
    // client branches on. Anything else is not this route's to interpret.
    if (caught instanceof VoucherError) throw badRequest(caught.name, caught.message);
    throw caught;
  }
}
