import { xdr } from '@stellar/stellar-sdk';
import type { SubmitResult } from '../feepayer.js';
import { readBalance, waitForFunds } from '../balance.js';
import { MAX_DEPLOY_FEE_STROOPS } from '../constants.js';
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
  /** Whether the funding service created the address on this request. */
  readonly created: boolean;
  /** What the address holds once the funds reached a ledger, in stroops. */
  readonly balanceStroops: string | null;
  /** How long the service waited for the funds, in milliseconds. */
  readonly waitedMs: number;
}

/** Whether a host function deploys the passkey wallet code, and does nothing else. */
export function isWalletDeployment(hostFunction: xdr.HostFunction, walletWasmHash: string): boolean {
  if (hostFunction.switch().name !== 'hostFunctionTypeCreateContractV2') return false;
  const executable = hostFunction.createContractV2().executable();
  return (
    executable.switch().name === 'contractExecutableWasm' &&
    executable.wasmHash().toString('hex') === walletWasmHash.toLowerCase()
  );
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
  // The route pays for a wallet deployment and for nothing else. A caller who
  // could name any host function could make the service pay for work of the
  // caller's choice, up to the deploy ceiling.
  if (!isWalletDeployment(hostFunction, context.config.walletWasmHash)) {
    throw badRequest('NOT_A_WALLET_DEPLOYMENT', 'hostFunction must deploy the passkey wallet code');
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
  return {
    ...(await context.feePayer.invoke(hostFunction, auth, MAX_DEPLOY_FEE_STROOPS)),
    contractId,
  };
}

/**
 * Ask the test network to fund an address.
 *
 * The route answers once the funds reach a ledger, and not once the request
 * goes out. The funding service replies as soon as it submits. A caller that
 * read the balance at that moment would read it from before the funds arrive.
 * It would then tell a person that their new account holds nothing.
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
  const started = Date.now();
  const created = await friendbotFund(context.config.friendbotUrl, address);
  const held = await waitForFunds(async () => {
    const balance = await readBalance(context.config, context.server, address);
    return balance.stroops;
  });
  const waitedMs = Date.now() - started;
  console.log(`funded ${address} created=${created} held=${held ?? 'none'} in ${waitedMs}ms`);
  return {
    address,
    created,
    balanceStroops: held === null ? null : held.toString(),
    waitedMs,
  };
}
