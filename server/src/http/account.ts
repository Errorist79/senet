import { xdr } from '@stellar/stellar-sdk';
import type { SubmitResult } from '../feepayer.js';
import { friendbotFund } from '../horizon.js';
import type { RouteContext } from './router.js';
import { badRequest, requireString } from './transport.js';

/** What a deployment produced. */
export interface DeployReply extends SubmitResult {
  readonly contractId: string;
}

/** What a funding request produced. */
export interface FundReply {
  readonly address: string;
  readonly funded: boolean;
}

/**
 * Submit a host function that the caller already authorized.
 *
 * A person who registers a passkey has no account yet, so they cannot pay for
 * the deployment of their own smart account. The registration ceremony signs
 * the authorization, and this route supplies the source account and the fee.
 *
 * The service never signs the authorization. It signs only the transaction
 * that carries it, so it pays for the deployment and it cannot change it.
 */
export async function deployRoute(
  context: RouteContext,
  body: Record<string, unknown>,
): Promise<DeployReply> {
  const contractId = requireString(body, 'contractId');
  let hostFunction: xdr.HostFunction;
  try {
    hostFunction = xdr.HostFunction.fromXDR(requireString(body, 'hostFunction'), 'base64');
  } catch {
    throw badRequest('MALFORMED_HOST_FUNCTION', 'hostFunction is not base64 XDR');
  }

  const entries = body['auth'];
  if (!Array.isArray(entries)) {
    throw badRequest('MISSING_FIELD', 'the request needs an auth list');
  }
  const auth: xdr.SorobanAuthorizationEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw badRequest('MALFORMED_ENTRY', 'every auth entry must be base64 XDR');
    }
    try {
      auth.push(xdr.SorobanAuthorizationEntry.fromXDR(entry, 'base64'));
    } catch {
      throw badRequest('MALFORMED_ENTRY', 'every auth entry must be base64 XDR');
    }
  }
  return { ...(await context.feePayer.invoke(hostFunction, auth)), contractId };
}

/**
 * Ask the test network to fund an address.
 *
 * This exists because the network under test hands out funds on request. A
 * network that does not do so needs another way to fund a new account, and
 * this route is the one place that changes.
 */
export async function fundRoute(
  context: RouteContext,
  body: Record<string, unknown>,
): Promise<FundReply> {
  const address = requireString(body, 'address');
  return { address, funded: await friendbotFund(context.config.friendbotUrl, address) };
}
