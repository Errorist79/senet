// Report what the event listener is doing, and fail when it falls behind.
//
//   node deploy/listener-check.mjs [/opt/senet/state/listener.json]
//
// The check reads the cursor that the listener stored and asks the RPC where
// the chain is now. It derives the ledger from the cursor rather than from any
// ledger number that the file also carries. A copy of a derived value can
// disagree with its own source, and the cursor is the source.
//
// Lag here is not a traffic signal. It is purely a stall signal, and every
// state it reports is an incident.
//
// That holds because a poll which matches no event still returns a cursor at
// the chain head, and the listener stores the position at the end of every
// batch including an empty one. The cursor therefore tracks the head while
// nothing is redeemed. A listener that is behind has stopped, or it holds the
// cursor because it cannot deliver, and the report below names which.
//
// This is worth stating plainly, because an operator who thinks lag might mean
// quiet traffic will wait before acting, and the waiting is the expensive part.
//
// The last number is the time left to repair a failure, which is how long the
// RPC still keeps what the listener has not read.

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
 *
 * This reads the modification time rather than a stamp inside the file. A
 * process that has stopped writing cannot refresh either one, but a process
 * with a stuck writer could still refresh a stamp it holds in memory.
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
  const { cursor, stuckOn } = parsed;
  if (typeof cursor !== 'string') return { problem: `${path} names no cursor` };
  // The age comes from the modification time of the file and not from a time
  // written inside it. The listener writes the position and nothing else, and
  // a stamp that a process writes about itself is a claim, while the time the
  // kernel recorded for the write is a fact.
  return {
    cursor,
    stuckOn: typeof stuckOn === 'string' ? stuckOn : null,
    changedAtMs: statSync(path).mtimeMs,
  };
}

async function health(rpcUrl) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: {} }),
  });
  if (!response.ok) throw new Error(`the RPC answered ${response.status}`);
  const body = await response.json();
  if (body === null || typeof body !== 'object') throw new Error('the RPC answered no object');
  // A JSON-RPC refusal arrives as HTTP 200 with an `error` member, and that
  // member is a plain object rather than an Error. Reading it through the
  // fields is the only way to keep what it says. A reader that tested it with
  // `instanceof Error` would report nothing and hide the reason.
  if ('error' in body) {
    const failure = body.error;
    const detail = failure !== null && typeof failure === 'object' && 'message' in failure
      ? String(failure.message)
      : JSON.stringify(failure);
    const code = failure !== null && typeof failure === 'object' && 'code' in failure
      ? ` (${String(failure.code)})`
      : '';
    throw new Error(`the RPC refused the request${code}: ${detail}`);
  }
  if (!('result' in body)) throw new Error('the RPC answered without a result');
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
console.log(`  written   ${new Date(state.changedAtMs).toISOString()}\n`);

// A quiet chain does not make the listener look behind. A poll that matches no
// event still returns a cursor at the chain head, measured against this
// contract over a silent window, so the cursor tracks the head while nothing is
// redeemed. Lag therefore never reports quiet traffic. It reports a listener
// that stopped, or one that is holding the cursor because it cannot deliver.
// Both are incidents, which is what makes this check worth gating on.
check(state.stuckOn === null,
  state.stuckOn === null
    ? 'the listener is not held on an event that it cannot deliver'
    : `the listener cannot deliver event ${state.stuckOn}, and it holds the cursor there`);

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

// Name the state rather than leaving a reader to assemble it from five lines.
// A stopped listener and a listener that cannot deliver both show as lag, and
// the repair is different for each.
if (failures > 0) {
  const behind = lag > LAG_LEDGERS_MAX;
  const silent = fileAgeMs > STATE_AGE_MAX_MS;
  if (state.stuckOn !== null) {
    console.log(`\n  the listener is running and cannot deliver ${state.stuckOn}.`);
    console.log('  Repair the receiver. The listener resumes at that event on its own.');
  } else if (cursorLedger < range.oldestLedger) {
    console.log('\n  the cursor is older than the range that the RPC holds.');
    console.log('  The events between are gone. This needs a person, and the unit stays down.');
  } else if (silent && behind) {
    console.log('\n  the listener is not running. Nothing has written the position, and it is behind.');
    console.log('  Read: journalctl -u senet-listener -n 50');
  } else if (silent) {
    console.log('\n  nothing has written the position lately, but the cursor is still at the head.');
    console.log('  The listener stopped a moment ago, or it writes less often than this check allows.');
  }
}

console.log(`\n5 checks, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('the listener holds a cursor that the RPC can still serve');
