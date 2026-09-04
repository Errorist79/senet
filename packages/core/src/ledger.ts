import {
  CONTRACT_MAX_TTL_LEDGERS,
  LEDGER_ESTIMATE_MARGIN_LEDGERS,
  LEDGER_MEAN_CLOSE_SECONDS,
  MIN_REMAINING_LEDGERS,
} from './constants.js';
import { ExpiryWindowError, RemainingLifeError } from './errors.js';

/**
 * Estimate the current ledger from the last one the device saw.
 *
 * A payer who mints a voucher offline cannot read the ledger, so the device
 * counts forward from its cached reading. The divisor is the measured mean
 * close time, and the estimate can only run ahead of the real ledger.
 */
export function estimateLedger(lastSeenLedger: number, elapsedSeconds: number): number {
  return (
    lastSeenLedger +
    Math.floor(elapsedSeconds / LEDGER_MEAN_CLOSE_SECONDS) +
    LEDGER_ESTIMATE_MARGIN_LEDGERS
  );
}

/**
 * Refuse a lifetime the contract will not accept.
 *
 * The contract compares the requested lifetime against its stored
 * `max_ttl_ledgers` and refuses a longer one. The refusal arrives after the
 * payer signed and after the merchant scanned, so the library refuses first.
 */
export function assertLifetime(lifetimeLedgers: number): number {
  if (
    !Number.isSafeInteger(lifetimeLedgers) ||
    lifetimeLedgers < 1 ||
    lifetimeLedgers > CONTRACT_MAX_TTL_LEDGERS
  ) {
    throw new ExpiryWindowError(lifetimeLedgers, CONTRACT_MAX_TTL_LEDGERS);
  }
  return lifetimeLedgers;
}

/**
 * The `expire_at` of a voucher that a device mints offline.
 *
 * The result feeds both the contract argument and the host credential field.
 * One value, computed once, is what keeps the two deadlines equal.
 */
export function offlineExpireAt(
  lastSeenLedger: number,
  elapsedSeconds: number,
  lifetimeLedgers: number,
): number {
  return estimateLedger(lastSeenLedger, elapsedSeconds) + assertLifetime(lifetimeLedgers);
}

/**
 * The ledgers of life that remain in a voucher.
 *
 * The result goes negative once the voucher passes its deadline. A caller that
 * only shows a number therefore needs no separate check for an expiry.
 */
export function remainingLedgers(expireAt: number, currentLedger: number): number {
  return expireAt - currentLedger;
}

/**
 * Refuse a voucher that would expire during the payment.
 *
 * A merchant simulates and then submits. A voucher that expires in between
 * fails in a way that looks the same as a bad voucher. The scanner refuses it
 * at the scan, where the payer is still there.
 */
export function assertRemainingLife(
  expireAt: number,
  currentLedger: number,
  required = MIN_REMAINING_LEDGERS,
): number {
  const remaining = remainingLedgers(expireAt, currentLedger);
  if (remaining < required) throw new RemainingLifeError(remaining, required);
  return remaining;
}
