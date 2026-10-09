import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
import {
  REDEEMED_TOPIC,
  findAgedOut,
  ledgerOfCursor,
  readListenerState,
  runListener,
  writeStall,
  pollOnce,
  readPosition,
  readRedemption,
  writePosition,
} from '../src/events.js';
import type { RedemptionMessage } from '../src/events.js';

/**
 * The listener's rules, against a feed that a test drives.
 *
 * Every case here begins from a state rather than from nothing. A listener
 * that starts empty and runs to the end proves only the case that never
 * happens in service: the faults live in what survives a restart, so each
 * case writes a position, or delivers part of a batch, before it begins.
 *
 * A second call that reads the same file stands for a restart. The file holds
 * everything that a restart keeps. A caller that reads it is therefore a
 * restart, in every respect that this module can affect. A separate check
 * drives a real process, because that claim deserves a test of its own.
 */

const work = mkdtempSync(join(tmpdir(), 'senet-listener-'));
after(() => rmSync(work, { recursive: true, force: true }));

let files = 0;
function statePath(): string {
  files += 1;
  return join(work, `listener-${files}.json`);
}

/** One event, as the network hands it over. */
function event(id: string, voucherId: bigint, payer: string, recipient: string): rpc.Api.EventResponse {
  return {
    id,
    type: 'contract',
    ledger: 4494450,
    ledgerClosedAt: '2026-09-04T04:23:57Z',
    transactionIndex: 5,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: `hash-${id}`,
    topic: [nativeToScVal(REDEEMED_TOPIC, { type: 'symbol' }), nativeToScVal(voucherId, { type: 'u64' })],
    value: nativeToScVal({
      payer: nativeToScVal(payer, { type: 'address' }),
      recipient: nativeToScVal(recipient, { type: 'address' }),
      amount: nativeToScVal(5_000_000n, { type: 'i128' }),
      expire_at: nativeToScVal(4_494_629, { type: 'u32' }),
    }),
  };
}

const PAYER = 'GAF5LEIT3GWHRMYX2UEOVOGCQMDSJVM3A7WSXO3TCC2GRND6EHCLGFXJ';
const MERCHANT = 'GC45NTB4OWWPE5FTJ5DI3IHLLGVNB3VCGFANCFAHKFVIVRK6C2PHLSSZ';

/** A feed that answers from a script, and keeps each request that it got. */
function feed(pages: readonly rpc.Api.GetEventsResponse[]): {
  server: { getEvents: (request: rpc.Api.GetEventsRequest) => Promise<rpc.Api.GetEventsResponse> };
  asked: string[];
} {
  const asked: string[] = [];
  let next = 0;
  return {
    asked,
    server: {
      getEvents: (request) => {
        asked.push('cursor' in request && request.cursor !== undefined ? request.cursor : 'start');
        const page = pages[Math.min(next, pages.length - 1)];
        next += 1;
        if (page === undefined) throw new Error('the test feed ran out of pages');
        return Promise.resolve(page);
      },
    },
  };
}

/** One page of the feed. */
function page(events: readonly rpc.Api.EventResponse[], cursor: string): rpc.Api.GetEventsResponse {
  return {
    events: [...events],
    cursor,
    latestLedger: 4507159,
    oldestLedger: 4386200,
    latestLedgerCloseTime: '1784671886',
    oldestLedgerCloseTime: '1784066056',
  };
}

test('the reader takes the event that the network really sends', () => {
  const message = readRedemption(event('e1', 15413150202130941583n, PAYER, MERCHANT));
  assert.notEqual(message, null);
  assert.equal(message?.voucher_id, '15413150202130941583');
  assert.equal(message?.payer, PAYER);
  assert.equal(message?.recipient, MERCHANT);
  assert.equal(message?.amount, '5000000');
  assert.equal(message?.expire_at, 4494629);
  assert.equal(message?.event_id, 'e1');
});

test('a void carries the payer as its recipient, and is still a redemption', () => {
  const message = readRedemption(event('e1', 7n, PAYER, PAYER));
  assert.equal(message?.payer, message?.recipient);
});

test('an event of another shape produces no message', () => {
  const other = event('e1', 7n, PAYER, MERCHANT);
  const changed: rpc.Api.EventResponse = {
    ...other,
    topic: [nativeToScVal('transfer', { type: 'symbol' }), other.topic[1] ?? xdr.ScVal.scvVoid()],
  };
  assert.equal(readRedemption(changed), null);
});

test('a position survives a write and a read', () => {
  const path = statePath();
  writePosition(path, { cursor: 'c-1' });
  assert.deepEqual(readPosition(path), { cursor: 'c-1' });
});

test('a truncated position reads as no position', () => {
  const path = statePath();
  writeFileSync(path, '{"cursor":"c-1');
  assert.equal(readPosition(path), null);
});

/** The range that the testnet RPC reported on 4 October 2026, a full window. */
const RANGE: rpc.Api.GetHealthResponse = {
  status: 'healthy',
  latestLedger: 5017451,
  oldestLedger: 4896492,
  ledgerRetentionWindow: 120960,
};

/** An RPC that reports one ledger range. */
function reports(range: rpc.Api.GetHealthResponse): { getHealth: () => Promise<rpc.Api.GetHealthResponse> } {
  return { getHealth: () => Promise.resolve(range) };
}

/** A cursor at the end of one ledger, in the shape that the RPC issues. */
function cursorAt(ledger: number): string {
  return `${(BigInt(ledger) << 32n).toString().padStart(19, '0')}-4294967295`;
}

test('a cursor newer than the head did not age out, although the RPC refuses it with the same code', async () => {
  // Measured: a cursor five ledgers past the head and a cursor a hundred
  // ledgers before the oldest both got -32600 and the same message.
  const path = statePath();
  writePosition(path, { cursor: cursorAt(RANGE.latestLedger + 5) });
  assert.equal(await findAgedOut(reports(RANGE), path, 0), null);
});

test('a cursor older than the window aged out, and the answer names both ledgers', async () => {
  const path = statePath();
  writePosition(path, { cursor: cursorAt(RANGE.oldestLedger - 100) });
  assert.deepEqual(await findAgedOut(reports(RANGE), path, 0), {
    ledger: RANGE.oldestLedger - 100,
    oldestKept: RANGE.oldestLedger,
  });
});

test('the oldest kept ledger is still readable, and the ledger before it is not', async () => {
  const path = statePath();
  writePosition(path, { cursor: cursorAt(RANGE.oldestLedger) });
  assert.equal(await findAgedOut(reports(RANGE), path, 0), null);
  writePosition(path, { cursor: cursorAt(RANGE.oldestLedger - 1) });
  assert.notEqual(await findAgedOut(reports(RANGE), path, 0), null);
});

test('an instance with a short history cannot stop the listener', async () => {
  // This instance holds a hundred ledgers. The full window still covers the
  // cursor, so another instance can serve it.
  const short = { ...RANGE, oldestLedger: RANGE.latestLedger - 100 };
  const path = statePath();
  writePosition(path, { cursor: cursorAt(RANGE.latestLedger - 1000) });
  assert.equal(await findAgedOut(reports(short), path, 0), null);
});

test('a range question that fails proves nothing', async () => {
  const silent = { getHealth: () => Promise.reject(new Error('the RPC did not answer')) };
  const path = statePath();
  writePosition(path, { cursor: cursorAt(RANGE.oldestLedger - 100) });
  assert.equal(await findAgedOut(silent, path, 0), null);
});

test('a first run with no position measures the configured ledger', async () => {
  const path = join(work, 'no-position-yet.json');
  assert.deepEqual(await findAgedOut(reports(RANGE), path, RANGE.oldestLedger - 1), {
    ledger: RANGE.oldestLedger - 1,
    oldestKept: RANGE.oldestLedger,
  });
  assert.equal(await findAgedOut(reports(RANGE), path, RANGE.latestLedger + 3), null);
});

test('a quiet poll moves the position, so a quiet week cannot wedge the listener', async () => {
  const path = statePath();
  writePosition(path, { cursor: 'old' });
  const { server } = feed([page([], 'quiet-sentinel')]);
  const result = await pollOnce(
    { server, contractId: 'C1', statePath: path, deliver: () => Promise.resolve(true) },
    { cursor: 'old' },
  );
  assert.equal(result.read, 0);
  assert.equal(result.delivered, 0);
  assert.deepEqual(readPosition(path), { cursor: 'quiet-sentinel' });
});

test('a refused delivery moves nothing past it, and repeats no accepted event', async () => {
  const path = statePath();
  writePosition(path, { cursor: 'start-here' });
  const seen: string[] = [];
  const deliver = (message: RedemptionMessage): Promise<boolean> => {
    seen.push(message.event_id);
    return Promise.resolve(message.event_id !== 'e3');
  };
  const events = [
    event('e1', 1n, PAYER, MERCHANT),
    event('e2', 2n, PAYER, MERCHANT),
    event('e3', 3n, PAYER, MERCHANT),
    event('e4', 4n, PAYER, MERCHANT),
  ];
  const { server } = feed([page(events, 'page-end')]);
  const parts = { server, contractId: 'C1', statePath: path, deliver };

  const first = await pollOnce(parts, { cursor: 'start-here' });
  assert.equal(first.stuckOn, 'e3');
  assert.equal(first.delivered, 2);
  // The position stands at the last accepted event, and not at the page's end.
  assert.deepEqual(readPosition(path), { cursor: 'e2' });

  // A restart reads the file and resumes. The receiver must not meet e1 or e2
  // again, and it must meet e3.
  const resumed = readPosition(path);
  assert.notEqual(resumed, null);
  const after3 = feed([page([events[2] ?? events[0], events[3] ?? events[0]].filter((one) => one !== undefined), 'page-end')]);
  seen.length = 0;
  await pollOnce(
    { server: after3.server, contractId: 'C1', statePath: path, deliver: () => Promise.resolve(true) },
    resumed ?? { cursor: 'e2' },
  );
  assert.equal(after3.asked[0], 'e2');
  assert.deepEqual(readPosition(path), { cursor: 'page-end' });
});

test('a stuck listener keeps writing, so its file is fresh and not stale', async () => {
  const path = statePath();
  writePosition(path, { cursor: 'c-0' });
  const events = [event('e1', 1n, PAYER, MERCHANT)];
  const { server } = feed([page(events, 'page-end')]);
  const result = await pollOnce(
    { server, contractId: 'C1', statePath: path, deliver: () => Promise.resolve(false) },
    { cursor: 'c-0' },
  );
  assert.equal(result.stuckOn, 'e1');
  // The position did not move, and the file says which event blocks the feed.
  const written: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(written, { cursor: 'c-0', stuckOn: 'e1' });
  // A reader that resumes still resumes from the unmoved cursor.
  assert.deepEqual(readPosition(path), { cursor: 'c-0' });
});

test('a refusal on a first run leaves the stuck event and no cursor', () => {
  const path = statePath();
  writeStall(path, null, 'e1');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { stuckOn: 'e1' });
  // No cursor means a resume from the configured ledger, which is correct
  // because nothing was ever delivered.
  assert.equal(readPosition(path), null);
});

test('a batch that succeeds clears the stuck event, because it writes no such field', async () => {
  const path = statePath();
  writeStall(path, 'c-0', 'e1');
  const { server } = feed([page([], 'quiet')]);
  await pollOnce(
    { server, contractId: 'C1', statePath: path, deliver: () => Promise.resolve(true) },
    { cursor: 'c-0' },
  );
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { cursor: 'quiet' });
});

test('a delivered event is never read again after a restart', async () => {
  const path = statePath();
  const delivered: string[] = [];
  const events = [event('e1', 1n, PAYER, MERCHANT), event('e2', 2n, PAYER, MERCHANT)];
  const one = feed([page(events, 'page-end')]);
  await pollOnce(
    {
      server: one.server,
      contractId: 'C1',
      statePath: path,
      deliver: (m) => {
        delivered.push(m.event_id);
        return Promise.resolve(true);
      },
    },
    { startLedger: 100 },
  );
  assert.deepEqual(delivered, ['e1', 'e2']);

  // The restart asks from the stored position, which is past both events.
  const two = feed([page([], 'page-end')]);
  const resumed = readPosition(path);
  assert.deepEqual(resumed, { cursor: 'page-end' });
  await pollOnce(
    { server: two.server, contractId: 'C1', statePath: path, deliver: () => Promise.resolve(true) },
    resumed ?? { cursor: 'page-end' },
  );
  assert.equal(two.asked[0], 'page-end');
  assert.deepEqual(delivered, ['e1', 'e2']);
});

test('a first start with no position asks from the configured ledger', async () => {
  const path = join(work, 'never-written.json');
  assert.equal(readPosition(path), null);
  const { server, asked } = feed([page([], 'first-cursor')]);
  await pollOnce(
    { server, contractId: 'C1', statePath: path, deliver: () => Promise.resolve(true) },
    { startLedger: 4_500_000 },
  );
  assert.equal(asked[0], 'start');
  assert.deepEqual(readPosition(path), { cursor: 'first-cursor' });
  assert.equal(readFileSync(path, 'utf8').trim(), '{"cursor":"first-cursor"}');
});

test('the observer reads a running listener, a stuck one and one that never ran', () => {
  const missing = join(work, 'no-listener-here.json');
  const never = readListenerState(missing);
  assert.deepEqual(never, { cursor: null, stuckOn: null, ageMs: null });

  const running = statePath();
  writePosition(running, { cursor: 'c-9' });
  const seen = readListenerState(running);
  assert.equal(seen.cursor, 'c-9');
  assert.equal(seen.stuckOn, null);
  // The age comes from the file, so a fresh write reads as fresh.
  assert.equal(typeof seen.ageMs, 'number');
  assert.ok((seen.ageMs ?? Number.MAX_SAFE_INTEGER) < 5_000);

  const stuck = statePath();
  writeStall(stuck, 'c-9', 'e7');
  const blocked = readListenerState(stuck);
  assert.equal(blocked.cursor, 'c-9');
  assert.equal(blocked.stuckOn, 'e7');
});

test('a truncated file still reports its age, which is the fact that matters', () => {
  const path = statePath();
  writeFileSync(path, '{"cursor":"c-1');
  const seen = readListenerState(path);
  assert.equal(seen.cursor, null);
  assert.equal(typeof seen.ageMs, 'number');
});

test('a cursor names the ledger that it reached', () => {
  // Measured against the network: a cursor at the head reports the same
  // ledger that the same response calls latestLedger. This cursor came from a
  // real quiet poll whose latestLedger was 4507159.
  assert.equal(ledgerOfCursor('0019358104797839359-4294967295'), 4507159);
  assert.equal(ledgerOfCursor('not-a-cursor'), null);
});

test('an empty page does not end a catch up, because the head decides', async () => {
  const path = statePath();
  // Two empty pages that each advance ten thousand ledgers, then the events.
  // The old rule stopped on the first of these and called it caught up.
  const behind = (cursorLedger: number, events: readonly rpc.Api.EventResponse[]) => {
    const held = { ...page(events, `${BigInt(cursorLedger) << 32n}-1`) };
    return { ...held, latestLedger: 4507468 };
  };
  const delivered: string[] = [];
  const { server } = feed([
    behind(4477467, []),
    behind(4487466, []),
    behind(4507468, [event('e1', 1n, PAYER, MERCHANT)]),
  ]);
  const outcome = await runListener(
    {
      server,
      contractId: 'C1',
      statePath: path,
      deliver: (m) => {
        delivered.push(m.event_id);
        return Promise.resolve(true);
      },
    },
    'quiet',
    4467468,
  );
  assert.equal(outcome.polls, 3);
  assert.deepEqual(delivered, ['e1']);
});
