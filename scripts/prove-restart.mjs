// Prove that the listener keeps its promise across a restart.
//
//   node scripts/prove-restart.mjs
//
// The promise has two halves and a stop between them. A restart must not repeat
// a redemption that a receiver already accepted, and it must not skip one that
// happened while the listener was not running. Those two pull against each
// other: a cursor stored too early repeats, and a cursor stored too late skips.
//
// The proof drives real events that this contract already emitted, so it costs
// no fee and it runs the same way twice. It needs the events to be inside the
// window that the RPC keeps.
//
// The stop is a receiver that refuses. That is the honest shape of a listener
// that goes down mid-batch, and it leaves the cursor where a crash would.
//
// Every phase below states what it expects before it runs. A phase that gets
// something else stops the proof, because a later phase would then measure a
// state that the proof did not create.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUT_DIR, ROOT, loadEnv, requireEnv } from './evidence-set.mjs';

/** Where the proof keeps its captures and its cursor. */
const PROOF_DIR = path.join(OUT_DIR, 'restart-proof');
const CAPTURE_DIR = path.join(PROOF_DIR, 'captures');
const STATE_FILE = path.join(PROOF_DIR, 'listener.json');

/** The port that the proof's receiver holds. */
const PORT = 8893;

/**
 * How many ledgers of history the proof reads.
 *
 * One getEvents request scans about ten thousand ledgers and then answers,
 * measured against this network. A request that starts further back than that
 * returns an empty page with a cursor, and the empty page means that nothing
 * matched inside the scanned span rather than that the chain holds no more
 * events. The proof therefore reads a window that one request covers, so a
 * single run of the listener reaches the events rather than stopping short of
 * them.
 */
const HISTORY_LEDGERS = 9_000;

/** The listener, in the mode that reads to the end of the chain and exits. */
const LISTEN = ['server/dist/tools/listen.js'];

let receiver = null;

/** Run one command to completion and give back what it printed. */
function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** Start a receiver that accepts a given number of messages and refuses the rest. */
async function startReceiver(acceptLimit) {
  await stopReceiver();
  const args = ['scripts/webhook-receiver.mjs', '--port', String(PORT), '--dir', CAPTURE_DIR];
  if (Number.isFinite(acceptLimit)) args.push('--accept', String(acceptLimit));
  receiver = spawn('node', args, { cwd: ROOT });
  // Wait for the port rather than for a length of time. A fixed wait either
  // costs more than it needs or fails on a slow machine.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/ready`);
      return;
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  }
  throw new Error('the receiver never answered');
}

async function stopReceiver() {
  if (receiver === null) return;
  receiver.kill('SIGTERM');
  receiver = null;
  await new Promise((resolve) => { setTimeout(resolve, 200); });
}

/** Every event identifier that a receiver accepted, in the order it accepted them. */
function accepted() {
  if (!existsSync(CAPTURE_DIR)) return [];
  return readdirSync(CAPTURE_DIR)
    .filter((name) => name.startsWith('webhook-'))
    .map((name) => JSON.parse(readFileSync(path.join(CAPTURE_DIR, name), 'utf8')))
    .map((capture) => ({ ...JSON.parse(capture.body), receivedAt: capture.receivedAt }))
    // A message without an event identifier is not a redemption message, and
    // counting one would let the proof measure something it produced itself.
    .filter((message) => typeof message.event_id === 'string')
    .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
}

function cursorNow() {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

let failures = 0;
function expect(condition, message) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!condition) failures += 1;
  return condition;
}

loadEnv();
const contractId = requireEnv('CONTRACT_ID');
process.env['WEBHOOK_URL'] = `http://127.0.0.1:${PORT}/redemption`;
process.env['LISTENER_STATE_FILE'] = STATE_FILE;

rmSync(PROOF_DIR, { recursive: true, force: true });
mkdirSync(CAPTURE_DIR, { recursive: true });

const rpcUrl = process.env['RPC_URL'] ?? 'https://soroban-testnet.stellar.org';
const health = await (await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: {} }),
})).json();
const from = Math.max(health.result.oldestLedger, health.result.latestLedger - HISTORY_LEDGERS);
process.env['LISTENER_START_LEDGER'] = String(from);

console.log(`contract ${contractId}`);
console.log(`reading from ledger ${from} to ${health.result.latestLedger}`);
console.log(`captures in ${CAPTURE_DIR}\n`);

// Check the premise before measuring anything. A proof that runs against a
// window with no redemption in it reports that nothing repeated and nothing
// was skipped, which is true and worthless.
const available = await (await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getEvents',
    params: {
      startLedger: from,
      filters: [{ type: 'contract', contractIds: [contractId] }],
      pagination: { limit: 200 },
    },
  }),
})).json();
const inWindow = available.result?.events?.length ?? 0;
console.log(`the window holds ${inWindow} events of this contract`);
if (inWindow < 2) {
  console.log('\nThe proof needs at least two redemptions inside one scan of the window.');
  console.log('Redeem two vouchers, then run this again.');
  process.exit(1);
}
console.log('');

// Phase 1. A receiver that refuses after the first message. The listener must
// deliver one, then hold the cursor at that one event.
console.log('phase 1: the receiver accepts one message and then refuses');
await startReceiver(1);
const first = await run('node', LISTEN, {});
await stopReceiver();

const afterFirst = accepted();
if (!expect(afterFirst.length === 1, `the receiver accepted ${afterFirst.length} message, and the proof needs 1`)) {
  console.log('\n  The contract emitted no redemption in this window, or it emitted only one.');
  console.log('  The proof needs at least two events inside the retained range.');
  process.exit(1);
}
const held = cursorNow();
expect(held !== null, 'the listener stored a cursor before it stopped');
expect(first.output.includes('stuck') || first.code === 0,
  'the listener ended without a crash when the receiver refused');
const firstEvent = afterFirst[0].event_id;
console.log(`  delivered ${firstEvent}`);
console.log(`  cursor    ${held?.cursor}\n`);

// Phase 2. The break, first. A cursor rewound behind the delivered event must
// make the listener repeat it. If this does not repeat, the proof cannot tell a
// working cursor from a broken one, and phase 3 would mean nothing.
console.log('phase 2: the cursor is rewound on purpose, and the repeat must happen');
// The rewind has to name a ledger that the RPC still holds. A cursor from
// before the retained range is a different failure entirely: the listener exits
// on the aged-out path and delivers nothing, which would look like the absence
// of a repeat rather than the presence of one.
const rewound = `${(BigInt(from) << 32n).toString().padStart(19, '0')}-0000000000`;
writeFileSync(STATE_FILE, `${JSON.stringify({ cursor: rewound })}\n`);
console.log(`  the cursor is set back to ${rewound}, at ledger ${from}`);
rmSync(CAPTURE_DIR, { recursive: true, force: true });
mkdirSync(CAPTURE_DIR, { recursive: true });
await startReceiver(Infinity);
await run('node', LISTEN, { LISTENER_START_LEDGER: String(from) });
await stopReceiver();
const afterRewind = accepted();
const repeated = afterRewind.some((message) => message.event_id === firstEvent);
expect(repeated,
  `the rewound cursor delivered ${firstEvent} again, so this proof can see a repeat`);
console.log(`  the rewind delivered ${afterRewind.length} messages\n`);

// Phase 3. The honest restart. The cursor goes back to where phase 1 left it,
// the receiver accepts everything, and the listener runs again.
console.log('phase 3: the cursor is restored, and the listener starts again');
writeFileSync(STATE_FILE, `${JSON.stringify(held)}\n`);
rmSync(CAPTURE_DIR, { recursive: true, force: true });
mkdirSync(CAPTURE_DIR, { recursive: true });
await startReceiver(Infinity);
const second = await run('node', LISTEN, {});
await stopReceiver();

const afterRestart = accepted();
const ids = afterRestart.map((message) => message.event_id);
expect(!ids.includes(firstEvent),
  `the restart did not repeat ${firstEvent}, which the receiver had already accepted`);
expect(ids.length === new Set(ids).size,
  `the restart delivered ${ids.length} messages and none of them twice`);
expect(ids.length > 0,
  `the restart delivered the ${ids.length} redemptions that came after the cursor`);
expect(second.code === 0, 'the listener read to the end of the chain and exited');

const finalCursor = cursorNow();
expect(finalCursor !== null && finalCursor.cursor !== held?.cursor,
  'the cursor moved past the event that the listener stopped on');

console.log(`\n  before the stop   ${held?.cursor}`);
console.log(`  after the restart ${finalCursor?.cursor}`);
console.log(`  delivered after the restart: ${ids.length}`);

console.log(`\n${failures === 0 ? 'the cursor survived the restart, with no repeat and no gap'
  : `${failures} checks failed`}`);
process.exit(failures === 0 ? 0 : 1);
