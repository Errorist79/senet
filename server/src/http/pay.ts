import { Operation, xdr } from '@stellar/stellar-sdk';
import { transferInvocation } from '@senet/core';
import type { SubmitResult } from '../feepayer.js';
import type { RouteContext } from './router.js';
import { badRequest, requireString } from './transport.js';

/**
 * Pay a payee-presented request from a smart account.
 *
 * The caller sends the payment it authorized and the entry that its passkey
 * signed. **The service builds the invocation itself** and compares it against
 * the one inside the entry. A caller therefore cannot have the fee-payer carry
 * a transaction that does something other than the payment it described.
 *
 * That is the redemption route's rule in another place. Take a description,
 * build from it, and refuse when the signed artefact differs from what the
 * description produces.
 */

/** What the service answers for one payment. */
export interface PayReply extends SubmitResult {
  readonly from: string;
  readonly to: string;
  readonly amountStroops: string;
}

/** Read a whole number of stroops from a request. */
function stroops(body: Record<string, unknown>): bigint {
  const raw = requireString(body, 'amountStroops');
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw badRequest('BAD_AMOUNT', 'amountStroops is a whole number of stroops above zero');
  }
  return BigInt(raw);
}

/** Submit one payment that a passkey authorized. */
export async function payRoute(
  context: RouteContext,
  body: Record<string, unknown>,
): Promise<PayReply> {
  const from = requireString(body, 'from');
  const to = requireString(body, 'to');
  const amount = stroops(body);
  const entryXdr = requireString(body, 'entryXdr');

  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
  } catch {
    throw badRequest('BAD_ENTRY', 'entryXdr is not an authorization entry');
  }

  // The service builds what the description means, and compares it against
  // what the caller signed. The caller's own invocation is never used.
  const wanted = transferInvocation(context.config.voucher, {
    from,
    to,
    amount,
    expireAt: 0,
  });
  if (!entry.rootInvocation().toXDR().equals(wanted.toXDR())) {
    throw badRequest(
      'ENTRY_MISMATCH',
      'the signed authorization does not match the payment that this request describes',
    );
  }

  const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
    entry.rootInvocation().function().contractFn(),
  );
  const result = await context.feePayer.invoke(hostFunction, [entry]);
  return { ...result, from, to, amountStroops: amount.toString() };
}

/** The operation that carries one payment, for a caller that builds its own. */
export function paymentOperation(entry: xdr.SorobanAuthorizationEntry): xdr.Operation {
  return Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      entry.rootInvocation().function().contractFn(),
    ),
    auth: [entry],
  });
}
