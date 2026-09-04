import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';
import { TX_TIMEOUT_SECONDS } from '@senet/core';
import type { ServerConfig } from './config.js';
import { FUND_CONFIRM_ATTEMPTS, FUND_CONFIRM_INTERVAL_MS } from './constants.js';
import { accountBalanceStroops } from './horizon.js';
import { errorText } from './outcomes.js';

/** The token function that reports what an address holds. */
const BALANCE_FUNCTION = 'balance';

/**
 * A source account for a read that changes nothing.
 *
 * Simulation needs a source account and a sequence number, and it spends
 * neither. This address is the all-zero ed25519 key, which nobody holds.
 */
const READ_ONLY_SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0)).publicKey();

/** The first letter of a contract address. */
const CONTRACT_PREFIX = 'C';

/** Where a balance came from, so a caller can report it. */
export type BalanceSource = 'account' | 'token contract';

/** One address's balance of the configured token. */
export interface Balance {
  readonly address: string;
  /** Stroops, or null when the network does not know the address. */
  readonly stroops: bigint | null;
  readonly source: BalanceSource;
}

/**
 * Read what an address holds.
 *
 * A classic account keeps its native balance in the account entry, and Horizon
 * serves that. A smart account is a contract, and it keeps its balance inside
 * the token contract instead, where only a contract call reads it. One route
 * answers for both kinds, because a person holding a passkey account should
 * not have to know which kind they have.
 */
export async function readBalance(
  config: ServerConfig,
  server: rpc.Server,
  address: string,
): Promise<Balance> {
  if (!address.startsWith(CONTRACT_PREFIX)) {
    return {
      address,
      stroops: await accountBalanceStroops(config.horizonUrl, address),
      source: 'account',
    };
  }
  return { address, stroops: await tokenBalanceStroops(config, server, address), source: 'token contract' };
}

/** Read a contract's balance through the token contract, by simulation. */
async function tokenBalanceStroops(
  config: ServerConfig,
  server: rpc.Server,
  address: string,
): Promise<bigint | null> {
  const transaction = new TransactionBuilder(new Account(READ_ONLY_SOURCE, '0'), {
    fee: '100',
    networkPassphrase: config.voucher.network,
  })
    .addOperation(
      new Contract(config.voucher.tokenId).call(
        BALANCE_FUNCTION,
        new Address(address).toScVal(),
      ),
    )
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await server.simulateTransaction(transaction);
  } catch (caught) {
    throw new Error(`the token contract did not answer for ${address}: ${errorText(caught)}`);
  }
  // A contract that never held the token has no balance entry, and the call
  // fails rather than answering zero. That is not an error to report, because
  // the address holds nothing yet.
  if (rpc.Api.isSimulationError(simulation)) return null;
  const returned = simulation.result?.retval;
  if (returned === undefined) return null;
  const value: unknown = scValToNative(returned);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

/**
 * Wait until a reader reports a balance above zero.
 *
 * The funding service answers as soon as it submits, and the transaction
 * reaches a ledger a few seconds later. A caller that reads at once reads the
 * balance from before the funds arrive. It then reports nothing to a person
 * who just added funds. This waits instead, and it gives up in the end.
 */
export async function waitForFunds(
  read: () => Promise<bigint | null>,
  attempts = FUND_CONFIRM_ATTEMPTS,
  intervalMs = FUND_CONFIRM_INTERVAL_MS,
): Promise<bigint | null> {
  let seen: bigint | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    seen = await read();
    if (seen !== null && seen > 0n) return seen;
    await new Promise((wake) => setTimeout(wake, intervalMs));
  }
  return seen;
}
