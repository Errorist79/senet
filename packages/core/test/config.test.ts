import assert from 'node:assert/strict';
import test from 'node:test';
import { Asset, Networks, hash } from '@stellar/stellar-sdk';
import {
  NETWORK_ID_BYTES,
  PAYLOAD_PREFIX_BYTES,
  PAYLOAD_VERSION,
  TESTNET_CONFIG,
  TESTNET_CONTRACT_ID,
  nativeTokenId,
  networkId,
  networkTag,
} from '../src/index.js';

test('the network id is the hash of the network passphrase', () => {
  const expected = new Uint8Array(hash(Buffer.from(Networks.TESTNET, 'utf8')));
  assert.deepEqual(networkId(Networks.TESTNET), expected);
  assert.equal(networkId(Networks.TESTNET).length, 32);
});

test('the network identifier is the first bytes of the network id', () => {
  const tag = networkTag(Networks.TESTNET);
  assert.equal(tag.length, NETWORK_ID_BYTES * 2);
  assert.equal(
    tag,
    Buffer.from(networkId(Networks.TESTNET).subarray(0, NETWORK_ID_BYTES)).toString('hex'),
  );
});

test('the public network carries a different identifier', () => {
  assert.notEqual(networkTag(Networks.TESTNET), networkTag(Networks.PUBLIC));
  assert.notEqual(networkTag(Networks.TESTNET), networkTag(Networks.FUTURENET));
  assert.notEqual(networkTag(Networks.PUBLIC), networkTag(Networks.FUTURENET));
});

test('the native token address follows the network', () => {
  assert.equal(nativeTokenId(Networks.TESTNET), Asset.native().contractId(Networks.TESTNET));
  assert.notEqual(nativeTokenId(Networks.TESTNET), nativeTokenId(Networks.PUBLIC));
});

test('the testnet default carries the testnet identities', () => {
  assert.equal(TESTNET_CONFIG.network, Networks.TESTNET);
  assert.equal(TESTNET_CONFIG.contractId, TESTNET_CONTRACT_ID);
  assert.equal(TESTNET_CONFIG.tokenId, nativeTokenId(Networks.TESTNET));
});

test('the payload prefix is one version byte and the network identifier', () => {
  assert.equal(PAYLOAD_PREFIX_BYTES, 1 + NETWORK_ID_BYTES);
  assert.ok(PAYLOAD_VERSION >= 0 && PAYLOAD_VERSION <= 255);
});
