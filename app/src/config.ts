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
 * What the application says to a worker that waits.
 *
 * A new worker installs and then waits. A payment application must not replace
 * itself while a payment is in progress. This message carries the person's
 * answer to it.
 */
export const SKIP_WAITING = 'senet.skip-waiting';

/**
 * How long the application waits for a restart to finish, in milliseconds.
 *
 * A worker that takes over changes the controller in well under a second. This
 * wait is long enough that a slow device never reads the fallback by mistake.
 * It is also short enough that a person does not sit in front of a screen that
 * says nothing.
 */
export const RESTART_TIMEOUT_MS = 6_000;

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
