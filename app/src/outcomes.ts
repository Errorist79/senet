/**
 * What each outcome means to a merchant, in one sentence.
 *
 * The service names the outcome, and this file says what a person does about
 * it. The two lists must hold the same names. An outcome that this file does
 * not know reads as an unknown outcome, and never as a blank screen.
 */

/** How the screen colours one outcome. */
export type Tone = 'good' | 'bad' | 'wait';

/** What a merchant reads for one outcome. */
export interface OutcomeText {
  readonly tone: Tone;
  readonly title: string;
  readonly advice: string;
}

const TEXTS: Readonly<Record<string, OutcomeText>> = {
  SUCCESS: {
    tone: 'good',
    title: 'Paid',
    advice: 'The ledger holds the payment. Give the goods to the payer.',
  },
  NONCE_CONSUMED: {
    tone: 'bad',
    title: 'Already spent',
    advice: 'Somebody redeemed this voucher before. Ask the payer for a new one.',
  },
  AUTH_EXPIRED: {
    tone: 'bad',
    title: 'Expired',
    advice: 'The voucher passed its deadline. Ask the payer to sign a new one.',
  },
  BAD_SIGNATURE: {
    tone: 'bad',
    title: 'Wrong signature',
    advice: 'The signature does not match the payer. Do not accept this voucher.',
  },
  PAYER_INSUFFICIENT_BALANCE: {
    tone: 'bad',
    title: 'Payer is short',
    advice: 'The payer does not hold the amount. Ask for another way to pay.',
  },
  CONTRACT_REJECTED: {
    tone: 'bad',
    title: 'Refused on chain',
    advice: 'The contract refused this voucher. Ask the payer for a new one.',
  },
  APPLY_FAILED: {
    tone: 'bad',
    title: 'Refused by the ledger',
    advice: 'The ledger refused the payment. Try again, or ask for a new voucher.',
  },
  BAD_SEQUENCE: {
    tone: 'bad',
    title: 'Refused by the ledger',
    advice: 'The payment did not reach a ledger. Try again.',
  },
  FEE_PAYER_UNDERFUNDED: {
    tone: 'bad',
    title: 'Service cannot pay the fee',
    advice: 'The service ran out of funds. Tell the operator.',
  },
  NO_CHANNEL_FREE: {
    tone: 'wait',
    title: 'Service is busy',
    advice: 'Every channel is in use. Try again in a few seconds.',
  },
  FEE_ABOVE_CEILING: {
    tone: 'bad',
    title: 'Refused, the fee is too high',
    advice: 'This voucher asks for more resources than a payment needs.',
  },
  TIMEOUT: {
    tone: 'wait',
    title: 'No answer yet',
    advice: 'The payment may still reach a ledger. Check the hash before you try again.',
  },
  UNKNOWN: {
    tone: 'bad',
    title: 'Unknown result',
    advice: 'The service could not name this failure. Tell the operator.',
  },
};

/** The text for one outcome, and a safe text for a name that this build lacks. */
export function outcomeText(outcome: string): OutcomeText {
  return (
    TEXTS[outcome] ?? {
      tone: 'bad',
      title: 'Unknown result',
      advice: `The service answered ${outcome}, which this version does not know.`,
    }
  );
}
