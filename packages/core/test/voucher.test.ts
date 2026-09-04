import assert from 'node:assert/strict';
import test from 'node:test';
import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import {
  AmountWindowError,
  CONTRACT_MAX_AMOUNT_STROOPS,
  CredentialTypeError,
  DeadlineMismatchError,
  TESTNET_CONFIG,
  VoucherFormatError,
  buildVoucherEntry,
  ed25519Signer,
  randomNonce,
  randomVoucherId,
  readVoucher,
  redeemArgs,
  signVoucher,
} from '../src/index.js';
import type { SignEntry, VoucherConfig } from '../src/index.js';
import { credentialsFor, readReferenceEntry } from './reference.js';

const reference = readReferenceEntry();
const { config, voucher, nonce } = reference;
const payerSecret = Keypair.fromRawEd25519Seed(
  Buffer.from(reference.payerSeedHex, 'hex'),
).secret();

/** An entry whose root call names `functionName` and carries `args`. */
function entryWithCall(
  functionName: string,
  args: xdr.ScVal[],
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: credentialsFor(voucher.payer, nonce, voucher.expireAt, 'addressV2'),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(config.contractId).toScAddress(),
          functionName,
          args,
        }),
      ),
      subInvocations: [],
    }),
  });
}

test('redeem takes five arguments and the recipient is the last', () => {
  const recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
  const args = redeemArgs(voucher, recipient);
  assert.equal(args.length, 5);
  assert.equal(Address.fromScVal(args[0] ?? xdr.ScVal.scvVoid()).toString(), voucher.payer);
  assert.equal(Address.fromScVal(args[4] ?? xdr.ScVal.scvVoid()).toString(), recipient);
});

test('the signed arguments leave the recipient out', () => {
  const entry = buildVoucherEntry(config, voucher, nonce);
  const call = entry.rootInvocation().function().contractFn();
  assert.equal(call.args().length, 3);
});

test('the sub-invocation transfers from the payer to the contract', () => {
  const entry = buildVoucherEntry(config, voucher, nonce);
  const subs = entry.rootInvocation().subInvocations();
  assert.equal(subs.length, 1);
  const transfer = subs[0]?.function().contractFn();
  assert.ok(transfer !== undefined);
  assert.equal(transfer.functionName().toString(), 'transfer');
  assert.equal(Address.fromScAddress(transfer.contractAddress()).toString(), config.tokenId);
});

test('a reader configured for another contract refuses the entry', () => {
  const entry = buildVoucherEntry(config, voucher, nonce);
  const other: VoucherConfig = { ...config, contractId: TESTNET_CONFIG.tokenId };
  assert.throws(() => readVoucher(other, entry), VoucherFormatError);
});

test('the reader refuses an entry that authorizes another function', () => {
  const entry = entryWithCall('void', [nativeToScVal(1, { type: 'u32' })]);
  assert.throws(() => readVoucher(config, entry), VoucherFormatError);
});

test('the reader refuses an entry with the wrong argument count', () => {
  const entry = entryWithCall('redeem', [nativeToScVal(1, { type: 'u32' })]);
  assert.throws(() => readVoucher(config, entry), VoucherFormatError);
});

test('the reader refuses an entry that authorizes a contract deployment', () => {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: credentialsFor(voucher.payer, nonce, voucher.expireAt, 'addressV2'),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
        new xdr.CreateContractArgs({
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new xdr.ContractIdPreimageFromAddress({
              address: new Address(voucher.payer).toScAddress(),
              salt: Buffer.alloc(32, 1),
            }),
          ),
          executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
        }),
      ),
      subInvocations: [],
    }),
  });
  assert.throws(() => readVoucher(config, entry), VoucherFormatError);
});

test('a signer that moves the deadline is caught', async () => {
  const moveDeadline: SignEntry = async (entry) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        new xdr.SorobanAddressCredentials({
          address: entry.credentials().addressV2().address(),
          nonce: entry.credentials().addressV2().nonce(),
          signatureExpirationLedger: voucher.expireAt - 1,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: entry.rootInvocation(),
    });
  await assert.rejects(
    signVoucher(config, voucher, nonce, moveDeadline),
    DeadlineMismatchError,
  );
});

test('a signer that drops address binding is caught', async () => {
  const downgrade: SignEntry = async (entry) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        entry.credentials().addressV2(),
      ),
      rootInvocation: entry.rootInvocation(),
    });
  await assert.rejects(signVoucher(config, voucher, nonce, downgrade), CredentialTypeError);
});

test('a signed voucher reads back as the terms that the payer chose', async () => {
  const signed = await signVoucher(config, voucher, nonce, ed25519Signer(config, payerSecret));
  const decoded = readVoucher(config, signed);
  assert.equal(decoded.amount, voucher.amount);
  assert.equal(decoded.voucherId, voucher.voucherId);
  assert.equal(decoded.expireAt, voucher.expireAt);
  assert.notEqual(signed.credentials().addressV2().signature().switch().name, 'scvVoid');
});

test('a nonce fits a signed 64-bit range and an identifier fits an unsigned one', () => {
  const drawnNonce = randomNonce();
  const drawnId = randomVoucherId();
  assert.equal(BigInt.asIntN(64, drawnNonce), drawnNonce);
  assert.equal(BigInt.asUintN(64, drawnId), drawnId);
  assert.ok(drawnId >= 0n);
});

test('two draws differ', () => {
  const draws = new Set<bigint>();
  for (let i = 0; i < 64; i += 1) draws.add(randomNonce());
  assert.equal(draws.size, 64);
});

test('the builder refuses an amount that the contract would reject', () => {
  const tooLarge = { ...voucher, amount: CONTRACT_MAX_AMOUNT_STROOPS + 1n };
  assert.throws(() => buildVoucherEntry(config, tooLarge, nonce), AmountWindowError);
  const zero = { ...voucher, amount: 0n };
  assert.throws(() => buildVoucherEntry(config, zero, nonce), AmountWindowError);
});
