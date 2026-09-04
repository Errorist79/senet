import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@stellar/stellar-sdk';
import { buildVoucherEntry, ed25519Signer, readVoucher, signVoucher } from '../src/index.js';
import { readReferenceEntry } from './reference.js';

const reference = readReferenceEntry();
const payerSecret = Keypair.fromRawEd25519Seed(
  Buffer.from(reference.payerSeedHex, 'hex'),
).secret();

test('the unsigned entry matches the recorded bytes', () => {
  const built = buildVoucherEntry(reference.config, reference.voucher, reference.nonce);
  assert.equal(built.toXDR('base64'), reference.unsignedEntryXdr);
});

test('the signed entry matches the recorded bytes', async () => {
  const signed = await signVoucher(
    reference.config,
    reference.voucher,
    reference.nonce,
    ed25519Signer(reference.config, payerSecret),
  );
  assert.equal(signed.toXDR('base64'), reference.signedEntryXdr);
});

test('the recorded entry reads back as the terms that produced it', () => {
  const built = buildVoucherEntry(reference.config, reference.voucher, reference.nonce);
  const decoded = readVoucher(reference.config, built);
  assert.equal(decoded.payer, reference.voucher.payer);
  assert.equal(decoded.amount, reference.voucher.amount);
  assert.equal(decoded.voucherId, reference.voucher.voucherId);
  assert.equal(decoded.expireAt, reference.voucher.expireAt);
  assert.equal(decoded.contractId, reference.config.contractId);
  assert.equal(decoded.nonce, reference.nonce);
  assert.equal(decoded.signatureExpirationLedger, reference.voucher.expireAt);
});

test('a voucher identifier above the safe integer range survives the round trip', () => {
  assert.ok(reference.voucher.voucherId > BigInt(Number.MAX_SAFE_INTEGER));
});
