import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
import {
  REDEEMED_TOPIC,
  isCursorTooOld,
  pollOnce,
  readPosition,
  readRedemption,
  writePosition,
} from '../src/events.js';
import type { RedemptionMessage } from '../src/events.js';
import { RPC_INVALID_REQUEST } from '../src/constants.js';

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

test('the guard reads the code of a refusal, and never its message', () => {
  assert.equal(isCursorTooOld({ code: RPC_INVALID_REQUEST, message: 'anything at all' }), true);
  assert.equal(isCursorTooOld({ code: -32000, message: 'startLedger must be within' }), false);
  assert.equal(isCursorTooOld(new Error('startLedger must be within the ledger range')), false);
  assert.equal(isCursorTooOld(null), false);
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
