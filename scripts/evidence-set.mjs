// The evidence trees, and the readers that a producer needs.
//
// The archive format and the step that writes it live in `@senet/evidence`, so
// that every writer holds one definition of a row. This file carries what only
// the commands under `scripts/` use. That is the path of each tree, the reader
// of `.env`, and three readers that decode a transaction.
//
// Two trees carry the same format. `scripts/out/evidence/` holds the proof
// rows, one row for one property. `scripts/out/load-check/` holds a run that
// measures throughput and fee across many redemptions.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import { TESTNET_HORIZON_URL, TESTNET_RPC_URL, readArchivedRow } from '@senet/evidence';

export {
  archiveManifest, archiveRow, readArchivedRow, readManifest, writeManifest,
} from '@senet/evidence';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = path.join(ROOT, 'scripts', 'out');
export const EVIDENCE_DIR = path.join(OUT_DIR, 'evidence');
export const LOAD_CHECK_DIR = path.join(OUT_DIR, 'load-check');
export const APP_CHECK_DIR = path.join(OUT_DIR, 'app-check');
export const RPC_URL = process.env.RPC_URL ?? TESTNET_RPC_URL;
export const HORIZON_URL = process.env.HORIZON_URL ?? TESTNET_HORIZON_URL;

/** The endpoints that the archive step reads a transaction from. */
export const ENDPOINTS = Object.freeze({ rpcUrl: RPC_URL, horizonUrl: HORIZON_URL });

/**
 * Read `.env` at the root of the repository into the process environment.
 *
 * A value that the environment already carries wins. A caller therefore
 * overrides one value and leaves the file alone.
 */
export function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

/** Read a variable that a command cannot run without. */
export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is absent from the environment and from .env`);
  return value;
}

async function rpcTransaction(hash) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: { hash } }),
  });
  if (!response.ok) throw new Error(`the RPC server answered ${response.status} for ${hash}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`the RPC server refused ${hash}: ${payload.error.message}`);
  return payload.result ?? {};
}

/**
 * The reasons that the network recorded for a refused transaction.
 *
 * A refusal is only evidence when it names its cause. This function reads the
 * diagnostic events of a transaction. It returns the text of each error, so a
 * caller checks the cause and not the status alone.
 */
export async function refusalReasons(hash) {
  const result = await rpcTransaction(hash);
  const reasons = [];
  for (const encoded of result.diagnosticEventsXdr ?? []) {
    const body = xdr.DiagnosticEvent.fromXDR(encoded, 'base64').event().body().v0();
    const topics = body.topics().map((topic) => {
      try {
        return String(scValToNative(topic));
      } catch {
        return '';
      }
    });
    if (!topics.includes('error')) continue;
    try {
      reasons.push(JSON.stringify(scValToNative(body.data())));
    } catch {
      reasons.push('');
    }
  }
  return reasons;
}

/**
 * The signature scheme that an authorization entry carries.
 *
 * Two shapes appear on chain, and both come from real transactions. An
 * account that holds a key signs with a list of one map that carries
 * `public_key` and `signature`. A smart account signs with a list of one map
 * whose key names the curve, and a passkey names `Secp256r1` there.
 */
function signatureScheme(signature) {
  let decoded;
  try {
    decoded = scValToNative(signature);
  } catch {
    return 'unknown';
  }
  const text = JSON.stringify(decoded, (key, value) =>
    (typeof value === 'bigint' ? value.toString() : value)) ?? '';
  if (text.includes('Secp256r1')) return 'secp256r1';
  if (text.includes('public_key') || text.includes('Ed25519')) return 'ed25519';
  return 'unknown';
}

/**
 * Read the contract that a transaction invoked, and how the payer signed it.
 *
 * A row that no script can produce still has to state which contract it proves
 * and which signature it carries. This function reads both from the chain, so
 * nobody writes either value by hand and nobody has to keep it correct.
 */
export async function describeTransaction(hash) {
  const result = await rpcTransaction(hash);
  if (!result.envelopeXdr) return null;
  const transaction = xdr.TransactionEnvelope.fromXDR(result.envelopeXdr, 'base64').v1().tx();
  const operation = transaction.operations()[0].body().invokeHostFunctionOp();
  const invoked = operation.hostFunction().invokeContract().contractAddress();
  const credentials = operation.auth()[0].credentials();
  const addressCredentials = credentials.switch().value === 2
    ? credentials.addressV2()
    : credentials.address();
  return {
    contractId: Address.fromScAddress(invoked).toString(),
    payer: Address.fromScAddress(addressCredentials.address()).toString(),
    credentialType: credentials.switch().value === 2 ? 'ADDRESS_V2' : 'ADDRESS',
    signature: signatureScheme(addressCredentials.signature()),
  };
}

/**
 * Derive the claims of a load check from its archived rows.
 *
 * A summary that states a figure is a label. The same figure, derived from the
 * archived rows, is a fact. This function reads the archive only, so it still
 * works after a testnet reset, when nobody can ask the network again.
 *
 * The channel of a row is the account that submitted it. The Horizon summary
 * carries that account as `source_account`, so no row stores it a second time.
 */
export function deriveLoadClaims(dir, manifest) {
  const batches = { sequential: [], concurrent: [] };
  let successful = 0;
  for (const row of manifest.rows) {
    const archived = readArchivedRow(dir, row.name);
    if (archived.horizon?.successful === true) successful += 1;
    const batch = batches[row.batch];
    if (batch === undefined) throw new Error(`${row.name}: the row names no known batch`);
    batch.push({ ledger: archived.horizon?.ledger, channel: archived.horizon?.source_account });
  }

  const shape = (rows) => ({
    rows: rows.length,
    ledgers: new Set(rows.map((each) => each.ledger)).size,
    channels: new Set(rows.map((each) => each.channel)).size,
    ledger: rows.length > 0 ? rows[0].ledger : null,
  });
  const sequential = shape(batches.sequential);
  const concurrent = shape(batches.concurrent);

  const summary = manifest.summary ?? {};
  const problems = [];
  const expect = (holds, message) => {
    if (!holds) problems.push(message);
  };
  expect(successful === manifest.rows.length,
    `${successful} of ${manifest.rows.length} rows succeeded on chain`);
  expect(successful === summary.succeeded,
    `the summary claims ${summary.succeeded} successes and the archive shows ${successful}`);
  expect(sequential.rows === summary.sequential,
    `the summary claims ${summary.sequential} sequential rows and the archive holds ${sequential.rows}`);
  expect(concurrent.rows === summary.concurrent,
    `the summary claims ${summary.concurrent} concurrent rows and the archive holds ${concurrent.rows}`);
  // One channel serves one transaction per ledger. A sequential batch that
  // reuses one channel must therefore occupy one ledger for each row.
  expect(sequential.channels === 1,
    `the sequential batch used ${sequential.channels} channels, and it must use one`);
  expect(sequential.ledgers === sequential.rows,
    `the sequential batch used ${sequential.ledgers} ledgers for ${sequential.rows} rows`);
  // The concurrent batch carries the throughput claim: one ledger, and one
  // channel for each row inside it.
  expect(concurrent.ledgers === 1,
    `the concurrent batch spread over ${concurrent.ledgers} ledgers, and it must use one`);
  expect(concurrent.channels === concurrent.rows,
    `the concurrent batch used ${concurrent.channels} channels for ${concurrent.rows} rows`);
  expect(concurrent.ledger === summary.concurrentLedger,
    `the summary names ledger ${summary.concurrentLedger} and the archive shows ${concurrent.ledger}`);

  return { derived: { successful, sequential, concurrent }, problems };
}

/** Seven decimal places separate one XLM from one stroop. */
const STROOPS_IN_ONE_XLM = 10_000_000n;

/** The amount that a screen shows for a figure that the chain holds in stroops. */
function stroopsAsXlm(stroops) {
  if (stroops === null || stroops === undefined) return null;
  const value = BigInt(stroops);
  const whole = value / STROOPS_IN_ONE_XLM;
  const fraction = (value % STROOPS_IN_ONE_XLM).toString().padStart(7, '0');
  return `${whole}.${fraction} XLM`;
}

/**
 * Whether a value that a screen shortened still names the same text.
 *
 * A screen shows a long identifier with its middle removed. The check compares
 * the head and the tail that remain.
 */
function namesTheSame(shown, full) {
  const parts = shown.split('\u2026');
  if (parts.length !== 2) return shown === full;
  return full.startsWith(parts[0]) && full.endsWith(parts[1]);
}

/**
 * Compare the figures that a screen showed against the chain.
 *
 * A figure on a screen is a claim about the application, and not a fact about
 * the network. This check turns each one into a fact, or it names the row where
 * the two disagree. It reads the archive alone, so it still works after a
 * testnet reset.
 */
export function deriveShownClaims(dir, manifest) {
  const problems = [];
  let checked = 0;
  for (const row of manifest.rows) {
    const values = row.shown?.values;
    if (values === undefined) continue;
    const archived = readArchivedRow(dir, row.name);
    const horizon = archived.horizon;
    if (horizon === null) {
      problems.push(`${row.name}: Horizon holds nothing to check the screen against`);
      continue;
    }
    const compare = (label, shown, actual) => {
      if (shown === undefined) return;
      checked += 1;
      if (shown !== actual) {
        problems.push(`${row.name}: the screen showed ${label} as ${shown}, and the chain says ${actual}`);
      }
    };
    compare('the ledger', values.Ledger, String(horizon.ledger));
    compare('the fee', values['Fee charged'], stroopsAsXlm(horizon.fee_charged));
    compare('the outcome', values.Outcome, horizon.successful ? 'SUCCESS' : 'FAILED');
    const transaction = values.Transaction;
    if (transaction !== undefined) {
      checked += 1;
      if (!namesTheSame(transaction, row.hash)) {
        problems.push(`${row.name}: the screen showed the transaction as ${transaction}, and the row cites ${row.hash}`);
      }
    }
  }
  return { checked, problems };
}
