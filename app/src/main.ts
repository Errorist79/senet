import { fetchConfig, fetchLedger } from './api.js';
import { startAccountScreen } from './account.js';
import { showDeviceFact, showLedgerFact, showServiceFact } from './banner.js';
import { LEDGER_REFRESH_MS } from './config.js';
import { element } from './dom.js';
import { startMerchantScreen } from './merchant.js';
import { startPayerScreen } from './payer.js';
import { getChain, setChain, setLedger } from './store.js';

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

/** Whether a value names a screen that this build carries. */
function isScreen(value: string): value is ScreenName {
  return SCREENS.some((name) => name === value);
}

/**
 * What a screen does when it becomes visible again.
 *
 * A screen draws from what the device holds, and another screen can change
 * that. A destination drawn once at start says that this device holds nothing
 * long after it holds an account. A screen that reads the device therefore
 * says how to draw itself again.
 */
const refreshers = new Map<ScreenName, () => void>();

/** Show one screen, and mark the button that leads to it. */
function showScreen(name: ScreenName): void {
  for (const screen of SCREENS) {
    element(`screen-${screen}`, HTMLElement).hidden = screen !== name;
    const button = element(`nav-${screen}`, HTMLButtonElement);
    button.setAttribute('aria-current', screen === name ? 'page' : 'false');
  }
  refreshers.get(name)?.();
  window.location.hash = name;
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
    showServiceFact(chain.contractId, true);
  } catch {
    showServiceFact(null, getChain() !== null);
  }
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
  refreshers.set('merchant', startMerchantScreen());
  showDeviceFact();

  // The first screen appeared before a screen registered its own refresh.
  const opened = window.location.hash.replace('#', '');
  if (isScreen(opened)) refreshers.get(opened)?.();

  await readLedger();
  window.setInterval(() => void readLedger(), LEDGER_REFRESH_MS);
  // The age of the ledger reading changes every second, and nothing else does.
  window.setInterval(showLedgerFact, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void start(), { once: true });
} else {
  void start();
}
