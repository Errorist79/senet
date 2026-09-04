import { ServiceError, fetchBalance, fundAddress } from './api.js';
import { detail, element, fill, make, short, xlm } from './dom.js';
import { createAccount, restoreAccount } from './passkey.js';
import { clearAccount, getAccount, getChain } from './store.js';
import type { StoredAccount } from './store.js';

/**
 * The account screen.
 *
 * A person creates a passkey account, funds it, and sees what it holds. No
 * seed phrase exists: the passkey stays inside the device's authenticator, and
 * the account is a contract that accepts it as a signer.
 */

/** Read a message out of a caught value of unknown type. */
function reason(caught: unknown): string {
  if (caught instanceof ServiceError) return caught.message;
  if (caught instanceof Error) return caught.message;
  return 'the application could not finish that step';
}

/** Show one failure, in the same shape that every screen uses. */
function showProblem(panel: HTMLElement, message: string): void {
  const box = make('div', 'result result-bad');
  box.append(make('h2', 'result-title', 'That did not work'), make('p', 'result-advice', message));
  fill(panel, box);
}

/** Wire the account screen to the document. */
export function startAccountScreen(): void {
  const panel = element('account-panel', HTMLDivElement);
  const create = element('account-create', HTMLButtonElement);
  const name = element('account-name', HTMLInputElement);
  const form = element('account-form', HTMLFormElement);

  /** Draw the account, and read what it holds when the network answers. */
  async function show(account: StoredAccount): Promise<void> {
    form.hidden = true;
    const box = make('div', 'result result-good');
    box.append(
      make('h2', 'result-title', 'Your account'),
      make('p', 'result-advice', 'The passkey stays in this device. There is no seed phrase.'),
      detail('Address', short(account.contractId), account.contractId),
    );
    if (account.deployHash !== null) {
      box.append(detail('Created by', short(account.deployHash), account.deployHash));
    }
    const balance = make('div', 'detail');
    balance.append(make('span', 'detail-label', 'Balance'), make('span', 'detail-value', 'reading'));
    box.append(balance);

    const fund = make('button', 'submit submit-quiet', 'Add test funds');
    if (fund instanceof HTMLButtonElement) {
      fund.type = 'button';
      fund.addEventListener('click', () => {
        void addFunds(account, fund, balance);
      });
      box.append(fund);
    }

    const forget = make('button', 'link-button', 'Forget this device');
    if (forget instanceof HTMLButtonElement) {
      forget.type = 'button';
      forget.addEventListener('click', () => {
        clearAccount();
        form.hidden = false;
        fill(panel);
      });
      box.append(forget);
    }

    fill(panel, box);
    await refreshBalance(account, balance);
  }

  /** Write one balance into the row that shows it. */
  function writeBalance(row: HTMLElement, stroops: string | null): void {
    const value = row.querySelector('.detail-value');
    if (value === null) return;
    value.textContent = stroops === null ? 'nothing yet' : xlm(stroops);
  }

  /** Read the balance and write it into the row that shows it. */
  async function refreshBalance(account: StoredAccount, row: HTMLElement): Promise<void> {
    try {
      writeBalance(row, (await fetchBalance(account.contractId)).balanceStroops);
    } catch {
      const value = row.querySelector('.detail-value');
      if (value !== null) value.textContent = 'unknown, the service did not answer';
    }
  }

  /**
   * Ask the network for test funds.
   *
   * The row says what happens while the funds reach a ledger. The old number
   * stays true for a few seconds and then stops being true. The service waits
   * for the funds and reports what the address holds, so the screen writes that
   * answer instead of a second read.
   */
  async function addFunds(
    account: StoredAccount,
    button: HTMLButtonElement,
    row: HTMLElement,
  ): Promise<void> {
    button.disabled = true;
    const value = row.querySelector('.detail-value');
    if (value !== null) value.textContent = 'adding funds';
    try {
      writeBalance(row, await fundAddress(account.contractId));
    } catch (caught) {
      showProblem(panel, reason(caught));
    } finally {
      button.disabled = false;
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void register();
  });

  /** Register a passkey and deploy the account behind it. */
  async function register(): Promise<void> {
    const chain = getChain();
    if (chain === null) {
      showProblem(panel, 'The service did not answer, so this device cannot create an account yet.');
      return;
    }
    create.disabled = true;
    fill(panel, make('p', 'waiting', 'Your device is asking you to confirm the passkey.'));
    try {
      await show(await createAccount(chain, name.value.trim() || 'Senet account'));
    } catch (caught) {
      showProblem(panel, reason(caught));
    } finally {
      create.disabled = false;
    }
  }

  const chain = getChain();
  const account = chain === null ? getAccount() : restoreAccount(chain);
  if (account !== null) void show(account);
}
