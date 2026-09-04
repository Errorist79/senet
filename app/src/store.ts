import { STORAGE } from './config.js';

/**
 * What the browser remembers between visits.
 *
 * Every read checks what it found, because local storage holds text that an
 * earlier version of this application wrote. A value that no longer fits reads
 * as absent, and the application asks for it again.
 *
 * Every write catches a failure, because a browser may refuse local storage.
 * Correctness never depends on these values. The account is the one whose loss
 * costs a person their voucher list, and the chain still holds their funds.
 */

/** The smart account that this device holds a passkey for. */
export interface StoredAccount {
  /** The passkey credential, as the authenticator names it. */
  readonly keyId: string;
  /** The smart account's contract address. */
  readonly contractId: string;
  /** The transaction that deployed it. */
  readonly deployHash: string | null;
  /**
   * The origin that created this account.
   *
   * A passkey binds to the domain that created it, so an account created under
   * one name cannot sign under another. The account survives a change of name
   * and the passkey does not, and nothing on chain says so. This value is what
   * lets the screen say it.
   *
   * An account stored by an earlier version carries no origin, and the screen
   * says nothing rather than guessing.
   */
  readonly origin: string | null;
}

/** The last ledger that this device saw, and when it saw it. */
export interface StoredLedger {
  readonly sequence: number;
  readonly seenAtMs: number;
}

/** The chain identities, as the service last reported them. */
export interface StoredChain {
  readonly network: string;
  readonly contractId: string;
  readonly tokenId: string;
  readonly rpcUrl: string;
  readonly walletWasmHash: string;
}

/** Read one stored value, or nothing when it is absent or no longer fits. */
function read(key: string): Record<string, unknown> | null {
  let text: string | null = null;
  try {
    text = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { ...parsed };
  } catch {
    return null;
  }
}

/** Write one value, and carry on when the browser refuses. */
function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A browser that refuses storage still runs every screen.
  }
}

function text(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function count(fields: Record<string, unknown>, key: string): number | null {
  const value = fields[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The account on this device. */
export function getAccount(): StoredAccount | null {
  const fields = read(STORAGE.account);
  if (fields === null) return null;
  const keyId = text(fields, 'keyId');
  const contractId = text(fields, 'contractId');
  if (keyId === null || contractId === null) return null;
  return {
    keyId,
    contractId,
    deployHash: text(fields, 'deployHash'),
    origin: text(fields, 'origin'),
  };
}

export function setAccount(account: StoredAccount): void {
  write(STORAGE.account, account);
}

/** Forget the account on this device. The chain still holds the funds. */
export function clearAccount(): void {
  try {
    window.localStorage.removeItem(STORAGE.account);
  } catch {
    // Nothing to do. The screen reports what it can still read.
  }
}

/** The last ledger that this device saw. */
export function getLedger(): StoredLedger | null {
  const fields = read(STORAGE.ledger);
  if (fields === null) return null;
  const sequence = count(fields, 'sequence');
  const seenAtMs = count(fields, 'seenAtMs');
  if (sequence === null || seenAtMs === null) return null;
  return { sequence, seenAtMs };
}

export function setLedger(ledger: StoredLedger): void {
  write(STORAGE.ledger, ledger);
}

/**
 * The chain identities that the service reported.
 *
 * The application keeps them because a payer mints with no network. The signer
 * needs the account code at that moment.
 */
export function getChain(): StoredChain | null {
  const fields = read(STORAGE.chain);
  if (fields === null) return null;
  const network = text(fields, 'network');
  const contractId = text(fields, 'contractId');
  const tokenId = text(fields, 'tokenId');
  const rpcUrl = text(fields, 'rpcUrl');
  const walletWasmHash = text(fields, 'walletWasmHash');
  if (
    network === null ||
    contractId === null ||
    tokenId === null ||
    rpcUrl === null ||
    walletWasmHash === null
  ) {
    return null;
  }
  return { network, contractId, tokenId, rpcUrl, walletWasmHash };
}

export function setChain(chain: StoredChain): void {
  write(STORAGE.chain, chain);
}

/** The account that a merchant sends funds to. */
export function getMerchantAddress(): string {
  try {
    return window.localStorage.getItem(STORAGE.merchant) ?? '';
  } catch {
    return '';
  }
}

export function setMerchantAddress(address: string): void {
  try {
    window.localStorage.setItem(STORAGE.merchant, address);
  } catch {
    // A merchant retypes the address on the next visit, and nothing else breaks.
  }
}
