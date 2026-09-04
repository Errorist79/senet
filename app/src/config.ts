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
  recipient: 'senet.recipient',
  ledger: 'senet.ledger',
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
