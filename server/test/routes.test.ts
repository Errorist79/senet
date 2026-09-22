import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Address, Keypair, Networks, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import {
  TESTNET_CONFIG,
  buildVoucherEntry,
  ed25519Signer,
  nativeTokenId,
  randomNonce,
  randomVoucherId,
  signVoucher,
} from '@senet/core';
import type { Voucher } from '@senet/core';
import {
  RP_ID,
  FeePayer,
  RATE_LIMIT_SPEND,
  TESTNET_FRIENDBOT_URL,
  TESTNET_HORIZON_URL,
  TESTNET_RPC_URL,
  TESTNET_WALLET_WASM_HASH,
  createApiHandler,
  addRedemption,
} from '../src/index.js';
import type { ServerConfig } from '../src/index.js';

/**
 * A service with one channel account that never pays.
 *
 * Every refusal in this file happens before the fee-payer reaches the network,
 * so no test here spends a fee or needs a funded key. A request that would
 * reach the network is not part of this file.
 */
const work = mkdtempSync(join(tmpdir(), 'senet-routes-'));
const config: ServerConfig = {
  voucher: TESTNET_CONFIG,
  rpcUrl: TESTNET_RPC_URL,
  horizonUrl: TESTNET_HORIZON_URL,
  friendbotUrl: TESTNET_FRIENDBOT_URL,
  walletWasmHash: TESTNET_WALLET_WASM_HASH,
  listenerStatePath: '/nonexistent/listener.json',
  redemptionStorePath: join(work, 'redemptions.json'),
  sep7SigningSecret: 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB',
  rpId: RP_ID,
  channelSecrets: [Keypair.random().secret()],
};

const payer = Keypair.random();
const recipient = Keypair.random().publicKey();
const expireAt = 4_500_000;

const voucher: Voucher = {
  payer: payer.publicKey(),
  amount: 1_000_000n,
  voucherId: randomVoucherId(),
  expireAt,
};

let service: Server;
let base: string;

before(async () => {
  // `FeePayer` reaches no network until it starts, and these tests never start
  // it, so the routes answer their refusals offline.
  const feePayer = new FeePayer(config);
  service = createServer(
    createApiHandler({ config, feePayer, server: new rpc.Server(config.rpcUrl) }),
  );
  await new Promise<void>((listening) => {
    service.listen(0, '127.0.0.1', listening);
  });
  const address = service.address();
  assert.ok(address !== null && typeof address !== 'string', 'the service took no port');
  base = `http://127.0.0.1:${address.port}/api`;
});

after(() => {
  service.close();
  rmSync(work, { recursive: true, force: true });
});

/** Post a JSON body and read the reply. */
async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

/** The error code of a reply, or nothing when the reply carries no error. */
function errorCode(json: unknown): string | null {
  if (json === null || typeof json !== 'object') return null;
  const fields: Record<string, unknown> = { ...json };
  const error = fields['error'];
  if (error === null || typeof error !== 'object') return null;
  const inner: Record<string, unknown> = { ...error };
  return typeof inner['code'] === 'string' ? inner['code'] : null;
}

/** An entry under a chosen credential arm and expiration ledger. */
function entryWith(
  arm: 'addressV2' | 'address',
  expirationLedger: number,
): xdr.SorobanAuthorizationEntry {
  const credentials = new xdr.SorobanAddressCredentials({
    address: new Address(voucher.payer).toScAddress(),
    nonce: new xdr.Int64(randomNonce()),
    signatureExpirationLedger: expirationLedger,
    signature: xdr.ScVal.scvVoid(),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials:
      arm === 'addressV2'
        ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddress(credentials),
    rootInvocation: buildVoucherEntry(TESTNET_CONFIG, voucher, randomNonce()).rootInvocation(),
  });
}

test('the configuration route names the contract and the network', async () => {
  const response = await fetch(`${base}/config`);
  assert.equal(response.status, 200);
  const json: unknown = await response.json();
  assert.ok(json !== null && typeof json === 'object');
  const fields: Record<string, unknown> = { ...json };
  assert.equal(fields['contractId'], TESTNET_CONFIG.contractId);
  assert.equal(fields['network'], Networks.TESTNET);
  assert.equal(fields['tokenId'], nativeTokenId(Networks.TESTNET));
  assert.equal(fields['networkTag'], 'cee0302d');
});

test('an unknown path is a typed refusal, not a crash', async () => {
  const response = await fetch(`${base}/nothing`);
  assert.equal(response.status, 404);
  assert.equal(errorCode(await response.json()), 'NOT_FOUND');
});

test('a redemption lookup requires the transaction hash', async () => {
  const response = await fetch(`${base}/redemption?voucherId=111`);
  assert.equal(response.status, 400);
  assert.equal(errorCode(await response.json()), 'MISSING_PARAMETER');
});

test('the redemption route selects the requested transaction for a repeated voucher identifier', async () => {
  const first = {
    voucher_id: '111', payer: payer.publicKey(), recipient, amount: '1000000',
    expire_at: expireAt, tx_hash: 'a'.repeat(64), ledger: expireAt - 1,
    ledger_closed_at: '2026-09-22T00:00:00Z', event_id: 'first',
  };
  const second = { ...first, tx_hash: 'b'.repeat(64), event_id: 'second', recipient: payer.publicKey() };
  addRedemption(config.redemptionStorePath, first);
  const url = `${base}/redemption?voucherId=111&txHash=${second.tx_hash}`;
  const pending = await fetch(url);
  assert.equal(pending.status, 200);
  assert.deepEqual(await pending.json(), { voucherId: '111', redemption: null });
  addRedemption(config.redemptionStorePath, second);
  const confirmed = await fetch(url);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), { voucherId: '111', redemption: second });
});

test('the service refuses a path outside its own prefix', async () => {
  const response = await fetch(`${base.replace('/api', '')}/index.html`);
  assert.equal(response.status, 404);
  assert.equal(errorCode(await response.json()), 'NOT_FOUND');
});

test('the service refuses a body that is not JSON', async () => {
  const { status, json } = await post('/redeem', 'not json at all');
  assert.equal(status, 400);
  assert.equal(errorCode(json), 'MALFORMED_BODY');
});

test('the service refuses a body that is a JSON array', async () => {
  const { status, json } = await post('/redeem', [1, 2, 3]);
  assert.equal(status, 400);
  assert.equal(errorCode(json), 'MALFORMED_BODY');
});

test('the service refuses a request with no entry', async () => {
  const { status, json } = await post('/redeem', { recipient });
  assert.equal(status, 400);
  assert.equal(errorCode(json), 'MISSING_FIELD');
});

test('the service refuses a request with no recipient', async () => {
  const { status, json } = await post('/redeem', { entryXdr: 'AAAA' });
  assert.equal(status, 400);
  assert.equal(errorCode(json), 'MISSING_FIELD');
});

test('the service refuses an entry that is not base64 XDR', async () => {
  const { status, json } = await post('/redeem', { entryXdr: 'not base64', recipient });
  assert.equal(status, 400);
  assert.equal(errorCode(json), 'MALFORMED_ENTRY');
});

test('the service names a legacy credential entry CredentialTypeError', async () => {
  const entry = entryWith('address', expireAt);
  const { status, json } = await post('/redeem', {
    entryXdr: entry.toXDR('base64'),
    recipient,
  });
  assert.equal(status, 400);
  assert.equal(errorCode(json), 'CredentialTypeError');
});

test('the service names deadlines that disagree DeadlineMismatchError', async () => {
  const entry = entryWith('addressV2', expireAt - 1000);
  const { status, json } = await post('/redeem', {
    entryXdr: entry.toXDR('base64'),
    recipient,
  });
  assert.equal(status, 400);
  assert.equal(errorCode(json), 'DeadlineMismatchError');
});

test('the service names an entry for another contract VoucherFormatError', async () => {
  const other = { ...TESTNET_CONFIG, contractId: nativeTokenId(Networks.TESTNET) };
  const entry = buildVoucherEntry(other, voucher, randomNonce());
  const { status, json } = await post('/redeem', {
    entryXdr: entry.toXDR('base64'),
    recipient,
  });
  assert.equal(status, 400);
  assert.equal(errorCode(json), 'VoucherFormatError');
});

test('the service refuses an entry that authorizes another function', async () => {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: entryWith('addressV2', expireAt).credentials(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(TESTNET_CONFIG.contractId).toScAddress(),
          functionName: 'void',
          args: [nativeToScVal(1, { type: 'u32' })],
        }),
      ),
      subInvocations: [],
    }),
  });
  const { status, json } = await post('/redeem', {
    entryXdr: entry.toXDR('base64'),
    recipient,
  });
  assert.equal(status, 400);
  assert.equal(errorCode(json), 'VoucherFormatError');
});

test('a well formed entry passes every check that runs before the network', async () => {
  // The signature and both invariants hold, so the route reaches the fee-payer.
  // The service then answers on the network, which this file does not exercise.
  const signed = await signVoucher(
    TESTNET_CONFIG,
    voucher,
    randomNonce(),
    ed25519Signer(TESTNET_CONFIG, payer.secret()),
  );
  assert.doesNotThrow(() => signed.credentials().addressV2());
  assert.equal(signed.credentials().addressV2().signatureExpirationLedger(), voucher.expireAt);
});

test('the budget on a paying route refuses a burst', async () => {
  const entry = entryWith('address', expireAt).toXDR('base64');
  let refused = 0;
  for (let i = 0; i < RATE_LIMIT_SPEND + 3; i += 1) {
    const { status } = await post('/redeem', { entryXdr: entry, recipient });
    if (status === 429) refused += 1;
  }
  assert.ok(refused >= 3, `the budget refused ${refused} requests of the burst`);
});
