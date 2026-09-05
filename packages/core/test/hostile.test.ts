import assert from 'node:assert/strict';
import test from 'node:test';
import { Address, xdr } from '@stellar/stellar-sdk';
import {
  PAYLOAD_PREFIX_BYTES,
  VOUCHER_ERROR_NAMES,
  VoucherError,
  buildVoucherEntry,
  contractFn,
  decodeVoucher,
  encodeVoucher,
  redeemInvocation,
} from '../src/index.js';
import { credentialsFor, readReferenceEntry } from './reference.js';

/**
 * The path that reads a scanned code, given bytes that a stranger chose.
 *
 * A merchant points a camera at whatever is in front of it. Anybody can hold a
 * symbol there, so the bytes that reach `decodeVoucher` are chosen by somebody
 * outside this system. That is the only place in this product where a hostile
 * party decides what our code parses.
 *
 * The claim that this path holds is not that a decoder is safe. It is
 * that whatever arrives leaves as one of two things: a voucher that meets
 * every rule the library holds, or a typed refusal that a screen can show. No
 * other exception, no other return, and no run that does not end.
 *
 * That claim was an argument until this file existed. An argument about a
 * control that nobody has watched fail is the weakest thing in a security
 * note. These tests watch it fail on purpose, once for each shape of input
 * that a stranger can produce.
 *
 * What this does not do: it does not test the decoder. `zxing-wasm` turns a
 * picture into bytes, and these tests start from the bytes. A fault inside the
 * decoder is a fault this file cannot see. What it shows is that the bytes a
 * decoder hands over, whatever they are, meet a reader that refuses them by
 * name.
 */

/** How long one refusal may take before this file calls it a hang. */
const REFUSAL_LIMIT_MS = 1_000;

/** How many mutations of a real voucher the sweep tries. */
const MUTATIONS = 400;

const { config, voucher, nonce } = readReferenceEntry();

/** The bytes that an honest payer's screen carries. */
const REAL = encodeVoucher(config, buildVoucherEntry(config, voucher, nonce));

/**
 * Read one byte string, and insist on a typed refusal.
 *
 * A refusal has to be a `VoucherError` whose name the library publishes,
 * because that name is what a screen shows a merchant. Anything else reaches a
 * person as two meaningless letters, or as nothing at all.
 */
function refuses(bytes: Uint8Array, what: string): string {
  const started = Date.now();
  let outcome: 'read' | 'threw' = 'threw';
  let caught: unknown = null;
  try {
    decodeVoucher(config, bytes);
    outcome = 'read';
  } catch (error) {
    caught = error;
  }
  const took = Date.now() - started;

  assert.equal(outcome, 'threw', `${what} was read as a voucher, and it is not one`);
  assert.ok(
    caught instanceof VoucherError,
    `${what} raised ${caught instanceof Error ? caught.name : typeof caught}, ` +
      'which no screen can show. A reader must refuse by name.',
  );
  assert.ok(
    VOUCHER_ERROR_NAMES.some((name) => name === caught.name),
    `${what} raised ${caught.name}, and the library does not publish that name`,
  );
  assert.ok(took < REFUSAL_LIMIT_MS, `${what} took ${took} ms, and a refusal must be prompt`);
  return caught.name;
}

/** A repeatable random source, so that a failing mutation comes back. */
function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

test('the reader refuses a payload shorter than the prefix', () => {
  for (let length = 0; length <= PAYLOAD_PREFIX_BYTES; length += 1) {
    refuses(REAL.subarray(0, length), `a payload of ${length} bytes`);
  }
});

test('the reader refuses a payload cut short after the prefix', () => {
  // A stranger who copies most of a real code, or a camera that reads a
  // symbol partly, produces exactly this.
  for (let length = PAYLOAD_PREFIX_BYTES + 1; length < REAL.length; length += 17) {
    refuses(REAL.subarray(0, length), `a payload cut to ${length} bytes`);
  }
});

test('the reader refuses every version byte but the right one', () => {
  const real = REAL[0];
  for (let version = 0; version < 256; version += 1) {
    if (version === real) continue;
    const bytes = Uint8Array.from(REAL);
    bytes[0] = version;
    refuses(bytes, `version byte ${version}`);
  }
});

test('the reader refuses a network tag from another network', () => {
  for (let at = 1; at < PAYLOAD_PREFIX_BYTES; at += 1) {
    const bytes = Uint8Array.from(REAL);
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    refuses(bytes, `a network tag with byte ${at} flipped`);
  }
});

test('the reader refuses correct framing around something else', () => {
  // The prefix says voucher and the body says otherwise. This is the shape a
  // stranger reaches for first: take a real code, keep the five bytes that a
  // reader checks, and put anything at all behind them.
  const noise = new Uint8Array(200);
  for (let at = 0; at < noise.length; at += 1) noise[at] = (at * 37 + 11) & 0xff;
  const bodies: readonly [string, Uint8Array][] = [
    ['an ScVal', xdr.ScVal.scvVoid().toXDR()],
    ['an address', new Address(voucher.payer).toScVal().toXDR()],
    ['bytes that are not XDR at all', noise],
    ['one byte', Uint8Array.from([0])],
  ];
  for (const [what, body] of bodies) {
    const bytes = new Uint8Array(PAYLOAD_PREFIX_BYTES + body.length);
    bytes.set(REAL.subarray(0, PAYLOAD_PREFIX_BYTES), 0);
    bytes.set(body, PAYLOAD_PREFIX_BYTES);
    refuses(bytes, `correct framing around ${what}`);
  }
});

test('the reader refuses an entry with legacy credentials', () => {
  // CAP-71 `ADDRESS_V2` binds the signer's address into the signed preimage.
  // The legacy arm does not, so an entry that carries it is replayable across
  // addresses. A reader that accepted one would undo the reason for the pin.
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: credentialsFor(voucher.payer, nonce, voucher.expireAt, 'address'),
    rootInvocation: redeemInvocation(config, voucher),
  });
  const name = refuses(encodeVoucher(config, entry), 'an entry with legacy credentials');
  assert.equal(name, 'CredentialTypeError', 'the reason must name the credential type');
});

test('the reader refuses an entry that authorizes another function', () => {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: credentialsFor(voucher.payer, nonce, voucher.expireAt, 'addressV2'),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: contractFn(config.contractId, 'drain', []),
      subInvocations: [],
    }),
  });
  refuses(encodeVoucher(config, entry), 'an entry that authorizes `drain`');
});

test('the reader refuses an entry that authorizes no contract call', () => {
  // The other arm of the authorized function union. A stranger who builds an
  // entry by hand reaches this when they name a contract creation.
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: credentialsFor(voucher.payer, nonce, voucher.expireAt, 'addressV2'),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
        new xdr.CreateContractArgs({
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new xdr.ContractIdPreimageFromAddress({
              address: new Address(voucher.payer).toScAddress(),
              salt: Buffer.alloc(32),
            }),
          ),
          executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
        }),
      ),
      subInvocations: [],
    }),
  });
  refuses(encodeVoucher(config, entry), 'an entry that creates a contract');
});

test('the reader refuses or reads whole a voucher with mutated bytes', { timeout: 60_000 }, () => {
  // The sweep that no hand written case covers. Each mutation is a byte string
  // that a stranger could put in front of a camera. The seed means that a
  // failure here comes back on the next run.
  //
  // A mutation can leave the bytes valid. This path never checks the payer's
  // signature, so a byte flipped inside one still reads. A read is therefore
  // allowed here. Anything other than a read or a typed refusal is not.
  const random = randomSource(20260905);
  let refused = 0;
  let read = 0;
  for (let attempt = 0; attempt < MUTATIONS; attempt += 1) {
    const bytes = Uint8Array.from(REAL);
    const flips = 1 + Math.floor(random() * 4);
    for (let flip = 0; flip < flips; flip += 1) {
      const at = Math.floor(random() * bytes.length);
      bytes[at] = Math.floor(random() * 256);
    }
    const what = `mutation ${attempt}`;
    const started = Date.now();
    let outcome: 'read' | 'threw' = 'threw';
    let caught: unknown = null;
    try {
      decodeVoucher(config, bytes);
      outcome = 'read';
    } catch (error) {
      caught = error;
    }
    const took = Date.now() - started;
    assert.ok(took < REFUSAL_LIMIT_MS, `${what} took ${took} ms`);
    if (outcome === 'read') {
      read += 1;
      continue;
    }
    assert.ok(
      caught instanceof VoucherError,
      `${what} raised ${caught instanceof Error ? caught.name : typeof caught}, ` +
        'which no screen can show',
    );
    assert.ok(
      VOUCHER_ERROR_NAMES.some((name) => name === caught.name),
      `${what} raised ${caught.name}, and the library does not publish that name`,
    );
    refused += 1;
  }
  // The sweep is worthless if every mutation lands in the signature and reads
  // cleanly. This holds it to refusing most of what it makes.
  assert.ok(
    refused > MUTATIONS / 2,
    `only ${refused} of ${MUTATIONS} mutations were refused, and ${read} read, ` +
      'so this sweep does not reach the guards that it exists to exercise',
  );
});
