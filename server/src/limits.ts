import { Account, Contract, Keypair, TransactionBuilder, rpc, scValToNative } from '@stellar/stellar-sdk';
import { CONTRACT_MAX_TTL_LEDGERS, TX_TIMEOUT_SECONDS } from '@senet/core';
import type { ServerConfig } from './config.js';
import { errorText } from './outcomes.js';

/** The function that reports the contract's stored limits. */
const LIMITS_FUNCTION = 'limits';

/**
 * A source account for a read that changes nothing.
 *
 * Simulation needs a source account and a sequence number, and it uses
 * neither. This address is the all-zero ed25519 key, which no one holds.
 */
const READ_ONLY_SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0)).publicKey();

/** The limits that the deployed contract enforces. */
export interface ContractLimits {
  /** The largest voucher that the contract accepts, in stroops. */
  readonly maxAmountStroops: bigint;
  /** The longest lifetime that the contract accepts, in ledgers. */
  readonly maxTtlLedgers: number;
}

/** The service could not read the contract's limits. */
export class ContractLimitsUnreadableError extends Error {
  constructor(
    readonly contractId: string,
    readonly detail: string,
  ) {
    super(
      `the service could not read the limits of contract ${contractId}: ${detail}. ` +
        `Check that this network carries the contract, and that it holds its limits.`,
    );
    this.name = new.target.name;
  }
}

/** The deployed contract and this build disagree about a limit. */
export class ContractLimitsMismatchError extends Error {
  constructor(
    readonly contractId: string,
    readonly deployedMaxTtlLedgers: number,
    readonly expectedMaxTtlLedgers: number,
  ) {
    super(
      `contract ${contractId} accepts ${deployedMaxTtlLedgers} ledgers of lifetime ` +
        `and this build offers up to ${expectedMaxTtlLedgers}. A payer would sign a ` +
        `voucher that the contract then refuses. Deploy a contract that matches, or ` +
        `change the lifetimes that this build offers.`,
    );
    this.name = new.target.name;
  }
}

/** Read a pair of whole numbers out of a decoded return value. */
function readLimits(value: unknown): ContractLimits {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${LIMITS_FUNCTION} returned no pair of values`);
  }
  const [amount, ttl] = value;
  if (typeof amount !== 'bigint' && typeof amount !== 'number') {
    throw new Error(`${LIMITS_FUNCTION} returned no amount`);
  }
  if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl)) {
    throw new Error(`${LIMITS_FUNCTION} returned no lifetime`);
  }
  return { maxAmountStroops: BigInt(amount), maxTtlLedgers: ttl };
}

/**
 * Read the limits that the deployed contract enforces.
 *
 * The call is a simulation, so it costs no fee and it changes no ledger.
 */
export async function readContractLimits(
  server: rpc.Server,
  config: ServerConfig,
): Promise<ContractLimits> {
  const transaction = new TransactionBuilder(new Account(READ_ONLY_SOURCE, '0'), {
    fee: '100',
    networkPassphrase: config.voucher.network,
  })
    .addOperation(new Contract(config.voucher.contractId).call(LIMITS_FUNCTION))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await server.simulateTransaction(transaction);
  } catch (caught) {
    throw new ContractLimitsUnreadableError(config.voucher.contractId, errorText(caught));
  }
  if (rpc.Api.isSimulationError(simulation)) {
    throw new ContractLimitsUnreadableError(
      config.voucher.contractId,
      simulation.error.split('\n', 1)[0] ?? simulation.error,
    );
  }
  const returned = simulation.result?.retval;
  if (returned === undefined) {
    throw new ContractLimitsUnreadableError(
      config.voucher.contractId,
      `${LIMITS_FUNCTION} returned nothing`,
    );
  }
  try {
    return readLimits(scValToNative(returned));
  } catch (caught) {
    throw new ContractLimitsUnreadableError(config.voucher.contractId, errorText(caught));
  }
}

/**
 * Refuse a contract whose lifetime ceiling differs from this build's.
 *
 * The library refuses a lifetime above `CONTRACT_MAX_TTL_LEDGERS` before the
 * payer signs. That check is worth nothing when the deployed contract holds a
 * different number, and contract code cannot tell the library which number it
 * holds. One read at start turns a mismatch that nobody would see into a
 * refusal to start.
 */
export function assertContractLimits(contractId: string, limits: ContractLimits): void {
  if (limits.maxTtlLedgers !== CONTRACT_MAX_TTL_LEDGERS) {
    throw new ContractLimitsMismatchError(
      contractId,
      limits.maxTtlLedgers,
      CONTRACT_MAX_TTL_LEDGERS,
    );
  }
}
