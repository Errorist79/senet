import { Address, xdr } from '@stellar/stellar-sdk';

/**
 * The outcome vocabulary. Every redeem returns exactly one of these values.
 *
 * A caller branches on the value and never on the text beside it.
 * `NONCE_CONSUMED` and `AUTH_EXPIRED` are the two that a merchant must tell
 * apart, because a new signature repairs the second and nothing repairs the
 * first.
 */
export const OUTCOMES = [
  'SUCCESS',
  'NONCE_CONSUMED',
  'AUTH_EXPIRED',
  'BAD_SIGNATURE',
  'PAYER_INSUFFICIENT_BALANCE',
  'CONTRACT_REJECTED',
  'APPLY_FAILED',
  'BAD_SEQUENCE',
  'FEE_PAYER_UNDERFUNDED',
  'NO_CHANNEL_FREE',
  'FEE_ABOVE_CEILING',
  'TIMEOUT',
  'UNKNOWN',
] as const;

/** One outcome of a redeem. */
export type Outcome = (typeof OUTCOMES)[number];

/** Where a redeem stopped. */
export type Stage = 'precheck' | 'simulate' | 'send' | 'poll' | 'apply';

/** One typed error that the host raised, with the contract that emitted it. */
export interface HostError {
  /** The error type, such as `sceAuth` or `sceContract`. */
  readonly type: string;
  /** A code name for most types, and a number for `sceContract`. */
  readonly code: string | number | null;
  /** The contract that emitted the error, when the event names one. */
  readonly contractId: string | null;
}

/** An outcome and the values that the classifier read to reach it. */
export interface Classification {
  readonly outcome: Outcome;
  readonly contractErrorCode: string | number | null;
  readonly errorOrigin: string | null;
}

/** Read a message out of a caught value of unknown type. */
export function errorText(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (typeof caught === 'string') return caught;
  try {
    return JSON.stringify(caught) ?? String(caught);
  } catch {
    return String(caught);
  }
}

/** The code of one typed error, which is a number only for a contract error. */
function errorCode(error: xdr.ScError): string | number | null {
  if (error.switch().name === 'sceContract') return Number(error.contractCode());
  return error.code().name;
}

/**
 * The typed errors that a set of diagnostic events carries, in the order that
 * the host raised them.
 *
 * The host escalates an error outwards, so the last entry is the outermost one
 * and it names the failure. A signature from the wrong key raises an
 * `sceContract` error inside the account contract first, and an `sceAuth`
 * error outside it. A reader that takes the first entry calls that a contract
 * rejection, which is wrong.
 */
export function hostErrors(events: readonly xdr.DiagnosticEvent[] | null): HostError[] {
  const found: HostError[] = [];
  for (const event of events ?? []) {
    try {
      const inner = event.event();
      // The SDK declares an XDR `Hash` as an opaque array, and it hands back a
      // Buffer at run time. `Buffer.isBuffer` is the narrowest check that
      // inspects the value rather than trusting the declaration.
      const contractHash = inner.contractId();
      const contractId = Buffer.isBuffer(contractHash)
        ? Address.contract(contractHash).toString()
        : null;
      for (const topic of inner.body().v0().topics()) {
        if (topic.switch().name !== 'scvError') continue;
        const error = topic.error();
        found.push({ type: error.switch().name, code: errorCode(error), contractId });
      }
    } catch {
      // An event that does not decode carries no typed signal. The fallback on
      // the message text still runs, so this loses nothing.
    }
  }
  return found;
}

/** Read a set of typed errors into one outcome, or nothing when none matches. */
function fromTypedErrors(errors: readonly HostError[], tokenId: string): Classification | null {
  const outermost = errors[errors.length - 1];
  const origin = errors[0];
  if (outermost === undefined || origin === undefined) return null;

  if (outermost.type === 'sceAuth') {
    if (outermost.code === 'scecExistingValue') return classification('NONCE_CONSUMED');
    if (outermost.code === 'scecInvalidInput') return classification('AUTH_EXPIRED');
    if (outermost.code === 'scecInvalidAction') return classification('BAD_SIGNATURE');
  }
  if (outermost.type === 'sceContract') {
    // A contract error code means nothing on its own, because the number
    // belongs to whichever contract produced it. The voucher contract re-raises
    // the code that the token contract produced, so the outermost entry cannot
    // say whose code it is. The first entry names the contract that refused.
    const outcome: Outcome =
      origin.contractId === tokenId ? 'PAYER_INSUFFICIENT_BALANCE' : 'CONTRACT_REJECTED';
    return { outcome, contractErrorCode: outermost.code, errorOrigin: origin.contractId };
  }
  return null;
}

/** An outcome with no contract error beside it. */
function classification(outcome: Outcome): Classification {
  return { outcome, contractErrorCode: null, errorOrigin: null };
}

/**
 * Map one failure to one outcome.
 *
 * The typed host error is the primary signal. The message text is a fallback
 * for the stages that carry no events, such as a rejection at submission.
 */
export function classify(
  text: string,
  events: readonly xdr.DiagnosticEvent[] | null,
  tokenId: string,
): Classification {
  const typed = fromTypedErrors(hostErrors(events), tokenId);
  if (typed !== null) return typed;

  const head = text.split('\n', 1)[0] ?? '';
  const hostError = head.match(/Error\((\w+), ([^)]+)\)/);
  if (hostError !== null) {
    const kind = hostError[1];
    const code = hostError[2] ?? '';
    if (kind === 'Auth') {
      if (code === 'ExistingValue') return classification('NONCE_CONSUMED');
      if (code === 'InvalidInput' && /signature has expired/.test(text)) {
        return classification('AUTH_EXPIRED');
      }
      if (code === 'InvalidAction') return classification('BAD_SIGNATURE');
    }
    if (kind === 'Contract') {
      const contractErrorCode = Number(code.replace('#', ''));
      const outcome: Outcome = /resulting balance is not within the allowed range/.test(text)
        ? 'PAYER_INSUFFICIENT_BALANCE'
        : 'CONTRACT_REJECTED';
      return { outcome, contractErrorCode, errorOrigin: null };
    }
  }
  if (/txBAD_SEQ|txBadSeq|bad sequence/i.test(text)) return classification('BAD_SEQUENCE');
  if (/txINSUFFICIENT_BALANCE|txInsufficientBalance/i.test(text)) {
    return classification('FEE_PAYER_UNDERFUNDED');
  }
  if (/txFAILED|txFailed/.test(text)) return classification('APPLY_FAILED');
  if (/TRY_AGAIN_LATER|tryAgainLater|NOT_FOUND|notFound|timeout|timed out/i.test(text)) {
    return classification('TIMEOUT');
  }
  return classification('UNKNOWN');
}
