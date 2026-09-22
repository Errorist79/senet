// Produce fresh transaction evidence on testnet, then archive it.
//
// A full run needs a fresh device redemption and a published SEP-7 key.
// Use --vouchers-only for the contract path with fresh testnet keys.
// Each run writes a new directory and keeps previous archives intact.
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
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Asset, Keypair, Networks, Operation, TransactionBuilder, rpc } from '@stellar/stellar-sdk';
import {
  LIFETIMES, STELLAR_TOML_PATH, buildPayUri, ed25519Signer, nativeTokenId,
  randomNonce, randomVoucherId, readVoucher, redeemArgs, signUri, signVoucher, TX_TIMEOUT_SECONDS,
  verifyUri,
} from '@senet/core';
// The domain that this deployment serves under. A request names it as its
// origin, and a wallet reads the signing key from that domain's file. The
// value must be the one that the deployment declares, and never a second
// copy.
import { RP_ID } from '@senet/server';
import {
  ENDPOINTS, HORIZON_URL, OUT_DIR, ROOT, RPC_URL, archiveRow, describeRedeem, loadEnv,
  publishesTheKey, refusalReasons, requireEnv, writeManifest,
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

/**
 * The lifetimes that this run walks, named here rather than imported.
 *
 * The names below decide four row names, and a listing has to answer from the
 * export alone. An imported value cannot. A package resolves through the
 * installed dependencies, and those point at the working tree. A listing that
 * read this table from the package would report the names on somebody's desk,
 * while the archive beside it came from a commit.
 *
 * The assertion further down holds this equal to the table that it mirrors, so
 * the copy cannot drift into a lie.
 */
const LIFETIME_NAMES = Object.freeze(['5m', '15m', '1h', '12h']);

/**
 * Every script row that a full run produces.
 *
 * The list exists so that a check can ask what the runner would produce, and
 * spend no transaction to find out. It follows the same lifetimes that the run
 * itself walks, so a new lifetime reaches both at once.
 *
 * `record` refuses a name that is not here, which is what keeps the list honest.
 * A declaration that nothing tests is documentation, and documentation drifts
 * from the code silently.
 */
export const PRODUCED_ROWS = Object.freeze([
  '1a-success',
  '1b-double-spend-failed',
  '1c-expired-host-signature-failed',
  '8-void-success',
  '8-after-void-failed',
  'task3-handbuilt',
  ...LIFETIME_NAMES.map((name) => `lifetime-${name}`),
  'sep7-payment',
]);

// Answer what this command produces, and spend nothing doing it. This stands
// above every read of configuration, and above the check below that reads the
// library. A question about what a command produces needs no keys, no network
// and no environment file. A reader who has cloned and set nothing up must
// still get an answer.
//
// It also stands above the library on purpose. The library resolves to built
// output, and a build can be older than the source it came from. A listing
// that read the table below would answer from a stale build. The archive
// beside it comes from a commit, so the two would agree for the wrong reason.
if (process.argv.includes('--list')) {
  for (const name of PRODUCED_ROWS) {
    if (name !== 'sep7-payment' || !process.argv.includes('--vouchers-only')) console.log(name);
  }
  process.exit(0);
}

// This is where the copy of the lifetime names meets its source. A lifetime
// that reaches the library and not the list stops the run, before it spends
// anything. Otherwise the run would quietly produce a row that no listing
// names.
const missing = Object.keys(LIFETIMES).filter((name) => !LIFETIME_NAMES.includes(name));
const extra = LIFETIME_NAMES.filter((name) => !(name in LIFETIMES));
if (missing.length > 0 || extra.length > 0) {
  throw new Error(
    `the lifetimes that this run names and the library's table disagree: `
    + `${missing.join(', ') || 'none'} missing, ${extra.join(', ') || 'none'} unknown`,
  );
}


loadEnv();

const args = process.argv.slice(2);
let vouchersOnly = false;
let deviceHash;
let outputDirectory;
let replayDirectory;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--vouchers-only') vouchersOnly = true;
  else if (argument === '--device-hash' || argument === '--output' || argument === '--replay-output') {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value`);
    if (argument === '--device-hash') deviceHash = value;
    else if (argument === '--replay-output') replayDirectory = path.resolve(value);
    else outputDirectory = value;
  } else throw new Error(`unknown argument: ${argument}`);
}
if (vouchersOnly && deviceHash) throw new Error('--device-hash requires a full run');
if (vouchersOnly && replayDirectory) throw new Error('--replay-output requires a full run');
if (replayDirectory && fs.existsSync(replayDirectory)) throw new Error('Choose a new replay output directory.');
if (!vouchersOnly && !deviceHash) {
  throw new Error('A full run needs --device-hash from a fresh phone redemption. Use --vouchers-only for the contract path.');
}
const evidenceDirectory = outputDirectory
  ? path.resolve(outputDirectory)
  : path.join(vouchersOnly ? tmpdir() : OUT_DIR, `evidence-run-${Date.now()}`);
if (fs.existsSync(evidenceDirectory)) {
  throw new Error(`${evidenceDirectory} already exists. Choose a new output directory to preserve the archive.`);
}

const server = new rpc.Server(RPC_URL);
const contractId = requireEnv('CONTRACT_ID');
const config = {
  network: Networks.TESTNET,
  contractId,
  tokenId: nativeTokenId(Networks.TESTNET),
};

/** The payer, who signs every voucher. */
const payer = Keypair.fromSecret(requireEnv('PAYER_SECRET'));
/** The submitter, who pays the network fee and selects the recipient. */
const submitter = Keypair.fromSecret(requireEnv('SUBMITTER_SECRET'));
// Check the remaining configuration before the first submission.
// A missing SEP-7 key must stop a full run before it spends transaction fees.
// Later failures retain the archive of each confirmed row.
requireEnv('MERCHANT_ADDRESS');
if (!vouchersOnly) requireEnv('SEP7_SIGNING_SECRET');
// A merchant receives an amount and signs nothing, so each merchant here is an
// address and not a secret. Every use below passes the address to the contract
// as the recipient argument.
/** The first recipient, who stands for a merchant. */
const merchant = requireEnv('MERCHANT_ADDRESS');
/** The second recipient, who receives a refused attempt. */
const otherMerchant = requireEnv('SECOND_MERCHANT_ADDRESS');

let deviceRow;
if (!vouchersOnly) {
  if (!/^[0-9a-f]{64}$/.test(deviceHash)) throw new Error('--device-hash needs a transaction hash');
  const described = await describeRedeem(deviceHash);
  const response = await fetch(`${HORIZON_URL}/transactions/${deviceHash}`);
  const horizon = response.ok ? await response.json() : null;
  if (horizon?.successful !== true || described === null || described.signature !== 'secp256r1'
      || described.credentialType !== 'ADDRESS_V2'
      || described.contractId !== contractId || described.redeem === null
      || described.redeem.payer === described.redeem.recipient) {
    throw new Error('The device hash must name a live successful passkey redemption on the configured contract.');
  }
  deviceRow = {
    name: 'passkey-fresh', hash: deviceHash, producer: 'device', contractId,
    note: 'A person supplied this passkey redemption hash. The transaction does not prove which phones created or scanned the code.',
  };
  const signingKey = Keypair.fromSecret(requireEnv('SEP7_SIGNING_SECRET'));
  const published = await publishesTheKey({
    tomlUrl: `https://${RP_ID}${STELLAR_TOML_PATH}`, signingKey: signingKey.publicKey(),
  });
  if (!published.published) throw new Error(`SEP-7 prerequisite failed: ${published.reason}`);
}

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
  const recorded = reasons.find((text) => text.includes(reason));
  if (recorded === undefined) {
    throw new Error(`${label}: the network refused this row, but not for "${reason}"`);
  }
  return { ...outcome, recorded };
}

const rows = [];
const manifest = {
  network: config.network, contractId, producedAt: new Date().toISOString(),
  producedBy: 'scripts/run-evidence.mjs',
  producedArgs: vouchersOnly ? ['--vouchers-only'] : [],
  scope: vouchersOnly ? 'vouchers-only' : 'full-transactions', complete: false, rows,
};

async function saveRow(row) {
  rows.push(row);
  writeManifest(evidenceDirectory, manifest);
  const archived = await archiveRow(evidenceDirectory, row, contractId, ENDPOINTS);
  if (!archived.rpc.envelopeXdr || !archived.rpc.resultXdr || !archived.rpc.resultMetaXdr
      || archived.horizon === null) {
    throw new Error(`${row.name}: the archive lacks RPC or Horizon evidence. The partial manifest stays at ${evidenceDirectory}.`);
  }
}

async function record(name, outcome, note, request) {
  if (!PRODUCED_ROWS.includes(name)) {
    throw new Error(`${name} is recorded but the produced list does not name it`);
  }
  await saveRow({ name, hash: outcome.hash, note, producer: 'script', ...(request ? { request } : {}) });
  console.log(`${name.padEnd(34)} ${outcome.status.padEnd(8)} ${outcome.hash}`);
  // A refusal is only evidence when it names its cause. The run therefore
  // prints the text that the network wrote into the diagnostic events.
  if (outcome.recorded !== undefined) console.log(`  the network recorded ${outcome.recorded}`);
}

/**
 * Produce the payee-presented payment that the evidence promises.
 *
 * The merchant asks and the payer answers, which is the standard direction and
 * the opposite of a voucher. The key that this domain's file publishes signs
 * the request, so a wallet can tell that the domain asked.
 *
 * The payment is a classic payment operation and not a contract call. A
 * different decoder therefore reads the row that it produces, and no other row
 * here needs that decoder.
 */
async function payeePresentedPayment() {
  const signingKey = Keypair.fromSecret(requireEnv('SEP7_SIGNING_SECRET'));
  const merchant = requireEnv('MERCHANT_ADDRESS');
  const amount = stroopsAsAmount(AMOUNT_STROOPS);

  const request = signUri(
    buildPayUri({ destination: merchant, amount, originDomain: RP_ID }),
    signingKey.secret(),
  );
  // Verify first, and pay after. A request that this domain's own key cannot
  // verify is evidence of nothing. A payment before that check would put a
  // transaction on the chain that no row could honestly cite.
  const verified = verifyUri(request, signingKey.publicKey());
  if (!verified.verified) {
    throw new Error(`the request that this domain signed does not verify: ${verified.reason}`);
  }

  const source = await server.getAccount(submitter.publicKey());
  const payment = new TransactionBuilder(source, {
    fee: INCLUSION_FEE_STROOPS,
    networkPassphrase: config.network,
  })
    .addOperation(Operation.payment({ destination: merchant, asset: Asset.native(), amount }))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  payment.sign(submitter);
  const outcome = await send(payment, 'sep7-payment');
  if (outcome.status !== 'SUCCESS') throw new Error('The SEP-7 payment did not succeed.');

  return {
    name: 'sep7-payment',
    hash: outcome.hash,
    status: outcome.status,
    note: 'A merchant published a signed request and a payer answered it. This is '
      + 'the payee-presented direction, which the voucher rows reverse.',
    request: {
      uri: request,
      originDomain: RP_ID,
      signingKey: signingKey.publicKey(),
      tomlUrl: `https://${RP_ID}${STELLAR_TOML_PATH}`,
    },
  };
}

/** Stroops as the decimal amount that a payment operation and a request take. */
function stroopsAsAmount(stroops) {
  const whole = stroops / 10_000_000n;
  const fraction = (stroops % 10_000_000n).toString().padStart(7, '0');
  return `${whole}.${fraction}`;
}

console.log(`contract ${contractId}`);
console.log(`payer ${payer.publicKey()}`);
console.log(`submitter ${submitter.publicKey()}\n`);
console.log(`archive ${evidenceDirectory}`);
if (deviceRow) await saveRow(deviceRow);
if (replayDirectory) {
  const replay = spawnSync(process.execPath, [
    'scripts/replay-voucher.mjs', path.join(evidenceDirectory, 'passkey-fresh.json'), replayDirectory,
  ], { cwd: ROOT, stdio: 'inherit' });
  if (replay.error) throw replay.error;
  if (replay.status !== 0) throw new Error('The device voucher replay failed. The transaction archive remains incomplete.');
}

// The core case. The payer signs, a second account submits, and the submitter
// selects the recipient after the signature exists.
const main = await terms(LIFETIMES['15m']);
const mainEntry = await mint(main, randomNonce());
const mainOutcome = await submitAccepted(main, merchant, mainEntry, '1a');
await record(
  '1a-success',
  mainOutcome,
  'One account signs the entry and a second account submits it. The party that submits selects the recipient after the signature exists.',
);

// The same signed bytes again, to a different recipient. The network consumed
// the nonce, so it refuses.
await record(
  '1b-double-spend-failed',
  await submitRefused(
    main, otherMerchant, mainEntry, mainOutcome.resources,
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
  await prepare(expiredTerms, merchant, twinEntry, '1c-footprint');
const latest = await server.getLatestLedger();
const expired = { ...expiredTerms, expireAt: latest.sequence - 1 };
const expiredEntry = await mint(expired, expiredNonce);
await record(
  '1c-expired-host-signature-failed',
  await submitRefused(
    expired, merchant, expiredEntry, expiredResources,
    REASON_SIGNATURE_EXPIRED, '1c',
  ),
  'The network refuses an entry whose signature expiration ledger is in the past.',
);

// The void. The payer redeems the voucher to their own address, which consumes
// the nonce and returns the amount.
const voided = await terms(LIFETIMES['15m']);
const voidEntry = await mint(voided, randomNonce());
const voidOutcome = await submitAccepted(voided, payer.publicKey(), voidEntry, '8-void');
await record(
  '8-void-success',
  voidOutcome,
  'The payer voids the voucher and redeems it to their own address. The redemption spends the nonce, and the balance does not change.',
);
await record(
  '8-after-void-failed',
  await submitRefused(
    voided, merchant, voidEntry, voidOutcome.resources,
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
await record(
  'task3-handbuilt',
  await submitAccepted(offline, merchant, offlineEntry, 'task3'),
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
  await record(
    `lifetime-${name}`,
    await submitAccepted(voucher, merchant, entry, `lifetime-${name}`),
    LIFETIME_NOTES[name],
  );
}

// The payee-presented payment. It calls no contract, so it runs after every
// voucher row rather than among them.
if (!vouchersOnly) {
  const sep7 = await payeePresentedPayment();
  await record(sep7.name, sep7, sep7.note, sep7.request);
}
manifest.complete = true;
writeManifest(evidenceDirectory, manifest);

console.log(`\narchived ${rows.length} rows in ${evidenceDirectory}`);
console.log('Phone capture, video and feed output require separate device evidence.');
if (vouchersOnly) console.log('The voucher-only run omits passkey and SEP-7 evidence.');
