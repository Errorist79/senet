// Produce the evidence set on testnet, then archive it.
//
// One command re-runs every transaction that the repository cites. It writes
// the envelope, the result, the meta and the diagnostic events of each one.
// The files go into `scripts/out/evidence/`.
//
// Run it with `node scripts/run-evidence.mjs`.
//
// The command needs four funded testnet accounts and the contract identifier,
// which it reads from `.env`. `.env.example` names every value.
//
// A refusal must land on chain, so that it becomes a public hash rather than a
// console line. Simulation of a refused voucher fails, and a client that trusts
// simulation therefore never submits it. This command declares the resource
// footprint itself for a refused row. That footprint always comes from a
// simulation of the same voucher under the same nonce. The reason is that the
// nonce of the entry is one of the ledger keys inside the footprint. A
// footprint from another voucher makes the network refuse the row for a missing
// key, which is not the refusal that the row must show.
//
// Every refused row therefore also checks the reason that the network recorded,
// and not the failed status alone.

import fs from 'node:fs';
import path from 'node:path';
import { Keypair, Networks, Operation, TransactionBuilder, rpc } from '@stellar/stellar-sdk';
import {
  LIFETIMES, ed25519Signer, nativeTokenId, randomNonce, randomVoucherId,
  readVoucher, redeemArgs, signVoucher, TX_TIMEOUT_SECONDS,
} from '@senet/core';
import {
  ROOT, RPC_URL, archiveManifest, describeTransaction, refusalReasons, writeManifest,
} from './evidence-set.mjs';

/** The value of one voucher in stroops, which is 0.5 XLM. */
const AMOUNT_STROOPS = 5_000_000n;
/** The fee that a submitter bids above the resource fee, in stroops. */
const FEE_MARGIN_STROOPS = 500_000n;
/** The inclusion fee of a transaction that simulation prepares, in stroops. */
const INCLUSION_FEE_STROOPS = '200000';
/** The reason that the network gives when a party reuses a consumed nonce. */
const REASON_NONCE_CONSUMED = 'nonce already exists for address';
/** The reason that the network gives when the signature of an entry is old. */
const REASON_SIGNATURE_EXPIRED = 'signature has expired';

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is absent from the environment and from .env`);
  return value;
}

loadEnv();

const server = new rpc.Server(RPC_URL);
const contractId = requireEnv('CONTRACT_ID');
const config = {
  network: Networks.TESTNET,
  contractId,
  tokenId: nativeTokenId(Networks.TESTNET),
};

/** The payer, who signs every voucher. */
const payer = Keypair.fromSecret(requireEnv('A_SECRET'));
/** The submitter, who pays the network fee and selects the recipient. */
const submitter = Keypair.fromSecret(requireEnv('B_SECRET'));
/** The first recipient, who stands for a merchant. */
const merchant = Keypair.fromSecret(requireEnv('C_SECRET'));
/** The second recipient, who receives a refused attempt. */
const otherMerchant = Keypair.fromSecret(requireEnv('D_SECRET'));

const signPayer = ed25519Signer(config, payer.secret());

/** Build the voucher terms for a lifetime, against the current ledger. */
async function terms(lifetimeLedgers) {
  const latest = await server.getLatestLedger();
  return {
    payer: payer.publicKey(),
    amount: AMOUNT_STROOPS,
    voucherId: randomVoucherId(),
    expireAt: latest.sequence + lifetimeLedgers,
  };
}

/** Sign a voucher. The library makes no network call on this path. */
function mint(voucher, nonce) {
  return signVoucher(config, voucher, nonce, signPayer);
}

/** Build the redeem transaction that a submitter assembles. */
async function redeemTransaction(voucher, recipient, entry, options = {}) {
  const account = await server.getAccount(submitter.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: options.fee ?? INCLUSION_FEE_STROOPS,
    networkPassphrase: config.network,
  })
    .addOperation(Operation.invokeContractFunction({
      contract: config.contractId,
      function: 'redeem',
      args: redeemArgs(voucher, recipient),
      auth: [entry],
    }))
    .setTimeout(TX_TIMEOUT_SECONDS);
  if (options.sorobanData) builder.setSorobanData(options.sorobanData);
  return builder.build();
}

async function send(transaction, label) {
  const sent = await server.sendTransaction(transaction);
  if (sent.status === 'ERROR') {
    throw new Error(`${label}: the network refused the transaction before apply`);
  }
  const settled = await server.pollTransaction(sent.hash, {
    attempts: 30,
    sleepStrategy: () => 1000,
  });
  return { hash: sent.hash, status: settled.status };
}

/** Simulate a voucher and return the prepared transaction with its resources. */
async function prepare(voucher, recipient, entry, label) {
  const raw = await redeemTransaction(voucher, recipient, entry);
  const simulation = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`${label}: simulation refused this voucher: ${simulation.error}`);
  }
  const sorobanData = simulation.transactionData.build();
  return {
    prepared: rpc.assembleTransaction(raw, simulation).build(),
    resources: { sorobanData, resourceFee: sorobanData.resourceFee().toString() },
  };
}

/**
 * Submit a voucher that simulation accepts.
 *
 * `assembleTransaction` keeps an authorization entry that the caller supplied,
 * so the bytes that the payer signed reach the network unchanged. The check
 * below holds that behaviour in place.
 *
 * The call also returns the resources, because a later row that must fail needs
 * the footprint of this same voucher under this same nonce.
 */
async function submitAccepted(voucher, recipient, entry, label) {
  const { prepared, resources } = await prepare(voucher, recipient, entry, label);
  const assembled = prepared.operations[0].auth[0];
  if (assembled.toXDR('base64') !== entry.toXDR('base64')) {
    throw new Error(`${label}: assembly changed the entry that the payer signed`);
  }
  // The invariants of the library run again on the assembled entry. A
  // regression in the SDK therefore cannot reach the network in silence.
  readVoucher(config, assembled);
  prepared.sign(submitter);
  const outcome = await send(prepared, label);
  if (outcome.status !== 'SUCCESS') {
    throw new Error(`${label}: the network refused a voucher that must succeed`);
  }
  return { ...outcome, resources };
}

/** Submit a voucher that the network must refuse for a stated reason. */
async function submitRefused(voucher, recipient, entry, resources, reason, label) {
  const raw = await redeemTransaction(voucher, recipient, entry, {
    fee: (BigInt(resources.resourceFee) + FEE_MARGIN_STROOPS).toString(),
    sorobanData: resources.sorobanData,
  });
  raw.sign(submitter);
  const outcome = await send(raw, label);
  if (outcome.status !== 'FAILED') {
    throw new Error(`${label}: the network accepted a voucher that it must refuse`);
  }
  const reasons = await refusalReasons(outcome.hash);
  if (!reasons.some((text) => text.includes(reason))) {
    throw new Error(`${label}: the network refused this row, but not for "${reason}"`);
  }
  return outcome;
}

const rows = [];
function record(name, outcome, note) {
  rows.push({ name, hash: outcome.hash, note });
  console.log(`${name.padEnd(34)} ${outcome.status.padEnd(8)} ${outcome.hash}`);
}

console.log(`contract ${contractId}`);
console.log(`payer ${payer.publicKey()}`);
console.log(`submitter ${submitter.publicKey()}\n`);

// The core case. The payer signs, a second account submits, and the submitter
// selects the recipient after the signature exists.
const main = await terms(LIFETIMES['15m']);
const mainEntry = await mint(main, randomNonce());
const mainOutcome = await submitAccepted(main, merchant.publicKey(), mainEntry, '1a');
record(
  '1a-success',
  mainOutcome,
  'One account signs the entry and a second account submits it. The party that submits selects the recipient after the signature exists.',
);

// The same signed bytes again, to a different recipient. The network consumed
// the nonce, so it refuses.
record(
  '1b-double-spend-failed',
  await submitRefused(
    main, otherMerchant.publicKey(), mainEntry, mainOutcome.resources,
    REASON_NONCE_CONSUMED, '1b',
  ),
  'The network refuses a second submission of the same signed entry, because it consumed the nonce.',
);

// A signature whose expiration ledger is in the past. The network checks that
// field before it runs contract code. The footprint comes from a twin voucher
// that carries the same nonce and a lifetime that is still valid.
const expiredNonce = randomNonce();
const expiredTerms = await terms(LIFETIMES['15m']);
const twinEntry = await mint(expiredTerms, expiredNonce);
const { resources: expiredResources } =
  await prepare(expiredTerms, merchant.publicKey(), twinEntry, '1c-footprint');
const latest = await server.getLatestLedger();
const expired = { ...expiredTerms, expireAt: latest.sequence - 1 };
const expiredEntry = await mint(expired, expiredNonce);
record(
  '1c-expired-host-signature-failed',
  await submitRefused(
    expired, merchant.publicKey(), expiredEntry, expiredResources,
    REASON_SIGNATURE_EXPIRED, '1c',
  ),
  'The network refuses an entry whose signature expiration ledger is in the past.',
);

// The void. The payer redeems the voucher to their own address, which consumes
// the nonce and returns the amount.
const voided = await terms(LIFETIMES['15m']);
const voidEntry = await mint(voided, randomNonce());
const voidOutcome = await submitAccepted(voided, payer.publicKey(), voidEntry, '8-void');
record(
  '8-void-success',
  voidOutcome,
  'The payer voids the voucher and redeems it to their own address. The nonce is consumed and the balance does not change.',
);
record(
  '8-after-void-failed',
  await submitRefused(
    voided, merchant.publicKey(), voidEntry, voidOutcome.resources,
    REASON_NONCE_CONSUMED, '8-after',
  ),
  'The network refuses a redemption of a voucher that the payer voided.',
);

// A voucher that the payer builds with no network access. `fetch` throws for
// the whole block, so a hidden request fails the run rather than the claim.
const offline = await terms(LIFETIMES['15m']);
const realFetch = globalThis.fetch;
let offlineEntry;
let violation = null;
globalThis.fetch = (...args) => {
  violation = String(args[0]);
  throw new Error(`the payer path reached the network: ${args[0]}`);
};
try {
  offlineEntry = await mint(offline, randomNonce());
} finally {
  globalThis.fetch = realFetch;
}
if (violation) throw new Error(`the payer path reached the network: ${violation}`);
console.log('the payer built and signed one voucher with no network call');
record(
  'task3-handbuilt',
  await submitAccepted(offline, merchant.publicKey(), offlineEntry, 'task3'),
  'A client that never called simulation built this voucher. The redemption succeeds.',
);

/** The text that states what each lifetime row shows. */
const LIFETIME_NOTES = {
  '5m': 'A voucher with a lifetime of 60 ledgers, about 5 minutes.',
  '15m': 'A voucher with a lifetime of 180 ledgers, about 15 minutes. This lifetime is the default.',
  '1h': 'A voucher with a lifetime of 720 ledgers, about 1 hour.',
  '12h': 'A voucher with a lifetime of 8,640 ledgers, about 12 hours. This lifetime equals the cap of the contract.',
};
for (const [name, lifetime] of Object.entries(LIFETIMES)) {
  const voucher = await terms(lifetime);
  const entry = await mint(voucher, randomNonce());
  record(
    `lifetime-${name}`,
    await submitAccepted(voucher, merchant.publicKey(), entry, `lifetime-${name}`),
    LIFETIME_NOTES[name],
  );
}

/**
 * The rows that a passkey produced, which this command keeps as they are.
 *
 * A script cannot produce a WebAuthn signature, because the ceremony needs a
 * person and a device. A person captures such a row, and the only value that
 * a person supplies is the hash. This command reads the rest from the chain.
 *
 * The contract of a kept row therefore comes from the transaction itself, and
 * nobody keeps it correct by hand. A person who captures a fresh redemption
 * replaces the hash. The row then names the current contract, and it needs no
 * other change. The command also proves that the row
 * carries a passkey signature, so a row of another kind cannot enter the set
 * under a passkey name.
 */
async function readKeptRows() {
  const file = path.join(ROOT, 'scripts', 'out', 'evidence', 'manifest.json');
  if (!fs.existsSync(file)) return [];
  const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  const kept = [];
  for (const row of previous.rows.filter((each) => each.name.startsWith('passkey-'))) {
    const described = await describeTransaction(row.hash);
    if (described === null) {
      console.log(`${row.name.padEnd(34)} KEPT     the RPC server no longer holds this row`);
      kept.push(row);
      continue;
    }
    if (described.signature !== 'secp256r1') {
      throw new Error(`${row.name}: this row carries a ${described.signature} signature, not a passkey`);
    }
    const current = described.contractId === contractId ? 'current contract' : 'earlier contract';
    console.log(`${row.name.padEnd(34)} KEPT     ${described.signature}, ${current}`);
    kept.push({ ...row, contractId: described.contractId });
  }
  return kept;
}

const kept = await readKeptRows();
const manifest = {
  network: config.network,
  contractId,
  producedAt: new Date().toISOString(),
  rows: [...rows, ...kept],
};
writeManifest(manifest);

console.log('\narchiving');
const incomplete = await archiveManifest(manifest);
console.log(`\nproduced ${rows.length} rows and kept ${kept.length} passkey rows`);
if (incomplete > 0) {
  console.log(`${incomplete} row(s) carry no meta, because the RPC server dropped them.`);
  process.exitCode = 1;
}
