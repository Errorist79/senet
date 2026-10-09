import assert from 'node:assert/strict';
import test from 'node:test';
import { Address, Keypair, Networks, xdr } from '@stellar/stellar-sdk';
import {
  INCLUSION_FEE_STROOPS,
  MAX_ATTEMPTS,
  MAX_DEPLOY_FEE_STROOPS,
  MAX_PASSKEY_REQUEST_FEE_STROOPS,
  MAX_REDEEM_FEE_STROOPS,
  MIN_CHANNEL_BALANCE_STROOPS,
  isWalletDeployment,
  payerCeilingFor,
  readConfig,
  retryable,
} from '../src/index.js';
import type { SubmitResult, Stage } from '../src/index.js';
import { TESTNET_CONTRACT_ID, nativeTokenId } from '@senet/core';

/**
 * The whole fees that requests declared on testnet on 4 October 2026, in
 * stroops: the most of each kind, at a rent rate of 5,403 stroops per KB.
 */
const MEASURED_REDEEM_BID_STROOPS = 49_334n;
const MEASURED_PASSKEY_REDEEM_BID_STROOPS = 52_035n;
const MEASURED_PAY_BID_STROOPS = 45_411n;
const MEASURED_DEPLOY_BID_STROOPS = 6_644_266n;

/** The network setting `rentFee1KbSorobanStateSizeHigh` over the measured rate. */
const RENT_RATE_GROWTH = 10_000 / 5_403;

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

/** A measured fee at the highest rent rate below the target state size. */
function atHighestRate(bid: bigint): number {
  return Number(bid) * RENT_RATE_GROWTH;
}

test('every ceiling covers its measured request at the highest rent rate, below the channel floor', () => {
  // A ceiling under the cost of a request refuses that request. A ceiling at
  // or above the floor would let one request empty a channel account.
  for (const [ceiling, bid] of [
    [MAX_REDEEM_FEE_STROOPS, MEASURED_REDEEM_BID_STROOPS],
    [MAX_PASSKEY_REQUEST_FEE_STROOPS, MEASURED_PASSKEY_REDEEM_BID_STROOPS],
    [MAX_PASSKEY_REQUEST_FEE_STROOPS, MEASURED_PAY_BID_STROOPS],
    [MAX_DEPLOY_FEE_STROOPS, MEASURED_DEPLOY_BID_STROOPS],
  ] as const) {
    assert.ok(Number(ceiling) > atHighestRate(bid));
    assert.ok(ceiling < MIN_CHANNEL_BALANCE_STROOPS);
  }
});

test('a key never spends what a passkey account or a deployment may spend', () => {
  // A key runs no authorization code, so nothing in its request extends an
  // account. Its ceiling stays far below the other two.
  assert.ok(MAX_REDEEM_FEE_STROOPS < MAX_DEPLOY_FEE_STROOPS);
  assert.ok(MAX_REDEEM_FEE_STROOPS < MAX_PASSKEY_REQUEST_FEE_STROOPS);
});

/** The code entry that a contract runs, by the hash of its Wasm. */
function wasm(hash: string): xdr.ContractExecutable {
  return xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hash, 'hex'));
}

const WALLET_WASM = '502ea4e7bdb3ea99880941f1d35ceb67fb598692c0bb40f842ef9c9f17d58b58';
const OTHER_WASM = 'c93a39a97541555caf3136dfa13dc33e1592ce492a07ad2f00d050352f98bf55';

test('only a passkey wallet gets the passkey ceiling', () => {
  const key = Keypair.random().publicKey();
  assert.equal(payerCeilingFor(key, null, WALLET_WASM), MAX_REDEEM_FEE_STROOPS);
  assert.equal(payerCeilingFor(TESTNET_CONTRACT_ID, wasm(WALLET_WASM), WALLET_WASM), MAX_PASSKEY_REQUEST_FEE_STROOPS);
  // A contract that runs code of its owner's choice spends no more than a key.
  assert.equal(payerCeilingFor(TESTNET_CONTRACT_ID, wasm(OTHER_WASM), WALLET_WASM), MAX_REDEEM_FEE_STROOPS);
  assert.equal(payerCeilingFor(TESTNET_CONTRACT_ID, null, WALLET_WASM), MAX_REDEEM_FEE_STROOPS);
});

test('the deploy route pays only for a deployment of the wallet code', () => {
  const deploy = (hash: string): xdr.HostFunction =>
    xdr.HostFunction.hostFunctionTypeCreateContractV2(
      new xdr.CreateContractArgsV2({
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({
            address: Address.fromString(Keypair.random().publicKey()).toScAddress(),
            salt: Buffer.alloc(32),
          }),
        ),
        executable: wasm(hash),
        constructorArgs: [],
      }),
    );
  assert.equal(isWalletDeployment(deploy(WALLET_WASM), WALLET_WASM), true);
  assert.equal(isWalletDeployment(deploy(OTHER_WASM), WALLET_WASM), false);
  // A call into any contract is not a deployment, whatever it does.
  const call = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(TESTNET_CONTRACT_ID).toScAddress(),
      functionName: 'redeem',
      args: [],
    }),
  );
  assert.equal(isWalletDeployment(call, WALLET_WASM), false);
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
      SEP7_SIGNING_SECRET: Keypair.random().secret(),
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
      SEP7_SIGNING_SECRET: Keypair.random().secret(),
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
