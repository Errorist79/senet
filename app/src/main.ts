import { fetchConfig, fetchLedger } from './api.js';
import { startAccountScreen } from './account.js';
import { LEDGER_REFRESH_MS } from './config.js';
import { element, short } from './dom.js';
import { startMerchantScreen } from './merchant.js';
import { startPayerScreen } from './payer.js';
import { getAccount, getChain, setChain, setLedger, getLedger } from './store.js';

/**
 * The application shell.
 *
 * It installs the service worker and reads the chain identities from the
 * service. It keeps the last ledger that the device saw, and it shows one
 * screen at a time. It holds no protocol logic of its own.
 */

/** The screens that this build carries. */
const SCREENS = ['account', 'payer', 'merchant'] as const;

type ScreenName = (typeof SCREENS)[number];

/** How old a ledger reading may be before the banner calls it stale. */
const STALE_LEDGER_MS = 60_000;

/** Whether a value names a screen that this build carries. */
function isScreen(value: string): value is ScreenName {
  return SCREENS.some((name) => name === value);
}

/** Show one screen, and mark the button that leads to it. */
function showScreen(name: ScreenName): void {
  for (const screen of SCREENS) {
    element(`screen-${screen}`, HTMLElement).hidden = screen !== name;
    const button = element(`nav-${screen}`, HTMLButtonElement);
    button.setAttribute('aria-current', screen === name ? 'page' : 'false');
  }
  window.location.hash = name;
}

/** Write one of the three facts that the banner keeps apart. */
function setFact(id: string, text: string, state: 'ready' | 'stale' | 'lost' | 'unknown'): void {
  const view = element(id, HTMLParagraphElement);
  view.textContent = text;
  view.dataset['state'] = state;
}

/**
 * Say whether this device holds an account.
 *
 * The banner keeps three facts apart on purpose. A device with an account and
 * no network can still mint. A device with a network and no account can do
 * nothing. One combined light would hide which of the two a person holds.
 */
function showDeviceFact(): void {
  const account = getAccount();
  if (account === null) {
    setFact('fact-device', 'no account yet', 'unknown');
    return;
  }
  setFact('fact-device', `account ${short(account.contractId)}`, 'ready');
}

/** Register the worker that makes the application open with no network. */
function installWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
    // The application runs without the worker. Only the offline start needs it.
  });
}

/**
 * Read the chain identities, and remember them.
 *
 * A payer mints with no network. The signer needs the account code to do
 * that, so the application keeps the last answer.
 */
async function loadChain(): Promise<void> {
  try {
    const chain = await fetchConfig();
    setChain({
      network: chain.network,
      contractId: chain.contractId,
      tokenId: chain.tokenId,
      rpcUrl: chain.rpcUrl,
      walletWasmHash: chain.walletWasmHash,
    });
    setFact('fact-service', `service on ${short(chain.contractId)}`, 'ready');
  } catch {
    const cached = getChain();
    setFact(
      'fact-service',
      cached === null ? 'the service has never answered' : 'the service did not answer',
      cached === null ? 'lost' : 'stale',
    );
  }
}

/** Say which ledger this device knows about, and how old that reading is. */
function showLedgerFact(): void {
  const seen = getLedger();
  if (seen === null) {
    setFact('fact-ledger', 'no ledger seen', 'lost');
    return;
  }
  const ageSeconds = Math.round((Date.now() - seen.seenAtMs) / 1000);
  setFact(
    'fact-ledger',
    `ledger ${seen.sequence}, ${ageSeconds} seconds old`,
    Date.now() - seen.seenAtMs > STALE_LEDGER_MS ? 'stale' : 'ready',
  );
}

/** Read the ledger now, and again while the device has a network. */
async function readLedger(): Promise<void> {
  try {
    const ledger = await fetchLedger();
    setLedger({ sequence: ledger.sequence, seenAtMs: Date.now() });
    element('ledger', HTMLParagraphElement).textContent = `ledger ${ledger.sequence}`;
  } catch {
    // The cached reading still stands, and the banner says how old it is.
  }
  showLedgerFact();
}

async function start(): Promise<void> {
  installWorker();
  for (const screen of SCREENS) {
    element(`nav-${screen}`, HTMLButtonElement).addEventListener('click', () => {
      showScreen(screen);
    });
  }
  const wanted = window.location.hash.replace('#', '');
  showScreen(isScreen(wanted) ? wanted : 'account');

  // The screens read the chain identities, so they wait for the first answer.
  await loadChain();
  startAccountScreen();
  startPayerScreen();
  startMerchantScreen();
  showDeviceFact();

  await readLedger();
  window.setInterval(() => void readLedger(), LEDGER_REFRESH_MS);
  window.setInterval(showLedgerFact, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void start(), { once: true });
} else {
  void start();
}
