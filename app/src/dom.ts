/**
 * The document helpers.
 *
 * Every reader checks the element that it found. A rename in the markup then
 * fails at start with a clear message, and not later with a blank screen.
 */

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
