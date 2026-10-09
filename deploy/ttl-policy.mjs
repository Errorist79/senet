// When a user request would pay to extend a shared ledger entry.
//
// Two contracts extend shared entries during a user request:
//
// - The voucher contract extends its instance and its code to 30 days during a
//   redemption, when less than one day remains. Source:
//   `contracts/senet-voucher/src/lib.rs`, `INSTANCE_TTL_THRESHOLD_LEDGERS` and
//   `INSTANCE_TTL_EXTEND_TO_LEDGERS`, applied in `redeem`.
// - The passkey-kit wallet extends its instance and its code to the maximum TTL
//   during an authentication. It does so when the entry sits more than 120,960
//   ledgers below that maximum. Source: passkey-kit
//   `contracts/smart-wallet/src/storage.rs`, `extend_instance`. Every wallet
//   runs the same code entry.
//
// `instance().extend_ttl` extends the instance and the code of a contract.
// Source: soroban-sdk 27.0.6, `src/storage.rs`, `Instance::extend_ttl`.
//
// An extension of code costs more than any fee ceiling allows, so the request
// that meets it fails. The timer that runs `deploy/extend-ttl.mjs` therefore
// extends these entries before a request has to. `deploy/verify.mjs` fails when
// the timer falls behind.

/** Ledgers in one day, at the target close time of five seconds. */
export const LEDGERS_PER_DAY = 17_280;

/** The voucher contract extends itself when fewer ledgers than this remain. */
const VOUCHER_EXTEND_THRESHOLD_LEDGERS = LEDGERS_PER_DAY;

/** The wallet extends itself when it sits this far below the maximum TTL. */
const WALLET_EXTEND_LAG_LEDGERS = 120_960;

/**
 * How early the timer extends an entry, in ledgers before a request would pay.
 *
 * The timer runs every hour, so two days give it 48 attempts.
 */
export const TIMER_LEAD_LEDGERS = 2 * LEDGERS_PER_DAY;

/**
 * How early `deploy/verify.mjs` fails, in ledgers before a request would pay.
 *
 * This is one day later than the timer acts. A failure here therefore means
 * that the timer missed 24 runs, and a person still has one day to act.
 */
export const ALARM_LEAD_LEDGERS = LEDGERS_PER_DAY;

/**
 * The longest TTL that the network allows an entry, counted from the current
 * ledger. An extension to this value is the most that one extension can add.
 *
 * The host sets the last live ledger at the current one plus `maxEntryTtl`
 * less one (soroban-env-host `src/ledger_info.rs`). Soroban-sdk `max_ttl`
 * subtracts the current ledger from that (`src/storage.rs`).
 *
 * @param {number} maxEntryTtl the network setting `maxEntryTtl`
 */
export function maxTtl(maxEntryTtl) {
  return maxEntryTtl - 1;
}

/**
 * The shared entries, each with the remaining TTL below which a user request
 * pays to extend it.
 *
 * @param {{ contractId: string, voucherCodeHash: Buffer, walletWasmHash: string }} names
 * @param {number} maxEntryTtl the network setting `maxEntryTtl`
 */
export function sharedEntries(names, maxEntryTtl) {
  const walletWindow = maxTtl(maxEntryTtl) - WALLET_EXTEND_LAG_LEDGERS;
  return [
    { name: 'the voucher instance', kind: 'instance', id: names.contractId, window: VOUCHER_EXTEND_THRESHOLD_LEDGERS },
    { name: 'the voucher code', kind: 'code', id: names.voucherCodeHash.toString('hex'), window: VOUCHER_EXTEND_THRESHOLD_LEDGERS },
    { name: 'the wallet code', kind: 'code', id: names.walletWasmHash, window: walletWindow },
  ];
}
