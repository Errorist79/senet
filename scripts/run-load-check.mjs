// Drive the fee-payer service against testnet, then archive what happened.
//
// The check answers two questions that one redemption cannot answer. How much
// does a redemption cost in steady state, and how many redemptions fit in one
// ledger. It mints one voucher for each redemption, runs a sequential batch and
// then a concurrent batch, and archives every transaction.
//
// Run it with `node scripts/run-load-check.mjs`.
//
// The throughput rule is that one channel account serves one transaction per
// ledger, so the pool size sets the throughput. The two batches show both sides
// of that rule. The sequential batch reuses one channel and therefore occupies
// one ledger for each redemption. The concurrent batch uses one channel for
// each redemption and therefore fits them all into one ledger.
//
// The summary states those figures, and `deriveLoadClaims` derives the same
// figures from the archived rows. A figure that a summary states is a label. The
// same figure, derived from the archive, is a fact. The command refuses to
// finish when the two disagree.

import { Keypair, rpc } from '@stellar/stellar-sdk';
import { LIFETIMES, ed25519Signer, randomNonce, randomVoucherId, signVoucher } from '@senet/core';
import { FeePayer, readConfig } from '@senet/server';
import {
  ENDPOINTS, LOAD_CHECK_DIR, archiveManifest, deriveLoadClaims, loadEnv, requireEnv, writeManifest,
} from './evidence-set.mjs';

/** Redemptions that run one after another, through one channel. */
const SEQUENTIAL_COUNT = 20;
/** Redemptions that run at the same time, through one channel each. */
const CONCURRENT_COUNT = 5;
/** The value of each voucher in stroops, which is 0.1 XLM. */
const AMOUNT_STROOPS = 1_000_000n;
/** The lifetime of each voucher. The run finishes long before it passes. */
const LIFETIME_LEDGERS = LIFETIMES['15m'];

function label(batch, index, total) {
  const width = String(total).length;
  return `${batch}-${String(index + 1).padStart(width, '0')}`;
}

/**
 * Every row that this command produces.
 *
 * Derived from the same counts and the same naming that the run itself uses, so
 * a change to either reaches the list without anybody remembering to edit it.
 */
export const PRODUCED_ROWS = Object.freeze([
  ...Array.from({ length: SEQUENTIAL_COUNT }, (_, i) => label('sequential', i, SEQUENTIAL_COUNT)),
  ...Array.from({ length: CONCURRENT_COUNT }, (_, i) => label('concurrent', i, CONCURRENT_COUNT)),
]);

// Answer what this command produces before it reads a key or opens a socket.
// A reader who has cloned the repository and set nothing up still gets an
// answer, which is the whole point of asking.
if (process.argv.includes('--list')) {
  for (const name of PRODUCED_ROWS) console.log(name);
  process.exit(0);
}

loadEnv();
const config = readConfig();
const payer = Keypair.fromSecret(requireEnv('PAYER_SECRET'));
// A merchant receives an amount and signs nothing, so it is an address.
const recipient = requireEnv('MERCHANT_ADDRESS');
const signPayer = ed25519Signer(config.voucher, payer.secret());

/** Mint and sign one voucher, as a payer with no network does. */
async function mint(expireAt) {
  const voucher = {
    payer: payer.publicKey(),
    amount: AMOUNT_STROOPS,
    voucherId: randomVoucherId(),
    expireAt,
  };
  return signVoucher(config.voucher, voucher, randomNonce(), signPayer);
}

/** What each batch of the run shows, as the row of every member states it. */
const BATCH_NOTES = {
  sequential: 'One of twenty redemptions that run one after another. They reuse one channel account, so they occupy one ledger each.',
  concurrent: 'One of five redemptions that run at the same time. They use one channel account each, so one ledger carries all five.',
};

/**
 * The row that the manifest keeps for one redemption.
 *
 * The row holds what the chain cannot say: which batch the redemption belonged
 * to, which attempt produced it, and how long the client waited. The ledger,
 * the channel and the fee stay out of the row, because the archived Horizon
 * summary already carries all three. A second copy beside the chain is a copy
 * that can disagree with it.
 */
function row(name, batch, result) {
  return {
    name,
    hash: result.hash,
    note: BATCH_NOTES[batch],
    producer: 'script',
    batch,
    attempt: result.attempt,
    elapsedMs: result.elapsedMs,
  };
}


const server = new rpc.Server(config.rpcUrl);
const feePayer = await new FeePayer(config).start();
const latest = await server.getLatestLedger();
const expireAt = latest.sequence + LIFETIME_LEDGERS;

console.log(`contract   ${config.voucher.contractId}`);
console.log(`channels   ${feePayer.addresses.length}`);
console.log(`ledger     ${latest.sequence}, expire_at ${expireAt}\n`);

const rows = [];

// The sequential batch. Each redemption waits for the one before it, so the
// service returns to the same free channel every time.
const sequentialEntries = await Promise.all(
  Array.from({ length: SEQUENTIAL_COUNT }, () => mint(expireAt)),
);
for (const [index, entry] of sequentialEntries.entries()) {
  const result = await feePayer.redeem(entry, recipient);
  if (result.outcome !== 'SUCCESS') {
    throw new Error(`sequential ${index + 1}: the service returned ${result.outcome}`);
  }
  const name = label('sequential', index, SEQUENTIAL_COUNT);
  rows.push(row(name, 'sequential', result));
  console.log(`${name.padEnd(14)} ${result.outcome} ${result.hash}`);
}

// The concurrent batch. Every redemption starts before any of them finishes, so
// the service hands each one a different channel.
const concurrentEntries = await Promise.all(
  Array.from({ length: CONCURRENT_COUNT }, () => mint(expireAt)),
);
const concurrentResults = await Promise.all(
  concurrentEntries.map((entry) => feePayer.redeem(entry, recipient)),
);
for (const [index, result] of concurrentResults.entries()) {
  if (result.outcome !== 'SUCCESS') {
    throw new Error(`concurrent ${index + 1}: the service returned ${result.outcome}`);
  }
  const name = label('concurrent', index, CONCURRENT_COUNT);
  rows.push(row(name, 'concurrent', result));
  console.log(`${name.padEnd(14)} ${result.outcome} ${result.hash}`);
}

const concurrentLedgers = new Set(concurrentResults.map((result) => result.ledger));
const manifest = {
  network: config.voucher.network,
  contractId: config.voucher.contractId,
  producedAt: new Date().toISOString(),
  producedBy: 'scripts/run-load-check.mjs',
  summary: {
    sequential: SEQUENTIAL_COUNT,
    concurrent: CONCURRENT_COUNT,
    succeeded: rows.length,
    channelCount: feePayer.addresses.length,
    concurrentLedger: concurrentLedgers.size === 1 ? [...concurrentLedgers][0] : null,
  },
  rows,
};
writeManifest(LOAD_CHECK_DIR, manifest);

console.log('\narchiving');
const incomplete = await archiveManifest(LOAD_CHECK_DIR, manifest, ENDPOINTS);
if (incomplete > 0) {
  throw new Error(`${incomplete} row(s) carry no meta, so the archive is not durable`);
}

const { derived, problems } = deriveLoadClaims(LOAD_CHECK_DIR, manifest);
console.log('\nderived from the archive');
console.log(`  ${derived.successful} of ${manifest.rows.length} rows succeeded`);
console.log(`  sequential: ${derived.sequential.rows} rows, `
  + `${derived.sequential.ledgers} ledgers, ${derived.sequential.channels} channel`);
console.log(`  concurrent: ${derived.concurrent.rows} rows, `
  + `ledger ${derived.concurrent.ledger}, ${derived.concurrent.channels} channels`);
if (problems.length > 0) {
  for (const problem of problems) console.log(`  PROBLEM: ${problem}`);
  throw new Error('the archive does not support the summary');
}
console.log('\nthe archive supports every figure in the summary');
