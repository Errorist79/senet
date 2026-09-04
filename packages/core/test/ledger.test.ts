import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTRACT_MAX_TTL_LEDGERS,
  DEFAULT_LIFETIME_LEDGERS,
  ExpiryWindowError,
  LEDGER_ESTIMATE_MARGIN_LEDGERS,
  LEDGER_MEAN_CLOSE_SECONDS,
  LEDGER_TARGET_CLOSE_MS,
  LIFETIMES,
  assertLifetime,
  estimateLedger,
  offlineExpireAt,
} from '../src/index.js';

test('an estimate with no elapsed time is the ledger the device saw', () => {
  assert.equal(estimateLedger(1000, 0), 1000);
});

test('an estimate counts one ledger per mean close time', () => {
  assert.equal(estimateLedger(1000, LEDGER_MEAN_CLOSE_SECONDS), 1001);
  assert.equal(estimateLedger(1000, LEDGER_MEAN_CLOSE_SECONDS * 10), 1010);
});

test('the estimate never runs behind the protocol floor', () => {
  // A ledger cannot close faster than the floor, so the real ledger over any
  // window is at most `elapsed / floor`. The estimate must not exceed it.
  const elapsedSeconds = 3600;
  const fastest = Math.floor(elapsedSeconds / (LEDGER_TARGET_CLOSE_MS / 1000));
  assert.ok(estimateLedger(0, elapsedSeconds) <= fastest);
});

test('the safety margin is zero', () => {
  assert.equal(LEDGER_ESTIMATE_MARGIN_LEDGERS, 0);
});

test('an offline deadline is the estimate plus the lifetime', () => {
  assert.equal(offlineExpireAt(5000, 0, LIFETIMES['15m']), 5000 + LIFETIMES['15m']);
  assert.equal(offlineExpireAt(5000, 0, DEFAULT_LIFETIME_LEDGERS), 5180);
});

test('the longest lifetime on offer is the contract ceiling', () => {
  assert.equal(CONTRACT_MAX_TTL_LEDGERS, LIFETIMES['12h']);
  assert.equal(assertLifetime(CONTRACT_MAX_TTL_LEDGERS), CONTRACT_MAX_TTL_LEDGERS);
});

test('every lifetime on offer passes the window check', () => {
  for (const ledgers of Object.values(LIFETIMES)) {
    assert.equal(assertLifetime(ledgers), ledgers);
  }
});

test('a lifetime past the ceiling raises ExpiryWindowError', () => {
  assert.throws(
    () => assertLifetime(CONTRACT_MAX_TTL_LEDGERS + 1),
    (error: unknown) => {
      assert.ok(error instanceof ExpiryWindowError);
      assert.equal(error.maxLifetimeLedgers, CONTRACT_MAX_TTL_LEDGERS);
      return true;
    },
  );
  assert.throws(() => offlineExpireAt(5000, 0, CONTRACT_MAX_TTL_LEDGERS + 1), ExpiryWindowError);
});

test('a lifetime of zero or less raises ExpiryWindowError', () => {
  assert.throws(() => assertLifetime(0), ExpiryWindowError);
  assert.throws(() => assertLifetime(-1), ExpiryWindowError);
  assert.throws(() => assertLifetime(1.5), ExpiryWindowError);
});
