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
import type { LifetimeName, Voucher, VoucherConfig } from '@senet/core';
import { ServiceError, submitRedeem } from './api.js';
import { detail, element, fill, lifeLeft, make, short, xlm } from './dom.js';
import { ERROR_CORRECTION, PLANNED_MAX_VERSION, encodeBytes, drawToCanvas } from './qr.js';
import { CODE_SIZE } from './config.js';
import type { ErrorCorrection } from './qr.js';
import { passkeySigner } from './passkey.js';
import { redeemDetails } from './receipt.js';
import { getAccount, getChain, getLedger, getVouchers, setVouchers } from './store.js';
import type { StoredChain, StoredVoucher } from './store.js';

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

/** How wide the code is drawn, in CSS pixels. */


/**
 * TEMPORARY. The error correction level is a control on this screen only so
 * that one measurement session can compare the two levels on real phones.
 *
 * Level M draws a denser symbol with more redundancy. Level L draws a larger
 * module with less. Nobody knows which one a camera reads more reliably from a
 * lit screen a few centimetres away. The production payload also sits six
 * bytes inside the largest symbol that level M holds.
 *
 * Remove this control, and the levels beside it, in the change that records
 * the decision. It must not outlive the question.
 */
const MEASUREMENT_LEVELS: readonly ErrorCorrection[] = ['M', 'L'];

/** Stroops in one XLM, for the amount that a person types. */
const STROOPS_PER_XLM = 10_000_000n;

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

/**
 * An amount in XLM, as stroops.
 *
 * A person types a decimal amount, and the ledger counts stroops. The reader
 * multiplies rather than parsing a float, because a float loses stroops.
 */
function toStroops(typed: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(typed.trim())) {
    throw new Error('the amount must be a number with up to seven decimal places');
  }
  const [whole, fraction] = typed.trim().split('.');
  const places = (fraction ?? '').padEnd(7, '0');
  return BigInt(whole ?? '0') * STROOPS_PER_XLM + BigInt(places);
}

/** The chain identities that the library needs. */
function voucherConfig(chain: StoredChain): VoucherConfig {
  return { network: chain.network, contractId: chain.contractId, tokenId: chain.tokenId };
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
   * The size of the code sits beside it in plain text, large enough to read in
   * a photograph of the screen. A person who measures a device needs the
   * version and the byte count in one shot, and taps nothing to get them.
   *
   * The level is drawn into that same line, so a photograph proves which level
   * produced the code. Nobody has to record it separately, and nobody can
   * record it wrongly.
   */
  function showCode(voucher: StoredVoucher, level: ErrorCorrection = ERROR_CORRECTION): void {
    const bytes = Uint8Array.from(window.atob(voucher.payloadBase64), (c) => c.charCodeAt(0));
    const symbol = encodeBytes(bytes, level);
    const box = make('div', 'result result-good');
    box.append(
      make('h2', 'result-title', xlm(voucher.amountStroops)),
      make('p', 'result-advice', 'Show this to the merchant. It works with no network.'),
    );
    // The size sits above the code, and not below it. A code fills a phone
    // screen, so a line under it falls off the bottom. A photograph would then
    // carry the code without the numbers that describe it.
    box.append(
      make('p', 'code-size', `version ${symbol.version} · level ${level} · ${bytes.length} bytes`),
    );
    if (symbol.version > PLANNED_MAX_VERSION) {
      // The code still works. It is denser than any code that a measurement
      // covered, so a scan that fails here is worth a report and not a retry.
      box.append(
        make(
          'p',
          'code-warning',
          `This code is denser than any code that this version measured, which ` +
            `reached version ${PLANNED_MAX_VERSION}. It should still scan. Tell the ` +
            `operator if it does not.`,
        ),
      );
    }
    // TEMPORARY, with the constant above. One session compares the two levels.
    // The control sits above the code. A code fills a phone screen, and a
    // person who holds two phones should not scroll past it to reach a button.
    const switcher = make('div', 'levels');
    switcher.append(make('span', 'levels-label', 'Measurement only'));
    for (const one of MEASUREMENT_LEVELS) {
      const button = make('button', 'levels-button', `Level ${one}`);
      if (button instanceof HTMLButtonElement) {
        button.type = 'button';
        button.setAttribute('aria-current', one === level ? 'true' : 'false');
        button.addEventListener('click', () => showCode(voucher, one));
        switcher.append(button);
      }
    }
    const canvas = document.createElement('canvas');
    canvas.className = 'code';
    box.append(switcher, canvas, detail('Voucher', voucher.voucherId));
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
