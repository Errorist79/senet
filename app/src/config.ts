/**
 * What the application knows before it asks the service.
 *
 * The chain identities are not here. The service names the contract, the
 * network and the token, and the application reads them once at start. One
 * place holds them, and the application keeps no copy that can disagree.
 */

/** Where the service answers. The same origin serves it, behind any host. */
export const API_BASE = '/api';

/** The name that the application shows, and that a device installs it under. */
export const APP_NAME = 'Senet';

/** Keys in the browser's local storage. One place, so a rename orphans nothing. */
export const STORAGE = {
  account: 'senet.account',
  chain: 'senet.chain',
  ledger: 'senet.ledger',
  merchant: 'senet.merchant',
  vouchers: 'senet.vouchers',
} as const;

/**
 * How often the application reads the ledger while it has a network.
 *
 * A device that mints a voucher offline counts forward from this reading, so a
 * stale reading costs accuracy. Twelve seconds is short next to the shortest
 * lifetime on offer, and long enough to keep the application a quiet client.
 */
export const LEDGER_REFRESH_MS = 12_000;

/** How long the application waits for one service reply, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 130_000;

/**
 * Camera frames that the scanner decodes each second.
 *
 * A decode costs real work on a phone. A camera at a screen also holds still
 * for far longer than a tenth of a second. Ten reads per second finds a code
 * as fast as a person aims, and it leaves the device cool.
 */
export const SCAN_FPS = 10;

/**
 * Where the deployment states which build it serves.
 *
 * The application shows this on the screen, so a person compares the phone
 * against the origin without a translation between two forms. The worker holds
 * the answer in the same cache as the rest of the build. The identity therefore
 * names the build that a person runs, and not the build that the origin now
 * serves.
 */
export const RELEASE_PATH = '/release.json';

/** How much of a commit a person reads, which is the usual short form. */
export const BUILD_ID_LENGTH = 7;

/**
 * How often the merchant screen asks the feed whether the chain confirmed.
 *
 * A ledger closes about every five seconds, and the listener polls the chain
 * every two. A confirmation therefore arrives within a few seconds of a
 * submission. One second keeps the screen close behind that. A shorter
 * interval asks the service a question that it cannot answer any faster.
 */
export const CONFIRM_POLL_MS = 1_000;

/**
 * How long the merchant screen waits for that confirmation.
 *
 * The redeem route already waits for the transaction result, so the payment
 * sits in a ledger before the screen starts waiting at all. What remains is
 * the listener noticing it, which takes up to one poll of two seconds plus
 * the network. Two to five seconds is the ordinary case.
 *
 * Twenty seconds is four to ten times that. An ordinary payment therefore
 * never reaches the end of the wait. Twenty seconds is also short enough that
 * a check reaches the end on purpose. A state that no check can reach is a
 * state that a person meets first.
 *
 * A merchant at a counter also learns nothing from a screen that says
 * `waiting` for two minutes. A longer bound is worse for that person, as well
 * as untestable.
 */
export const CONFIRM_TIMEOUT_MS = 20_000;

/** The width that a code is drawn at, in CSS pixels. One value, two screens. */
export const CODE_SIZE = 320;
