// Capture webhook evidence for the redemptions in one transaction archive.
// Each run keeps prior archives and writes its completion status.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CONFIRMS = Object.freeze({
  'confirm-1a-success': '1a-success',
  'confirm-8-void-success': '8-void-success',
  'confirm-lifetime-5m': 'lifetime-5m',
  'confirm-lifetime-15m': 'lifetime-15m',
  'confirm-lifetime-1h': 'lifetime-1h',
  'confirm-lifetime-12h': 'lifetime-12h',
});
const DEVICE_CONFIRMATION = 'confirm-passkey-fresh';
const DEVICE_ROW = 'passkey-fresh';
export const PRODUCED_ROWS = Object.freeze(Object.keys(CONFIRMS));
if (process.argv.includes('--list')) {
  console.log([...PRODUCED_ROWS, ...(process.argv.includes('--device-confirmation') ? [DEVICE_CONFIRMATION] : [])].join('\n'));
  process.exit(0);
}

const { Networks } = await import('@stellar/stellar-sdk');
const { ENDPOINTS, OUT_DIR, ROOT, archiveRow, deriveDeliveryClaims, loadEnv, readManifest, writeManifest } =
  await import('./evidence-set.mjs');
const PORT = 8894;
const LEDGERS_BEFORE = 50;
const RECEIVER_TIMEOUT_MS = 5000;
const LISTENER = 'server/dist/tools/listen.js';
const args = process.argv.slice(2);
let evidenceDirectory;
let outputDirectory;
let deviceConfirmation = false;
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  if (flag === '--device-confirmation') deviceConfirmation = true;
  else if (flag === '--evidence' || flag === '--output') {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag === '--evidence') evidenceDirectory = path.resolve(value);
    else outputDirectory = path.resolve(value);
  } else throw new Error(`unknown argument: ${flag}`);
}
if (!evidenceDirectory) throw new Error('Use --evidence DIRECTORY to select the transaction archive.');
outputDirectory ??= path.join(OUT_DIR, `confirmation-run-${Date.now()}`);
if (fs.existsSync(outputDirectory)) throw new Error(`${outputDirectory} already exists. Choose a new output directory.`);
loadEnv();
const header = JSON.parse(fs.readFileSync(path.join(evidenceDirectory, 'manifest.json'), 'utf8'));
if (header.complete === false) throw new Error('The transaction archive is incomplete.');
const evidence = readManifest(evidenceDirectory);
if (evidence.network !== Networks.TESTNET) throw new Error('Confirmation evidence requires testnet.');
deviceConfirmation ||= evidence.rows.some((row) => row.name === DEVICE_ROW);
const confirms = { ...CONFIRMS, ...(deviceConfirmation ? { [DEVICE_CONFIRMATION]: DEVICE_ROW } : {}) };
const wanted = new Map();
const ledgers = [];
for (const [name, sourceName] of Object.entries(confirms)) {
  const row = evidence.rows.find((each) => each.name === sourceName);
  if (!row) throw new Error(`The transaction archive lacks ${sourceName}.`);
  if (wanted.has(row.hash)) throw new Error('Each confirmation must name a separate redemption.');
  const archived = JSON.parse(fs.readFileSync(path.join(evidenceDirectory, `${sourceName}.json`), 'utf8'));
  if (!Number.isInteger(archived.horizon?.ledger) || archived.horizon.ledger < 1
      || archived.horizon.successful !== true || archived.hash !== row.hash) {
    throw new Error(`${sourceName} lacks a matching successful ledger archive.`);
  }
  ledgers.push(archived.horizon.ledger);
  wanted.set(row.hash, { name, sourceName });
}
const from = Math.max(1, Math.min(...ledgers) - LEDGERS_BEFORE);
fs.mkdirSync(path.dirname(outputDirectory), { recursive: true });
fs.mkdirSync(outputDirectory);
const captureDirectory = path.join(outputDirectory, 'captures');
const manifest = {
  network: evidence.network, contractId: evidence.contractId, producedAt: new Date().toISOString(),
  producedBy: 'scripts/run-confirmation.mjs',
  producedArgs: deviceConfirmation ? ['--device-confirmation'] : [],
  sourceEvidence: path.relative(outputDirectory, evidenceDirectory),
  scope: deviceConfirmation ? 'transactions-and-device-confirmations' : 'transaction-confirmations',
  complete: false, missing: Object.keys(confirms), rows: [],
};
writeManifest(outputDirectory, manifest);
console.log(`archive ${outputDirectory}`);
console.log(`confirming ${wanted.size} redemptions from ledger ${from}`);

function startReceiver() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'scripts/webhook-receiver.mjs', '--port', String(PORT), '--dir', captureDirectory,
    ], { cwd: ROOT });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('The receiver did not start.'));
    }, RECEIVER_TIMEOUT_MS);
    let output = '';
    child.stderr.resume();
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', () => { clearTimeout(timeout); reject(new Error('The receiver stopped.')); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(`the receiver holds 127.0.0.1:${PORT}`)) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
  });
}

function listen() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LISTENER], {
      cwd: ROOT,
      env: {
        ...process.env, CONTRACT_ID: evidence.contractId, NETWORK_PASSPHRASE: evidence.network,
        WEBHOOK_URL: `http://127.0.0.1:${PORT}/redemption`,
        LISTENER_STATE_FILE: path.join(outputDirectory, 'listener.json'), LISTENER_START_LEDGER: String(from),
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`The listener failed.\n${output.split('\n').slice(-6).join('\n')}`));
      else resolve();
    });
  });
}

try {
  const receiver = await startReceiver();
  try {
    await listen();
  } finally {
    await new Promise((resolve) => {
      if (receiver.exitCode !== null || receiver.signalCode !== null) resolve();
      else { receiver.once('close', resolve); receiver.kill('SIGTERM'); }
    });
  }
  for (const file of fs.readdirSync(captureDirectory).filter((name) => name.startsWith('webhook-'))) {
    const delivery = JSON.parse(fs.readFileSync(path.join(captureDirectory, file), 'utf8'));
    let message;
    try { message = JSON.parse(delivery.body); } catch { continue; }
    const match = wanted.get(message?.tx_hash);
    if (!match || manifest.rows.some((row) => row.name === match.name)) continue;
    manifest.rows.push({
      name: match.name, hash: message.tx_hash, producer: 'script', delivery,
      note: `The receiver captured a webhook for ${match.sourceName}. The archive checks its content against the transaction, without proof of sender identity.`,
    });
  }
  manifest.rows.sort((left, right) => left.name.localeCompare(right.name));
  manifest.missing = Object.keys(confirms).filter((name) => !manifest.rows.some((row) => row.name === name));
  writeManifest(outputDirectory, manifest);
  for (const row of manifest.rows) {
    const archived = await archiveRow(outputDirectory, row, manifest.contractId, ENDPOINTS);
    if (!archived.rpc.envelopeXdr || !archived.rpc.resultXdr || !archived.rpc.resultMetaXdr
        || archived.horizon?.successful !== true) throw new Error(`${row.name} lacks complete successful transaction evidence.`);
  }
  const checked = deriveDeliveryClaims(outputDirectory, manifest);
  manifest.problems = checked.problems;
  if (manifest.missing.length > 0) throw new Error(`Missing deliveries: ${manifest.missing.join(', ')}`);
  if (checked.problems.length > 0) throw new Error(checked.problems.join('\n'));
  manifest.complete = true;
  console.log(`${manifest.rows.length} deliveries, ${checked.checked} comparisons against the chain`);
} catch (error) {
  manifest.error = error instanceof Error ? error.message : String(error);
  console.error(manifest.error);
  process.exitCode = 1;
} finally {
  writeManifest(outputDirectory, manifest);
}
