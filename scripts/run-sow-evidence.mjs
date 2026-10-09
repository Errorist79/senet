// Produce transaction evidence, the supplied voucher replay, and webhook captures.
// Phone actions, screen evidence, and video remain separate human evidence.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vouchersOnly = false;
let deviceHash;
let output;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  if (flag === '--vouchers-only') vouchersOnly = true;
  else if (flag === '--device-hash' || flag === '--output') {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag === '--device-hash') deviceHash = value;
    else output = path.resolve(value);
  } else throw new Error(`unknown argument: ${flag}`);
}
if (vouchersOnly && deviceHash) throw new Error('--device-hash requires full mode.');
if (!vouchersOnly && !/^[0-9a-f]{64}$/.test(deviceHash ?? '')) {
  throw new Error('Use --device-hash HASH from a fresh phone redemption, or --vouchers-only.');
}
output ??= path.join(vouchersOnly ? tmpdir() : path.join(ROOT, 'scripts/out'), `sow-run-${Date.now()}`);
const confirmations = `${output}-confirmations`;
const replay = `${output}-device-replay`;
for (const directory of [output, confirmations, ...(!vouchersOnly ? [replay] : [])]) {
  if (fs.existsSync(directory)) throw new Error(`${directory} already exists. Choose a new output directory.`);
}
const report = {
  producedBy: 'scripts/run-sow-evidence.mjs', producedAt: new Date().toISOString(),
  scope: vouchersOnly ? 'vouchers-only' : 'transactions-device-replay-and-confirmations', complete: false,
  archives: { transactions: '.', confirmations: path.relative(output, confirmations), ...(!vouchersOnly ? { replay: path.relative(output, replay) } : {}) },
  humanEvidence: 'Phone actions, merchant screen, phone void, and video require separate capture.',
};

function run(script, options) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...options], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed with ${result.signal ?? result.status}.`);
}

function requireComplete(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.complete !== true) throw new Error(`${directory} is incomplete.`);
}

try {
  run('run-evidence.mjs', [
    '--output', output,
    ...(vouchersOnly ? ['--vouchers-only'] : ['--device-hash', deviceHash, '--replay-output', replay]),
  ]);
  requireComplete(output);
  if (!vouchersOnly) requireComplete(replay);
  run('run-confirmation.mjs', [
    '--evidence', output, '--output', confirmations,
    ...(!vouchersOnly ? ['--device-confirmation'] : []),
  ]);
  requireComplete(confirmations);
  report.complete = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'run.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Run status: ${path.join(output, 'run.json')}`);
}
