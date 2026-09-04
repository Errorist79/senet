import { readFileSync } from 'node:fs';
import { Address, xdr } from '@stellar/stellar-sdk';
import type { VoucherConfig, Voucher } from '../src/index.js';

/**
 * The entry that an earlier voucher module builds for one fixed input.
 *
 * A generator ran that module once and recorded the bytes. This package never
 * imports the module, so the record is the only link between the two.
 */
export interface ReferenceEntry {
  readonly config: VoucherConfig;
  readonly voucher: Voucher;
  readonly nonce: bigint;
  readonly payerSeedHex: string;
  readonly unsignedEntryXdr: string;
  readonly signedEntryXdr: string;
}

/** A plain object, whose values stay unknown until a check reads one. */
function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`the fixture field ${label} is not an object`);
  }
  return { ...value };
}

/** A value that carries a string under `key`. */
function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw new Error(`the fixture field ${key} is not a string`);
  }
  return value;
}

/** A value that carries a whole number under `key`. */
function numberField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`the fixture field ${key} is not a whole number`);
  }
  return value;
}

/**
 * Read the recorded fixture.
 *
 * `JSON.parse` returns a value of unknown shape. Every field passes a check
 * that inspects it before this function names its type.
 */
export function readReferenceEntry(): ReferenceEntry {
  const path = new URL('../../test/fixtures/reference-entry.json', import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const root = asObject(parsed, 'the fixture');
  const input = asObject(root['input'], 'input');
  return {
    config: {
      network: stringField(input, 'network'),
      contractId: stringField(input, 'contractId'),
      tokenId: stringField(input, 'tokenId'),
    },
    voucher: {
      payer: stringField(input, 'payer'),
      amount: BigInt(stringField(input, 'amount')),
      voucherId: BigInt(stringField(input, 'voucherId')),
      expireAt: numberField(input, 'expireAt'),
    },
    nonce: BigInt(stringField(input, 'nonce')),
    payerSeedHex: stringField(input, 'payerSeedHex'),
    unsignedEntryXdr: stringField(root, 'unsignedEntryXdr'),
    signedEntryXdr: stringField(root, 'signedEntryXdr'),
  };
}

/** The address credentials that the tests build, under either address arm. */
export function credentialsFor(
  payer: string,
  nonce: bigint,
  expirationLedger: number,
  arm: 'addressV2' | 'address',
): xdr.SorobanCredentials {
  const credentials = new xdr.SorobanAddressCredentials({
    address: new Address(payer).toScAddress(),
    nonce: new xdr.Int64(nonce),
    signatureExpirationLedger: expirationLedger,
    signature: xdr.ScVal.scvVoid(),
  });
  return arm === 'addressV2'
    ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials)
    : xdr.SorobanCredentials.sorobanCredentialsAddress(credentials);
}
