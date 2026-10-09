import {
  CONTRACT_MAX_AMOUNT_STROOPS,
  LEDGER_MEAN_CLOSE_SECONDS,
  LIFETIMES,
  VoucherError,
  decodeVoucher,
  encodeVoucher,
  estimateLedger,
  offlineExpireAt,
  randomNonce,
  randomVoucherId,
  remainingLedgers,
  signVoucher,
} from '@senet/core';
import type { LifetimeName, Voucher } from '@senet/core';
import { ServiceError, submitRedeem } from './api.js';
import {
  STROOPS_PER_XLM,
  detail,
  element,
  fill,
  lifeLeft,
  make,
  short,
  toStroops,
  xlm,
} from './dom.js';
import { encodeBytes, drawToCanvas } from './qr.js';
import { CODE_SIZE } from './config.js';
import { passkeySigner } from './passkey.js';
import { redeemDetails } from './receipt.js';
import {
  getAccount,
  getChain,
  getLedger,
  getVouchers,
  setVouchers,
  voucherConfig,
} from './store.js';
import type { StoredVoucher } from './store.js';

/**
 * The payer screen.
 *
 * A payer names an amount, picks how long the voucher lives, and shows the
 * code. The mint makes no network call: the device counts forward from the
 * last ledger it saw, and the passkey signs.
 *
 * That is the whole point of this screen. A payer with no network can still
 * pay, so nothing on this path may reach for one.
 */

/** The lifetimes that the screen offers, in the order that it shows them. */
const LIFETIME_ORDER: readonly LifetimeName[] = ['5m', '15m', '1h', '12h'];

/** The lifetime that the screen offers first. */
const DEFAULT_LIFETIME: LifetimeName = '15m';

/** How a lifetime reads to a person. */
const LIFETIME_LABELS: Readonly<Record<LifetimeName, string>> = {
  '5m': '5 minutes',
  '15m': '15 minutes',
  '1h': '1 hour',
  '12h': '12 hours',
};

/** Whether a value names a lifetime that this screen offers. */
function isLifetimeName(value: string): value is LifetimeName {
  return LIFETIME_ORDER.some((name) => name === value);
}

/** Read a code and a message out of a caught value of unknown type. */
function reason(caught: unknown): { code: string; message: string } {
  if (caught instanceof VoucherError) return { code: caught.name, message: caught.message };
  if (caught instanceof ServiceError) return { code: caught.code, message: caught.message };
  if (caught instanceof Error && caught.name === 'NotAllowedError') {
    return { code: 'REFUSED', message: 'You did not confirm the passkey, so nothing happened.' };
  }
  return { code: 'APPLICATION_FAILED', message: 'The application could not finish that step.' };
}

/** Wire the payer screen to the document. */
export function startPayerScreen(): void {
  const form = element('payer-form', HTMLFormElement);
  const amount = element('payer-amount', HTMLInputElement);
  const lifetime = element('payer-lifetime', HTMLSelectElement);
  const mint = element('payer-mint', HTMLButtonElement);
  const panel = element('payer-panel', HTMLDivElement);
  const list = element('payer-list', HTMLDivElement);

  for (const name of LIFETIME_ORDER) {
    const option = make('option', '', LIFETIME_LABELS[name]);
    if (option instanceof HTMLOptionElement) {
      option.value = name;
      option.selected = name === DEFAULT_LIFETIME;
      lifetime.append(option);
    }
  }

  /** Show one failure, in the shape that every screen uses. */
  function showProblem(code: string, message: string): void {
    const box = make('div', 'result result-bad');
    box.append(make('h2', 'result-title', 'That did not work'), make('p', 'result-advice', message));
    box.append(detail('Reason', code));
    fill(panel, box);
  }

  /**
   * Draw one voucher's code, so a merchant can read it.
   *
   * The screen carries the amount, the code and the voucher name. A payer
   * hands the code over and reads the amount back, and nothing else on this
   * screen helps them do that.
   */
  function showCode(voucher: StoredVoucher): void {
    const bytes = Uint8Array.from(window.atob(voucher.payloadBase64), (c) => c.charCodeAt(0));
    const symbol = encodeBytes(bytes);
    const box = make('div', 'result result-good');
    box.append(
      make('h2', 'result-title', xlm(voucher.amountStroops)),
      make('p', 'result-advice', 'Show this to the merchant. It works with no network.'),
    );
    const canvas = document.createElement('canvas');
    canvas.className = 'code';
    box.append(canvas, detail('Voucher', voucher.voucherId));
    fill(panel, box);
    drawToCanvas(canvas, symbol, CODE_SIZE);
  }

  /** Draw every voucher that this device minted. */
  function showList(): void {
    const vouchers = getVouchers();
    if (vouchers.length === 0) {
      fill(list, make('p', 'screen-note', 'No voucher yet. Mint one above.'));
      return;
    }
    const seen = getLedger();
    const now =
      seen === null ? null : estimateLedger(seen.sequence, (Date.now() - seen.seenAtMs) / 1000);
    const rows = vouchers.map((voucher) => {
      const row = make('div', `voucher voucher-${voucher.state}`);
      const left = now === null ? null : remainingLedgers(voucher.expireAt, now);
      row.append(
        make('span', 'voucher-amount', xlm(voucher.amountStroops)),
        make(
          'span',
          'voucher-life',
          voucher.state === 'void'
            ? 'voided'
            : left === null
              ? 'life unknown'
              : lifeLeft(left, LEDGER_MEAN_CLOSE_SECONDS),
        ),
      );
      const show = make('button', 'link-button', 'Show');
      if (show instanceof HTMLButtonElement && voucher.state === 'active') {
        show.type = 'button';
        show.addEventListener('click', () => showCode(voucher));
        row.append(show);
      }
      const drop = make('button', 'link-button', 'Void');
      if (drop instanceof HTMLButtonElement && voucher.state === 'active') {
        drop.type = 'button';
        drop.addEventListener('click', () => {
          drop.disabled = true;
          void voidVoucher(voucher);
        });
        row.append(drop);
      }
      if (voucher.voidHash !== null) {
        row.append(make('span', 'voucher-hash', short(voucher.voidHash)));
      }
      return row;
    });
    fill(list, ...rows);
  }

  /**
   * Mint one voucher, with no network call.
   *
   * The device counts forward from the last ledger it saw. Both deadlines come
   * from one computed value, and the library refuses to let them drift apart.
   */
  async function mintVoucher(): Promise<void> {
    const chain = getChain();
    const account = getAccount();
    if (chain === null) {
      showProblem('NO_SETTINGS', 'This device has no settings yet. Open it once with a network.');
      return;
    }
    if (account === null) {
      showProblem('NO_ACCOUNT', 'Create an account first, on the account screen.');
      return;
    }
    const seen = getLedger();
    if (seen === null) {
      showProblem(
        'NO_LEDGER',
        'This device knows no ledger, so it cannot say when a voucher expires. ' +
          'Open the application once with a network, then mint offline.',
      );
      return;
    }

    mint.disabled = true;
    fill(panel, make('p', 'waiting', 'Your device is asking you to confirm the passkey.'));
    try {
      const config = voucherConfig(chain);
      const elapsedSeconds = (Date.now() - seen.seenAtMs) / 1000;
      const name = isLifetimeName(lifetime.value) ? lifetime.value : DEFAULT_LIFETIME;
      const lifetimeLedgers = LIFETIMES[name];
      const voucher: Voucher = {
        payer: account.contractId,
        amount: toStroops(amount.value),
        voucherId: randomVoucherId(),
        expireAt: offlineExpireAt(seen.sequence, elapsedSeconds, lifetimeLedgers),
      };
      const entry = await signVoucher(config, voucher, randomNonce(), passkeySigner(chain));
      const payload = encodeVoucher(config, entry);
      let binary = '';
      for (const byte of payload) binary += String.fromCharCode(byte);
      const stored: StoredVoucher = {
        voucherId: voucher.voucherId.toString(),
        amountStroops: voucher.amount.toString(),
        expireAt: voucher.expireAt,
        mintedAtMs: Date.now(),
        payloadBase64: window.btoa(binary),
        state: 'active',
        voidHash: null,
      };
      setVouchers([stored, ...getVouchers()]);
      showList();
      showCode(stored);
    } catch (caught) {
      const { code, message } = reason(caught);
      showProblem(code, message);
    } finally {
      mint.disabled = false;
    }
  }

  /**
   * Void one voucher, and pay it back to the payer's own account.
   *
   * Nothing on chain cancels a voucher. The host refuses a nonce that it
   * already saw, so a spent voucher is an unusable one. A payment to yourself
   * spends it and costs you nothing.
   */
  async function voidVoucher(voucher: StoredVoucher): Promise<void> {
    const account = getAccount();
    const chain = getChain();
    if (account === null || chain === null) {
      showProblem('NO_ACCOUNT', 'This device has no account, so it cannot void a voucher.');
      return;
    }
    fill(panel, make('p', 'waiting', 'Paying the voucher back to your own account.'));
    try {
      // The service takes the entry, and the payload carries the prefix in
      // front of it. The library wrote both, and it reads both back.
      const bytes = Uint8Array.from(window.atob(voucher.payloadBase64), (c) => c.charCodeAt(0));
      const decoded = decodeVoucher(voucherConfig(chain), bytes);
      const reply = await submitRedeem(decoded.entry.toXDR('base64'), account.contractId);
      const box = make('div', `result result-${reply.outcome === 'SUCCESS' ? 'good' : 'bad'}`);
      box.append(
        make('h2', 'result-title', reply.outcome === 'SUCCESS' ? 'Voided' : 'Not voided'),
        make(
          'p',
          'result-advice',
          reply.outcome === 'SUCCESS'
            ? 'Nobody else can use this voucher now. The funds stayed with you.'
            : 'The voucher is still out there. Try again.',
        ),
        ...redeemDetails(reply),
      );
      fill(panel, box);
      if (reply.outcome === 'SUCCESS') {
        setVouchers(
          getVouchers().map((one) =>
            one.voucherId === voucher.voucherId
              ? { ...one, state: 'void' as const, voidHash: reply.hash }
              : one,
          ),
        );
      }
      showList();
    } catch (caught) {
      const { code, message } = reason(caught);
      showProblem(code, message);
      showList();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void mintVoucher();
  });

  amount.max = (CONTRACT_MAX_AMOUNT_STROOPS / STROOPS_PER_XLM).toString();
  showList();
}
