import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { archiveManifest, archiveRow, readArchivedRow, readManifest, validateRow, writeManifest } from '../src/index.js';
import type { Manifest, Row } from '../src/index.js';

const HASH = 'd205263f859e7e4433573f9dd4e3b6c267facc2932727ee9d297d35f6c5a5ecf';

function goodRow(): Row {
  return { name: 'app-merchant-905134460058084626', hash: HASH, note: 'What this row shows.' };
}

function tree(): string {
  return mkdtempSync(join(tmpdir(), 'senet-evidence-'));
}

function manifest(rows: readonly Row[]): Manifest {
  return {
    network: 'Test SDF Network ; September 2015',
    contractId: 'CADGZVNCAFRHJ44P33RODTVXGXCX5EMVCYFHYFMGWNFYVILC556XGWBY',
    producedAt: '2026-09-04T00:00:00.000Z',
    rows,
  };
}

test('a row with a name, a hash and a note passes', () => {
  assert.deepEqual(validateRow(goodRow()), goodRow());
});

test('a row without a note fails', () => {
  const { name, hash } = goodRow();
  // A caller in JavaScript reaches this function with any shape at all, which
  // is the case that the check exists for.
  const row: Row = { name, hash, note: '' };
  assert.throws(() => validateRow(row), /needs a note/);
});

test('a row without a name fails', () => {
  assert.throws(() => validateRow({ ...goodRow(), name: '' }), /needs a name/);
});

test('a hash that is not 64 hexadecimal characters fails', () => {
  assert.throws(() => validateRow({ ...goodRow(), hash: 'abc' }), /64 hexadecimal/);
  assert.throws(() => validateRow({ ...goodRow(), hash: HASH.toUpperCase() }), /64 hexadecimal/);
});

test('a name with a capital letter or a space fails', () => {
  assert.throws(() => validateRow({ ...goodRow(), name: 'App-Merchant' }), /lower case/);
  assert.throws(() => validateRow({ ...goodRow(), name: 'app merchant' }), /lower case/);
});

test('the optional fields travel through the manifest unchanged', () => {
  const dir = tree();
  const row: Row = {
    ...goodRow(),
    producer: 'browser',
    screen: 'merchant',
    shown: { title: 'Paid', advice: 'Give the goods to the payer.', values: { Ledger: '4494766' } },
  };
  writeManifest(dir, manifest([row]));
  const read = readManifest(dir);
  assert.equal(read.rows.length, 1);
  assert.deepEqual(read.rows[0], row);
});

test('a summary keeps a boolean, a number and a string', () => {
  const dir = tree();
  writeManifest(dir, {
    ...manifest([goodRow()]),
    summary: { serviceWorkerActive: true, concurrentLedger: 4494973, origin: 'http://127.0.0.1' },
  });
  const read = readManifest(dir);
  assert.deepEqual(read.summary, {
    serviceWorkerActive: true,
    concurrentLedger: 4494973,
    origin: 'http://127.0.0.1',
  });
});

test('writing a manifest checks every row', () => {
  const dir = tree();
  assert.throws(
    () => writeManifest(dir, manifest([goodRow(), { ...goodRow(), name: 'second', hash: 'no' }])),
    /64 hexadecimal/,
  );
});

test('reading a manifest whose row lost its note fails', () => {
  const dir = tree();
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    network: 'Test SDF Network ; September 2015',
    contractId: 'CADGZVNCAFRHJ44P33RODTVXGXCX5EMVCYFHYFMGWNFYVILC556XGWBY',
    producedAt: '2026-09-04T00:00:00.000Z',
    rows: [{ name: 'a-row', hash: HASH }],
  }));
  assert.throws(() => readManifest(dir), /no name, hash or note/);
});

test('reading a manifest that names no network fails', () => {
  const dir = tree();
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ rows: [] }));
  assert.throws(() => readManifest(dir), /names no network/);
});

const FIXTURE_DIR = fileURLToPath(new URL('../../../../scripts/out/evidence/', import.meta.url));
const FIXTURE_NAME = 'passkey-redeem-1';

for (const missing of ['all RPC data', 'only metadata', 'the Horizon summary'] as const) {
  test(`an incomplete refresh preserves the historical bytes when it lacks ${missing}`, async (t) => {
    const dir = tree();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const prior = readArchivedRow(FIXTURE_DIR, FIXTURE_NAME);
    const original = readFileSync(join(FIXTURE_DIR, `${FIXTURE_NAME}.json`));
    const destination = join(dir, `${FIXTURE_NAME}.json`);
    writeFileSync(destination, original);
    const currentRpc = missing === 'all RPC data'
      ? { status: 'NOT_FOUND' }
      : missing === 'only metadata' ? { ...prior.rpc, resultMetaXdr: null } : prior.rpc;
    let request = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      request += 1;
      if (request === 2 && missing === 'the Horizon summary') return new Response(null, { status: 404 });
      return new Response(JSON.stringify(request === 1 ? { result: currentRpc } : prior.horizon));
    });
    const messages: string[] = [];
    t.mock.method(console, 'log', (message: string) => messages.push(message));
    const incomplete = await archiveManifest(dir, manifest([prior]));
    assert.equal(incomplete, 1);
    assert.equal(request, 2);
    assert(readFileSync(destination).equals(original), 'historical archive bytes changed');
    assert(messages.some((message) => message.includes('preserved historical archive')));
  });
}

test('a complete refresh replaces the previous archive', async (t) => {
  const dir = tree();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prior = readArchivedRow(FIXTURE_DIR, FIXTURE_NAME);
  const destination = join(dir, `${FIXTURE_NAME}.json`);
  writeFileSync(destination, readFileSync(join(FIXTURE_DIR, `${FIXTURE_NAME}.json`)));
  let request = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    request += 1;
    return new Response(JSON.stringify(request === 1 ? { result: prior.rpc } : prior.horizon));
  });
  const fresh = await archiveRow(dir, prior, prior.contractId);
  assert.notEqual(fresh.archivedAt, prior.archivedAt);
  assert.deepEqual(fresh.rpc, prior.rpc);
  assert.deepEqual(fresh.horizon, prior.horizon);
  assert.equal(readFileSync(destination, 'utf8'), `${JSON.stringify(fresh, null, 2)}\n`);
});

test('the refresh command skips marked analysis, preserves stale evidence, and refuses an unmarked row without a hash', (t) => {
  const dir = tree();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'out');
  const analysisDir = join(out, 'fee-check');
  const transactionDir = join(out, 'transactions');
  mkdirSync(analysisDir, { recursive: true });
  mkdirSync(transactionDir);
  const analysis = { kind: 'derived-analysis', producedBy: 'scripts/analyze-fees.mjs', rows: [{ name: 'redemption-fees' }] };
  writeFileSync(join(analysisDir, 'manifest.json'), JSON.stringify(analysis));
  const prior = readArchivedRow(FIXTURE_DIR, FIXTURE_NAME);
  const original = readFileSync(join(FIXTURE_DIR, `${FIXTURE_NAME}.json`));
  const destination = join(transactionDir, `${FIXTURE_NAME}.json`);
  writeFileSync(destination, original);
  writeManifest(transactionDir, manifest([prior]));
  const script = join(dir, 'archive-evidence.mjs');
  writeFileSync(script, readFileSync(new URL('../../../../scripts/archive-evidence.mjs', import.meta.url)));
  writeFileSync(join(dir, 'evidence-set.mjs'), `
    export { archiveManifest, readManifest } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
    export const OUT_DIR = ${JSON.stringify(out)};
    export const ENDPOINTS = { rpcUrl: 'rpc-fixture', horizonUrl: 'horizon-fixture' };
    export const deriveShownClaims = () => ({ checked: 0, problems: [] });
    globalThis.fetch = async (url) => {
      if (url === ENDPOINTS.rpcUrl) return new Response(JSON.stringify({ result: { status: 'NOT_FOUND' } }));
      if (url === ENDPOINTS.horizonUrl + '/transactions/' + ${JSON.stringify(prior.hash)}) {
        return new Response(${JSON.stringify(JSON.stringify(prior.horizon))});
      }
      throw new Error('Unexpected request: ' + url);
    };
  `);
  const stale = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stdout, /skipped derived analysis/);
  assert.match(stale.stdout, /preserved historical archive/);
  assert.match(stale.stdout, /1 refresh result\(s\) lack complete RPC or Horizon evidence/);
  assert(readFileSync(destination).equals(original), 'the command changed historical archive bytes');

  writeFileSync(join(analysisDir, 'manifest.json'), JSON.stringify({
    ...manifest([]),
    rows: [{ name: 'not-a-transaction', note: 'This row lacks a hash.' }],
  }));
  const malformed = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /no name, hash or note/);
  assert.doesNotMatch(malformed.stdout, /skipped derived analysis/);
});
