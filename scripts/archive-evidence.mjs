// Archive the on-chain evidence for every transaction in the manifest.
//
// Testnet resets, and the RPC server keeps about seven days of history. A
// transaction hash is therefore not a durable citation. This command reads the
// envelope, the result, the meta and the diagnostic events from RPC. It also
// reads the summary from Horizon. It then writes one JSON file for each row.
// The files stay in the repository, so a reader verifies the record after the
// network forgets the hash.
//
// Run it with `node scripts/archive-evidence.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = path.join(ROOT, 'scripts', 'out', 'evidence');
const MANIFEST_PATH = path.join(EVIDENCE_DIR, 'manifest.json');
const RPC_URL = process.env.RPC_URL ?? 'https://soroban-testnet.stellar.org';
const HORIZON_URL = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

/** The fields that this command keeps from the Horizon summary of a transaction. */
const HORIZON_FIELDS = ['successful', 'ledger', 'fee_charged', 'created_at', 'source_account'];

async function rpcTransaction(hash) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getTransaction',
    params: { hash },
  });
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
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

async function archiveRow(row) {
  const result = await rpcTransaction(row.hash);
  const horizon = await horizonSummary(row.hash);
  const payload = {
    name: row.name,
    hash: row.hash,
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
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, `${row.name}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  return payload;
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

let missing = 0;
for (const row of manifest.rows) {
  const payload = await archiveRow(row);
  const rpcStatus = payload.rpc.status ?? 'NOT_FOUND';
  // A status of NOT_FOUND means that the RPC server dropped the transaction.
  // The file on disk then holds the Horizon summary only, and a reader cannot
  // read the meta. The command reports the row and continues.
  if (rpcStatus === 'NOT_FOUND' || payload.rpc.envelopeXdr == null) missing += 1;
  const ledger = payload.rpc.ledger ?? payload.horizon?.ledger ?? 'unknown';
  console.log(`${row.name.padEnd(34)} ${rpcStatus.padEnd(10)} ledger ${ledger}`);
}

console.log(`\narchived ${manifest.rows.length} rows into scripts/out/evidence`);
if (missing > 0) {
  console.log(`${missing} row(s) carry no meta, because the RPC server dropped them.`);
  process.exitCode = 1;
}
