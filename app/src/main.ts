import { fetchConfig, fetchLedger } from './api.js';
import { startAccountScreen } from './account.js';
import { startCameraReport } from './camera-report.js';
import { showDeviceFact, showLedgerFact, showServiceFact } from './banner.js';
import { LEDGER_REFRESH_MS, SKIP_WAITING } from './config.js';
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
const SCREENS = ['account', 'payer', 'merchant', 'camera'] as const;

/**
 * The screens that the navigation leads to.
 *
 * The camera report is a measurement, and it is not part of the work that a
 * payer or a merchant does. The merchant screen offers it where a person needs
 * it, which is next to a camera that reads nothing.
 */
const NAV_SCREENS = ['account', 'payer', 'merchant'] as const;

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
  }
  for (const screen of NAV_SCREENS) {
    const button = element(`nav-${screen}`, HTMLButtonElement);
    button.setAttribute('aria-current', screen === name ? 'page' : 'false');
  }
  refreshers.get(name)?.();
  window.location.hash = name;
}

/**
 * Offer the new version, and restart when the person takes it.
 *
 * The worker installs and waits. It does not take over on its own. A person
 * can hold a minted voucher on the screen, or wait for a payment to answer. A
 * swap at that moment ends the payment, and it destroys the only evidence of
 * the payment. The person picks the moment instead.
 */
/**
 * Whether the person asked for the restart.
 *
 * A worker takes control twice for two different reasons. The first time is
 * the first visit, where the worker claims a page that no worker controlled,
 * and the page is already the newest build. The second time is a restart that
 * the person accepted. Only the second one reloads.
 *
 * An earlier version reloaded on both. That reload landed in the middle of the
 * passkey ceremony on a first visit, and it made the account screen do nothing
 * at all.
 */
let acceptedRestart = false;

function offerUpdate(waiting: ServiceWorker): void {
  const bar = element('update-bar', HTMLDivElement);
  const restart = element('update-restart', HTMLButtonElement);
  bar.hidden = false;
  restart.addEventListener(
    'click',
    () => {
      restart.disabled = true;
      restart.textContent = 'Restarting';
      acceptedRestart = true;
      waiting.postMessage(SKIP_WAITING);
    },
    { once: true },
  );
}

/**
 * Register the worker, and watch for a newer one.
 *
 * A browser looks for a new worker when the page navigates. An application on
 * a home screen resumes without a navigation, so it can run for days and never
 * look. This asks whenever the application comes back to the front.
 */
function installWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  // The page reloads only for a restart that the person accepted, and only
  // once. Any other change of controller leaves the screen alone.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!acceptedRestart) return;
    acceptedRestart = false;
    window.location.reload();
  });

  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((registration) => {
      // A worker can already be waiting from an earlier visit. Nothing fires
      // for that one, so the application asks.
      if (registration.waiting !== null) offerUpdate(registration.waiting);

      registration.addEventListener('updatefound', () => {
        const arriving = registration.installing;
        if (arriving === null) return;
        arriving.addEventListener('statechange', () => {
          // A first install controls nothing and replaces nothing, so it needs
          // no permission. Only a worker that displaces another one does.
          if (arriving.state !== 'installed') return;
          if (navigator.serviceWorker.controller === null) return;
          offerUpdate(arriving);
        });
      });

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration.update();
      });
    })
    .catch(() => {
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
  for (const screen of NAV_SCREENS) {
    element(`nav-${screen}`, HTMLButtonElement).addEventListener('click', () => {
      showScreen(screen);
    });
  }
  element('merchant-report', HTMLButtonElement).addEventListener('click', () => {
    showScreen('camera');
  });
  const wanted = window.location.hash.replace('#', '');
  showScreen(isScreen(wanted) ? wanted : 'account');

  // The screens read the chain identities, so they wait for the first answer.
  await loadChain();
  startAccountScreen();
  startPayerScreen();
  refreshers.set('merchant', startMerchantScreen());
  startCameraReport();
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
