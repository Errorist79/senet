import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { Channel, ChannelPool, TESTNET_HORIZON_URL, TESTNET_RPC_URL } from '../src/index.js';

/** A pool of `count` channels. No test in this file reaches the network. */
function poolOf(count: number): ChannelPool {
  const server = new rpc.Server(TESTNET_RPC_URL);
  const channels = Array.from(
    { length: count },
    () => new Channel(Keypair.random(), server, TESTNET_HORIZON_URL),
  );
  return new ChannelPool(channels);
}

test('a pool with no channel refuses to exist', () => {
  assert.throws(() => new ChannelPool([]), /at least one channel account/);
});

test('one channel serves one caller at a time', () => {
  const pool = poolOf(1);
  const first = pool.acquire();
  assert.ok(first !== null);
  assert.equal(pool.busyCount, 1);
  assert.equal(pool.acquire(), null);
});

test('a released channel is available again', () => {
  const pool = poolOf(1);
  const first = pool.acquire();
  assert.ok(first !== null);
  pool.release(first);
  assert.equal(pool.busyCount, 0);
  const second = pool.acquire();
  assert.equal(second?.address, first.address);
});

test('no two callers hold the same channel', () => {
  const pool = poolOf(5);
  const held = new Set<string>();
  for (let i = 0; i < pool.size; i += 1) {
    const channel = pool.acquire();
    assert.ok(channel !== null);
    assert.equal(held.has(channel.address), false, 'the pool handed out one channel twice');
    held.add(channel.address);
  }
  assert.equal(held.size, pool.size);
  assert.equal(pool.acquire(), null, 'a full pool refuses new work');
});

test('a full pool frees one channel per release', () => {
  const pool = poolOf(3);
  const first = pool.acquire();
  const second = pool.acquire();
  const third = pool.acquire();
  assert.ok(first !== null && second !== null && third !== null);
  assert.equal(pool.acquire(), null);
  pool.release(second);
  assert.equal(pool.busyCount, 2);
  assert.equal(pool.acquire()?.address, second.address);
  assert.equal(pool.acquire(), null);
});

test('a release of a channel that nobody holds changes nothing', () => {
  const pool = poolOf(2);
  const first = pool.acquire();
  assert.ok(first !== null);
  pool.release(first);
  pool.release(first);
  assert.equal(pool.busyCount, 0);
});

test('a channel that read no sequence number refuses to build', () => {
  const pool = poolOf(1);
  const channel = pool.acquire();
  assert.ok(channel !== null);
  assert.throws(() => channel.next(), /did not read its sequence number/);
});
