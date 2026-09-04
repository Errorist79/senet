/**
 * Every number the voucher rules depend on, with the reason for its value.
 *
 * This file defines every value that more than one module uses. A second copy
 * of a value is how the two deadlines came apart in earlier work.
 */

/**
 * The protocol's target ledger close time, in milliseconds.
 *
 * `ledgerTargetCloseTimeMilliseconds` is an on-chain configuration setting.
 * Consensus cannot close a ledger faster than this floor, so a real close
 * time is always 5 seconds or more.
 */
export const LEDGER_TARGET_CLOSE_MS = 5000;

/**
 * The measured mean ledger close time on testnet, in seconds.
 *
 * The measurement covers 4.44 million ledgers over 257 days. The excess above
 * the 5 second floor is a uniform overhead of about 7 milliseconds per ledger,
 * not an occasional stall. A divisor of 5.007 holds the estimate error to 7
 * ledgers, which is 35 seconds, at every lifetime that this library offers.
 */
export const LEDGER_MEAN_CLOSE_SECONDS = 5.007;

/**
 * Ledgers added to an offline estimate as a safety margin.
 *
 * The margin is zero on purpose. A ledger can never close below the 5 second
 * floor, so an estimate can only run ahead of the real ledger. A positive
 * margin makes that overshoot worse, and overshoot is the failure that the
 * contract ceiling exists to catch.
 */
export const LEDGER_ESTIMATE_MARGIN_LEDGERS = 0;

/** The voucher lifetimes that an application offers, in ledgers. */
export const LIFETIMES = {
  '5m': 60,
  '15m': 180,
  '1h': 720,
  '12h': 8640,
} as const;

/** A lifetime name that an application can offer. */
export type LifetimeName = keyof typeof LIFETIMES;

/** The lifetime that an application selects when the payer chooses none. */
export const DEFAULT_LIFETIME_LEDGERS = LIFETIMES['15m'];

/**
 * The longest lifetime the deployed contract accepts, in ledgers.
 *
 * The contract stores its own `max_ttl_ledgers` and refuses a longer voucher
 * with error 8. This constant must equal the deployed value, so that the
 * library refuses the voucher before the payer signs it.
 */
export const CONTRACT_MAX_TTL_LEDGERS = LIFETIMES['12h'];

/**
 * The largest voucher that the deployed contract accepts, in stroops.
 *
 * The contract stores its own `max_amount` and refuses a larger voucher. The
 * refusal arrives after the payer signed and after the merchant scanned, so
 * the library refuses first. This constant must equal the deployed value, and
 * the service compares the two when it starts.
 */
export const CONTRACT_MAX_AMOUNT_STROOPS = 1_000_000_000n;

/**
 * The ledgers of life that a merchant demands before it takes a voucher.
 *
 * The merchant path costs one simulation and one submission. A voucher can
 * expire between the scan and the apply. That failure looks the same to the
 * merchant as a bad voucher, so the scanner refuses the voucher early instead.
 */
export const MIN_REMAINING_LEDGERS = 6;

/**
 * The `max_time_bound` of a submitted transaction, in seconds.
 *
 * This bounds the transaction, not the voucher. It only has to outlast one
 * simulation and the network's own retry window.
 */
export const TX_TIMEOUT_SECONDS = 120;

/**
 * The credential union discriminant of CAP-71 `ADDRESS_V2` credentials.
 *
 * Discriminant 0 is the source account, 1 is the legacy `ADDRESS` arm, and 2
 * is `ADDRESS_V2`.
 */
export const CREDENTIAL_TYPE_ADDRESS_V2 = 2;

/**
 * The envelope type of the preimage that CAP-71 credentials commit to.
 *
 * Type 9 is `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION`. Its payload omits the
 * address that authorizes the call, so one signature serves every address.
 * Type 10 is `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION_WITH_ADDRESS`. It binds the
 * address into the signed bytes.
 */
export const AUTH_ENVELOPE_TYPE_WITH_ADDRESS = 10;

/**
 * The major version of `@stellar/stellar-sdk` that this library reads.
 *
 * Major 16 uses js-xdr 4, which exposes a decoded XDR struct attribute as a
 * method. Major 17 uses js-xdr 5, which exposes the same attribute as a plain
 * property. This code is method style throughout.
 */
export const EXPECTED_SDK_MAJOR = 16;

/** The lowest minor version that carries the whole CAP-71 surface. */
export const EXPECTED_SDK_MINOR_MIN = 3;

/**
 * The first byte of a voucher payload.
 *
 * A reader that meets an unknown version stops at the first byte. The reader
 * then names the version that it found. A later payload format therefore
 * ships without a break for every reader in the field.
 */
export const PAYLOAD_VERSION = 1;

/**
 * The width of the network identifier in a voucher payload, in bytes.
 *
 * The identifier is the first bytes of the network id. The network id is the
 * SHA-256 hash of the network passphrase. The set of named Stellar networks is
 * small, so a person can enumerate four-byte identifiers and check that no two
 * collide. The identifier is a check at scan time, not a security boundary.
 * The signed preimage already carries the whole network passphrase. A voucher
 * that reaches the wrong network therefore fails on chain, even after a
 * collision.
 */
export const NETWORK_ID_BYTES = 4;

/**
 * The whole payload prefix width, in bytes: one version byte and the network
 * identifier.
 *
 * A signed entry measures 792 bytes. At error correction level M a QR symbol
 * of version 23 holds 857 bytes, so this prefix keeps the voucher QR at
 * version 23.
 */
export const PAYLOAD_PREFIX_BYTES = 1 + NETWORK_ID_BYTES;
