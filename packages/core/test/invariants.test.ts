import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuthorizationEntryPreimage, xdr } from '@stellar/stellar-sdk';
import {
  AUTH_ENVELOPE_TYPE_WITH_ADDRESS,
  CREDENTIAL_TYPE_ADDRESS_V2,
  CredentialTypeError,
  DeadlineMismatchError,
  EXPECTED_SDK_MAJOR,
  EXPECTED_SDK_MINOR_MIN,
  SdkVersionError,
  VoucherFormatError,
  addressCredentials,
  assertAddressV2,
  assertDeadlinesAligned,
  assertSdkVersion,
  authEnvelopeType,
  buildVoucherEntry,
  credentialDiscriminant,
  redeemInvocation,
} from '../src/index.js';
import { credentialsFor, readReferenceEntry } from './reference.js';

const reference = readReferenceEntry();
const entry = buildVoucherEntry(reference.config, reference.voucher, reference.nonce);

/** The same voucher, under a chosen credential arm and expiration ledger. */
function entryWith(
  arm: 'addressV2' | 'address',
  expirationLedger: number,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: credentialsFor(
      reference.voucher.payer,
      reference.nonce,
      expirationLedger,
      arm,
    ),
    rootInvocation: redeemInvocation(reference.config, reference.voucher),
  });
}

test('the credential constant is the value the pinned SDK declares', () => {
  assert.equal(
    CREDENTIAL_TYPE_ADDRESS_V2,
    xdr.SorobanCredentialsType.sorobanCredentialsAddressV2().value,
  );
});

test('the envelope constant is the value the pinned SDK computes', () => {
  const preimage = buildAuthorizationEntryPreimage(
    entry,
    reference.voucher.expireAt,
    reference.config.network,
  );
  assert.equal(AUTH_ENVELOPE_TYPE_WITH_ADDRESS, preimage.switch().value);
});

test('a built entry is address bound', () => {
  assert.equal(credentialDiscriminant(entry), CREDENTIAL_TYPE_ADDRESS_V2);
  assert.equal(
    authEnvelopeType(entry, reference.config.network),
    AUTH_ENVELOPE_TYPE_WITH_ADDRESS,
  );
  assert.doesNotThrow(() => assertAddressV2(reference.config, entry));
});

test('a legacy credential arm raises CredentialTypeError', () => {
  const legacy = entryWith('address', reference.voucher.expireAt);
  assert.notEqual(credentialDiscriminant(legacy), CREDENTIAL_TYPE_ADDRESS_V2);
  assert.notEqual(
    authEnvelopeType(legacy, reference.config.network),
    AUTH_ENVELOPE_TYPE_WITH_ADDRESS,
  );
  assert.throws(
    () => assertAddressV2(reference.config, legacy),
    (error: unknown) => {
      assert.ok(error instanceof CredentialTypeError);
      assert.equal(error.expectedDiscriminant, CREDENTIAL_TYPE_ADDRESS_V2);
      assert.equal(error.expectedEnvelopeType, AUTH_ENVELOPE_TYPE_WITH_ADDRESS);
      return true;
    },
  );
});

test('source-account credentials raise VoucherFormatError', () => {
  const sourceAccount = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: redeemInvocation(reference.config, reference.voucher),
  });
  assert.throws(() => addressCredentials(sourceAccount), VoucherFormatError);
});

test('aligned deadlines return the one value', () => {
  assert.equal(
    assertDeadlinesAligned(entry, reference.voucher.expireAt),
    reference.voucher.expireAt,
  );
});

test('a host deadline below expire_at raises DeadlineMismatchError', () => {
  const truncated = entryWith('addressV2', reference.voucher.expireAt - 1000);
  assert.throws(
    () => assertDeadlinesAligned(truncated, reference.voucher.expireAt),
    (error: unknown) => {
      assert.ok(error instanceof DeadlineMismatchError);
      assert.equal(error.signatureExpirationLedger, reference.voucher.expireAt - 1000);
      assert.equal(error.expireAt, reference.voucher.expireAt);
      return true;
    },
  );
});

test('the pinned SDK version passes the guard', () => {
  const pinned = `${EXPECTED_SDK_MAJOR}.${EXPECTED_SDK_MINOR_MIN}.0`;
  assert.equal(assertSdkVersion(pinned), pinned);
  assert.equal(assertSdkVersion('16.9.1'), '16.9.1');
});

test('a wrong SDK version raises SdkVersionError', () => {
  assert.throws(() => assertSdkVersion('17.0.1'), SdkVersionError);
  assert.throws(() => assertSdkVersion('16.2.9'), SdkVersionError);
  assert.throws(() => assertSdkVersion('not a version'), SdkVersionError);
});
