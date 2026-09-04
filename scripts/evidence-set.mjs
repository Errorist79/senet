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

import { createHash } from 'node:crypto';
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
export const DEVICE_CHECK_DIR = path.join(OUT_DIR, 'device-check');
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
 * Read the terms of a redemption out of the transaction itself.
 *
 * A person who finishes a run on a phone holds a hash and nothing else. Every
 * other value of the voucher sits inside the transaction, so this reader takes
 * them from there and nobody types one of them.
 *
 * The contract takes `redeem(payer, amount, voucher_id, expire_at, recipient)`,
 * so the arguments arrive in that order.
 */
export async function describeRedeem(hash) {
  const described = await describeTransaction(hash);
  if (described === null) return null;
  // A transaction that deploys an account calls no contract function, so the
  // reader asks what kind of host function it carries before it reads one.
  if (described.hostFunction !== 'hostFunctionTypeInvokeContract') {
    return { ...described, functionName: null, redeem: null };
  }
  const result = await rpcTransaction(hash);
  const decoded = redeemFromEnvelope(result.envelopeXdr);
  return { ...described, functionName: decoded.functionName, redeem: decoded.redeem };
}

/**
 * Read the terms of a redemption out of one transaction envelope.
 *
 * A live reader takes the envelope from the RPC server, and a check over the
 * archive takes the same envelope from the archived row. Both decode it here,
 * so a check that runs after the RPC forgets a ledger reads exactly what the
 * live reader read.
 *
 * The contract takes `redeem(payer, amount, voucher_id, expire_at, recipient)`,
 * so the arguments arrive in that order.
 */
export function redeemFromEnvelope(envelopeXdr) {
  if (!envelopeXdr) return { functionName: null, redeem: null };
  const transaction = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64').v1().tx();
  const operation = transaction.operations()[0].body().invokeHostFunctionOp();
  if (operation.hostFunction().switch().name !== 'hostFunctionTypeInvokeContract') {
    return { functionName: null, redeem: null };
  }
  const invocation = operation.hostFunction().invokeContract();
  const functionName = invocation.functionName().toString();
  const args = invocation.args().map((argument) => scValToNative(argument));
  if (functionName !== 'redeem' || args.length !== 5) return { functionName, redeem: null };
  const [payer, amount, voucherId, expireAt, recipient] = args;
  return {
    functionName,
    redeem: {
      payer: String(payer),
      amount: String(amount),
      voucherId: String(voucherId),
      expireAt: Number(expireAt),
      recipient: String(recipient),
    },
  };
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
  const hostFunction = operation.hostFunction().switch().name;
  // A deployment names no contract, because the contract does not exist yet.
  const contractId = hostFunction === 'hostFunctionTypeInvokeContract'
    ? Address.fromScAddress(operation.hostFunction().invokeContract().contractAddress()).toString()
    : null;
  const entry = operation.auth()[0];
  if (entry === undefined) {
    return { hostFunction, contractId, payer: null, credentialType: null, signature: null };
  }
  const credentials = entry.credentials();
  if (credentials.switch().value !== 1 && credentials.switch().value !== 2) {
    return {
      hostFunction, contractId, payer: null,
      credentialType: credentials.switch().name, signature: null,
    };
  }
  const addressCredentials = credentials.switch().value === 2
    ? credentials.addressV2()
    : credentials.address();
  return {
    hostFunction,
    contractId,
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
  const [head, tail] = parts;
  // A head or a tail that is empty matches almost anything, so a value shortened
  // that far proves nothing and the check refuses it.
  if (head.length + tail.length < 8) return false;
  return full.startsWith(head) && full.endsWith(tail);
}

/**
 * Compare the figures that a screen showed against one Horizon summary.
 *
 * The preview of a new row and the check over the whole archive both call this.
 * A person therefore sees the same comparison before a write that the archive
 * applies after it.
 */
export function compareShownToChain(values, horizon, hash) {
  const problems = [];
  let checked = 0;
  if (horizon === null || horizon === undefined) {
    return { checked, problems: ['Horizon holds nothing to check the screen against'] };
  }
  const compare = (label, shown, actual) => {
    if (shown === undefined) return;
    checked += 1;
    if (shown !== actual) {
      problems.push(`the screen showed ${label} as ${shown}, and the chain says ${actual}`);
    }
  };
  compare('the ledger', values.Ledger, String(horizon.ledger));
  compare('the fee', values['Fee charged'], stroopsAsXlm(horizon.fee_charged));
  compare('the outcome', values.Outcome, horizon.successful ? 'SUCCESS' : 'FAILED');
  const transaction = values.Transaction;
  if (transaction !== undefined) {
    checked += 1;
    if (!namesTheSame(transaction, hash)) {
      problems.push(`the screen showed the transaction as ${transaction}, and the row cites ${hash}`);
    }
  }
  return { checked, problems };
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
    const found = compareShownToChain(values, archived.horizon, row.hash);
    checked += found.checked;
    for (const problem of found.problems) problems.push(`${row.name}: ${problem}`);
  }
  return { checked, problems };
}

/**
 * The fields that the listener posts, and the chain value that each must equal.
 *
 * The listener names them, so a change to its message changes this table and
 * nothing else. A field that the message stops sending fails as a missing
 * field rather than passing as an absent one.
 */
const DELIVERED_FIELDS = Object.freeze([
  // A voucher identifier is 64 bits and an amount is 128, and both pass the
  // range that a JSON number holds exactly. The listener sends them as decimal
  // text for that reason, so this check demands the text. A value that arrives
  // as a number compares equal here while it is already corrupt, which is the
  // one failure that a comparison of values alone cannot see.
  ['voucher_id', 'string', (redeem) => redeem.voucherId],
  ['amount', 'string', (redeem) => redeem.amount],
  ['payer', 'any', (redeem) => redeem.payer],
  ['recipient', 'any', (redeem) => redeem.recipient],
  ['expire_at', 'any', (redeem) => String(redeem.expireAt)],
]);

/** The shape of an event identifier, which is the deduplication key. */
const EVENT_ID_SHAPE = /^\d{19}-\d{10}$/;

/**
 * Compare one webhook message against the transaction that it reports.
 *
 * The claim in a delivery row is that the listener posted this message for this
 * redemption. This check tests the two properties that a captured message can
 * carry: every field agrees with a chain that we did not write, and the message
 * arrived after the ledger that carries the event closed.
 *
 * It does not test authenticity, and it must not be read as testing it. A
 * composed message that agrees with the chain passes. What fails is a message
 * that reports a redemption differently from the network, one whose bytes
 * changed after capture, and one that claims to arrive before its own event.
 */
export function compareDeliveryToChain(delivery, redeem, horizon, hash) {
  const problems = [];
  let checked = 0;

  checked += 1;
  const digest = createHash('sha256').update(delivery.body, 'utf8').digest('hex');
  if (digest !== delivery.bodySha256) {
    problems.push(`the body digest is ${delivery.bodySha256} and its bytes hash to ${digest}`);
    // Every check below reads the body, and the bytes are not the ones that the
    // receiver stored, so nothing below would mean what it says.
    return { checked, problems };
  }

  let message;
  try {
    message = JSON.parse(delivery.body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { checked, problems: [...problems, `the delivered body is not JSON: ${detail}`] };
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { checked, problems: [...problems, 'the delivered body is not a message object'] };
  }

  if (redeem === null) {
    return { checked, problems: [...problems, `${hash} is not a redemption, so no message can report it`] };
  }

  for (const [field, wanted, chainValue] of DELIVERED_FIELDS) {
    checked += 1;
    const sent = message[field];
    if (sent === undefined) {
      problems.push(`the message names no ${field}`);
      continue;
    }
    if (wanted === 'string' && typeof sent !== 'string') {
      problems.push(
        `the message sends ${field} as a ${typeof sent}, and a value of that width `
        + 'loses digits as a number. It has to arrive as text.',
      );
      continue;
    }
    const expected = chainValue(redeem);
    if (String(sent) !== expected) {
      problems.push(`the message reports ${field} as ${sent}, and the chain says ${expected}`);
    }
  }

  checked += 1;
  const reported = message.tx_hash;
  if (reported === undefined) problems.push('the message names no tx_hash');
  else if (String(reported) !== hash) {
    problems.push(`the message reports tx_hash ${reported}, and the row cites ${hash}`);
  }

  // The deduplication key. A repeat of a delivery is expected under at-least-once
  // delivery, and a reader can only drop the repeat if the key arrived with it.
  checked += 1;
  const eventId = message.event_id;
  if (eventId === undefined) problems.push('the message names no event_id, so no reader can drop a repeat');
  else if (typeof eventId !== 'string' || !EVENT_ID_SHAPE.test(eventId)) {
    problems.push(`the message reports event_id ${eventId}, which is not an event identifier`);
  }

  if (horizon !== null && horizon !== undefined) {
    checked += 1;
    if (message.ledger === undefined) problems.push('the message names no ledger');
    else if (String(message.ledger) !== String(horizon.ledger)) {
      problems.push(`the message reports ledger ${message.ledger}, and the chain says ${horizon.ledger}`);
    }

    // The listener sends the close time as well, so the message can be checked
    // against the chain without a second read of it later.
    if (horizon.created_at !== null && message.ledger_closed_at !== undefined) {
      checked += 1;
      if (Date.parse(String(message.ledger_closed_at)) !== Date.parse(horizon.created_at)) {
        problems.push(
          `the message reports the close time as ${message.ledger_closed_at}, `
          + `and the chain says ${horizon.created_at}`,
        );
      }
    }

    // The order is the one property here that a chain comparison cannot give.
    // A message cannot arrive before the ledger that carries its event closed.
    if (horizon.created_at !== null) {
      checked += 1;
      const closed = Date.parse(horizon.created_at);
      const arrived = Date.parse(delivery.receivedAt);
      if (Number.isNaN(arrived)) problems.push(`${delivery.receivedAt} is not a time`);
      else if (arrived < closed) {
        problems.push(
          `the message arrived at ${delivery.receivedAt}, before its ledger closed at ${horizon.created_at}`,
        );
      }
    }
  }

  return { checked, problems };
}

/**
 * Check every delivery in one tree against the chain.
 *
 * It reads the archive alone, so it still answers after a testnet reset and
 * after the RPC forgets the ledger.
 */
export function deriveDeliveryClaims(dir, manifest) {
  const problems = [];
  let checked = 0;
  for (const row of manifest.rows) {
    if (row.delivery === undefined) continue;
    const archived = readArchivedRow(dir, row.name);
    const { redeem } = redeemFromEnvelope(archived.rpc.envelopeXdr);
    const found = compareDeliveryToChain(row.delivery, redeem, archived.horizon, row.hash);
    checked += found.checked;
    for (const problem of found.problems) problems.push(`${row.name}: ${problem}`);
  }
  return { checked, problems };
}
