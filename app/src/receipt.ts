import { detail, make, short, xlm } from './dom.js';
import type { RedeemReply } from './api.js';

/**
 * The evidence of one redemption, as rows that a person reads.
 *
 * A payment and a void are one act on the chain. The service redeems a
 * voucher, and the ledger records the same fields for both. The merchant
 * screen showed all of them and the payer screen showed two, so the person
 * who voids a voucher read the least. That person acts because something went
 * wrong, and needs the evidence more than a merchant who takes the money.
 *
 * One list now serves both screens. Neither can drift away from the other.
 */

/** Where a person looks up a transaction that this build submitted. */
const EXPLORER_TRANSACTION = 'https://stellar.expert/explorer/testnet/tx/';

/** The transaction row, with a link out to the explorer. */
function transaction(hash: string): HTMLElement {
  const row = detail('Transaction', short(hash), hash);
  const link = make('a', 'detail-link', 'open');
  if (link instanceof HTMLAnchorElement) {
    link.href = `${EXPLORER_TRANSACTION}${hash}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    row.append(link);
  }
  return row;
}

/** Every fact that the service reported about one redemption. */
export function redeemDetails(reply: RedeemReply): readonly HTMLElement[] {
  const rows: HTMLElement[] = [
    detail('Outcome', reply.outcome),
    detail('Amount', xlm(reply.amountStroops)),
    detail('Voucher', reply.voucherId),
    detail('Payer', short(reply.payer), reply.payer),
    detail('Recipient', short(reply.recipient), reply.recipient),
  ];
  if (reply.hash !== null) rows.push(transaction(reply.hash));
  if (reply.ledger !== null) rows.push(detail('Ledger', String(reply.ledger)));
  if (reply.feeChargedStroops !== null) {
    rows.push(detail('Fee charged', xlm(reply.feeChargedStroops)));
  }
  return rows;
}
