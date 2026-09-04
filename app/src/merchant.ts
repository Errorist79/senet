import {
  LEDGER_MEAN_CLOSE_SECONDS,
  VoucherError,
  assertRemainingLife,
  decodeVoucher,
  estimateLedger,
} from '@senet/core';
import type { DecodedVoucher, VoucherConfig } from '@senet/core';
import { ServiceError, fetchLedger, submitRedeem } from './api.js';
import type { RedeemReply } from './api.js';
import { CameraError, scanForSymbol } from './camera.js';
import type { Scan } from './camera.js';
import { detail, element, fill, lifeLeft, make, short, xlm } from './dom.js';
import { outcomeText } from './outcomes.js';
import {
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

/** Wire the merchant screen to the document. */
export function startMerchantScreen(): void {
  const form = element('merchant-form', HTMLFormElement);
  const payload = element('merchant-payload', HTMLTextAreaElement);
  const recipient = element('merchant-recipient', HTMLInputElement);
  const scanButton = element('merchant-scan', HTMLButtonElement);
  const video = element('merchant-video', HTMLVideoElement);
  const panel = element('merchant-result', HTMLDivElement);

  recipient.value = getMerchantAddress();
  let scan: Scan | null = null;

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
    const address = recipient.value.trim();
    if (address === '') {
      showRefusal(panel, 'MISSING_FIELD', 'Name the account that receives the funds.');
      return;
    }
    setMerchantAddress(address);
    fill(panel, make('p', 'waiting', 'The service is paying the fee and waiting for a ledger.'));
    try {
      showResult(panel, await submitRedeem(entryXdr, address));
    } catch (caught) {
      const { code, message } = reason(caught);
      showRefusal(panel, code, message);
    }
  }
}
