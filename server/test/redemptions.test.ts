import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { nativeToScVal } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
import { REDEEMED_TOPIC } from '../src/events.js';
import type { RedemptionMessage } from '../src/events.js';
import { addRedemption, findRedemption, readFromChain, readStore } from '../src/redemptions.js';

/**
 * The store that a merchant screen confirms from.
 *
 * Every case begins from a store that already holds something, because a
 * merchant asking about one voucher is asking a store that holds others. A
 * lookup against an empty store cannot tell a right answer from a lucky one.
 */

const work = mkdtempSync(join(tmpdir(), 'senet-redemptions-'));
after(() => rmSync(work, { recursive: true, force: true }));

let files = 0;
function storePath(): string {
  files += 1;
  return join(work, `store-${files}.json`);
}

const PAYER = 'GAF5LEIT3GWHRMYX2UEOVOGCQMDSJVM3A7WSXO3TCC2GRND6EHCLGFXJ';
const MERCHANT = 'GC45NTB4OWWPE5FTJ5DI3IHLLGVNB3VCGFANCFAHKFVIVRK6C2PHLSSZ';

function message(eventId: string, voucherId: string): RedemptionMessage {
  return {
    voucher_id: voucherId,
    payer: PAYER,
    recipient: MERCHANT,
    amount: '5000000',
    expire_at: 4494629,
    tx_hash: `hash-of-${eventId}`,
    ledger: 4494450,
    ledger_closed_at: '2026-09-04T04:23:57Z',
    event_id: eventId,
  };
}

/** One event, as the network returns it after the SDK parsed it. */
function event(id: string, voucherId: bigint): rpc.Api.EventResponse {
  return {
    id,
    type: 'contract',
    ledger: 4494450,
    ledgerClosedAt: '2026-09-04T04:23:57Z',
    transactionIndex: 5,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: `chain-hash-${id}`,
    topic: [
      nativeToScVal(REDEEMED_TOPIC, { type: 'symbol' }),
      nativeToScVal(voucherId, { type: 'u64' }),
    ],
    value: nativeToScVal({
      payer: nativeToScVal(PAYER, { type: 'address' }),
      recipient: nativeToScVal(MERCHANT, { type: 'address' }),
      amount: nativeToScVal(5_000_000n, { type: 'i128' }),
      expire_at: nativeToScVal(4_494_629, { type: 'u32' }),
    }),
  };
}

/** A chain that holds one event in one ledger. */
function chain(events: readonly rpc.Api.EventResponse[]): Pick<rpc.Server, 'getEvents'> {
  return {
    getEvents: () =>
      Promise.resolve({
        events: [...events],
        cursor: 'end',
        latestLedger: 4507159,
        oldestLedger: 4386200,
        latestLedgerCloseTime: '1784671886',
        oldestLedgerCloseTime: '1784066056',
      }),
  };
}

test('a lookup finds the right voucher among others', () => {
  const path = storePath();
  addRedemption(path, message('e1', '111'));
  addRedemption(path, message('e2', '222'));
  addRedemption(path, message('e3', '333'));
  assert.equal(findRedemption(path, '222')?.event_id, 'e2');
  assert.equal(findRedemption(path, '999'), null);
});

test('the same event twice stores one record and answers the same way', () => {
  const path = storePath();
  addRedemption(path, message('e1', '111'));
  const again = addRedemption(path, message('e1', '111'));
  assert.equal(again.added, false);
  assert.equal(readStore(path).length, 1);
  assert.equal(findRedemption(path, '111')?.event_id, 'e1');
});

test('a store survives a restart, because it is a file', () => {
  const path = storePath();
  addRedemption(path, message('e1', '111'));
  // No memory carries a value between these two calls, which is the point.
  assert.equal(findRedemption(path, '111')?.tx_hash, 'hash-of-e1');
});

test('a truncated store reads as empty rather than as a wrong answer', () => {
  const path = storePath();
  writeFileSync(path, '{"redemptions":[{"voucher_id":"1');
  assert.deepEqual(readStore(path), []);
});

test('the reader drops a record that no longer fits the shape', () => {
  const path = storePath();
  writeFileSync(path, '{"redemptions":[{"voucher_id":"111"},{"nothing":true}]}');
  assert.deepEqual(readStore(path), []);
});

test('the chain decides what a redemption says, and not the caller', async () => {
  const server = chain([event('e1', 111n)]);
  const fromChain = await readFromChain(server, 'C1', { eventId: 'e1', ledger: 4494450 });
  // The caller's own account of the payment never reaches the store. These
  // values come from the event, and they differ from the ones a caller sent.
  assert.equal(fromChain?.tx_hash, 'chain-hash-e1');
  assert.equal(fromChain?.voucher_id, '111');
});

test('a pointer to an event that the chain does not hold gives nothing', async () => {
  const server = chain([event('e1', 111n)]);
  assert.equal(await readFromChain(server, 'C1', { eventId: 'e2', ledger: 4494450 }), null);
});
