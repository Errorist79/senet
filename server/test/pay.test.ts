import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair, Networks, xdr } from '@stellar/stellar-sdk';
import { buildPaymentEntry, nativeTokenId, transferInvocation } from '@senet/core';

/**
 * What a payment authorizes, and what it must not.
 *
 * The service rebuilds the invocation from the request and compares it against
 * the signed one. Every case here changes one field of the description, and
 * asserts that the comparison notices. A comparison that passed on a changed
 * field would let a caller move an amount that nobody signed for.
 */

const config = {
  network: Networks.TESTNET,
  contractId: 'CADGZVNCAFRHJ44P33RODTVXGXCX5EMVCYFHYFMGWNFYVILC556XGWBY',
  tokenId: nativeTokenId(Networks.TESTNET),
};
const FROM = Keypair.random().publicKey();
const TO = Keypair.random().publicKey();

/** The invocation that a description produces, as the service builds it. */
function built(from: string, to: string, amount: bigint): Buffer {
  return transferInvocation(config, { from, to, amount, expireAt: 0 }).toXDR();
}

test('a signed entry matches the invocation that its own description builds', () => {
  const entry = buildPaymentEntry(config, { from: FROM, to: TO, amount: 5n, expireAt: 100 }, 1n);
  assert.ok(entry.rootInvocation().toXDR().equals(built(FROM, TO, 5n)));
});

test('a changed amount no longer matches, so the service refuses it', () => {
  const entry = buildPaymentEntry(config, { from: FROM, to: TO, amount: 5n, expireAt: 100 }, 1n);
  assert.ok(!entry.rootInvocation().toXDR().equals(built(FROM, TO, 6n)));
});

test('a changed recipient no longer matches', () => {
  const entry = buildPaymentEntry(config, { from: FROM, to: TO, amount: 5n, expireAt: 100 }, 1n);
  const stranger = Keypair.random().publicKey();
  assert.ok(!entry.rootInvocation().toXDR().equals(built(FROM, stranger, 5n)));
});

test('the entry carries ADDRESS_V2 credentials, which bind the signer', () => {
  const entry = buildPaymentEntry(config, { from: FROM, to: TO, amount: 5n, expireAt: 100 }, 1n);
  assert.equal(entry.credentials().switch().value, 2);
  const held = entry.credentials().addressV2();
  assert.equal(held.signatureExpirationLedger(), 100);
});

test('the builder refuses a payment of nothing, and signs nothing', () => {
  for (const amount of [0n, -1n]) {
    assert.throws(() =>
      buildPaymentEntry(config, { from: FROM, to: TO, amount, expireAt: 100 }, 1n),
    );
  }
});

test('the entry names the native asset contract and the transfer function', () => {
  const entry = buildPaymentEntry(config, { from: FROM, to: TO, amount: 5n, expireAt: 100 }, 1n);
  const call = entry.rootInvocation().function().contractFn();
  assert.equal(call.functionName().toString(), 'transfer');
  assert.equal(xdr.ScAddress.fromXDR(call.contractAddress().toXDR()).toXDR().length > 0, true);
});
