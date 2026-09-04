import { fetchConfig, fetchLedger } from './api.js';
import { startAccountScreen } from './account.js';
import { LEDGER_REFRESH_MS } from './config.js';
import { element, short } from './dom.js';
import { startMerchantScreen } from './merchant.js';
import { getChain, setChain, setLedger } from './store.js';

/**
 * The application shell.
 *
 * It installs the service worker and reads the chain identities from the
 * service. It keeps the last ledger that the device saw, and it shows one
 * screen at a time. It holds no protocol logic of its own.
 */

/** The screens that this build carries. The payer screen arrives next. */
const SCREENS = ['account', 'merchant'] as const;

type ScreenName = (typeof SCREENS)[number];

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
  const banner = element('chain', HTMLParagraphElement);
  try {
    const chain = await fetchConfig();
    setChain({
      network: chain.network,
      contractId: chain.contractId,
      tokenId: chain.tokenId,
      rpcUrl: chain.rpcUrl,
      walletWasmHash: chain.walletWasmHash,
    });
    banner.textContent = `${chain.network} · contract ${short(chain.contractId)}`;
    banner.dataset['state'] = 'ready';
  } catch {
    const cached = getChain();
    banner.textContent =
      cached === null
        ? 'The service did not answer, and this device has no settings yet.'
        : `offline · contract ${short(cached.contractId)}`;
    banner.dataset['state'] = 'offline';
  }
}

/** Read the ledger now, and again while the device has a network. */
async function readLedger(): Promise<void> {
  const view = element('ledger', HTMLParagraphElement);
  try {
    const ledger = await fetchLedger();
    setLedger({ sequence: ledger.sequence, seenAtMs: Date.now() });
    view.textContent = `ledger ${ledger.sequence}`;
  } catch {
    view.textContent = 'ledger unknown';
  }
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
  startMerchantScreen();

  await readLedger();
  window.setInterval(() => void readLedger(), LEDGER_REFRESH_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void start(), { once: true });
} else {
  void start();
}
