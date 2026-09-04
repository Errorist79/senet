import { Account, Keypair, rpc } from '@stellar/stellar-sdk';
import { BALANCE_CACHE_MS } from './constants.js';
import { accountBalanceStroops } from './horizon.js';

/**
 * One transaction source that holds its own sequence number.
 *
 * Stellar raises the sequence number of the source account by one for each
 * transaction, so one account serves one transaction per ledger. Each channel
 * is one independent sequence pool, and the pool size sets the throughput.
 * See https://developers.stellar.org/docs/build/guides/transactions/channel-accounts
 */
export class Channel {
  private account: Account | null = null;

  private balanceStroops: bigint | null = null;

  private balanceReadAt = 0;

  constructor(
    readonly keypair: Keypair,
    private readonly server: rpc.Server,
    private readonly horizonUrl: string,
  ) {}

  get address(): string {
    return this.keypair.publicKey();
  }

  /** Read the sequence number from the network. */
  async load(): Promise<void> {
    this.account = await this.server.getAccount(this.address);
  }

  /** Read the balance, and reuse a recent reading. This never throws. */
  async balance(): Promise<bigint | null> {
    if (this.balanceStroops !== null && Date.now() - this.balanceReadAt < BALANCE_CACHE_MS) {
      return this.balanceStroops;
    }
    try {
      this.balanceStroops = await accountBalanceStroops(this.horizonUrl, this.address);
      this.balanceReadAt = Date.now();
    } catch {
      // A failed reading must not stop a redeem. The network still judges the
      // transaction, and the floor check treats an unknown balance as funded.
    }
    return this.balanceStroops;
  }

  /**
   * A copy of the account, so that the builder does not move the sequence
   * number that this channel holds.
   */
  next(): Account {
    const account = this.account;
    if (account === null) {
      throw new Error(`channel ${this.address} did not read its sequence number`);
    }
    const copy = new Account(account.accountId(), account.sequenceNumber());
    account.incrementSequenceNumber();
    return copy;
  }
}

/**
 * The channel accounts, and the rule that one caller holds one channel.
 *
 * The nonce and the sequence number are two separate single-use resources. Two
 * callers that hold one channel at once produce a bad sequence number, and the
 * failure looks like a protocol failure. This pool is the rule that prevents
 * it inside one process.
 */
export class ChannelPool {
  private readonly busy = new Set<string>();

  constructor(private readonly channels: readonly Channel[]) {
    if (channels.length === 0) {
      throw new Error('a fee-payer needs at least one channel account');
    }
  }

  get size(): number {
    return this.channels.length;
  }

  get busyCount(): number {
    return this.busy.size;
  }

  get all(): readonly Channel[] {
    return this.channels;
  }

  /**
   * Take a free channel, or nothing when every channel is in use.
   *
   * The pool refuses new work rather than queueing it. A caller that waits
   * cannot tell a slow network from a full pool, and a refusal says which one
   * it is.
   */
  acquire(): Channel | null {
    const free = this.channels.find((channel) => !this.busy.has(channel.address));
    if (free === undefined) return null;
    this.busy.add(free.address);
    return free;
  }

  release(channel: Channel): void {
    this.busy.delete(channel.address);
  }
}
