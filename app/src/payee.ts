import { requestPayment } from './api.js';
import { CODE_SIZE } from './config.js';
import { detail, element, fill, make, short } from './dom.js';
import { drawToCanvas, encodeBytes } from './qr.js';
import { getAccount } from './store.js';
import { judgeRequest, judgementText, readRequest } from './verify.js';

/**
 * The payee-presented screen.
 *
 * A payee asks for a payment. The service signs the request so that a wallet can
 * tell which domain it came from, and this screen shows it as a code.
 *
 * The same screen reads one. A person who scans a request needs two different
 * things: what the payment is, and whether anybody vouched for it. The screen
 * shows the second first, because a person who reads the amount and pays has
 * already acted.
 */

/** Draw one failure, in the shape that every screen uses. */
function showProblem(panel: HTMLElement, message: string): void {
  const box = make('div', 'result result-bad');
  box.append(make('h2', 'result-title', 'That did not work'), make('p', 'result-advice', message));
  fill(panel, box);
}

/** Read a message out of a caught value of unknown type. */
function reason(caught: unknown): string {
  return caught instanceof Error ? caught.message : 'the application could not finish that step';
}

/** Wire the payee screen to the document. */
export function startPayeeScreen(): () => void {
  const form = element('payee-form', HTMLFormElement);
  const amount = element('payee-amount', HTMLInputElement);
  const message = element('payee-message', HTMLInputElement);
  const destination = element('payee-destination', HTMLElement);
  const panel = element('payee-panel', HTMLDivElement);
  const readForm = element('payee-read-form', HTMLFormElement);
  const uriField = element('payee-uri', HTMLTextAreaElement);
  const readPanel = element('payee-read-panel', HTMLDivElement);

  /**
   * Say where a payment would go.
   *
   * The destination is this device's account, and a person types nothing. A
   * screen that asked for an address it already holds is the fault that the
   * merchant screen had.
   */
  function showDestination(): void {
    const account = getAccount();
    if (account === null) {
      destination.textContent = 'This device holds no account, so it can ask for no payment.';
      destination.dataset['full'] = '';
      return;
    }
    destination.textContent = short(account.contractId);
    destination.dataset['full'] = account.contractId;
  }

  /** Ask the service to sign a request, and draw it as a code. */
  async function ask(): Promise<void> {
    const account = getAccount();
    if (account === null) {
      showProblem(panel, 'This device holds no account, so nobody can pay it.');
      return;
    }
    fill(panel, make('p', 'waiting', 'Asking the service to sign this request.'));
    try {
      const signed = await requestPayment(account.contractId, amount.value.trim(), message.value);
      const box = make('div', 'result result-good');
      box.append(
        make('h2', 'result-title', `${amount.value.trim()} XLM`),
        make('p', 'result-advice', `Signed by ${signed.originDomain}. Show this to the payer.`),
      );
      const canvas = document.createElement('canvas');
      canvas.className = 'code';
      box.append(canvas);
      box.append(detail('Request', short(signed.uri), signed.uri));
      fill(panel, box);
      drawToCanvas(canvas, encodeBytes(new TextEncoder().encode(signed.uri)), CODE_SIZE);
    } catch (caught) {
      showProblem(panel, reason(caught));
    }
  }

  /**
   * Judge a request, then show what it asks for.
   *
   * The judgement comes first on the screen. A person who reads an amount and
   * acts on it pays before they judge anything. The details sit under it.
   */
  async function judge(): Promise<void> {
    const uri = uriField.value.trim();
    if (uri === '') {
      showProblem(readPanel, 'Paste a payment request, or scan one.');
      return;
    }
    fill(readPanel, make('p', 'waiting', 'Asking the domain that this request names.'));
    try {
      const judged = await judgeRequest(uri);
      const words = judgementText(judged);
      const box = make('div', `result result-${words.tone}`);
      box.append(
        make('h2', 'result-title', words.title),
        make('p', 'result-advice', words.advice),
      );
      const request = readRequest(uri);
      box.append(detail('Operation', request.operation));
      for (const name of ['destination', 'amount', 'memo', 'msg']) {
        const value = request.fields[name];
        if (value !== undefined && value !== '') {
          box.append(detail(name, value.length > 16 ? short(value) : value, value));
        }
      }
      fill(readPanel, box);
    } catch (caught) {
      showProblem(readPanel, reason(caught));
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void ask();
  });
  readForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void judge();
  });

  showDestination();
  return showDestination;
}
