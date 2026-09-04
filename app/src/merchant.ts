import {
  LEDGER_MEAN_CLOSE_SECONDS,
  VoucherError,
  assertRemainingLife,
  decodeVoucher,
  estimateLedger,
} from '@senet/core';
import type { DecodedVoucher, VoucherConfig } from '@senet/core';
import { ServiceError, fetchLedger, fetchRedemption, submitRedeem } from './api.js';
import type { RedeemReply, Redemption } from './api.js';
import { CameraError, scanForSymbol } from './camera.js';
import { CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS } from './config.js';
import type { Scan } from './camera.js';
import { detail, element, fill, lifeLeft, make, short, xlm } from './dom.js';
import { outcomeText } from './outcomes.js';
import {
  getAccount,
  getChain,
  getLedger,
  getMerchantAddress,
  setLedger,
  setMerchantAddress,
} from './store.js';

/**
 * The merchant screen.
 *
 * A merchant names the account that receives the funds. They then scan the
 * code that the payer shows, read what the voucher is worth, and take the
 * payment.
 *
 * The screen holds no protocol logic. The library reads the code and judges
 * it, and the service pays the fee and submits the transaction.
 */

/** The voucher that a merchant looks at, until they take it or drop it. */
interface Held {
  readonly voucher: DecodedVoucher;
  /** Ledgers of life left. */
  readonly remaining: number;
}

/** Read a code and a message out of a caught value of unknown type. */
function reason(caught: unknown): { code: string; message: string } {
  if (caught instanceof VoucherError) return { code: caught.name, message: caught.message };
  if (caught instanceof CameraError) return { code: caught.problem, message: caught.message };
  if (caught instanceof ServiceError) return { code: caught.code, message: caught.message };
  return { code: 'APPLICATION_FAILED', message: 'The application could not finish that step.' };
}

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
    detail('Payer', short(reply.payer), reply.payer),
    detail('Recipient', short(reply.recipient), reply.recipient),
  );
  if (reply.hash !== null) {
    const row = detail('Transaction', short(reply.hash), reply.hash);
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
  if (reply.outcome === 'SUCCESS') void confirmFromFeed(box, reply);
}

/**
 * Wait for the chain to say that the contract paid.
 *
 * A submission that returns says the network accepted a transaction. Only the
 * contract's own event says that the payment happened, and the screen once
 * said `paid` on the strength of the first. This reads the second.
 *
 * The state is drawn from what the feed holds, and it is drawn again on every
 * answer. Three states exist rather than two, and the third is the one that a
 * screen usually forgets.
 */
async function confirmFromFeed(box: HTMLElement, reply: RedeemReply): Promise<void> {
  const line = make('p', 'confirming', 'The network took the payment. Waiting for the chain to confirm it.');
  box.append(line);

  const until = Date.now() + CONFIRM_TIMEOUT_MS;
  for (;;) {
    let found: Redemption | null = null;
    try {
      found = await fetchRedemption(reply.voucherId);
    } catch {
      // A service that does not answer is not a payment that failed. The wait
      // continues, and the bound below ends it.
    }
    if (found !== null) {
      line.className = 'confirmed';
      line.textContent = 'The chain confirms this payment.';
      box.append(detail('Confirmed in ledger', String(found.ledger)));
      // The hash comes from the event, and not from the submission. They agree
      // on a healthy network, and the one that matters is the chain's.
      box.append(detail('Confirmed hash', short(found.tx_hash), found.tx_hash));
      return;
    }
    if (Date.now() >= until) {
      // The submission succeeded, so this is not a failure and the screen must
      // not call it one. The funds may well have moved. The merchant gets the
      // transaction, which is what lets them settle it themselves.
      line.className = 'confirming confirming-late';
      line.textContent =
        'The network took this payment and the chain has not confirmed it yet. ' +
        'The payment may still be good. Check the transaction below, or ask ' +
        'the payer to show the code again.';
      return;
    }
    await new Promise((rest) => window.setTimeout(rest, CONFIRM_POLL_MS));
  }
}

/**
 * The ledger that the network reached.
 *
 * A merchant needs the network to take a payment at all, so the screen reads
 * the ledger rather than counting forward from an old one. It falls back to
 * counting only when the read fails, the way a payer's device counts when it
 * mints with no network.
 *
 * A merchant who cannot reach either cannot judge how long a voucher lives,
 * and this reports nothing rather than a guess.
 */
async function currentLedger(): Promise<number | null> {
  try {
    const read = await fetchLedger();
    setLedger({ sequence: read.sequence, seenAtMs: Date.now() });
    return read.sequence;
  } catch {
    const seen = getLedger();
    if (seen === null) return null;
    return estimateLedger(seen.sequence, (Date.now() - seen.seenAtMs) / 1000);
  }
}

/**
 * Read a voucher out of the bytes that a code carried.
 *
 * The library refuses an unknown format, another network, a credential that is
 * not address bound, and two deadlines that disagree. This adds the rule that
 * belongs to the merchant: a voucher must live long enough to survive the
 * payment.
 */
function readCode(config: VoucherConfig, bytes: Uint8Array, now: number): Held {
  const voucher = decodeVoucher(config, bytes);
  return { voucher, remaining: assertRemainingLife(voucher.expireAt, now) };
}

/**
 * Wire the merchant screen to the document.
 *
 * It gives back the way to refresh itself. The account arrives on another
 * screen. A destination drawn once at start would then say that this device
 * holds nothing long after it holds an account.
 */
export function startMerchantScreen(): () => void {
  const form = element('merchant-form', HTMLFormElement);
  const payload = element('merchant-payload', HTMLTextAreaElement);
  const recipient = element('merchant-recipient', HTMLInputElement);
  const scanButton = element('merchant-scan', HTMLButtonElement);
  const destination = element('merchant-destination', HTMLDivElement);
  const destinationValue = element('merchant-destination-value', HTMLSpanElement);
  const elsewhere = element('merchant-elsewhere', HTMLButtonElement);
  const other = element('merchant-other', HTMLLabelElement);
  const otherLabel = element('merchant-other-label', HTMLSpanElement);
  const video = element('merchant-video', HTMLVideoElement);
  const panel = element('merchant-result', HTMLDivElement);

  let scan: Scan | null = null;

  /**
   * Show where the payment goes.
   *
   * A merchant taking a payment on their own phone should not type a fifty six
   * character address that the same screen is already displaying. A mistyped
   * address that happens to be valid sends the money where nobody can recover
   * it. The device's own account is therefore the default, and typing is the
   * deliberate path.
   */
  function showDestination(): void {
    const account = getAccount();
    const typed = getMerchantAddress();
    if (account === null) {
      // With no account the screen has nothing to offer, so it asks, and it
      // says why it is asking rather than presenting an empty box.
      destination.hidden = true;
      other.hidden = false;
      otherLabel.textContent =
        'This device holds no account, so name the account that receives the funds';
      recipient.value = typed;
      return;
    }
    if (typed !== '' && typed !== account.contractId) {
      // Somebody chose another destination, and that choice stands until they
      // clear it. The screen shows what it will really do.
      destination.hidden = true;
      other.hidden = false;
      otherLabel.textContent = 'Account that receives the funds';
      recipient.value = typed;
      return;
    }
    destination.hidden = false;
    other.hidden = true;
    destinationValue.textContent = short(account.contractId);
    destinationValue.dataset['full'] = account.contractId;
    recipient.value = account.contractId;
  }

  elsewhere.addEventListener('click', () => {
    destination.hidden = true;
    other.hidden = false;
    otherLabel.textContent = 'Account that receives the funds';
    recipient.value = '';
    recipient.focus();
  });

  showDestination();
  

  /** Stop the camera and put the button back. */
  function stopScan(): void {
    scan?.stop();
    scan = null;
    video.hidden = true;
    scanButton.textContent = 'Scan a voucher';
  }

  /** Show the voucher, and offer to take it. */
  function offer(held: Held): void {
    const box = make('div', 'result result-wait');
    box.append(
      make('h2', 'result-title', xlm(held.voucher.amount.toString())),
      make('p', 'result-advice', lifeLeft(held.remaining, LEDGER_MEAN_CLOSE_SECONDS)),
      detail('Payer', short(held.voucher.payer), held.voucher.payer),
      detail('Voucher', held.voucher.voucherId.toString()),
    );
    const take = make('button', 'submit', 'Take the payment');
    if (take instanceof HTMLButtonElement) {
      take.type = 'button';
      take.addEventListener('click', () => {
        take.disabled = true;
        void send(held.voucher.entry.toXDR('base64'));
      });
      box.append(take);
    }
    fill(panel, box);
  }

  /**
   * Read one code, whether the camera or the paste field carried it.
   *
   * The screen refuses a voucher that it cannot judge. The life check exists
   * to stop a merchant taking a voucher that expires during the payment. An
   * unknown ledger is therefore a refusal, and not a warning.
   */
  async function present(bytes: Uint8Array): Promise<void> {
    const chain = getChain();
    if (chain === null) {
      showRefusal(
        panel,
        'NO_SETTINGS',
        'The service did not answer, so this device cannot read a voucher yet.',
      );
      return;
    }
    const now = await currentLedger();
    if (now === null) {
      showRefusal(
        panel,
        'NO_LEDGER',
        'This device does not know which ledger the network reached, so it cannot ' +
          'say whether this voucher still lives. Check the network, then scan again.',
      );
      return;
    }
    const config: VoucherConfig = {
      network: chain.network,
      contractId: chain.contractId,
      tokenId: chain.tokenId,
    };
    try {
      offer(readCode(config, bytes, now));
    } catch (caught) {
      const { code, message } = reason(caught);
      showRefusal(panel, code, message);
    }
  }

  /** Open the camera and wait for a code. */
  async function startScan(): Promise<void> {
    fill(panel, make('p', 'waiting', 'Point the camera at the code that the payer shows.'));
    video.hidden = false;
    scanButton.textContent = 'Stop the camera';
    try {
      scan = await scanForSymbol(video, (found) => {
        stopScan();
        void present(found.bytes);
      });
    } catch (caught) {
      stopScan();
      const { code, message } = reason(caught);
      showRefusal(panel, code, message);
    }
  }

  scanButton.addEventListener('click', () => {
    if (scan !== null) {
      stopScan();
      return;
    }
    void startScan();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = payload.value.trim();
    if (text === '') {
      showRefusal(panel, 'MISSING_FIELD', 'Scan a code, or paste one into the box.');
      return;
    }
    try {
      void present(Uint8Array.from(window.atob(text), (character) => character.charCodeAt(0)));
    } catch {
      showRefusal(panel, 'MALFORMED_CODE', 'That is not a voucher code.');
    }
  });

  /** Send one voucher to the service, and show what it answers. */
  async function send(entryXdr: string): Promise<void> {
    const account = getAccount();
    const address = recipient.value.trim() === '' ? (account?.contractId ?? '') : recipient.value.trim();
    if (address === '') {
      showRefusal(panel, 'MISSING_FIELD', 'Name the account that receives the funds.');
      return;
    }
    // A destination that is this device's own account needs no remembering,
    // because the account is where it comes from.
    if (account === null || address !== account.contractId) setMerchantAddress(address);
    fill(panel, make('p', 'waiting', 'The service is paying the fee and waiting for a ledger.'));
    try {
      showResult(panel, await submitRedeem(entryXdr, address));
    } catch (caught) {
      const { code, message } = reason(caught);
      showRefusal(panel, code, message);
    }
  }

  return showDestination;
}
