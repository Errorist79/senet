import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AmountWindowError,
  CredentialTypeError,
  DeadlineMismatchError,
  ExpiryWindowError,
  NETWORK_ID_BYTES,
  NetworkMismatchError,
  PAYLOAD_VERSION,
  PayloadVersionError,
  SdkVersionError,
  VoucherError,
  VoucherFormatError,
  networkTag,
} from '../src/index.js';
import { TESTNET_CONFIG } from '../src/index.js';

/** Every error the library raises, so a consumer can list what it must handle. */
const errors: readonly VoucherError[] = [
  new VoucherFormatError('the entry carries no address credentials'),
  new PayloadVersionError(2, PAYLOAD_VERSION),
  new NetworkMismatchError(
    '7ac33997',
    networkTag(TESTNET_CONFIG.network),
    TESTNET_CONFIG.network,
  ),
  new CredentialTypeError(1, 9, 2, 10),
  new DeadlineMismatchError(1000, 2000),
  new ExpiryWindowError(9000, 8640),
  new AmountWindowError(2_000_000_000n, 1_000_000_000n),
  new SdkVersionError('17.0.1', 16, 3),
];

test('every error is a VoucherError and an Error', () => {
  for (const error of errors) {
    assert.ok(error instanceof VoucherError);
    assert.ok(error instanceof Error);
  }
});

test('every error names its own class', () => {
  assert.deepEqual(
    errors.map((error) => error.name),
    [
      'VoucherFormatError',
      'PayloadVersionError',
      'NetworkMismatchError',
      'CredentialTypeError',
      'DeadlineMismatchError',
      'ExpiryWindowError',
      'AmountWindowError',
      'SdkVersionError',
    ],
  );
});

test('every error carries a message that says what went wrong', () => {
  for (const error of errors) {
    assert.ok(error.message.length > 0);
  }
});

test('a payload version error names both versions', () => {
  const error = new PayloadVersionError(2, PAYLOAD_VERSION);
  assert.equal(error.found, 2);
  assert.equal(error.expected, PAYLOAD_VERSION);
});

test('a network mismatch names the identifier and the passphrase', () => {
  const expected = networkTag(TESTNET_CONFIG.network);
  const error = new NetworkMismatchError('7ac33997', expected, TESTNET_CONFIG.network);
  assert.equal(error.found.length, NETWORK_ID_BYTES * 2);
  assert.equal(error.expected, expected);
  assert.equal(error.expectedNetwork, TESTNET_CONFIG.network);
});

test('a deadline mismatch reports the lifetime that the payer would lose', () => {
  const error = new DeadlineMismatchError(1000, 2000);
  assert.match(error.message, /1000/);
  assert.match(error.message, /2000/);
});

test('an SDK version error names the version that it needs', () => {
  const error = new SdkVersionError('17.0.1', 16, 3);
  assert.equal(error.found, '17.0.1');
  assert.equal(error.expectedMajor, 16);
  assert.equal(error.expectedMinorMin, 3);
});

test('an amount window error names the amount and the cap', () => {
  const error = new AmountWindowError(2_000_000_000n, 1_000_000_000n);
  assert.equal(error.amount, 2_000_000_000n);
  assert.equal(error.maxAmount, 1_000_000_000n);
});
