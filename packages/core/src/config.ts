import { Asset, Networks, hash } from '@stellar/stellar-sdk';
import { NETWORK_ID_BYTES } from './constants.js';

/**
 * The chain identities a voucher binds to.
 *
 * These are values, and not constants inside functions. A later network, a
 * redeployed contract or a non-native token therefore needs no change to this
 * library. Every field must carry a value. A configuration with a missing
 * field lets a caller build a voucher against one contract, and read it
 * against another.
 */
export interface VoucherConfig {
  /** The network passphrase, which the signed preimage also carries. */
  readonly network: string;
  /** The voucher contract that holds the `redeem` function. */
  readonly contractId: string;
  /** The token contract that moves the funds. */
  readonly tokenId: string;
}

/**
 * The network id, which is the SHA-256 hash of the network passphrase.
 *
 * The protocol puts this same value in a transaction signature preimage. The
 * pinned SDK computes the hash, so the call is synchronous. It needs no Web
 * Crypto and no Node module.
 */
export function networkId(network: string): Uint8Array {
  return new Uint8Array(hash(Buffer.from(network, 'utf8')));
}

/**
 * The network identifier that a voucher payload carries, as lower-case hex.
 *
 * It is the first `NETWORK_ID_BYTES` of the network id. A reader compares
 * this value, and it refuses a wrong-network voucher at scan time.
 */
export function networkTag(network: string): string {
  return Buffer.from(networkId(network).subarray(0, NETWORK_ID_BYTES)).toString('hex');
}

/**
 * The native asset's Stellar Asset Contract on one network.
 *
 * The serialized asset and the network passphrase determine the address. It is
 * therefore correct on every network, and nobody writes it down.
 */
export function nativeTokenId(network: string): string {
  return Asset.native().contractId(network);
}

/**
 * The voucher contract deployed on testnet.
 *
 * A redeploy replaces this value, and it is the one place that holds it. The
 * deployed contract accepts at most 8640 ledgers of lifetime, which is the
 * value that `CONTRACT_MAX_TTL_LEDGERS` carries.
 */
export const TESTNET_CONTRACT_ID =
  'CADGZVNCAFRHJ44P33RODTVXGXCX5EMVCYFHYFMGWNFYVILC556XGWBY';

/** The configuration that the application, the service and the tests use. */
export const TESTNET_CONFIG: VoucherConfig = Object.freeze({
  network: Networks.TESTNET,
  contractId: TESTNET_CONTRACT_ID,
  tokenId: nativeTokenId(Networks.TESTNET),
});
