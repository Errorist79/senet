import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@stellar/stellar-sdk';
import {
  SEP7_SCHEME,
  STELLAR_TOML_PATH,
  UriFormatError,
  buildPayUri,
  parseUri,
  readUriSigningKey,
  signUri,
  splitSignature,
  verifyUri,
} from '../src/index.js';
import { asObject, readFixture, stringField } from './reference.js';

const fixture = readFixture('sep7-uri.json');
const input = asObject(fixture['input'], 'input');
const signer = Keypair.fromRawEd25519Seed(
  Buffer.from(stringField(input, 'signerSeedHex'), 'hex'),
);
const fields = {
  destination: stringField(input, 'destination'),
  amount: stringField(input, 'amount'),
  memo: stringField(input, 'memo'),
  memoType: stringField(input, 'memoType'),
  msg: stringField(input, 'msg'),
  originDomain: stringField(input, 'originDomain'),
};

test('the unsigned request matches the recorded text', () => {
  assert.equal(buildPayUri(fields), stringField(fixture, 'unsignedUri'));
});

test('the signed request matches the recorded text', () => {
  assert.equal(
    signUri(buildPayUri(fields), signer.secret()),
    stringField(fixture, 'signedUri'),
  );
});

test('the recorded request verifies against the recorded key', () => {
  const outcome = verifyUri(stringField(fixture, 'signedUri'), signer.publicKey());
  assert.equal(outcome.verified, true);
  assert.ok(outcome.verified);
  assert.equal(outcome.signedText, stringField(fixture, 'unsignedUri'));
});

test('a request carries only the fields that a caller sets', () => {
  const bare = buildPayUri({ destination: fields.destination });
  assert.equal(bare, `${SEP7_SCHEME}pay?destination=${fields.destination}`);
});

test('a caller escapes nothing itself', () => {
  const uri = buildPayUri({ destination: fields.destination, msg: 'a & b = c' });
  assert.match(uri, /msg=a\+%26\+b\+%3D\+c/);
  assert.equal(parseUri(uri).fields['msg'], 'a & b = c');
});

test('the signature is the last parameter', () => {
  const signed = signUri(buildPayUri(fields), signer.secret());
  assert.match(signed, /&signature=[^&]+$/);
  const parts = splitSignature(signed);
  assert.ok(parts !== null);
  assert.equal(parts.signed, buildPayUri(fields));
});

test('a changed request no longer verifies', () => {
  const signed = signUri(buildPayUri(fields), signer.secret());
  const tampered = signed.replace('amount=12.5000000', 'amount=99.0000000');
  const outcome = verifyUri(tampered, signer.publicKey());
  assert.equal(outcome.verified, false);
  assert.ok(!outcome.verified);
  assert.equal(outcome.reason, 'the signature does not match the request');
});

test('another key no longer verifies', () => {
  const signed = signUri(buildPayUri(fields), signer.secret());
  const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 13)).publicKey();
  const outcome = verifyUri(signed, other);
  assert.equal(outcome.verified, false);
});

test('verification names each failure separately', () => {
  const unsigned = buildPayUri(fields);
  const noSignature = verifyUri(unsigned, signer.publicKey());
  assert.ok(!noSignature.verified);
  assert.equal(noSignature.reason, 'the request carries no signature');

  const signed = signUri(unsigned, signer.secret());
  const noKey = verifyUri(signed, null);
  assert.ok(!noKey.verified);
  assert.equal(noKey.reason, 'the domain publishes no request signing key');

  const badKey = verifyUri(signed, 'not a public key');
  assert.ok(!badKey.verified);
  assert.equal(badKey.reason, 'the signing key is not a valid public key');
});

test('a request cannot carry two signatures', () => {
  const signed = signUri(buildPayUri(fields), signer.secret());
  assert.throws(() => signUri(signed, signer.secret()), UriFormatError);
});

test('a request that is not SEP-7 raises UriFormatError', () => {
  assert.throws(() => parseUri('https://example.test/pay'), UriFormatError);
  assert.throws(() => buildPayUri({ destination: '' }), UriFormatError);
});

test('parsing reads the operation and every parameter', () => {
  const parsed = parseUri(stringField(fixture, 'signedUri'));
  assert.equal(parsed.operation, 'pay');
  assert.equal(parsed.fields['destination'], fields.destination);
  assert.equal(parsed.fields['amount'], fields.amount);
  assert.equal(parsed.fields['memo'], fields.memo);
  assert.equal(parsed.fields['origin_domain'], fields.originDomain);
  assert.ok(typeof parsed.fields['signature'] === 'string');
});

test('a request with no parameters still parses', () => {
  assert.deepEqual(parseUri(`${SEP7_SCHEME}pay`), { operation: 'pay', fields: {} });
});

test('the signing key reader takes either quoting style', () => {
  const key = signer.publicKey();
  assert.equal(readUriSigningKey(`URI_REQUEST_SIGNING_KEY="${key}"`), key);
  assert.equal(readUriSigningKey(`URI_REQUEST_SIGNING_KEY='${key}'`), key);
  assert.equal(readUriSigningKey(`  URI_REQUEST_SIGNING_KEY = "${key}"\nOTHER=1`), key);
  assert.equal(readUriSigningKey('NETWORK_PASSPHRASE="x"'), null);
});

test('the information file sits where SEP-1 puts it', () => {
  assert.equal(STELLAR_TOML_PATH, '/.well-known/stellar.toml');
});
