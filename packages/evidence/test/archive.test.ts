import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readManifest, validateRow, writeManifest } from '../src/index.js';
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
