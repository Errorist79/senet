import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import {
  INCLUSION_FEE_STROOPS,
  MAX_ATTEMPTS,
  MAX_FEE_STROOPS,
  MIN_CHANNEL_BALANCE_STROOPS,
  readConfig,
  retryable,
} from '../src/index.js';
import type { SubmitResult, Stage } from '../src/index.js';
import { TESTNET_CONTRACT_ID, nativeTokenId } from '@senet/core';

/** The whole bid that one redeem declared on testnet, in stroops. */
const MEASURED_REDEEM_BID_STROOPS = 47_743n;

/** A result with only the two fields that the retry rule reads. */
function resultOf(outcome: SubmitResult['outcome'], stage: Stage): SubmitResult {
  return {
    outcome,
    stage,
    hash: null,
    ledger: null,
    declaredFeeStroops: null,
    feeChargedStroops: null,
    contractErrorCode: null,
    errorOrigin: null,
    resultCode: null,
    operationResultCode: null,
    attempt: 1,
    elapsedMs: 0,
    channel: null,
    detail: '',
  };
}

/** Run `body` with a chosen environment, and put the old one back. */
function withEnv(values: Record<string, string | undefined>, body: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('a bad sequence number is safe to try again', () => {
  assert.equal(retryable(resultOf('BAD_SEQUENCE', 'send')), true);
  assert.equal(retryable(resultOf('BAD_SEQUENCE', 'apply')), true);
});

test('a timeout before the network is safe to try again', () => {
  assert.equal(retryable(resultOf('TIMEOUT', 'simulate')), true);
  assert.equal(retryable(resultOf('TIMEOUT', 'send')), true);
});

test('a timeout at the poll stage is never tried again', () => {
  // The transaction carries a hash and it may still apply. A second attempt
  // would send the same voucher while the first one is still in flight.
  assert.equal(retryable(resultOf('TIMEOUT', 'poll')), false);
});

test('a spent voucher is never tried again', () => {
  assert.equal(retryable(resultOf('NONCE_CONSUMED', 'simulate')), false);
  assert.equal(retryable(resultOf('SUCCESS', 'apply')), false);
  assert.equal(retryable(resultOf('AUTH_EXPIRED', 'simulate')), false);
  assert.equal(retryable(resultOf('BAD_SIGNATURE', 'simulate')), false);
  assert.equal(retryable(resultOf('PAYER_INSUFFICIENT_BALANCE', 'simulate')), false);
  assert.equal(retryable(resultOf('CONTRACT_REJECTED', 'simulate')), false);
  assert.equal(retryable(resultOf('APPLY_FAILED', 'apply')), false);
  assert.equal(retryable(resultOf('UNKNOWN', 'apply')), false);
});

test('the attempt count leaves room for one retry and stays small', () => {
  assert.ok(MAX_ATTEMPTS >= 2);
  assert.ok(MAX_ATTEMPTS <= 5);
});

test('the fee ceiling sits above a redeem and below the channel floor', () => {
  // A ceiling under the measured bid would refuse every redeem. A ceiling at
  // or above the floor would let one request empty a channel account.
  assert.ok(MAX_FEE_STROOPS > MEASURED_REDEEM_BID_STROOPS);
  assert.ok(MAX_FEE_STROOPS < MIN_CHANNEL_BALANCE_STROOPS);
});

test('the inclusion fee is a part of the measured bid', () => {
  assert.ok(INCLUSION_FEE_STROOPS < MEASURED_REDEEM_BID_STROOPS);
});

test('the configuration needs at least one channel key', () => {
  withEnv({ FEEPAYER_CHANNELS: undefined }, () => {
    assert.throws(() => readConfig(), /FEEPAYER_CHANNELS is not set/);
  });
  withEnv({ FEEPAYER_CHANNELS: ' , ' }, () => {
    assert.throws(() => readConfig(), /cannot pay any fee/);
  });
});

test('the configuration refuses one key that appears twice', () => {
  const secret = Keypair.random().secret();
  withEnv({ FEEPAYER_CHANNELS: `${secret},${secret}` }, () => {
    assert.throws(() => readConfig(), /names one key twice/);
  });
});

test('the configuration takes the testnet defaults', () => {
  withEnv(
    {
      FEEPAYER_CHANNELS: Keypair.random().secret(),
      NETWORK_PASSPHRASE: undefined,
      CONTRACT_ID: undefined,
      TOKEN_ID: undefined,
      RPC_URL: undefined,
      HORIZON_URL: undefined,
    },
    () => {
      const config = readConfig();
      assert.equal(config.voucher.network, Networks.TESTNET);
      assert.equal(config.channelSecrets.length, 1);
      assert.match(config.voucher.contractId, /^C[A-Z2-7]{55}$/);
      assert.match(config.voucher.tokenId, /^C[A-Z2-7]{55}$/);
    },
  );
});

test('the configuration takes an operator override', () => {
  // A redeploy changes the contract, and an operator names the new one here
  // without a code change. The value is any contract other than the default.
  const redeployed = nativeTokenId(Networks.TESTNET);
  withEnv(
    {
      FEEPAYER_CHANNELS: Keypair.random().secret(),
      CONTRACT_ID: redeployed,
      RPC_URL: 'https://rpc.example.test',
    },
    () => {
      const config = readConfig();
      assert.notEqual(redeployed, TESTNET_CONTRACT_ID);
      assert.equal(config.voucher.contractId, redeployed);
      assert.equal(config.rpcUrl, 'https://rpc.example.test');
    },
  );
});
