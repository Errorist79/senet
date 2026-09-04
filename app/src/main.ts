import { fetchConfig, fetchLedger } from './api.js';
import { LEDGER_REFRESH_MS, STORAGE } from './config.js';
import { element, short } from './dom.js';
import { startMerchantScreen } from './merchant.js';

/**
 * The application shell.
 *
 * It installs the service worker, reads the chain identities from the service,
 * keeps the last ledger that the device saw, and starts the screen. It holds
 * no protocol logic of its own.
 */

/** Register the worker that makes the application run without a network. */
function installWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
    // The application runs without the worker. Only the offline start needs it.
  });
}

/** Keep the last ledger, because a device that mints offline counts from it. */
function rememberLedger(sequence: number, readAtIso: string): void {
  try {
    window.localStorage.setItem(STORAGE.ledger, JSON.stringify({ sequence, readAtIso }));
  } catch {
    // This value helps only while the device has a network.
  }
}

/** Read the chain identities once, and show which network this build talks to. */
async function showChain(): Promise<void> {
  const banner = element('chain', HTMLParagraphElement);
  try {
    const chain = await fetchConfig();
    banner.textContent = `${chain.network} · contract ${short(chain.contractId)}`;
    banner.dataset['state'] = 'ready';
  } catch {
    banner.textContent = 'The service did not answer. The screen still opens.';
    banner.dataset['state'] = 'offline';
  }
}

/** Read the ledger now, and again while the device has a network. */
async function followLedger(): Promise<void> {
  const view = element('ledger', HTMLParagraphElement);
  const read = async (): Promise<void> => {
    try {
      const ledger = await fetchLedger();
      rememberLedger(ledger.sequence, ledger.readAtIso);
      view.textContent = `ledger ${ledger.sequence}`;
    } catch {
      view.textContent = 'ledger unknown';
    }
  };
  await read();
  window.setInterval(() => void read(), LEDGER_REFRESH_MS);
}

function start(): void {
  installWorker();
  startMerchantScreen();
  void showChain();
  void followLedger();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
