import { STROOPS_PER_XLM } from './constants.js';

/** One balance entry that Horizon reports for an account. */
interface Balance {
  readonly asset_type: string;
  readonly balance: string;
}

/** Whether a value carries the two fields that a balance entry needs. */
function isBalance(value: unknown): value is Balance {
  if (value === null || typeof value !== 'object') return false;
  const fields: Record<string, unknown> = { ...value };
  return typeof fields['asset_type'] === 'string' && typeof fields['balance'] === 'string';
}

/**
 * The native balance in a Horizon account reply, in stroops.
 *
 * Horizon answers with a JSON body of unknown shape, so the reader inspects
 * every field that it uses. A balance arrives as a decimal string with seven
 * places, and the conversion multiplies rather than parses a float, because a
 * float loses stroops.
 */
function nativeBalanceStroops(body: unknown): bigint | null {
  if (body === null || typeof body !== 'object') return null;
  const fields: Record<string, unknown> = { ...body };
  const balances = fields['balances'];
  if (!Array.isArray(balances)) return null;
  for (const entry of balances) {
    if (!isBalance(entry) || entry.asset_type !== 'native') continue;
    const [whole, fraction] = entry.balance.split('.');
    if (whole === undefined) return null;
    const places = (fraction ?? '').padEnd(7, '0').slice(0, 7);
    return BigInt(whole) * STROOPS_PER_XLM + BigInt(places);
  }
  return null;
}

/**
 * Read an account's native balance, in stroops.
 *
 * The reply is `null` when Horizon does not know the account, and when the
 * account carries no native balance.
 */
export async function accountBalanceStroops(
  horizonUrl: string,
  address: string,
): Promise<bigint | null> {
  const response = await fetch(`${horizonUrl}/accounts/${address}`);
  if (!response.ok) return null;
  const body: unknown = await response.json();
  return nativeBalanceStroops(body);
}
