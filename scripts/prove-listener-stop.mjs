// Prove that the listener stops for good only on a cursor that aged out.
//
//   ENV_FILE=/opt/senet/.env node scripts/prove-listener-stop.mjs
//
// The RPC gives code -32600 to a cursor that aged out. It gives the same code
// to a cursor that is newer than the head of the instance that answers. That
// second refusal clears when the head passes the cursor. A listener that
// stopped for good on the code alone stopped the merchant feed on a cursor that
// was two seconds old.
//
// The proof plants a cursor in a state file of its own and runs the built
// listener against the RPC. It never reads or writes the state file of a
// deployment. Three steps:
//
// 1. A cursor a few ledgers past the head. The listener must exit with 1, so
//    that the service manager starts it again.
// 2. The same cursor, after the head passes it. The listener must read on and
//    exit with 0. The refusal in step 1 therefore cleared on its own.
// 3. A cursor older than the retained range. The listener must exit with 78,
//    so that the service manager leaves it down for a person.
//
// Steps 1 and 3 get the same code from the RPC, and the proof checks that.
// Only the exit status differs.
//
// The listener reads the whole service configuration before it polls. The
// proof therefore needs the environment file of a deployment, and ENV_FILE
// names it. The proof replaces the state file and the webhook address in that
// environment with its own.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT_CURSOR_AGED_OUT } from '@senet/server';
import { OUT_DIR, ROOT, RPC_URL } from './evidence-set.mjs';

/** Where the proof keeps its cursor. */
const PROOF_DIR = path.join(OUT_DIR, 'stop-proof');
const STATE_FILE = path.join(PROOF_DIR, 'listener.json');

/**
 * Where the listener posts. Nothing listens there.
 *
 * No step reads a ledger with a redemption in it. A redemption can still land
 * in the short span of step 2. Its post then fails, and the listener says
 * `stuck on` in the output that this proof prints.
 */
const WEBHOOK_URL = 'http://127.0.0.1:9/redemption';

/**
 * How far past the head the proof puts its first cursor, in ledgers.
 *
 * Six ledgers are about thirty seconds. Step 1 meets the refusal well inside
 * that time, and step 2 waits no longer than that for the head.
 */
const AHEAD = 6;

/** How far before the oldest retained ledger the aged-out cursor sits. */
const BEHIND = 100;

/**
 * How many runs step 2 allows.
 *
 * The service manager starts a failed listener again, so a second run here is
 * what the service does. Each run that this step needs is in the report.
 */
const RUNS_TO_CATCH_UP = 3;

/** The listener, in the mode that reads to the end of the chain and exits. */
const LISTEN = path.join(ROOT, 'server', 'dist', 'tools', 'listen.js');

async function rpc(method) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
  });
  const body = await response.json();
  if (body.result === undefined) throw new Error(`${method} refused: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** A cursor at the end of one ledger, in the shape that the RPC issues. */
function cursorAt(ledger) {
  return `${(BigInt(ledger) << 32n).toString().padStart(19, '0')}-4294967295`;
}

function plant(ledger) {
  writeFileSync(STATE_FILE, `${JSON.stringify({ cursor: cursorAt(ledger) })}\n`);
}

function listen() {
  const result = spawnSync(process.execPath, [LISTEN], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LISTENER_STATE_FILE: STATE_FILE, WEBHOOK_URL },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

let failures = 0;
function expect(condition, message) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!condition) failures += 1;
}

/** Print what the listener said, so that a reader sees the refusal itself. */
function show(run) {
  for (const line of run.output.trim().split('\n')) console.log(`        | ${line}`);
}

rmSync(PROOF_DIR, { recursive: true, force: true });
mkdirSync(PROOF_DIR, { recursive: true });
console.log(`asking ${RPC_URL}`);
console.log(`cursor ${STATE_FILE}\n`);

const start = await rpc('getHealth');
const ahead = start.latestLedger + AHEAD;
console.log(`step 1: a cursor at ledger ${ahead}, ${AHEAD} ledgers past the head ${start.latestLedger}`);
plant(ahead);
const first = listen();
show(first);
expect(first.output.includes('-32600'), 'the RPC refused the cursor with -32600');
expect(first.code === 1, `the listener exited with ${first.code}, and 1 lets the service manager start it again`);

console.log(`\nstep 2: the same cursor, after the head passes ledger ${ahead}`);
for (;;) {
  const { sequence } = await rpc('getLatestLedger');
  if (sequence > ahead) break;
  await new Promise((done) => { setTimeout(done, 2000); });
}
const codes = [];
for (let run = 0; run < RUNS_TO_CATCH_UP; run += 1) {
  const again = listen();
  codes.push(again.code);
  if (again.code === 0) break;
  show(again);
}
expect(codes.at(-1) === 0,
  `the listener exited with ${codes.join(', then ')}, and it read on from the cursor of step 1`);

const now = await rpc('getHealth');
const aged = now.oldestLedger - BEHIND;
console.log(`\nstep 3: a cursor at ledger ${aged}, ${BEHIND} ledgers before the oldest retained ledger ${now.oldestLedger}`);
plant(aged);
const third = listen();
show(third);
expect(third.output.includes('-32600'), 'the RPC refused the cursor with -32600, the code from step 1');
expect(third.code === EXIT_CURSOR_AGED_OUT,
  `the listener exited with ${third.code}, and ${EXIT_CURSOR_AGED_OUT} keeps the service down for a person`);

console.log(`\n${failures === 0
  ? 'the listener stopped for good only on the cursor that aged out'
  : `${failures} checks failed`}`);
process.exit(failures === 0 ? 0 : 1);
