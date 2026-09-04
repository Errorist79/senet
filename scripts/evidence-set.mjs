// The evidence set, and the archive step that makes it durable.
//
// Testnet resets, and the RPC server keeps about seven days of history. A
// transaction hash is therefore not a durable citation. `archiveRow` reads the
// envelope, the result, the meta and the diagnostic events from RPC. It also
// reads the summary from Horizon. It then writes one JSON file for the row.
// The files stay in the repository, so a reader verifies the record after the
// network forgets the hash.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EVIDENCE_DIR = path.join(ROOT, 'scripts', 'out', 'evidence');
export const MANIFEST_PATH = path.join(EVIDENCE_DIR, 'manifest.json');
export const RPC_URL = process.env.RPC_URL ?? 'https://soroban-testnet.stellar.org';
export const HORIZON_URL = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

/** The fields that the archive keeps from the Horizon summary of a transaction. */
const HORIZON_FIELDS = ['successful', 'ledger', 'fee_charged', 'created_at', 'source_account'];

async function rpcTransaction(hash) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: { hash } }),
  });
  if (!response.ok) throw new Error(`RPC ${response.status} for ${hash}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`RPC error for ${hash}: ${payload.error.message}`);
  return payload.result ?? {};
}

async function horizonSummary(hash) {
  const response = await fetch(`${HORIZON_URL}/transactions/${hash}`);
  if (!response.ok) return null;
  const record = await response.json();
  const summary = {};
  for (const field of HORIZON_FIELDS) summary[field] = record[field];
  return summary;
}

/** Read one transaction from the network and write its archive file. */
export async function archiveRow(row, contractId) {
  const result = await rpcTransaction(row.hash);
  const horizon = await horizonSummary(row.hash);
  const payload = {
    name: row.name,
    hash: row.hash,
    contractId: row.contractId ?? contractId,
    note: row.note,
    archivedAt: new Date().toISOString(),
    rpc: {
      status: result.status,
      ledger: result.ledger,
      createdAt: result.createdAt,
      envelopeXdr: result.envelopeXdr,
      resultXdr: result.resultXdr,
      resultMetaXdr: result.resultMetaXdr,
      diagnosticEventsXdr: result.diagnosticEventsXdr,
    },
    horizon,
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, `${row.name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

export function writeManifest(manifest) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Archive every row of a manifest.
 *
 * A row that the RPC server no longer holds keeps its Horizon summary, but it
 * carries no meta. This function counts such a row and names it to the caller.
 */
export async function archiveManifest(manifest) {
  let incomplete = 0;
  for (const row of manifest.rows) {
    const payload = await archiveRow(row, manifest.contractId);
    const status = payload.rpc.status ?? 'NOT_FOUND';
    if (payload.rpc.envelopeXdr == null) incomplete += 1;
    const ledger = payload.rpc.ledger ?? payload.horizon?.ledger ?? 'unknown';
    console.log(`${row.name.padEnd(34)} ${String(status).padEnd(10)} ledger ${ledger}`);
  }
  return incomplete;
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
 * Two shapes appear on chain, and both were read from real transactions. An
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
  const entry = operation.auth()[0];
  const credentials = entry.credentials();
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
