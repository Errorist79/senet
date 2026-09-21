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
import { Address, Networks, StrKey, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  TESTNET_HORIZON_URL, TESTNET_RPC_URL, archiveRow, readArchivedRow, readManifest, writeManifest,
} from '@senet/evidence';

export {
  archiveManifest, archiveRow, readArchivedRow, readManifest, writeManifest,
} from '@senet/evidence';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = path.join(ROOT, 'scripts', 'out');
export const EVIDENCE_DIR = path.join(OUT_DIR, 'evidence');
export const LOAD_CHECK_DIR = path.join(OUT_DIR, 'load-check');
export const APP_CHECK_DIR = path.join(OUT_DIR, 'app-check');
export const DEVICE_CHECK_DIR = path.join(OUT_DIR, 'device-check');
export const CONFIRM_CHECK_DIR = path.join(OUT_DIR, 'confirm-check');
export const RPC_URL = process.env.RPC_URL ?? TESTNET_RPC_URL;
export const HORIZON_URL = process.env.HORIZON_URL ?? TESTNET_HORIZON_URL;

/** The endpoints that the archive step reads a transaction from. */
export const ENDPOINTS = Object.freeze({ rpcUrl: RPC_URL, horizonUrl: HORIZON_URL });

/** How many characters of a hash name a row that carries no voucher. */
const HASH_NAME_LENGTH = 12;

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
export function signatureScheme(signature) {
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
/**
 * Read a decimal amount as stroops.
 *
 * An amount carries seven decimal places exactly, so the conversion runs
 * through text and BigInt. A number would lose the last place on a large
 * amount, and it would give no sign that it did.
 */
function xlmAsStroops(amount) {
  if (!/^\d+(\.\d{1,7})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * STROOPS_IN_ONE_XLM + BigInt(fraction.padEnd(7, '0'));
}

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
  // as a number compares equal here while it is already corrupt. That is the
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
 * It does not test authenticity, and nobody may read it as a test of that. A
 * composed message that agrees with the chain passes. Three messages fail:
 * one that reports a redemption differently from the network, one whose bytes
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

  // The deduplication key. At-least-once delivery repeats a message, and a
  // reader can drop the repeat only when the key arrived with it.
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

    // The listener sends the close time as well, so a reader can check the
    // message against the chain without a second read of it later.
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

/**
 * Read the terms of a classic payment out of one transaction envelope.
 *
 * A payee-presented payment is not a contract call. It is a payment operation,
 * so the reader that decodes a redemption cannot read one, and this reads the
 * operation instead. The Soroban RPC holds a classic transaction with its
 * envelope, result and meta, measured against the network. A payment row
 * therefore archives and re-reads exactly as a redemption row does.
 */
export function paymentFromEnvelope(envelopeXdr) {
  if (!envelopeXdr) return null;
  const transaction = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64').v1().tx();
  const operation = transaction.operations()[0];
  if (operation.body().switch().name !== 'payment') return null;
  const payment = operation.body().paymentOp();
  const asset = payment.asset();
  // A payment names a muxed account, and the common case carries a plain
  // ed25519 key. A real testnet payment checks this decode: the address below
  // equals the destination that Horizon reports for it. A muxed destination
  // has a different shape. This says so, rather than reading the wrong field
  // and giving back a plausible address that belongs to nobody.
  const destination = payment.destination();
  const kind = destination.switch().name;
  if (kind !== 'keyTypeEd25519') {
    return { destination: null, muxedKind: kind, amountStroops: payment.amount().toString(), assetType: asset.switch().name };
  }
  return {
    destination: StrKey.encodeEd25519PublicKey(destination.ed25519()),
    muxedKind: kind,
    amountStroops: payment.amount().toString(),
    assetType: asset.switch().name,
  };
}

/**
 * Compare one payee-presented request against the payment that answered it.
 *
 * The request is the artifact and the payment is the fact. This check asks
 * whether the two agree, and whether the stored key really signed the request.
 *
 * The signature check needs no network. The request and the key are both in the
 * row, so this still answers after the domain changes its key or stops
 * answering at all. Whether the domain still publishes that key is a different
 * question, it decays, and `tomlUrl` is where a reader goes to ask it.
 */
export function compareRequestToChain(request, payment, horizon, verify) {
  const problems = [];
  let checked = 0;

  checked += 1;
  const verified = verify(request.uri, request.signingKey);
  if (!verified.verified) {
    problems.push(`the stored key does not verify the request: ${verified.reason}`);
  }

  checked += 1;
  const parsed = new URL(request.uri.replace('web+stellar:', 'https://sep7/'));
  const declared = parsed.searchParams.get('origin_domain');
  if (declared !== request.originDomain) {
    problems.push(`the request names origin_domain ${declared}, and the row says ${request.originDomain}`);
  }

  checked += 1;
  if (!request.tomlUrl.includes(request.originDomain)) {
    problems.push(`the key came from ${request.tomlUrl}, which is not the domain the request names`);
  }

  if (payment !== null) {
    checked += 1;
    if (payment.destination === null) {
      problems.push(`the payment names a ${payment.muxedKind} destination, which this row cannot read`);
    }
    const wanted = parsed.searchParams.get('destination');
    if (payment.destination !== null && wanted !== payment.destination) {
      problems.push(`the request asks for ${wanted}, and the payment went to ${payment.destination}`);
    }

    const askedAmount = parsed.searchParams.get('amount');
    if (askedAmount !== null) {
      checked += 1;
      // Compare in stroops rather than in decimal text. An amount carries seven
      // decimal places, and a comparison through a floating point number loses
      // the smallest of them silently. The display formatter is not usable
      // here either, because it appends the name of the asset.
      const wantedStroops = xlmAsStroops(askedAmount);
      if (wantedStroops === null) {
        problems.push(`the request asks for ${askedAmount}, which is not an amount`);
      } else if (wantedStroops !== BigInt(payment.amountStroops)) {
        problems.push(
          `the request asks for ${wantedStroops} stroops and the payment carried ${payment.amountStroops}`,
        );
      }
    }

    // A request that names no asset asks for the native one. Without this the
    // amount could match while the payment carried a different asset entirely,
    // which is a payment that answers nothing.
    checked += 1;
    const askedCode = parsed.searchParams.get('asset_code');
    if (askedCode === null && payment.assetType !== 'assetTypeNative') {
      problems.push(`the request asks for the native asset and the payment carried ${payment.assetType}`);
    }
    if (askedCode !== null && payment.assetType === 'assetTypeNative') {
      problems.push(`the request asks for ${askedCode} and the payment carried the native asset`);
    }
  } else {
    problems.push('the transaction carries no payment operation, so it answers no request');
  }

  if (horizon !== null && horizon !== undefined) {
    checked += 1;
    if (horizon.successful !== true) problems.push('the payment did not succeed');
  }

  return { checked, problems };
}

/**
 * Ask whether the domain still publishes the key that signed a request.
 *
 * This is the half of a request row that decays, and it is separate on purpose.
 * The signature check beside it needs no network and stays true for ever. This
 * one reads the domain's file today, so it answers about today: it fails when
 * the domain rotates its key, and it fails when nobody published the key at all.
 *
 * The second failure is the one worth having. A row can carry a request that
 * verifies perfectly against a key that no wallet could ever find. Every
 * check that needs no network would pass, while the row proved nothing about
 * the deployment. That state is not imaginary. It reached the archive once,
 * and this function is what found it.
 */
export async function publishesTheKey(request) {
  let text;
  try {
    const response = await fetch(request.tomlUrl);
    if (!response.ok) {
      return { published: false, reason: `${request.tomlUrl} answered ${response.status}` };
    }
    text = await response.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { published: false, reason: `${request.tomlUrl} could not be read: ${detail}` };
  }
  const found = text.match(/URI_REQUEST_SIGNING_KEY\s*=\s*"([^"]+)"/);
  if (found === null) return { published: false, reason: `${request.tomlUrl} names no signing key` };
  if (found[1] !== request.signingKey) {
    return {
      published: false,
      reason: `the domain publishes ${found[1]} and the row was signed by ${request.signingKey}`,
    };
  }
  return { published: true, reason: null };
}

/**
 * Archive one row that a person made on a screen.
 *
 * Two commands need this, and they differ in four values:
 *
 * - the tree that they write to
 * - the word for who made the row
 * - the prefix on a row's name
 * - the sentences that describe what the row shows
 *
 * Somebody wrote everything else twice, once for a phone and once for a
 * browser. It lives here once.
 *
 * A caller passes `argv` rather than reading it here, so this stays a function
 * and not a second entry point.
 */
export async function archiveScreenRow(settings) {
  const { dir, producer, namePrefix, producedBy, notes, argv, screens } = settings;

  const usage = (problem) => {
    console.error(`${problem}\n`);
    console.error(`  node ${producedBy} <hash> --screen <name> \\`);
    console.error('    --title "<what the screen said>" --advice "<the sentence under it>" \\');
    console.error('    [--value "Label=value"] [--note "<what this row shows>"] [--write]');
    console.error(`\n  a screen is one of: ${screens.join(', ')}`);
    process.exit(1);
  };

  const options = { values: {}, write: false };
  const [hash, ...rest] = argv;
  if (hash === undefined) usage('name the transaction hash');
  options.hash = hash;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--write') {
      options.write = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) usage(`${flag} carries no value`);
    index += 1;
    if (flag === '--screen') options.screen = value;
    else if (flag === '--title') options.title = value;
    else if (flag === '--advice') options.advice = value;
    else if (flag === '--note') options.note = value;
    else if (flag === '--value') {
      const split = value.indexOf('=');
      if (split < 1) usage(`--value takes "Label=value", and it carries ${value}`);
      options.values[value.slice(0, split)] = value.slice(split + 1);
    } else usage(`${flag} is not an option of this command`);
  }
  if (!/^[0-9a-f]{64}$/.test(options.hash)) usage(`${options.hash} is not a transaction hash`);
  if (options.screen === undefined) usage('name the screen with --screen');
  if (!screens.includes(options.screen)) usage(`--screen takes one of: ${screens.join(', ')}`);
  if (options.title === undefined) usage('give the title with --title');
  if (options.advice === undefined) usage('give the sentence with --advice');

  const described = await describeRedeem(options.hash);
  if (described === null) {
    console.error(`the network holds no transaction ${options.hash}`);
    console.error('A hash that a screen showed reaches the network within a few seconds.');
    console.error('The RPC server keeps about seven days, so an older run needs Horizon.');
    process.exit(1);
  }
  // The account screen deploys an account, which calls no contract function.
  // Every other screen redeems, so a row from one of those has to be one.
  const isAccount = options.screen === 'account';
  if (!isAccount && described.redeem === null) {
    const called = described.functionName ?? described.hostFunction;
    console.error(`${options.hash} carries ${called}, and a ${options.screen} row needs a redeem`);
    process.exit(1);
  }
  if (isAccount && described.redeem !== null) {
    console.error(`${options.hash} is a redemption, so it is not an account row`);
    process.exit(1);
  }

  const configuredContract = process.env.CONTRACT_ID;
  const { redeem } = described;
  // A redemption takes its name from the voucher that both parties share. A
  // deployment has no voucher, so it takes the first characters of its hash.
  const name = isAccount
    ? `${namePrefix}-account-${options.hash.slice(0, HASH_NAME_LENGTH)}`
    : `${namePrefix}-${options.screen}-${redeem.voucherId}`;
  const row = {
    name,
    hash: options.hash,
    note: options.note ?? (isAccount ? notes.account : notes.redeem(redeem)),
    producer,
    screen: options.screen,
    ...(described.contractId === null ? {} : { contractId: described.contractId }),
    shown: { title: options.title, advice: options.advice, values: options.values },
  };

  // The archive step needs the Horizon summary to compare a figure that a
  // person read, so the preview asks for it before anything reaches disk.
  const summary = await fetch(`${ENDPOINTS.horizonUrl}/transactions/${options.hash}`);
  const horizon = summary.ok ? await summary.json() : null;
  const shown = compareShownToChain(options.values, horizon, options.hash);

  console.log(`\nthis command would write ${name}`);
  console.log(`  into        ${path.relative(ROOT, dir)}/`);
  console.log(`  hash        ${options.hash}`);
  console.log(`  contract    ${described.contractId ?? 'none, this transaction deploys one'}`);
  // The account that pays for a deployment signs it. The passkey of the new
  // account signs nothing here, so a note about the scheme would mislead.
  const passkey = isAccount || described.signature === 'secp256r1';
  console.log(`  signature   ${described.signature}${passkey ? '' : '   NOT A PASSKEY'}`);
  if (isAccount) {
    console.log(`  deployer    ${described.payer}`);
  } else {
    const voided = redeem.payer === redeem.recipient ? '   the payer voided it' : '';
    console.log(`  payer       ${redeem.payer}`);
    console.log(`  recipient   ${redeem.recipient}${voided}`);
    console.log(`  amount      ${redeem.amount} stroops`);
    console.log(`  voucher     ${redeem.voucherId}`);
  }
  console.log(`  ledger      ${horizon?.ledger ?? 'unknown'}`);
  console.log(`  outcome     ${horizon?.successful === true ? 'SUCCESS' : 'FAILED'}`);
  console.log(`  note        ${row.note}`);
  console.log(`  screen      ${options.title} / ${options.advice}`);
  console.log(`  figures     ${shown.checked} compared against the chain`);
  for (const problem of shown.problems) console.log(`  PROBLEM     ${problem}`);

  if (configuredContract !== undefined && described.contractId !== null
    && described.contractId !== configuredContract) {
    console.log(`  NOTE        this contract is not the one that .env names, ${configuredContract}`);
  }

  if (shown.problems.length > 0) {
    console.error('\nnothing written. A figure on the screen does not match the chain.');
    process.exit(1);
  }

  if (!options.write) {
    console.log('\nnothing written. Add --write to archive this row.');
    process.exit(0);
  }

  const manifest = fs.existsSync(path.join(dir, 'manifest.json'))
    ? readManifest(dir)
    : {
        network: process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET,
        contractId: described.contractId ?? configuredContract ?? '',
        producedAt: new Date().toISOString(),
        rows: [],
      };

  const rows = manifest.rows.filter((each) => each.name !== name).concat([row]);
  rows.sort((left, right) => left.name.localeCompare(right.name));
  const written = { ...manifest, producedAt: new Date().toISOString(), producedBy, rows };

  await archiveRow(dir, row, written.contractId, ENDPOINTS);
  writeManifest(dir, written);

  const checked = deriveShownClaims(dir, written);
  console.log(`\narchived ${name}`);
  console.log(`  the tree now holds ${written.rows.length} rows`);
  console.log(`  ${checked.checked} figures across the tree match the chain`);
  for (const problem of checked.problems) console.log(`  PROBLEM ${problem}`);
  if (checked.problems.length > 0) process.exitCode = 1;
}
