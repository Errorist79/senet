/**
 * The document helpers.
 *
 * Every reader checks the element that it found. A rename in the markup then
 * fails at start with a clear message, and not later with a blank screen.
 */

/**
 * What a screen does when a person reaches it, and when they leave it.
 *
 * A screen draws from what the device holds, and another screen can change
 * that, so a screen draws itself again when a person reaches it. A screen that
 * holds the camera releases it when a person leaves, because nobody aims a
 * camera behind a hidden screen.
 */
export interface ScreenHooks {
  readonly refresh: () => void;
  readonly leave: () => void;
}

/** The element with `id`, when it is of the kind that the caller needs. */
export function element<T extends Element>(
  id: string,
  kind: new () => T,
): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`the page carries no element with id ${id}`);
  if (!(found instanceof kind)) {
    throw new Error(`the element ${id} is not a ${kind.name}`);
  }
  return found;
}

/** Build one element, with text and a class. */
export function make(
  tag: string,
  className: string,
  text = '',
): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

/**
 * One labelled value in a list of details.
 *
 * A long identifier reads better shortened, so the row shows the short form
 * and keeps the whole value in `data-full`. A person reads the first, and
 * anything that copies or checks the value reads the second.
 */
export function detail(label: string, value: string, full = value): HTMLElement {
  const row = make('div', 'detail');
  const shown = make('span', 'detail-value', value);
  if (full !== value) shown.dataset['full'] = full;
  row.append(make('span', 'detail-label', label), shown);
  return row;
}

/** Replace everything inside a node. */
export function fill(node: Element, ...children: readonly Node[]): void {
  node.replaceChildren(...children);
}

/** Stroops in one XLM. */
export const STROOPS_PER_XLM = 10_000_000n;

/**
 * An amount in XLM, as stroops.
 *
 * A person types a decimal amount, or a payment request carries one, and the
 * ledger counts stroops. The reader multiplies rather than parsing a float,
 * because a float loses stroops.
 */
export function toStroops(typed: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(typed.trim())) {
    throw new Error('the amount must be a number with up to seven decimal places');
  }
  const [whole, fraction] = typed.trim().split('.');
  const places = (fraction ?? '').padEnd(7, '0');
  return BigInt(whole ?? '0') * STROOPS_PER_XLM + BigInt(places);
}

/** Stroops as an XLM amount with seven places. */
export function xlm(stroops: string): string {
  const negative = stroops.startsWith('-');
  const digits = (negative ? stroops.slice(1) : stroops).padStart(8, '0');
  const whole = digits.slice(0, -7);
  const fraction = digits.slice(-7);
  return `${negative ? '-' : ''}${whole}.${fraction} XLM`;
}

/** A long identifier, shortened for a screen but never for a copy. */
export function short(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

/**
 * A count of ledgers, as a person reads it.
 *
 * A ledger closes about every five seconds, so a count of ledgers is a
 * duration. The text stays vague on purpose, because the number is an estimate.
 */
export function lifeLeft(ledgers: number, secondsPerLedger: number): string {
  if (ledgers <= 0) return 'expired';
  const seconds = Math.round(ledgers * secondsPerLedger);
  if (seconds < 90) return `about ${seconds} seconds left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} minutes left`;
  return `about ${Math.round(minutes / 60)} hours left`;
}
