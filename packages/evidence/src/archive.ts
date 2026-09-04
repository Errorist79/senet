/**
 * Read a transaction from the network and write it into an evidence tree.
 *
 * Testnet resets, and the RPC server keeps about seven days of history. A
 * transaction hash is therefore not a durable citation. This step reads the
 * envelope, the result, the meta and the diagnostic events from RPC. It also
 * reads the summary from Horizon. It then writes one file for the row. The
 * files stay in the repository, so a reader verifies the record after the
 * network forgets it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchivedRow, HorizonSummary, Manifest, Row, RpcSummary } from './types.js';

/** The public Soroban RPC server of testnet. */
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
/** The public Horizon server of testnet. */
export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/** Where the archive step reads a transaction from. */
export interface Endpoints {
  readonly rpcUrl: string;
  readonly horizonUrl: string;
}

/** The endpoints that every command uses unless an operator names others. */
export const TESTNET_ENDPOINTS: Endpoints = Object.freeze({
  rpcUrl: TESTNET_RPC_URL,
  horizonUrl: TESTNET_HORIZON_URL,
});

/**
 * A parsed JSON document has no shape that the compiler knows. Every read
 * below therefore inspects the value, and it trusts no declaration.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' ? value : null;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === 'boolean' ? value : null;
}

function readStrings(record: Record<string, unknown>, key: string): readonly string[] | null {
  const value = record[key];
  if (!Array.isArray(value)) return null;
  const found: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    found.push(item);
  }
  return found;
}

const EMPTY_RPC: RpcSummary = Object.freeze({
  status: null,
  ledger: null,
  createdAt: null,
  envelopeXdr: null,
  resultXdr: null,
  resultMetaXdr: null,
  diagnosticEventsXdr: null,
});

async function rpcTransaction(endpoints: Endpoints, hash: string): Promise<RpcSummary> {
  const response = await fetch(endpoints.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: { hash } }),
  });
  if (!response.ok) throw new Error(`the RPC server answered ${response.status} for ${hash}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error(`the RPC server sent no object for ${hash}`);
  const error = payload['error'];
  if (isRecord(error)) {
    throw new Error(`the RPC server refused ${hash}: ${readString(error, 'message') ?? 'no reason'}`);
  }
  const result = payload['result'];
  if (!isRecord(result)) return EMPTY_RPC;
  return {
    status: readString(result, 'status'),
    ledger: readNumber(result, 'ledger'),
    createdAt: readString(result, 'createdAt'),
    envelopeXdr: readString(result, 'envelopeXdr'),
    resultXdr: readString(result, 'resultXdr'),
    resultMetaXdr: readString(result, 'resultMetaXdr'),
    diagnosticEventsXdr: readStrings(result, 'diagnosticEventsXdr'),
  };
}

async function horizonSummary(
  endpoints: Endpoints,
  hash: string,
): Promise<HorizonSummary | null> {
  const response = await fetch(`${endpoints.horizonUrl}/transactions/${hash}`);
  if (!response.ok) return null;
  const payload: unknown = await response.json();
  if (!isRecord(payload)) return null;
  return {
    successful: readBoolean(payload, 'successful'),
    ledger: readNumber(payload, 'ledger'),
    fee_charged: readString(payload, 'fee_charged'),
    created_at: readString(payload, 'created_at'),
    source_account: readString(payload, 'source_account'),
  };
}

/**
 * Check a row before the archive writes it.
 *
 * A caller in TypeScript fails to build when the shape changes. A caller in
 * JavaScript compiles nothing. This check therefore fails loudly here. Without
 * it, such a caller writes a row that looks right and is wrong.
 */
export function validateRow(row: Row): Row {
  for (const field of ['name', 'hash', 'note'] as const) {
    const value = row[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`a row needs a ${field}, and this one carries ${JSON.stringify(value)}`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(row.hash)) {
    throw new Error(`${row.name}: the hash ${row.hash} is not 64 hexadecimal characters`);
  }
  if (!/^[a-z0-9-]+$/.test(row.name)) {
    throw new Error(`${row.name}: a name holds lower case letters, digits and hyphens only`);
  }
  return row;
}

function manifestPath(dir: string): string {
  return join(dir, 'manifest.json');
}

export function readManifest(dir: string): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath(dir), 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed['rows'])) {
    throw new Error(`${manifestPath(dir)} holds no manifest`);
  }
  const network = readString(parsed, 'network');
  const contractId = readString(parsed, 'contractId');
  const producedAt = readString(parsed, 'producedAt');
  if (network === null || contractId === null || producedAt === null) {
    throw new Error(`${manifestPath(dir)} names no network, contract or time`);
  }
  const rows: Row[] = [];
  for (const candidate of parsed['rows']) {
    if (!isRecord(candidate)) throw new Error(`${manifestPath(dir)} holds a row that is not an object`);
    const name = readString(candidate, 'name');
    const hash = readString(candidate, 'hash');
    const note = readString(candidate, 'note');
    if (name === null || hash === null || note === null) {
      throw new Error(`${manifestPath(dir)} holds a row with no name, hash or note`);
    }
    // The optional fields travel unchanged. `validateRow` guards the three that
    // every row must carry, and the reader keeps the rest as it found them.
    rows.push({ ...candidate, name, hash, note });
  }
  const summary = parsed['summary'];
  const manifest: Manifest = isRecord(summary)
    ? { network, contractId, producedAt, summary: readSummary(summary), rows }
    : { network, contractId, producedAt, rows };
  return manifest;
}

function isSummaryValue(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

function readSummary(
  summary: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const found: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (isSummaryValue(value)) found[key] = value;
  }
  return found;
}

export function writeManifest(dir: string, manifest: Manifest): void {
  for (const row of manifest.rows) validateRow(row);
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Read the archive file of one row. */
export function readArchivedRow(dir: string, name: string): ArchivedRow {
  const parsed: unknown = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${name}.json holds no archived row`);
  const rpc = parsed['rpc'];
  const horizon = parsed['horizon'];
  const row = validateRow({
    ...parsed,
    name: readString(parsed, 'name') ?? '',
    hash: readString(parsed, 'hash') ?? '',
    note: readString(parsed, 'note') ?? '',
  });
  return {
    ...row,
    contractId: readString(parsed, 'contractId') ?? '',
    archivedAt: readString(parsed, 'archivedAt') ?? '',
    rpc: isRecord(rpc)
      ? {
          status: readString(rpc, 'status'),
          ledger: readNumber(rpc, 'ledger'),
          createdAt: readString(rpc, 'createdAt'),
          envelopeXdr: readString(rpc, 'envelopeXdr'),
          resultXdr: readString(rpc, 'resultXdr'),
          resultMetaXdr: readString(rpc, 'resultMetaXdr'),
          diagnosticEventsXdr: readStrings(rpc, 'diagnosticEventsXdr'),
        }
      : EMPTY_RPC,
    horizon: isRecord(horizon)
      ? {
          successful: readBoolean(horizon, 'successful'),
          ledger: readNumber(horizon, 'ledger'),
          fee_charged: readString(horizon, 'fee_charged'),
          created_at: readString(horizon, 'created_at'),
          source_account: readString(horizon, 'source_account'),
        }
      : null,
  };
}

/** Read one transaction from the network and write its archive file. */
export async function archiveRow(
  dir: string,
  row: Row,
  contractId: string,
  endpoints: Endpoints = TESTNET_ENDPOINTS,
): Promise<ArchivedRow> {
  validateRow(row);
  const rpc = await rpcTransaction(endpoints, row.hash);
  const horizon = await horizonSummary(endpoints, row.hash);
  const archived: ArchivedRow = {
    ...row,
    contractId: row.contractId ?? contractId,
    archivedAt: new Date().toISOString(),
    rpc,
    horizon,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${row.name}.json`), `${JSON.stringify(archived, null, 2)}\n`);
  return archived;
}

/**
 * Archive every row of a manifest.
 *
 * A row that the RPC server no longer holds keeps its Horizon summary, but it
 * carries no meta. This function counts such a row and names it to the caller.
 */
export async function archiveManifest(
  dir: string,
  manifest: Manifest,
  endpoints: Endpoints = TESTNET_ENDPOINTS,
): Promise<number> {
  let incomplete = 0;
  for (const row of manifest.rows) {
    const archived = await archiveRow(dir, row, manifest.contractId, endpoints);
    if (archived.rpc.envelopeXdr === null) incomplete += 1;
    const status = archived.rpc.status ?? 'NOT_FOUND';
    const ledger = archived.rpc.ledger ?? archived.horizon?.ledger ?? 'unknown';
    console.log(`${row.name.padEnd(34)} ${status.padEnd(10)} ledger ${ledger}`);
  }
  return incomplete;
}
