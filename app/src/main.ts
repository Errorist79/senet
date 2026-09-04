import { fetchConfig, fetchLedger, fetchRelease } from './api.js';
import { startAccountScreen } from './account.js';
import { startCameraReport } from './camera-report.js';
import { showBuildFact, showDeviceFact, showLedgerFact, showServiceFact } from './banner.js';
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
 * Register the worker, and let a newer one arrive at the next start.
 *
 * The worker takes over as soon as it installs, and it never claims a page
 * that is already open. A person keeps the version that they opened, for as
 * long as they keep it open. They get the newer one at the next start.
 *
 * This is the whole update path, and it holds the rule that matters by
 * construction: a payment application must not replace itself while a payment
 * is in progress. Nothing about a running session changes, so no moment exists
 * at which a change could be unsafe.
 *
 * An earlier version offered the person a restart instead. It asked a question
 * that nobody needs to answer, and the machinery of the question carried four
 * faults in one evening. The footer names the build. That answers the only
 * question that a person has, and a person never has to ask it.
 */
function installWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((registration) => {
      // A browser looks for a new worker when the page navigates. An
      // application on a home screen resumes without a navigation, so it can
      // run for days and never look. This asks whenever it comes to the front.
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

  // The build identity comes first. It comes before every call that needs
  // the service. It is a fact about the files that this device runs, so it does
  // not wait on a network. A device with no network needs about a second to
  // fail the service call. The footer said `build unknown` for that second,
  // which is the one moment a person is most likely to read it.
  showBuildFact(await fetchRelease());
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
