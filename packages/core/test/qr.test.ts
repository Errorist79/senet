import assert from 'node:assert/strict';
import test from 'node:test';
import { xdr } from '@stellar/stellar-sdk';
import qrcode from 'qrcode-generator';
import {
  PAYLOAD_PREFIX_BYTES,
  buildVoucherEntry,
  decodeVoucher,
  encodeVoucher,
  redeemInvocation,
} from '../src/index.js';
import { credentialsFor, readReferenceEntry } from './reference.js';
import { decodeSymbol } from './scanner.js';

/**
 * The wire format, proven end to end.
 *
 * A voucher travels as raw bytes in byte mode, and not as text. Base64url
 * would make it about a third longer in characters. Its lower case letters
 * also rule out the alphanumeric mode, so it would cost full byte mode.
 *
 * These tests use the pinned encoder and the pinned decoder. The claim about
 * the symbol version belongs to those two releases and to no others.
 */

/** The error correction level that the payer's code uses. */
const ERROR_CORRECTION = 'M';

/** The size of a signed entry from a passkey account, in bytes. */
const PASSKEY_ENTRY_BYTES = 792;

/** The largest payload that a version 23 symbol holds at this level. */
const VERSION_23_CAPACITY_BYTES = 857;

/** The symbol version that the payer's code uses. */
const VOUCHER_QR_VERSION = 23;

/** Pixels per module when the test rasterizes a symbol. */
const MODULE_PIXELS = 4;

/** Quiet zone around a symbol, in modules. The standard asks for four. */
const QUIET_MODULES = 4;

const reference = readReferenceEntry();
const { config, voucher, nonce } = reference;

/** One symbol, built the way the application builds it. */
function encodeSymbol(bytes: Uint8Array): {
  isDark: (row: number, column: number) => boolean;
  moduleCount: number;
  version: number;
} {
  // `qrcode-generator` reads a string and encodes it as UTF-8. Its documented
  // way to carry other data is a replacement for `stringToBytes`. The bytes
  // travel through a latin1 string that maps one character to one byte.
  qrcode.stringToBytes = (text: string) =>
    Array.from(text, (character) => character.charCodeAt(0) & 0xff);
  let latin1 = '';
  for (const byte of bytes) latin1 += String.fromCharCode(byte);

  // Type 0 selects the smallest version that holds the payload.
  const symbol = qrcode(0, ERROR_CORRECTION);
  symbol.addData(latin1, 'Byte');
  symbol.make();
  const moduleCount = symbol.getModuleCount();
  return {
    isDark: (row, column) => symbol.isDark(row, column),
    moduleCount,
    // A symbol of version v has 4v + 17 modules on a side.
    version: (moduleCount - 17) / 4,
  };
}

/** The version that the pinned encoder selects for a payload of `size` bytes. */
function versionFor(size: number): number {
  return encodeSymbol(new Uint8Array(size)).version;
}

/** Paint a symbol as pixels, the way a screen shows it to a camera. */
function rasterize(symbol: ReturnType<typeof encodeSymbol>): {
  data: Uint8ClampedArray;
  width: number;
} {
  const side = (symbol.moduleCount + QUIET_MODULES * 2) * MODULE_PIXELS;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let row = 0; row < symbol.moduleCount; row += 1) {
    for (let column = 0; column < symbol.moduleCount; column += 1) {
      if (!symbol.isDark(row, column)) continue;
      const top = (row + QUIET_MODULES) * MODULE_PIXELS;
      const left = (column + QUIET_MODULES) * MODULE_PIXELS;
      for (let y = top; y < top + MODULE_PIXELS; y += 1) {
        for (let x = left; x < left + MODULE_PIXELS; x += 1) {
          const at = (y * side + x) * 4;
          data[at] = 0;
          data[at + 1] = 0;
          data[at + 2] = 0;
        }
      }
    }
  }
  return { data, width: side };
}

/** An entry that carries padding in its signature, to reach `target` bytes. */
function entryOfSize(target: number): xdr.SorobanAuthorizationEntry {
  let padding = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const credentials = credentialsFor(voucher.payer, nonce, voucher.expireAt, 'addressV2');
    const address = credentials.addressV2();
    const built = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        new xdr.SorobanAddressCredentials({
          address: address.address(),
          nonce: address.nonce(),
          signatureExpirationLedger: address.signatureExpirationLedger(),
          signature: xdr.ScVal.scvBytes(Buffer.alloc(padding)),
        }),
      ),
      rootInvocation: redeemInvocation(config, voucher),
    });
    const size = built.toXDR().length;
    if (size === target) return built;
    padding += target - size;
    if (padding < 0) break;
  }
  throw new Error(`no entry of exactly ${target} bytes exists with this shape`);
}

test('the pinned encoder puts a passkey voucher at version 23', () => {
  // The claim the product makes about the code that a payer shows.
  const payload = PASSKEY_ENTRY_BYTES + PAYLOAD_PREFIX_BYTES;
  assert.equal(versionFor(PASSKEY_ENTRY_BYTES), VOUCHER_QR_VERSION);
  assert.equal(versionFor(payload), VOUCHER_QR_VERSION);
});

test('version 23 holds 857 bytes and no more', () => {
  assert.equal(versionFor(VERSION_23_CAPACITY_BYTES), VOUCHER_QR_VERSION);
  assert.equal(versionFor(VERSION_23_CAPACITY_BYTES + 1), VOUCHER_QR_VERSION + 1);
});

test('the prefix leaves room to spare at version 23', () => {
  const spare = VERSION_23_CAPACITY_BYTES - PASSKEY_ENTRY_BYTES - PAYLOAD_PREFIX_BYTES;
  assert.ok(spare > 0, `the prefix leaves ${spare} bytes`);
  assert.equal(spare, 60);
});

/** Encode a payload, paint it, scan it, and give back what the scan read. */
function throughTheCamera(payload: Uint8Array): { bytes: Uint8Array; version: number } {
  const symbol = encodeSymbol(payload);
  const image = rasterize(symbol);
  const scanned = decodeSymbol(image.data, image.width, image.width);
  assert.ok(scanned !== null, 'the decoder read no symbol');
  return { bytes: Uint8Array.from(scanned.binaryData), version: symbol.version };
}

test('a real payload survives the whole path, from encode to decode', () => {
  const entry = buildVoucherEntry(config, voucher, nonce);
  const payload = encodeVoucher(config, entry);
  const scanned = throughTheCamera(payload);
  assert.deepEqual(scanned.bytes, payload);
  assert.equal(
    decodeVoucher(config, scanned.bytes).entry.toXDR('base64'),
    entry.toXDR('base64'),
  );
});

test('a payload of the passkey size survives the whole path', () => {
  const entry = entryOfSize(PASSKEY_ENTRY_BYTES);
  assert.equal(entry.toXDR().length, PASSKEY_ENTRY_BYTES);
  const payload = encodeVoucher(config, entry);
  const scanned = throughTheCamera(payload);
  assert.equal(scanned.version, VOUCHER_QR_VERSION);
  assert.deepEqual(scanned.bytes, payload);
  assert.equal(
    decodeVoucher(config, scanned.bytes).entry.toXDR('base64'),
    entry.toXDR('base64'),
  );
});
