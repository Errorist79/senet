import { BUILD_ID_LENGTH } from './config.js';
import { element, short } from './dom.js';
import { getAccount, getLedger } from './store.js';

/**
 * The four facts along the bottom of every screen.
 *
 * They stay apart on purpose. A device with an account and no network can
 * still mint. A device with a network and no account can do nothing. One
 * combined light would hide which of the two a person holds.
 *
 * The banner is its own module so that any screen can correct a fact the
 * moment it changes one. A fact drawn once at start goes stale, and a banner
 * that says `no account yet` beside an account is worse than no banner.
 */

/** How old a ledger reading may be before the banner calls it stale. */
const STALE_LEDGER_MS = 60_000;

/** How a fact reads: settled, going out of date, or absent. */
type FactState = 'ready' | 'stale' | 'lost' | 'unknown';

/** Write one fact. */
function setFact(id: string, text: string, state: FactState): void {
  const view = element(id, HTMLParagraphElement);
  view.textContent = text;
  view.dataset['state'] = state;
}

/** Say whether this device holds an account. */
export function showDeviceFact(): void {
  const account = getAccount();
  if (account === null) {
    setFact('fact-device', 'no account yet', 'unknown');
    return;
  }
  setFact('fact-device', `account ${short(account.contractId)}`, 'ready');
}

/** Say whether the service answered, and what it named. */
export function showServiceFact(contractId: string | null, everAnswered: boolean): void {
  if (contractId !== null) {
    setFact('fact-service', `service on ${short(contractId)}`, 'ready');
    return;
  }
  setFact(
    'fact-service',
    everAnswered ? 'the service did not answer' : 'the service has never answered',
    everAnswered ? 'stale' : 'lost',
  );
}

/** Say which ledger this device knows, and how old that reading is. */
export function showLedgerFact(): void {
  const seen = getLedger();
  if (seen === null) {
    setFact('fact-ledger', 'no ledger seen', 'lost');
    return;
  }
  const age = Date.now() - seen.seenAtMs;
  const seconds = Math.round(age / 1000);
  setFact(
    'fact-ledger',
    `ledger ${seen.sequence}, ${seconds} ${seconds === 1 ? 'second' : 'seconds'} old`,
    age > STALE_LEDGER_MS ? 'stale' : 'ready',
  );
}

/**
 * Say which build this is.
 *
 * A person who presses a button that changes the application needs to see the
 * change with their own eyes. This is the string that changes. It carries the
 * same form as the identity that the origin publishes, so a person compares the
 * two without a translation.
 */
export function showBuildFact(commit: string | null): void {
  if (commit === null) {
    setFact('fact-build', 'build unknown', 'unknown');
    return;
  }
  setFact('fact-build', `build ${commit.slice(0, BUILD_ID_LENGTH)}`, 'ready');
}
