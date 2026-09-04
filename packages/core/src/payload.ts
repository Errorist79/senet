import { xdr } from '@stellar/stellar-sdk';
import { NETWORK_ID_BYTES, PAYLOAD_PREFIX_BYTES, PAYLOAD_VERSION } from './constants.js';
import { networkId, networkTag } from './config.js';
import type { VoucherConfig } from './config.js';
import {
  NetworkMismatchError,
  PayloadVersionError,
  VoucherFormatError,
} from './errors.js';
import { readVoucher } from './voucher.js';
import type { DecodedVoucher } from './voucher.js';

/**
 * The bytes that a voucher code carries.
 *
 * The payload is the version byte, then the network identifier, then the
 * signed entry as XDR. The prefix wraps the entry, and it changes no byte of
 * it. The entry keeps exactly what the payer signed.
 *
 * A voucher is bytes first. The code that a merchant scans is one presentation
 * of these bytes, and the application draws it.
 */
export function encodeVoucher(
  config: VoucherConfig,
  entry: xdr.SorobanAuthorizationEntry,
): Uint8Array {
  const body = entry.toXDR();
  const payload = new Uint8Array(PAYLOAD_PREFIX_BYTES + body.length);
  payload[0] = PAYLOAD_VERSION;
  payload.set(networkId(config.network).subarray(0, NETWORK_ID_BYTES), 1);
  payload.set(body, PAYLOAD_PREFIX_BYTES);
  return payload;
}

/**
 * Read a voucher out of the bytes that a merchant scanned.
 *
 * The reader refuses at the earliest point that it can. A version that it does
 * not know stops it at the first byte. A network that is not the configured
 * one stops it at the fifth. Both refusals happen at scan time, where the
 * merchant can still ask for another voucher, rather than on chain.
 *
 * `readVoucher` then runs the credential and the deadline invariants. A
 * decoded voucher therefore meets every rule that the library holds.
 */
export function decodeVoucher(config: VoucherConfig, payload: Uint8Array): DecodedVoucher {
  if (payload.length <= PAYLOAD_PREFIX_BYTES) {
    throw new VoucherFormatError(
      `the code carries ${payload.length} bytes, and a voucher needs more than ` +
        `the ${PAYLOAD_PREFIX_BYTES} byte prefix`,
    );
  }
  const version = payload[0];
  if (version !== PAYLOAD_VERSION) {
    throw new PayloadVersionError(version ?? 0, PAYLOAD_VERSION);
  }
  const found = Buffer.from(payload.subarray(1, PAYLOAD_PREFIX_BYTES)).toString('hex');
  const expected = networkTag(config.network);
  if (found !== expected) {
    throw new NetworkMismatchError(found, expected, config.network);
  }

  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(
      Buffer.from(payload.subarray(PAYLOAD_PREFIX_BYTES)),
    );
  } catch {
    throw new VoucherFormatError('the code carries no authorization entry after the prefix');
  }
  return readVoucher(config, entry);
}
