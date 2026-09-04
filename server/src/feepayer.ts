import {
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { TX_TIMEOUT_SECONDS, readVoucher, redeemArgs } from '@senet/core';
import type { DecodedVoucher } from '@senet/core';
import { Channel, ChannelPool } from './channels.js';
import type { ServerConfig } from './config.js';
import {
  INCLUSION_FEE_STROOPS,
  MAX_ATTEMPTS,
  MAX_FEE_STROOPS,
  MIN_CHANNEL_BALANCE_STROOPS,
  POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
} from './constants.js';
import { assertContractLimits, readContractLimits } from './limits.js';
import type { ContractLimits } from './limits.js';
import { classify, errorText } from './outcomes.js';
import type { Classification, Outcome, Stage } from './outcomes.js';

/** The contract function that a voucher authorizes. */
const REDEEM_FUNCTION = 'redeem';

/** What one redeem produced. The service returns this and it raises nothing. */
export interface RedeemResult {
  readonly outcome: Outcome;
  readonly stage: Stage;
  /** The ledger hash, when the transaction reached the network. */
  readonly hash: string | null;
  /** The ledger that applied the transaction. */
  readonly ledger: number | null;
  /** The whole fee that the service bid, in stroops. */
  readonly declaredFeeStroops: string | null;
  /** The fee that the network took, in stroops. */
  readonly feeChargedStroops: string | null;
  /** The contract error code, when a contract raised one. */
  readonly contractErrorCode: string | number | null;
  /** The contract that refused first, when the events name one. */
  readonly errorOrigin: string | null;
  /** The transaction result code, such as `txFailed`. */
  readonly resultCode: string | null;
  /** The operation result code, such as `invokeHostFunctionTrapped`. */
  readonly operationResultCode: string | null;
  /** Which attempt produced this outcome, counting from one. */
  readonly attempt: number;
  readonly elapsedMs: number;
  /** The channel account that paid, when the service took one. */
  readonly channel: string | null;
  /** The text that the classifier read. It belongs in a log, not in a branch. */
  readonly detail: string;
}

/** One redeem, with the terms that the signed entry carried. */
export interface RedeemRecord extends RedeemResult {
  readonly voucher: DecodedVoucher;
}

/** The fields that every stage carries, so no result grows key by key. */
const EMPTY: Omit<RedeemResult, 'outcome' | 'stage' | 'detail'> = {
  hash: null,
  ledger: null,
  declaredFeeStroops: null,
  feeChargedStroops: null,
  contractErrorCode: null,
  errorOrigin: null,
  resultCode: null,
  operationResultCode: null,
  attempt: 1,
  elapsedMs: 0,
  channel: null,
};

/** The transaction result code, such as `txBadSeq`. */
export function resultCodeOf(result: xdr.TransactionResult | undefined): string | null {
  return result === undefined ? null : result.result().switch().name;
}

/**
 * The operation result code, such as `invokeHostFunctionTrapped`.
 *
 * A trapped host function does not say why it trapped. The reason lives in the
 * diagnostic events, which the classifier reads instead.
 */
export function operationResultCodeOf(
  result: xdr.TransactionResult | undefined,
): string | null {
  if (result === undefined) return null;
  const inner = result.result();
  const name = inner.switch().name;
  if (name !== 'txSuccess' && name !== 'txFailed') return null;
  const operation = inner.results()[0];
  if (operation === undefined || operation.switch().name !== 'opInner') return null;
  const tr = operation.tr();
  if (tr.switch().name !== 'invokeHostFunction') return null;
  return tr.invokeHostFunctionResult().switch().name;
}

/**
 * Whether a second attempt is safe.
 *
 * A bad sequence number means the network took nothing, so a retry spends
 * nothing twice. A timeout before the poll stage means the transaction never
 * reached the network. A timeout at the poll stage is different, because the
 * transaction carries a hash and it may still apply. The service reports that
 * timeout with the hash and leaves the resolution to the caller, rather than
 * sending the same voucher a second time.
 */
export function retryable(result: RedeemResult): boolean {
  if (result.outcome === 'BAD_SEQUENCE') return true;
  return result.outcome === 'TIMEOUT' && result.stage !== 'poll';
}

/**
 * The fee-payer.
 *
 * The payer signs an authorization entry that names no recipient. This service
 * chooses the recipient, builds the transaction, simulates it in enforcing
 * mode, signs as the source account and pays the fee.
 */
export class FeePayer {
  private readonly pool: ChannelPool;

  private readonly server: rpc.Server;

  private limits: ContractLimits | null = null;

  constructor(private readonly config: ServerConfig) {
    this.server = new rpc.Server(config.rpcUrl);
    this.pool = new ChannelPool(
      config.channelSecrets.map(
        (secret) => new Channel(Keypair.fromSecret(secret), this.server, config.horizonUrl),
      ),
    );
  }

  /**
   * Prepare the service, and refuse to start when something does not agree.
   *
   * The service reads each channel's sequence number once. It also reads the
   * contract's stored limits and compares the lifetime ceiling with its own. A
   * payer must never sign a voucher that the contract then refuses.
   */
  async start(): Promise<this> {
    const limits = await readContractLimits(this.server, this.config);
    assertContractLimits(this.config.voucher.contractId, limits);
    this.limits = limits;
    await Promise.all(this.pool.all.map((channel) => channel.load()));
    return this;
  }

  /** The limits that the deployed contract enforces, read once at start. */
  get contractLimits(): ContractLimits | null {
    return this.limits;
  }

  get addresses(): string[] {
    return this.pool.all.map((channel) => channel.address);
  }

  /** The channel balances in stroops, with an unknown reading left as null. */
  async balances(): Promise<Record<string, bigint | null>> {
    const readings = await Promise.all(
      this.pool.all.map(async (channel): Promise<[string, bigint | null]> => [
        channel.address,
        await channel.balance(),
      ]),
    );
    return Object.fromEntries(readings);
  }

  /**
   * Whether any channel still holds enough to pay a fee.
   *
   * A channel whose balance did not read counts as funded. A refusal on a
   * failed Horizon call would turn a monitoring problem into an outage, and the
   * network judges the transaction anyway.
   */
  async hasFundedChannel(): Promise<boolean> {
    const readings = await Promise.all(this.pool.all.map((channel) => channel.balance()));
    return readings.some((balance) => balance === null || balance >= MIN_CHANNEL_BALANCE_STROOPS);
  }

  /**
   * The channels that fell under the floor.
   *
   * An operator watches this list. It fills before the service cannot pay, and
   * not after.
   */
  async lowChannels(): Promise<string[]> {
    const balances = await this.balances();
    return Object.entries(balances)
      .filter(([, balance]) => balance !== null && balance < MIN_CHANNEL_BALANCE_STROOPS)
      .map(([address]) => address);
  }

  /**
   * Redeem one voucher.
   *
   * The terms come out of the signed entry and never out of the request. The
   * caller supplies only the recipient, which the entry deliberately omits.
   * `readVoucher` runs the credential and deadline invariants, and it throws
   * when the entry fails one of them.
   */
  async redeem(
    entry: xdr.SorobanAuthorizationEntry,
    recipient: string,
  ): Promise<RedeemRecord> {
    const voucher = readVoucher(this.config.voucher, entry);
    return { ...(await this.withChannel(voucher, entry, recipient)), voucher };
  }

  /** Hold one channel, and try again only where a retry cannot spend twice. */
  private async withChannel(
    voucher: DecodedVoucher,
    entry: xdr.SorobanAuthorizationEntry,
    recipient: string,
  ): Promise<RedeemResult> {
    if (!(await this.hasFundedChannel())) {
      return {
        ...EMPTY,
        outcome: 'FEE_PAYER_UNDERFUNDED',
        stage: 'precheck',
        detail:
          `every channel account holds less than ${MIN_CHANNEL_BALANCE_STROOPS} stroops, ` +
          `so the service cannot pay a fee. Fund the channels and try again.`,
      };
    }
    const channel = this.pool.acquire();
    if (channel === null) {
      return {
        ...EMPTY,
        outcome: 'NO_CHANNEL_FREE',
        stage: 'precheck',
        detail:
          `all ${this.pool.size} channel accounts are in use. One channel serves ` +
          `one transaction per ledger. Try again, or add a channel.`,
      };
    }

    const started = Date.now();
    try {
      let last: RedeemResult = {
        ...EMPTY,
        outcome: 'UNKNOWN',
        stage: 'precheck',
        detail: 'no attempt ran',
      };
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const result = await this.attempt(channel, voucher, entry, recipient);
        last = {
          ...result,
          attempt,
          elapsedMs: Date.now() - started,
          channel: channel.address,
        };
        if (!retryable(last)) return last;
        // The network took nothing, so read the sequence number again before
        // the service builds the next attempt.
        await channel.load();
      }
      return last;
    } finally {
      this.pool.release(channel);
    }
  }

  /** One build, one simulation and one submission. */
  private async attempt(
    channel: Channel,
    voucher: DecodedVoucher,
    entry: xdr.SorobanAuthorizationEntry,
    recipient: string,
  ): Promise<RedeemResult> {
    const raw = new TransactionBuilder(channel.next(), {
      fee: INCLUSION_FEE_STROOPS.toString(),
      networkPassphrase: this.config.voucher.network,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.config.voucher.contractId,
          function: REDEEM_FUNCTION,
          args: redeemArgs(voucher, recipient),
          auth: [entry],
        }),
      )
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();

    // Enforcing mode: the entry travels with the transaction, so the host
    // checks the signature, the expiration ledger and the nonce during
    // simulation. A voucher that is already spent fails here and costs nothing.
    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.server.simulateTransaction(raw);
    } catch (caught) {
      return this.failed('simulate', errorText(caught), null);
    }
    if (rpc.Api.isSimulationError(simulation)) {
      return this.failed('simulate', simulation.error, simulation.events);
    }

    const prepared = rpc.assembleTransaction(raw, simulation).build();
    const declaredFeeStroops = BigInt(prepared.fee);
    if (declaredFeeStroops > MAX_FEE_STROOPS) {
      return {
        ...EMPTY,
        outcome: 'FEE_ABOVE_CEILING',
        stage: 'simulate',
        declaredFeeStroops: declaredFeeStroops.toString(),
        detail:
          `simulation declared ${declaredFeeStroops} stroops and the service pays ` +
          `at most ${MAX_FEE_STROOPS}. The call asks for more resources than a ` +
          `redeem needs.`,
      };
    }
    prepared.sign(channel.keypair);
    return this.submit(prepared, declaredFeeStroops.toString());
  }

  /** Send one prepared transaction, and wait for the ledger to judge it. */
  private async submit(
    prepared: Transaction,
    declaredFeeStroops: string,
  ): Promise<RedeemResult> {
    let sent: rpc.Api.SendTransactionResponse;
    try {
      sent = await this.server.sendTransaction(prepared);
    } catch (caught) {
      return { ...this.failed('send', errorText(caught), null), declaredFeeStroops };
    }
    if (sent.status === 'ERROR') {
      const resultCode = resultCodeOf(sent.errorResult);
      const detail = resultCode ?? sent.status;
      return {
        ...this.failed('send', detail, null),
        hash: sent.hash,
        resultCode,
        declaredFeeStroops,
      };
    }

    let applied: rpc.Api.GetTransactionResponse;
    try {
      applied = await this.server.pollTransaction(sent.hash, {
        attempts: POLL_ATTEMPTS,
        sleepStrategy: () => POLL_INTERVAL_MS,
      });
    } catch (caught) {
      return {
        ...EMPTY,
        outcome: 'TIMEOUT',
        stage: 'poll',
        hash: sent.hash,
        declaredFeeStroops,
        detail: errorText(caught),
      };
    }
    if (applied.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return {
        ...EMPTY,
        outcome: 'TIMEOUT',
        stage: 'poll',
        hash: sent.hash,
        declaredFeeStroops,
        detail: 'the transaction reached no ledger inside the poll window',
      };
    }

    const base = {
      ...EMPTY,
      stage: 'apply' as const,
      hash: sent.hash,
      ledger: applied.ledger,
      declaredFeeStroops,
      feeChargedStroops: applied.resultXdr.feeCharged().toString(),
      resultCode: resultCodeOf(applied.resultXdr),
      operationResultCode: operationResultCodeOf(applied.resultXdr),
    };
    if (applied.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { ...base, outcome: 'SUCCESS', detail: '' };
    }
    const detail = base.resultCode ?? applied.status;
    return {
      ...base,
      ...this.classified(detail, applied.diagnosticEventsXdr ?? null),
      detail,
    };
  }

  /** One failure, classified, with no stage-specific field filled. */
  private failed(
    stage: Stage,
    detail: string,
    events: readonly xdr.DiagnosticEvent[] | null,
  ): RedeemResult {
    return { ...EMPTY, ...this.classified(detail, events), stage, detail };
  }

  private classified(
    detail: string,
    events: readonly xdr.DiagnosticEvent[] | null,
  ): Classification {
    return classify(detail, events, this.config.voucher.tokenId);
  }
}
