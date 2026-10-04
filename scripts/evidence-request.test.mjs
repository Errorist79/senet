import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { buildPayUri, signUri } from '@senet/core';
import {
  EVIDENCE_DIR,
  compareRequestToChain,
  paymentFromEnvelope,
  readArchivedRow,
} from './evidence-set.mjs';

// One real archived payment answers every case. Each case changes the request
// alone, and a fresh key signs every request, so the signature always holds.
// A problem can then come only from the field that the case changes.
const archived = readArchivedRow(EVIDENCE_DIR, 'sep7-payment');
const payment = paymentFromEnvelope(archived.rpc.envelopeXdr);
const signer = Keypair.random();
const DOMAIN = 'senet.hoodrun.io';

/** The archived amount, as the decimal text that a request carries. */
function paidAmount() {
  const stroops = BigInt(payment.amountStroops);
  return `${stroops / 10_000_000n}.${(stroops % 10_000_000n).toString().padStart(7, '0')}`;
}

/** A signed request in the shape that the producer archives. */
function requestRow(uri) {
  return {
    uri: signUri(uri, signer.secret()),
    originDomain: DOMAIN,
    signingKey: signer.publicKey(),
    tomlUrl: `https://${DOMAIN}/.well-known/stellar.toml`,
  };
}

/** The request that the archived payment answers, with one field replaced. */
function unsignedRequest(changed = {}) {
  return buildPayUri({
    destination: payment.destination,
    networkPassphrase: Networks.TESTNET,
    amount: paidAmount(),
    originDomain: DOMAIN,
    ...changed,
  });
}

function compare(uri) {
  return compareRequestToChain(requestRow(uri), payment, archived.horizon, Networks.TESTNET);
}

test('the archive holds a payment that a request can answer', () => {
  assert.ok(payment !== null && payment.destination !== null);
  assert.equal(archived.horizon.successful, true);
});

test('a request that the payment answers raises nothing', () => {
  const found = compare(unsignedRequest());
  assert.deepEqual(found.problems, []);
  assert.ok(found.checked >= 7);
});

test('a request for another amount does not match its payment', () => {
  const more = (BigInt(payment.amountStroops) + 1n).toString().padStart(8, '0');
  const amount = `${more.slice(0, -7)}.${more.slice(-7)}`;
  const found = compare(unsignedRequest({ amount }));
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0] ?? '', /stroops and the payment carried/);
});

test('a request for another destination does not match its payment', () => {
  const found = compare(unsignedRequest({ destination: Keypair.random().publicKey() }));
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0] ?? '', /the payment went to/);
});

test('a request for another network does not match its payment', () => {
  const found = compare(unsignedRequest({ networkPassphrase: Networks.PUBLIC }));
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0] ?? '', /Public Global Stellar Network/);
});

test('a request that names no network is for the public network', () => {
  const unnamed = unsignedRequest().replace(/&network_passphrase=[^&]*/, '');
  assert.ok(!unnamed.includes('network_passphrase'));
  const found = compare(unnamed);
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0] ?? '', /Public Global Stellar Network/);
});
