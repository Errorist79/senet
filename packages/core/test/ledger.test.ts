import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AmountWindowError,
  CONTRACT_MAX_AMOUNT_STROOPS,
  CONTRACT_MAX_TTL_LEDGERS,
  DEFAULT_LIFETIME_LEDGERS,
  ExpiryWindowError,
  LEDGER_ESTIMATE_MARGIN_LEDGERS,
  LEDGER_MEAN_CLOSE_SECONDS,
  LEDGER_TARGET_CLOSE_MS,
  LIFETIMES,
  MIN_REMAINING_LEDGERS,
  RemainingLifeError,
  assertAmount,
  assertLifetime,
  assertRemainingLife,
  estimateLedger,
  offlineExpireAt,
  remainingLedgers,
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

test('an amount at the cap passes', () => {
  assert.equal(assertAmount(CONTRACT_MAX_AMOUNT_STROOPS), CONTRACT_MAX_AMOUNT_STROOPS);
  assert.equal(assertAmount(1n), 1n);
});

test('an amount one stroop above the cap raises AmountWindowError', () => {
  assert.throws(
    () => assertAmount(CONTRACT_MAX_AMOUNT_STROOPS + 1n),
    (error: unknown) => {
      assert.ok(error instanceof AmountWindowError);
      assert.equal(error.amount, CONTRACT_MAX_AMOUNT_STROOPS + 1n);
      assert.equal(error.maxAmount, CONTRACT_MAX_AMOUNT_STROOPS);
      return true;
    },
  );
});

test('an amount of zero or below raises AmountWindowError', () => {
  assert.throws(() => assertAmount(0n), AmountWindowError);
  assert.throws(() => assertAmount(-1n), AmountWindowError);
});

test('a voucher with plenty of life left passes', () => {
  assert.equal(assertRemainingLife(1000, 900), 100);
  assert.equal(remainingLedgers(1000, 900), 100);
});

test('a voucher at the limit passes and a shorter one does not', () => {
  const now = 1000;
  assert.equal(assertRemainingLife(now + MIN_REMAINING_LEDGERS, now), MIN_REMAINING_LEDGERS);
  assert.throws(
    () => assertRemainingLife(now + MIN_REMAINING_LEDGERS - 1, now),
    (error: unknown) => {
      assert.ok(error instanceof RemainingLifeError);
      assert.equal(error.remaining, MIN_REMAINING_LEDGERS - 1);
      assert.equal(error.required, MIN_REMAINING_LEDGERS);
      return true;
    },
  );
});

test('a voucher that already expired reports a negative life', () => {
  assert.equal(remainingLedgers(900, 1000), -100);
  assert.throws(() => assertRemainingLife(900, 1000), RemainingLifeError);
});

test('the headroom covers a simulation and a submission', () => {
  // Each costs about one ledger, and a merchant needs room for both plus slack.
  assert.ok(MIN_REMAINING_LEDGERS >= 2);
});
