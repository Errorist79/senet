// Report what the event listener is doing, and fail when it falls behind.
//
//   node deploy/listener-check.mjs [/opt/senet/state/listener.json]
//
// The check reads the cursor that the listener stored and asks the RPC where
// the chain is now. It derives the ledger from the cursor rather than from any
// ledger number that the file also carries. A copy of a derived value can
// disagree with its own source, and the cursor is the source.
//
// The one number that matters most is the last: how many ledgers of margin the
// cursor still has before it falls out of the range that the RPC keeps. A
// listener that stops during a quiet week does not fail while it is stopped. It
// fails at the next redemption, and by then the events between are gone.

import { existsSync, readFileSync, statSync } from 'node:fs';

/** The RPC that the deployment reads, when the caller names none. */
const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

/** Where the deployment keeps the cursor. */
const DEFAULT_STATE_FILE = '/opt/senet/state/listener.json';

/**
 * The shape of a cursor: a 19-character TOID, a hyphen, and a 10-character
 * event index. Verified against the getEvents reference and against a cursor
 * that the testnet RPC returned.
 */
const CURSOR_SHAPE = /^\d{19}-\d{10}$/;

/** The TOID carries the ledger in its high 32 bits. */
const TOID_LEDGER_SHIFT = 32n;

/** The network targets a close time of five seconds. */
const SECONDS_PER_LEDGER = 5;

/**
 * How far behind the chain the cursor may fall before this check fails.
 *
 * Ten minutes of ledgers. A poller that reads every few seconds stays within a
 * handful, so this value catches a stopped listener without failing on one slow
 * poll.
 */
const LAG_LEDGERS_MAX = 120;

/**
 * How long the state file may go untouched before this check fails.
 *
 * A running listener stores the cursor after every batch, including a batch
 * with no events, so the file changes even while nothing is redeemed. A file
 * that has not changed for this long means the listener is not running.
 */
const STATE_AGE_MAX_MS = 10 * 60 * 1000;

// The margin that the cursor keeps inside the retained range is reported below
// rather than checked. It cannot be a gate. The lag and the margin add up to
// the retention window itself, so a margin small enough to matter needs a lag
// of more than a hundred thousand ledgers, and the lag check fails at 120. A
// gate that another gate always reaches first proves nothing.
//
// The number is still worth printing, because it answers the question that an
// operator asks after a failure: how long is there to repair this before the
// unread events are gone.

let failures = 0;

function check(condition, message) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!condition) failures += 1;
}

/** Read the state file, or say why it cannot be read. */
function readState(path) {
  if (!existsSync(path)) {
    return { problem: `${path} does not exist, so the listener has never stored a cursor` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { problem: `${path} does not hold JSON: ${detail}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { problem: `${path} holds ${JSON.stringify(parsed)}, which is not a state object` };
  }
  const { cursor, updatedAt } = parsed;
  if (typeof cursor !== 'string') return { problem: `${path} names no cursor` };
  if (typeof updatedAt !== 'string') return { problem: `${path} names no updatedAt` };
  return { cursor, updatedAt, changedAtMs: statSync(path).mtimeMs };
}

async function health(rpcUrl) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: {} }),
  });
  if (!response.ok) throw new Error(`the RPC answered ${response.status}`);
  const body = await response.json();
  if (body === null || typeof body !== 'object' || !('result' in body)) {
    throw new Error('the RPC answered without a result');
  }
  const { result } = body;
  const { latestLedger, oldestLedger } = result;
  if (typeof latestLedger !== 'number' || typeof oldestLedger !== 'number') {
    throw new Error('the RPC named no ledger range');
  }
  return { latestLedger, oldestLedger };
}

/** Say how long ago, in words a person reads faster than a number of seconds. */
function ago(ledgers) {
  const seconds = ledgers * SECONDS_PER_LEDGER;
  if (seconds < 120) return `${seconds} seconds`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${(seconds / 86_400).toFixed(1)} days`;
}

const statePath = process.argv[2] ?? process.env['LISTENER_STATE_FILE'] ?? DEFAULT_STATE_FILE;
const rpcUrl = process.env['RPC_URL'] ?? DEFAULT_RPC_URL;

console.log(`reading ${statePath}`);
console.log(`asking  ${rpcUrl}\n`);

const state = readState(statePath);
if (state.problem !== undefined) {
  console.log(`  FAIL  ${state.problem}`);
  console.log('\n1 check failed. The listener has no usable cursor.');
  process.exit(1);
}

check(CURSOR_SHAPE.test(state.cursor), `the cursor ${state.cursor} carries the documented shape`);
if (!CURSOR_SHAPE.test(state.cursor)) {
  console.log('\nThe cursor is unreadable, so nothing below it can be measured.');
  process.exit(1);
}

const [toid] = state.cursor.split('-');
const cursorLedger = Number(BigInt(toid) >> TOID_LEDGER_SHIFT);

let range;
try {
  range = await health(rpcUrl);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.log(`  FAIL  the RPC did not answer: ${detail}`);
  console.log('\n1 check failed. The chain position is unknown, not proved good.');
  process.exit(1);
}

const lag = range.latestLedger - cursorLedger;
const margin = cursorLedger - range.oldestLedger;
const fileAgeMs = Date.now() - state.changedAtMs;

console.log(`  cursor    ${state.cursor}`);
console.log(`  at ledger ${cursorLedger}`);
console.log(`  chain     ${range.oldestLedger} to ${range.latestLedger}`);
console.log(`  stored    ${state.updatedAt}\n`);

check(cursorLedger <= range.latestLedger,
  `the cursor is not ahead of the chain`);
check(cursorLedger >= range.oldestLedger,
  `the cursor is inside the range that the RPC still holds`);
check(lag <= LAG_LEDGERS_MAX,
  `the listener is ${lag} ledgers behind, which is ${ago(lag)} (the limit is ${LAG_LEDGERS_MAX})`);
check(fileAgeMs <= STATE_AGE_MAX_MS,
  `the cursor was written ${Math.round(fileAgeMs / 1000)} seconds ago (the limit is ${STATE_AGE_MAX_MS / 1000})`);
console.log(`\n  the RPC still holds everything the cursor has not read, and it forgets`);
console.log(`  the oldest of it in ${ago(margin)}. That is the time to repair a failure above.`);

console.log(`\n4 checks, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('the listener holds a cursor that the RPC can still serve');
