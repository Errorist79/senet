import assert from 'node:assert/strict';
import test from 'node:test';
import { Networks, xdr } from '@stellar/stellar-sdk';
import {
  CredentialTypeError,
  NETWORK_ID_BYTES,
  NetworkMismatchError,
  PAYLOAD_PREFIX_BYTES,
  PAYLOAD_VERSION,
  PayloadVersionError,
  VoucherFormatError,
  buildVoucherEntry,
  decodeVoucher,
  encodeVoucher,
  nativeTokenId,
  networkTag,
  redeemInvocation,
} from '../src/index.js';
import type { VoucherConfig } from '../src/index.js';
import { credentialsFor, readReferenceEntry } from './reference.js';

const reference = readReferenceEntry();
const { config, voucher, nonce } = reference;
const entry = buildVoucherEntry(config, voucher, nonce);
const payload = encodeVoucher(config, entry);

test('the payload is the prefix and then the entry', () => {
  assert.equal(payload[0], PAYLOAD_VERSION);
  assert.equal(
    Buffer.from(payload.subarray(1, PAYLOAD_PREFIX_BYTES)).toString('hex'),
    networkTag(config.network),
  );
  assert.equal(payload.length, PAYLOAD_PREFIX_BYTES + entry.toXDR().length);
});

test('the prefix costs one version byte and the network identifier', () => {
  assert.equal(PAYLOAD_PREFIX_BYTES, 1 + NETWORK_ID_BYTES);
  assert.equal(payload.length - entry.toXDR().length, PAYLOAD_PREFIX_BYTES);
});

test('the entry inside the payload is byte identical', () => {
  const inner = Buffer.from(payload.subarray(PAYLOAD_PREFIX_BYTES));
  assert.deepEqual(inner, entry.toXDR());
  assert.equal(decodeVoucher(config, payload).entry.toXDR('base64'), entry.toXDR('base64'));
});

test('a decoded voucher carries the terms that the payer signed', () => {
  const decoded = decodeVoucher(config, payload);
  assert.equal(decoded.payer, voucher.payer);
  assert.equal(decoded.amount, voucher.amount);
  assert.equal(decoded.voucherId, voucher.voucherId);
  assert.equal(decoded.expireAt, voucher.expireAt);
  assert.equal(decoded.contractId, config.contractId);
});

test('an unknown version raises PayloadVersionError', () => {
  const wrong = Uint8Array.from(payload);
  wrong[0] = PAYLOAD_VERSION + 1;
  assert.throws(
    () => decodeVoucher(config, wrong),
    (error: unknown) => {
      assert.ok(error instanceof PayloadVersionError);
      assert.equal(error.found, PAYLOAD_VERSION + 1);
      assert.equal(error.expected, PAYLOAD_VERSION);
      return true;
    },
  );
});

test('another network raises NetworkMismatchError', () => {
  const publicConfig: VoucherConfig = {
    network: Networks.PUBLIC,
    contractId: config.contractId,
    tokenId: nativeTokenId(Networks.PUBLIC),
  };
  assert.throws(
    () => decodeVoucher(publicConfig, payload),
    (error: unknown) => {
      assert.ok(error instanceof NetworkMismatchError);
      assert.equal(error.found, networkTag(Networks.TESTNET));
      assert.equal(error.expected, networkTag(Networks.PUBLIC));
      return true;
    },
  );
});

test('the reader checks the version before the network', () => {
  // A reader that does not know the format cannot judge the network inside it.
  const wrong = Uint8Array.from(payload);
  wrong[0] = PAYLOAD_VERSION + 1;
  wrong[1] = (wrong[1] ?? 0) ^ 0xff;
  assert.throws(() => decodeVoucher(config, wrong), PayloadVersionError);
});

test('a legacy credential arm raises CredentialTypeError', () => {
  const legacy = new xdr.SorobanAuthorizationEntry({
    credentials: credentialsFor(voucher.payer, nonce, voucher.expireAt, 'address'),
    rootInvocation: redeemInvocation(config, voucher),
  });
  assert.throws(() => decodeVoucher(config, encodeVoucher(config, legacy)), CredentialTypeError);
});

test('bytes that hold no entry raise VoucherFormatError', () => {
  const broken = Uint8Array.from(payload);
  broken.set([0xff, 0xff, 0xff, 0xff], PAYLOAD_PREFIX_BYTES);
  assert.throws(() => decodeVoucher(config, broken), VoucherFormatError);
});

test('a payload with nothing after the prefix raises VoucherFormatError', () => {
  assert.throws(
    () => decodeVoucher(config, payload.subarray(0, PAYLOAD_PREFIX_BYTES)),
    VoucherFormatError,
  );
  assert.throws(() => decodeVoucher(config, new Uint8Array(0)), VoucherFormatError);
});
