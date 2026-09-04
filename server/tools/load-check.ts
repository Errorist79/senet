/**
 * Drive the fee-payer against testnet and record what happened.
 *
 * The check mints one voucher per redemption, runs a sequential batch and then
 * a concurrent batch, and writes every outcome to a file. It reads the payer
 * key and the recipient from the environment, so no key appears here.
 *
 * Run it on the host that holds the keys:
 *   ENV_FILE=/path/to/.env npm run load-check --workspace @senet/server
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { rpc, xdr } from '@stellar/stellar-sdk';
import { LIFETIMES, ed25519Signer, randomNonce, randomVoucherId, signVoucher } from '@senet/core';
import type { Voucher } from '@senet/core';
import { FeePayer, loadEnvFile, readConfig } from '../src/index.js';
import type { RedeemResult, ServerConfig } from '../src/index.js';

/** Redemptions that run one after another. */
const SEQUENTIAL_COUNT = 20;

/** Redemptions that run at the same time. */
const CONCURRENT_COUNT = 5;

/** The amount of each voucher, in stroops. One tenth of an XLM. */
const AMOUNT_STROOPS = 1_000_000n;

/** The lifetime of each voucher. The check finishes long before it passes. */
const LIFETIME_LEDGERS = LIFETIMES['15m'];

/** Read a variable that the check cannot run without. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set, and the load check needs it`);
  }
  return value;
}

/** Mint one voucher and sign it, as a payer with no network would. */
async function mint(
  config: ServerConfig,
  payerSecret: string,
  payer: string,
  expireAt: number,
): Promise<{ voucher: Voucher; entryXdr: string }> {
  const voucher: Voucher = {
    payer,
    amount: AMOUNT_STROOPS,
    voucherId: randomVoucherId(),
    expireAt,
  };
  const entry = await signVoucher(
    config.voucher,
    voucher,
    randomNonce(),
    ed25519Signer(config.voucher, payerSecret),
  );
  return { voucher, entryXdr: entry.toXDR('base64') };
}

/** One redemption, as the record file holds it. */
interface Attempt {
  readonly batch: 'sequential' | 'concurrent';
  readonly index: number;
  readonly voucherId: string;
  readonly outcome: string;
  readonly hash: string | null;
  readonly ledger: number | null;
  readonly channel: string | null;
  readonly attempt: number;
  readonly elapsedMs: number;
  readonly declaredFeeStroops: string | null;
  readonly feeChargedStroops: string | null;
  readonly detail: string;
}

function record(
  batch: Attempt['batch'],
  index: number,
  voucher: Voucher,
  result: RedeemResult,
): Attempt {
  return {
    batch,
    index,
    voucherId: voucher.voucherId.toString(),
    outcome: result.outcome,
    hash: result.hash,
    ledger: result.ledger,
    channel: result.channel,
    attempt: result.attempt,
    elapsedMs: result.elapsedMs,
    declaredFeeStroops: result.declaredFeeStroops,
    feeChargedStroops: result.feeChargedStroops,
    detail: result.detail,
  };
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = readConfig();
  const payerSecret = required('PAYER_SECRET');
  const payer = required('PAYER_PUBLIC');
  const recipient = required('RECIPIENT');
  const outPath = process.argv[2] ?? resolve(process.cwd(), 'load-check.json');

  const server = new rpc.Server(config.rpcUrl);
  const feePayer = await new FeePayer(config).start();
  const latest = await server.getLatestLedger();
  const expireAt = latest.sequence + LIFETIME_LEDGERS;

  console.log(`contract   ${config.voucher.contractId}`);
  console.log(`channels   ${feePayer.addresses.length}`);
  console.log(`ledger     ${latest.sequence}, expire_at ${expireAt}`);

  const records: Attempt[] = [];

  const sequential = await Promise.all(
    Array.from({ length: SEQUENTIAL_COUNT }, () =>
      mint(config, payerSecret, payer, expireAt),
    ),
  );
  for (const [index, minted] of sequential.entries()) {
    const result = await feePayer.redeem(
      xdr.SorobanAuthorizationEntry.fromXDR(minted.entryXdr, 'base64'),
      recipient,
    );
    records.push(record('sequential', index, minted.voucher, result));
    console.log(`sequential ${index + 1}/${SEQUENTIAL_COUNT} ${result.outcome} ${result.hash ?? ''}`);
  }

  const concurrent = await Promise.all(
    Array.from({ length: CONCURRENT_COUNT }, () => mint(config, payerSecret, payer, expireAt)),
  );
  const results = await Promise.all(
    concurrent.map((minted) =>
      feePayer.redeem(
        xdr.SorobanAuthorizationEntry.fromXDR(minted.entryXdr, 'base64'),
        recipient,
      ),
    ),
  );
  for (const [index, result] of results.entries()) {
    const minted = concurrent[index];
    if (minted === undefined) continue;
    records.push(record('concurrent', index, minted.voucher, result));
    console.log(`concurrent ${index + 1}/${CONCURRENT_COUNT} ${result.outcome} ${result.hash ?? ''}`);
  }

  const succeeded = records.filter((entry) => entry.outcome === 'SUCCESS').length;
  const summary = {
    ranAt: new Date().toISOString(),
    contractId: config.voucher.contractId,
    network: config.voucher.network,
    channels: feePayer.addresses,
    sequential: SEQUENTIAL_COUNT,
    concurrent: CONCURRENT_COUNT,
    succeeded,
    records,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`${succeeded} of ${records.length} redemptions succeeded`);
  console.log(`record written to ${outPath}`);
  if (succeeded !== records.length) process.exitCode = 1;
}

await main();
