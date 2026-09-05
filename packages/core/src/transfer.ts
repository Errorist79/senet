import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { contractFn } from './voucher.js';
import type { SignEntry } from './voucher.js';
import type { VoucherConfig } from './config.js';

/**
 * A payment from a smart account to an address.
 *
 * A voucher is a payer-presented promise that somebody else redeems. This is
 * the other direction: a payee presents a request, and the payer's account
 * pays it directly. The two share a signer and a fee-payer and nothing else.
 *
 * The transfer is a call on the native asset contract. The payer's account
 * authorizes it, the passkey signs the authorization, and the fee-payer holds
 * the transaction that carries it.
 */

/** The function that moves a balance on the native asset contract. */
const TRANSFER_FUNCTION = 'transfer';

/** One payment, as the payer authorizes it. */
export interface Payment {
  /** The smart account that pays. */
  readonly from: string;
  /** The address that receives, which a payee named in its request. */
  readonly to: string;
  readonly amount: bigint;
  /** The ledger after which the network refuses the signed authorization. */
  readonly expireAt: number;
}

/** The invocation that one payment authorizes. */
export function transferInvocation(
  config: VoucherConfig,
  payment: Payment,
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: contractFn(config.tokenId, TRANSFER_FUNCTION, [
      new Address(payment.from).toScVal(),
      new Address(payment.to).toScVal(),
      nativeToScVal(payment.amount, { type: 'i128' }),
    ]),
    subInvocations: [],
  });
}

/**
 * Build an unsigned authorization entry for one payment.
 *
 * The credentials are `ADDRESS_V2`, which binds the signer's address into the
 * signed preimage. Legacy `ADDRESS` credentials are replayable across
 * addresses, and this path carries a person's own balance rather than a
 * voucher that a contract bounds.
 */
export function buildPaymentEntry(
  config: VoucherConfig,
  payment: Payment,
  nonce: bigint,
): xdr.SorobanAuthorizationEntry {
  if (payment.amount <= 0n) throw new Error('a payment moves more than nothing');
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: new Address(payment.from).toScAddress(),
        nonce: new xdr.Int64(nonce),
        signatureExpirationLedger: payment.expireAt,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: transferInvocation(config, payment),
  });
}

/**
 * Build one payment and sign it.
 *
 * The deadline reaches the signer from `payment.expireAt` and from nowhere
 * else. A caller therefore cannot sign an entry to a ledger that the entry
 * does not carry. That is the voucher path's rule, and it exists because the
 * two values must always be one value.
 */
export async function signPayment(
  config: VoucherConfig,
  payment: Payment,
  nonce: bigint,
  signEntry: SignEntry,
): Promise<xdr.SorobanAuthorizationEntry> {
  return signEntry(buildPaymentEntry(config, payment, nonce), payment.expireAt);
}
