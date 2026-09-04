import assert from 'node:assert/strict';
import test from 'node:test';
import { Networks } from '@stellar/stellar-sdk';
import { nativeTokenId } from '@senet/core';
import { OUTCOMES, classify, errorText, hostErrors } from '../src/index.js';
import { readHostFailures } from './fixtures.js';

const failures = readHostFailures();
const TOKEN = nativeTokenId(Networks.TESTNET);

/** The typed error that the host raised outermost, which names the failure. */
function outermost(name: string): { type: string; code: string | number | null } {
  const failure = failures[name];
  assert.ok(failure !== undefined, `the fixture ${name} is missing`);
  const found = hostErrors(failure.events);
  assert.ok(found.length > 0, `${name} carries no typed host error`);
  const last = found[found.length - 1];
  assert.ok(last !== undefined);
  return { type: last.type, code: last.code };
}

/** Classify one recorded failure. */
function classifyFixture(name: string): ReturnType<typeof classify> {
  const failure = failures[name];
  assert.ok(failure !== undefined, `the fixture ${name} is missing`);
  return classify(failure.error, failure.events, TOKEN);
}

test('a consumed nonce is sceAuth and scecExistingValue', () => {
  assert.deepEqual(outermost('nonceConsumed'), {
    type: 'sceAuth',
    code: 'scecExistingValue',
  });
  assert.equal(classifyFixture('nonceConsumed').outcome, 'NONCE_CONSUMED');
});

test('an expired signature is sceAuth and scecInvalidInput', () => {
  assert.deepEqual(outermost('authExpired'), {
    type: 'sceAuth',
    code: 'scecInvalidInput',
  });
  assert.equal(classifyFixture('authExpired').outcome, 'AUTH_EXPIRED');
});

test('a wrong signature reads the outermost error, not the inner contract code', () => {
  const failure = failures['badSignature'];
  assert.ok(failure !== undefined);
  const found = hostErrors(failure.events);
  assert.equal(found[0]?.type, 'sceContract', 'the account contract refuses first');
  assert.deepEqual(outermost('badSignature'), {
    type: 'sceAuth',
    code: 'scecInvalidAction',
  });
  assert.equal(classifyFixture('badSignature').outcome, 'BAD_SIGNATURE');
});

test('a short payer balance names the contract that refused first', () => {
  const failure = failures['payerInsufficientBalance'];
  assert.ok(failure !== undefined);
  const found = hostErrors(failure.events);
  assert.equal(found[0]?.contractId, TOKEN);
  const got = classifyFixture('payerInsufficientBalance');
  assert.equal(got.outcome, 'PAYER_INSUFFICIENT_BALANCE');
  assert.equal(got.contractErrorCode, 10);
  assert.equal(got.errorOrigin, TOKEN);
});

test('another contract that raises the same code is a contract rejection', () => {
  const failure = failures['payerInsufficientBalance'];
  assert.ok(failure !== undefined);
  // The same events, read by a service configured for a different token.
  const got = classify(failure.error, failure.events, nativeTokenId(Networks.PUBLIC));
  assert.equal(got.outcome, 'CONTRACT_REJECTED');
});

test('the typed error wins when the message says something else', () => {
  const failure = failures['nonceConsumed'];
  assert.ok(failure !== undefined);
  const got = classify('HostError: Error(Contract, #5)', failure.events, TOKEN);
  assert.equal(got.outcome, 'NONCE_CONSUMED');
});

test('the message fallback runs when no event carries a typed error', () => {
  assert.equal(classify('txBadSeq', null, TOKEN).outcome, 'BAD_SEQUENCE');
  assert.equal(classify('txFailed', null, TOKEN).outcome, 'APPLY_FAILED');
  assert.equal(classify('txInsufficientBalance', null, TOKEN).outcome, 'FEE_PAYER_UNDERFUNDED');
  assert.equal(classify('TRY_AGAIN_LATER', null, TOKEN).outcome, 'TIMEOUT');
  assert.equal(classify('Error(Auth, ExistingValue)', null, TOKEN).outcome, 'NONCE_CONSUMED');
  assert.equal(classify('Error(Auth, InvalidAction)', null, TOKEN).outcome, 'BAD_SIGNATURE');
});

test('an expired signature needs the message that names the expiry', () => {
  assert.equal(
    classify('HostError: Error(Auth, InvalidInput)\nsignature has expired', null, TOKEN).outcome,
    'AUTH_EXPIRED',
  );
  assert.equal(
    classify('HostError: Error(Auth, InvalidInput)', null, TOKEN).outcome,
    'UNKNOWN',
  );
});

test('a contract error in the message keeps its code', () => {
  const got = classify('HostError: Error(Contract, #7)', null, TOKEN);
  assert.equal(got.outcome, 'CONTRACT_REJECTED');
  assert.equal(got.contractErrorCode, 7);
});

test('a failure that nothing matches is UNKNOWN, never a guess', () => {
  assert.equal(classify('something new', null, TOKEN).outcome, 'UNKNOWN');
  assert.equal(classify('', null, TOKEN).outcome, 'UNKNOWN');
});

test('an event list that does not decode never throws', () => {
  assert.deepEqual(hostErrors(null), []);
  assert.deepEqual(hostErrors([]), []);
});

test('the outcome list holds no duplicate', () => {
  assert.equal(new Set(OUTCOMES).size, OUTCOMES.length);
});

test('a caught value of any shape yields a message', () => {
  assert.equal(errorText(new Error('a message')), 'a message');
  assert.equal(errorText('a string'), 'a string');
  assert.equal(errorText({ code: 7 }), '{"code":7}');
  assert.equal(errorText(undefined), 'undefined');
  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  assert.equal(errorText(circular), '[object Object]');
});
