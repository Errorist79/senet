import { ServiceError, submitRedeem } from './api.js';
import type { RedeemReply } from './api.js';
import { detail, element, fill, make, short, xlm } from './dom.js';
import { outcomeText } from './outcomes.js';
import { getMerchantAddress, setMerchantAddress } from './store.js';

/**
 * The merchant screen.
 *
 * The merchant pastes a voucher, names the account that receives the funds,
 * and submits. The screen shows one typed outcome and what to do about it.
 *
 * The camera arrives with the scanner. The screen holds no protocol logic: it
 * sends the payload to the service and it reads the service's answer.
 */

/** Show one refusal that never reached the ledger. */
function showRefusal(panel: HTMLElement, code: string, message: string): void {
  const box = make('div', 'result result-bad');
  box.append(make('h2', 'result-title', 'Refused'), make('p', 'result-advice', message));
  box.append(detail('Reason', code));
  fill(panel, box);
}

/** Show what the service answered. */
function showResult(panel: HTMLElement, reply: RedeemReply): void {
  const text = outcomeText(reply.outcome);
  const box = make('div', `result result-${text.tone}`);
  box.append(
    make('h2', 'result-title', text.title),
    make('p', 'result-advice', text.advice),
    detail('Outcome', reply.outcome),
    detail('Amount', xlm(reply.amountStroops)),
    detail('Voucher', reply.voucherId),
    detail('Payer', short(reply.payer)),
    detail('Recipient', short(reply.recipient)),
  );
  if (reply.hash !== null) {
    const row = detail('Transaction', short(reply.hash));
    const link = make('a', 'detail-link', 'open');
    if (link instanceof HTMLAnchorElement) {
      link.href = `https://stellar.expert/explorer/testnet/tx/${reply.hash}`;
      link.target = '_blank';
      link.rel = 'noreferrer';
      row.append(link);
    }
    box.append(row);
  }
  if (reply.ledger !== null) box.append(detail('Ledger', String(reply.ledger)));
  if (reply.feeChargedStroops !== null) {
    box.append(detail('Fee charged', xlm(reply.feeChargedStroops)));
  }
  fill(panel, box);
}

/** Wire the merchant screen to the document. */
export function startMerchantScreen(): void {
  const form = element('merchant-form', HTMLFormElement);
  const payload = element('merchant-payload', HTMLTextAreaElement);
  const recipient = element('merchant-recipient', HTMLInputElement);
  const submit = element('merchant-submit', HTMLButtonElement);
  const panel = element('merchant-result', HTMLDivElement);

  recipient.value = getMerchantAddress();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void send();
  });

  async function send(): Promise<void> {
    const entryXdr = payload.value.trim();
    const address = recipient.value.trim();
    if (entryXdr === '' || address === '') {
      showRefusal(panel, 'MISSING_FIELD', 'Paste a voucher and name the account that receives it.');
      return;
    }
    setMerchantAddress(address);
    submit.disabled = true;
    fill(panel, make('p', 'waiting', 'The service is paying the fee and waiting for a ledger.'));
    try {
      showResult(panel, await submitRedeem(entryXdr, address));
    } catch (caught) {
      if (caught instanceof ServiceError) showRefusal(panel, caught.code, caught.message);
      else showRefusal(panel, 'APPLICATION_FAILED', 'The application could not send the voucher.');
    } finally {
      submit.disabled = false;
    }
  }
}
