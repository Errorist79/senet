import { networkTag } from '@senet/core';
import { MIN_CHANNEL_BALANCE_STROOPS } from '../constants.js';
import { readBalance } from '../balance.js';
import type { RouteContext } from './router.js';
import { requireParameter } from './transport.js';

/** What the application needs to know about the chain that it talks to. */
export interface ConfigReply {
  readonly network: string;
  readonly networkTag: string;
  readonly contractId: string;
  readonly tokenId: string;
  readonly rpcUrl: string;
  /** The smart account code that a new passkey account runs. */
  readonly walletWasmHash: string;
  /** The domain that a passkey binds to. */
  readonly rpId: string;
}

/** The latest ledger that the service saw. */
export interface LedgerReply {
  readonly sequence: number;
  /** The RPC reports the protocol version as text, and this route repeats it. */
  readonly protocolVersion: string;
  /** When the service read the ledger, so a device can count forward. */
  readonly readAtIso: string;
}

/** One address's balance of the configured token. */
export interface BalanceReply {
  readonly address: string;
  /** Stroops, or null when the network does not know the address. */
  readonly balanceStroops: string | null;
  /** Where the value came from, so a caller can report it. */
  readonly source: string;
}

/** What an operator watches. */
export interface StatusReply {
  readonly channels: Record<string, string | null>;
  readonly lowChannels: readonly string[];
  readonly minChannelBalanceStroops: string;
  readonly maxTtlLedgers: number | null;
  readonly maxAmountStroops: string | null;
}

/**
 * The chain identities.
 *
 * The application reads these once and it holds no copy of its own. The
 * service is therefore the one place that names the contract and the network.
 */
export function configRoute(context: RouteContext): ConfigReply {
  const { voucher } = context.config;
  return {
    network: voucher.network,
    networkTag: networkTag(voucher.network),
    contractId: voucher.contractId,
    tokenId: voucher.tokenId,
    rpcUrl: context.config.rpcUrl,
    walletWasmHash: context.config.walletWasmHash,
    rpId: context.config.rpId,
  };
}

/**
 * The latest ledger.
 *
 * A device that mints a voucher offline counts forward from the last ledger
 * that it saw. It reads this route while it still has a network.
 */
export async function ledgerRoute(context: RouteContext): Promise<LedgerReply> {
  const latest = await context.server.getLatestLedger();
  return {
    sequence: latest.sequence,
    protocolVersion: latest.protocolVersion,
    readAtIso: new Date().toISOString(),
  };
}

/**
 * One address's balance.
 *
 * A classic account and a smart account keep their balances in different
 * places. This route answers for both kinds. A person who holds a passkey
 * account does not need to know which kind it is.
 */
export async function balanceRoute(
  context: RouteContext,
  url: URL,
): Promise<BalanceReply> {
  const address = requireParameter(url, 'address');
  const balance = await readBalance(context.config, context.server, address);
  return {
    address,
    balanceStroops: balance.stroops === null ? null : balance.stroops.toString(),
    source: balance.source,
  };
}

/** The channel balances, the ones under the floor, and the contract limits. */
export async function statusRoute(context: RouteContext): Promise<StatusReply> {
  const balances = await context.feePayer.balances();
  const limits = context.feePayer.contractLimits;
  return {
    channels: Object.fromEntries(
      Object.entries(balances).map(([address, stroops]) => [
        address,
        stroops === null ? null : stroops.toString(),
      ]),
    ),
    lowChannels: await context.feePayer.lowChannels(),
    minChannelBalanceStroops: MIN_CHANNEL_BALANCE_STROOPS.toString(),
    maxTtlLedgers: limits === null ? null : limits.maxTtlLedgers,
    maxAmountStroops: limits === null ? null : limits.maxAmountStroops.toString(),
  };
}
