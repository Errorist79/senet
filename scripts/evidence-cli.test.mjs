import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROWS = ['1a-success', '8-void-success', 'lifetime-5m', 'lifetime-15m', 'lifetime-1h', 'lifetime-12h'];

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function fixture(t, device = false) {
  const root = fs.mkdtempSync(path.join(ROOT, '.evidence-cli-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['run-confirmation.mjs', 'webhook-receiver.mjs', 'run-sow-evidence.mjs']) {
    const source = path.join(ROOT, 'scripts', name);
    if (fs.existsSync(source)) write(path.join(root, 'scripts', name), fs.readFileSync(source, 'utf8'));
  }
  write(path.join(root, 'scripts/evidence-set.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    export const OUT_DIR = path.join(ROOT, 'scripts/out');
    export const EVIDENCE_DIR = path.join(OUT_DIR, 'evidence');
    export const CONFIRM_CHECK_DIR = path.join(OUT_DIR, 'confirm-check');
    export const ENDPOINTS = {};
    export function loadEnv() {}
    export function readManifest(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'))); }
    export function writeManifest(dir, value) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(value));
    }
    export async function archiveRow(dir, row) {
      const archived = { ...row, rpc: { envelopeXdr: 'envelope', resultXdr: 'result', resultMetaXdr: 'meta' }, horizon: { successful: true } };
      fs.writeFileSync(path.join(dir, row.name + '.json'), JSON.stringify(archived));
      return archived;
    }
    export function deriveDeliveryClaims() { return { checked: 1, problems: [] }; }
  `);
  write(path.join(root, 'server/dist/tools/listen.js'), `
    import fs from 'node:fs';
    if (process.env.FAIL_LISTENER) process.exit(1);
    if (process.env.CONTRACT_ID !== 'selected-contract') process.exit(2);
    const manifest = JSON.parse(fs.readFileSync(process.env.TEST_EVIDENCE));
    const rows = process.env.PARTIAL ? manifest.rows.slice(0, 1) : manifest.rows;
    for (const row of rows) {
      await fetch(process.env.WEBHOOK_URL, { method: 'POST', body: JSON.stringify({ tx_hash: row.hash, voucher_id: row.name }) });
    }
  `);
  const source = path.join(root, 'fresh-evidence');
  const rows = [...ROWS, ...(device ? ['passkey-fresh'] : [])].map((name, index) => ({
    name, hash: String(index + 1).padStart(64, '0'), note: name,
  }));
  write(path.join(source, 'manifest.json'), {
    network: 'Test SDF Network ; September 2015', contractId: 'selected-contract',
    producedAt: new Date().toISOString(), complete: true, rows,
  });
  for (const row of rows) write(path.join(source, row.name + '.json'), { ...row, horizon: { ledger: 100, successful: true } });
  write(path.join(root, 'scripts/out/evidence/manifest.json'), {
    network: 'Test SDF Network ; September 2015', contractId: 'wrong-contract',
    producedAt: new Date().toISOString(), rows: [{ ...rows[0], hash: 'f'.repeat(64) }],
  });
  write(path.join(root, 'scripts/out/evidence/1a-success.json'), { horizon: { ledger: 90 } });
  const sentinel = path.join(root, 'scripts/out/confirm-check/historical.json');
  write(sentinel, 'historical evidence');
  return { root, source, sentinel, output: path.join(root, 'new-confirmations') };
}

function run(f, script, args, env = {}) {
  return spawnSync(process.execPath, [path.join(f.root, 'scripts', script), ...args], {
    cwd: f.root, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, TEST_EVIDENCE: path.join(f.source, 'manifest.json'), ...env },
  });
}

test('a listener failure preserves the historical archive and marks the new run partial', (t) => {
  const f = fixture(t);
  const result = run(f, 'run-confirmation.mjs', ['--evidence', f.source, '--output', f.output], { FAIL_LISTENER: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(f.sentinel, 'utf8'), 'historical evidence');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.output, 'manifest.json'))).complete, false);
});

test('missing deliveries retain partial rows and return failure', (t) => {
  const f = fixture(t);
  const result = run(f, 'run-confirmation.mjs', ['--evidence', f.source, '--output', f.output], { PARTIAL: '1' });
  assert.notEqual(result.status, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'manifest.json')));
  assert.equal(manifest.complete, false);
  assert.equal(manifest.rows.length, 1);
  assert.equal(manifest.missing.length, 5);
});

test('explicit evidence selects its hashes and contract, including the supplied passkey', (t) => {
  const f = fixture(t, true);
  const result = run(f, 'run-confirmation.mjs', ['--evidence', f.source, '--output', f.output]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'manifest.json')));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.rows.length, 7);
  assert.equal(manifest.rows.find(row => row.name === 'confirm-passkey-fresh').hash, '7'.padStart(64, '0'));
  assert.equal(fs.readFileSync(f.sentinel, 'utf8'), 'historical evidence');
});

test('the command refuses an existing output and preserves its files', (t) => {
  const f = fixture(t);
  write(path.join(f.output, 'keep.json'), 'keep');
  const result = run(f, 'run-confirmation.mjs', ['--evidence', f.source, '--output', f.output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/);
  assert.equal(fs.readFileSync(path.join(f.output, 'keep.json'), 'utf8'), 'keep');
});

function combinedFixture(t) {
  const f = fixture(t);
  write(path.join(f.root, 'scripts/run-evidence.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    const dir = args[args.indexOf('--output') + 1];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ complete: !process.env.FAIL_PRODUCER }));
    fs.writeFileSync(path.join(dir, 'arguments.json'), JSON.stringify(args));
    if (process.env.FAIL_PRODUCER) process.exit(3);
    if (args.includes('--replay-output')) {
      const replay = args[args.indexOf('--replay-output') + 1];
      fs.mkdirSync(replay);
      fs.writeFileSync(path.join(replay, 'manifest.json'), JSON.stringify({ complete: true }));
    }
  `);
  write(path.join(f.root, 'scripts/run-confirmation.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    const source = args[args.indexOf('--evidence') + 1];
    const dir = args[args.indexOf('--output') + 1];
    if (!fs.existsSync(path.join(source, 'arguments.json'))) process.exit(4);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'arguments.json'), JSON.stringify(args));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ complete: !process.env.FAIL_CONFIRMATION }));
    if (process.env.FAIL_CONFIRMATION) process.exit(5);
  `);
  return f;
}

test('combined full mode connects the exact directory and delegates the device replay', (t) => {
  const f = combinedFixture(t);
  const output = path.join(f.root, 'full-run');
  const hash = 'a'.repeat(64);
  const result = run(f, 'run-sow-evidence.mjs', ['--device-hash', hash, '--output', output]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const producer = JSON.parse(fs.readFileSync(path.join(output, 'arguments.json')));
  assert.equal(producer[producer.indexOf('--device-hash') + 1], hash);
  assert.equal(producer[producer.indexOf('--replay-output') + 1], output + '-device-replay');
  const confirmation = JSON.parse(fs.readFileSync(path.join(output + '-confirmations', 'arguments.json')));
  assert.equal(confirmation[confirmation.indexOf('--evidence') + 1], output);
  assert.ok(confirmation.includes('--device-confirmation'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'run.json'))).complete, true);
});

for (const failure of ['FAIL_PRODUCER', 'FAIL_CONFIRMATION']) {
  test('combined voucher mode propagates ' + failure, (t) => {
    const f = combinedFixture(t);
    const output = path.join(f.root, 'partial-run');
    const result = run(f, 'run-sow-evidence.mjs', ['--vouchers-only', '--output', output], { [failure]: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'run.json'))).complete, false);
    assert.equal(fs.existsSync(output + '-device-replay'), false);
    if (failure === 'FAIL_PRODUCER') assert.equal(fs.existsSync(output + '-confirmations'), false);
  });
}
