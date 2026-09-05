// Archive the webhook messages that the listener delivers for real redemptions.
//
//   node scripts/run-confirmation.mjs [--list]
//
// The funded promise is the merchant screen confirming from the event feed,
// with the webhook output. This command produces the second half of that: the
// messages themselves, captured as a receiver got them, paired with the
// redemptions they report.
//
// It redeems nothing. The evidence set already holds redemptions, so this reads
// the chain over the window that contains them and archives what the listener
// posts. Redeeming again here would duplicate the machinery that produces those
// rows, and two copies of it would disagree the first time one changed.
//
// What a row proves is written into the archive's own type. The message agrees
// with a transaction that we did not write, and it arrived after the ledger
// that carries the event closed. It is not proof that a particular listener
// sent it, and the archive says so rather than letting a reader assume more.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Networks } from '@stellar/stellar-sdk';
import {
  CONFIRM_CHECK_DIR, ENDPOINTS, EVIDENCE_DIR, ROOT, archiveRow, deriveDeliveryClaims, loadEnv,
  readManifest, writeManifest,
} from './evidence-set.mjs';

/**
 * The rows that this command produces, one for each redemption it confirms.
 *
 * The names follow the evidence rows they confirm, so a reader can put the two
 * side by side. The list is fixed rather than discovered, because a check that
 * asks what this command produces must get an answer with no network, no keys
 * and no environment file.
 */
export const PRODUCED_ROWS = Object.freeze([
  'confirm-1a-success',
  'confirm-8-void-success',
  'confirm-lifetime-5m',
  'confirm-lifetime-15m',
  'confirm-lifetime-1h',
  'confirm-lifetime-12h',
]);

/** The evidence row that each confirmation row reports. */
const CONFIRMS = Object.freeze({
  'confirm-1a-success': '1a-success',
  'confirm-8-void-success': '8-void-success',
  'confirm-lifetime-5m': 'lifetime-5m',
  'confirm-lifetime-15m': 'lifetime-15m',
  'confirm-lifetime-1h': 'lifetime-1h',
  'confirm-lifetime-12h': 'lifetime-12h',
});

if (process.argv.includes('--list')) {
  for (const name of PRODUCED_ROWS) console.log(name);
  process.exit(0);
}

/** The port that this run's receiver holds. */
const PORT = 8894;

/** How far before the earliest redemption the listener starts reading. */
const LEDGERS_BEFORE = 50;

/** The listener, in the mode that reads to the head of the chain and exits. */
const LISTENER = 'server/dist/tools/listen.js';

const CAPTURE_DIR = path.join(CONFIRM_CHECK_DIR, 'captures');
const STATE_FILE = path.join(CONFIRM_CHECK_DIR, 'listener.json');

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function startReceiver() {
  const child = spawn('node', [
    'scripts/webhook-receiver.mjs', '--port', String(PORT), '--dir', CAPTURE_DIR,
  ], { cwd: ROOT });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/ready`);
      return child;
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  }
  child.kill('SIGTERM');
  throw new Error('the receiver never answered');
}

/** Every message that the receiver captured, read back with its envelope. */
function captured() {
  if (!fs.existsSync(CAPTURE_DIR)) return [];
  return fs.readdirSync(CAPTURE_DIR)
    .filter((name) => name.startsWith('webhook-'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, name), 'utf8')))
    .map((delivery) => {
      try {
        return { delivery, message: JSON.parse(delivery.body) };
      } catch {
        return { delivery, message: null };
      }
    })
    .filter((each) => each.message !== null && typeof each.message.tx_hash === 'string');
}

loadEnv();

if (!fs.existsSync(path.join(EVIDENCE_DIR, 'manifest.json'))) {
  console.error('the evidence set holds no manifest, so there is no redemption to confirm');
  console.error('run: node scripts/run-evidence.mjs');
  process.exit(1);
}
const evidence = readManifest(EVIDENCE_DIR);
const wanted = new Map();
for (const [name, confirms] of Object.entries(CONFIRMS)) {
  const row = evidence.rows.find((each) => each.name === confirms);
  if (row !== undefined) wanted.set(row.hash, { name, confirms });
}
if (wanted.size === 0) {
  console.error('the evidence set holds none of the redemptions that this command confirms');
  process.exit(1);
}

// Read from a little before the earliest redemption in the set. One request
// scans about ten thousand ledgers, so a window this narrow reaches every row.
const ledgers = [];
for (const hash of wanted.keys()) {
  const archived = path.join(EVIDENCE_DIR, `${evidence.rows.find((r) => r.hash === hash).name}.json`);
  const row = JSON.parse(fs.readFileSync(archived, 'utf8'));
  if (typeof row.horizon?.ledger === 'number') ledgers.push(row.horizon.ledger);
}
const from = Math.min(...ledgers) - LEDGERS_BEFORE;

fs.rmSync(CONFIRM_CHECK_DIR, { recursive: true, force: true });
fs.mkdirSync(CAPTURE_DIR, { recursive: true });

console.log(`confirming ${wanted.size} redemptions`);
console.log(`reading the chain from ledger ${from}\n`);

const receiver = await startReceiver();
let listener;
try {
  listener = await run('node', [LISTENER], {
    WEBHOOK_URL: `http://127.0.0.1:${PORT}/redemption`,
    LISTENER_STATE_FILE: STATE_FILE,
    LISTENER_START_LEDGER: String(from),
  });
} finally {
  receiver.kill('SIGTERM');
  await new Promise((resolve) => { setTimeout(resolve, 300); });
}

if (listener.code !== 0) {
  console.error('the listener did not finish, so no message can be archived');
  console.error(listener.output.split('\n').slice(-6).join('\n'));
  process.exit(1);
}

const messages = captured();
console.log(`the listener delivered ${messages.length} messages\n`);

const rows = [];
for (const { delivery, message } of messages) {
  const match = wanted.get(message.tx_hash);
  if (match === undefined) continue;
  rows.push({
    name: match.name,
    hash: message.tx_hash,
    note: `The listener read this redemption from the chain and posted it. The `
      + `merchant screen confirms from this feed rather than from the reply to `
      + `its own submission. It reports the evidence row ${match.confirms}.`,
    producer: 'script',
    delivery,
  });
  console.log(`${match.name.padEnd(26)} ${message.tx_hash}`);
}

const missing = PRODUCED_ROWS.filter((name) => !rows.some((row) => row.name === name));
for (const name of missing) {
  console.log(`${name.padEnd(26)} NOT DELIVERED, so no row is written for it`);
}

if (rows.length === 0) {
  console.error('\nno message reported a redemption that this command confirms');
  process.exit(1);
}

rows.sort((left, right) => left.name.localeCompare(right.name));
const manifest = {
  network: process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET,
  contractId: evidence.contractId,
  producedAt: new Date().toISOString(),
  producedBy: 'scripts/run-confirmation.mjs',
  rows,
};
writeManifest(CONFIRM_CHECK_DIR, manifest);
console.log('\narchiving');
for (const row of rows) await archiveRow(CONFIRM_CHECK_DIR, row, manifest.contractId, ENDPOINTS);

const checked = deriveDeliveryClaims(CONFIRM_CHECK_DIR, manifest);
console.log(`\n${checked.checked} comparisons against the chain`);
for (const problem of checked.problems) console.log(`  PROBLEM ${problem}`);
if (checked.problems.length > 0) process.exitCode = 1;
else console.log(`every message agrees with the transaction it reports`);
