import { LIFETIMES, SEP7_SCHEME, decodeVoucher, randomNonce, signPayment } from '@senet/core';
import { requestPayment, submitPayment } from './api.js';
import { wireScanButton } from './camera.js';
import { CODE_SIZE } from './config.js';
import { detail, element, fill, make, short, toStroops, xlm } from './dom.js';
import type { ScreenHooks } from './dom.js';
import { passkeySigner } from './passkey.js';
import { drawToCanvas, encodeBytes } from './qr.js';
import type { Scanned } from './qr.js';
import { transactionDetail } from './receipt.js';
import { getAccount, getChain, getLedger, voucherConfig } from './store.js';
import { judgeRequest, judgementText, mayPay, readRequest } from './verify.js';

/**
 * The payee-presented screen.
 *
 * A payee asks for a payment. The service signs the request so that a wallet can
 * tell which domain it came from, and this screen shows it as a code.
 *
 * The same screen reads one, from the camera or from pasted text. A person who
 * reads a request needs two different things: what the payment is, and
 * whether anybody vouched for it. The screen shows the second first, because a
 * person who reads the amount and pays has already acted.
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

/**
 * Whether a code carries a voucher for the chain that this device knows.
 *
 * The library is the one judge of what a voucher is, so this asks it. The
 * answer only chooses the words of a refusal, and it never lets anything pay.
 */
function isVoucher(bytes: Uint8Array): boolean {
  const chain = getChain();
  if (chain === null) return false;
  try {
    decodeVoucher(voucherConfig(chain), bytes);
    return true;
  } catch {
    return false;
  }
}

/** Wire the payee screen to the document. */
export function startPayeeScreen(): ScreenHooks {
  const form = element('payee-form', HTMLFormElement);
  const amount = element('payee-amount', HTMLInputElement);
  const message = element('payee-message', HTMLInputElement);
  const destination = element('payee-destination', HTMLElement);
  const panel = element('payee-panel', HTMLDivElement);
  const readForm = element('payee-read-form', HTMLFormElement);
  const scanButton = element('payee-scan', HTMLButtonElement);
  const video = element('payee-video', HTMLVideoElement);
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
   * The camera and the paste field both end here, so a request reads the same
   * whichever way it arrived. The judgement comes first on the screen. A person
   * who reads an amount and acts on it pays before they judge anything. The
   * details sit under it.
   */
  async function judge(uri: string): Promise<void> {
    const chain = getChain();
    if (chain === null) {
      showProblem(
        readPanel,
        'The service did not answer, so this device does not know its network yet. ' +
          'Check the network, then try again.',
      );
      return;
    }
    fill(readPanel, make('p', 'waiting', 'Asking the domain that this request names.'));
    try {
      const judged = await judgeRequest(uri, chain.network);
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
      if (mayPay(judged)) addPayButton(box, uri, request.fields);
      fill(readPanel, box);
    } catch (caught) {
      showProblem(readPanel, reason(caught));
    }
  }

  /**
   * Take what the camera read, when it is a payment request.
   *
   * A request is text, and a voucher is bytes. The camera reads both, and a
   * person can aim at the wrong phone. A voucher gets its own words, because it
   * is the one wrong code that this application itself draws.
   */
  function readScanned(scanned: Scanned): void {
    const text = scanned.text.trim();
    if (text.startsWith(SEP7_SCHEME)) {
      void judge(text);
      return;
    }
    showProblem(
      readPanel,
      isVoucher(scanned.bytes)
        ? 'This code is a voucher, not a payment request. ' +
            'To take a voucher, open Take a payment and scan it there.'
        : 'This code is not a payment request. Scan the code that the payee shows.',
    );
  }

  /** Offer to pay a request, from this device's account. */
  function addPayButton(
    box: HTMLElement,
    uri: string,
    fields: Readonly<Record<string, string>>,
  ): void {
    const to = fields['destination'];
    const asked = fields['amount'];
    if (to === undefined || asked === undefined || asked === '') return;
    const button = document.createElement('button');
    button.className = 'submit';
    button.type = 'button';
    button.textContent = `Pay ${asked} XLM`;
    button.addEventListener('click', () => {
      button.disabled = true;
      void pay(to, asked, box, uri);
    });
    box.append(button);
  }

  /**
   * Pay one request from this device's account.
   *
   * The passkey signs an authorization for a transfer, and the service pays
   * the network fee. The amount and the destination come from the request that
   * the screen judged, and the network is the one that the judgement matched.
   * Nothing here comes from a field that a person typed, so the payment
   * matches what the judgement covered.
   */
  async function pay(
    to: string,
    asked: string,
    box: HTMLElement,
    uri: string,
  ): Promise<void> {
    const account = getAccount();
    const chain = getChain();
    const seen = getLedger();
    if (account === null || chain === null) {
      showProblem(readPanel, 'This device holds no account, so it can pay nothing.');
      return;
    }
    if (seen === null) {
      // The deadline needs a ledger. A device that saw none cannot date the
      // end of its own authorization.
      showProblem(readPanel, 'This device knows no ledger, so it cannot date a payment.');
      return;
    }
    box.append(make('p', 'confirming', `Paying ${asked} XLM. Your device will ask you to confirm.`));
    try {
      const stroops = toStroops(asked);
      const entry = await signPayment(
        voucherConfig(chain),
        { from: account.contractId, to, amount: stroops, expireAt: seen.sequence + LIFETIMES['15m'] },
        randomNonce(),
        passkeySigner(chain),
      );
      const paid = await submitPayment({
        from: account.contractId,
        to,
        amountStroops: stroops.toString(),
        entryXdr: entry.toXDR('base64'),
      });
      const done = make('div', `result result-${paid.outcome === 'SUCCESS' ? 'good' : 'bad'}`);
      done.append(
        make('h2', 'result-title', paid.outcome === 'SUCCESS' ? 'Paid' : 'Not paid'),
        make('p', 'result-advice', `${xlm(paid.amountStroops)} to ${short(paid.to)}.`),
        detail('Outcome', paid.outcome),
      );
      if (paid.hash !== null) done.append(transactionDetail(paid.hash));
      fill(readPanel, done);
      // The request stays on the screen, so a person can read what they paid.
      uriField.value = uri;
    } catch (caught) {
      showProblem(readPanel, reason(caught));
    }
  }

  const stopScan = wireScanButton(scanButton, video, {
    onStart: () => {
      fill(readPanel, make('p', 'waiting', 'Point the camera at the payment request that the payee shows.'));
    },
    onFound: readScanned,
    onFailure: (caught) => {
      showProblem(readPanel, reason(caught));
    },
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void ask();
  });
  readForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const uri = uriField.value.trim();
    if (uri === '') {
      showProblem(readPanel, 'Paste a payment request, or scan one.');
      return;
    }
    void judge(uri);
  });

  showDestination();
  return { refresh: showDestination, leave: stopScan };
}
