/**
 * The failure vocabulary of this library.
 *
 * A consumer branches on a class, never on a message. Each class carries the
 * values that produced the failure, so a caller can report the failure without
 * parsing text.
 */

/** The base class of every error this library raises. */
export class VoucherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The bytes or the entry do not hold a voucher of the expected shape. */
export class VoucherFormatError extends VoucherError {}

/** The payload starts with a version byte this reader does not know. */
export class PayloadVersionError extends VoucherError {
  constructor(
    readonly found: number,
    readonly expected: number,
  ) {
    super(
      `the payload declares version ${found} and this reader accepts version ` +
        `${expected}. Update the reader, or ask the payer for a version ` +
        `${expected} voucher.`,
    );
  }
}

/** The payload names a network other than the configured one. */
export class NetworkMismatchError extends VoucherError {
  constructor(
    readonly found: string,
    readonly expected: string,
    readonly expectedNetwork: string,
  ) {
    super(
      `the payload names network ${found} and this reader is configured for ` +
        `${expected} (${expectedNetwork}). The voucher belongs to another network.`,
    );
  }
}

/**
 * The entry does not carry CAP-71 address-bound credentials.
 *
 * A legacy `ADDRESS` credential signs a preimage that does not name the
 * address which authorizes the call. One signature then serves every address.
 * This error stops a voucher that falls back to the legacy arm.
 */
export class CredentialTypeError extends VoucherError {
  constructor(
    readonly discriminant: number,
    readonly envelopeType: number,
    readonly expectedDiscriminant: number,
    readonly expectedEnvelopeType: number,
  ) {
    super(
      `the entry carries credential discriminant ${discriminant} and envelope ` +
        `type ${envelopeType}, and CAP-71 address binding needs discriminant ` +
        `${expectedDiscriminant} with envelope type ${expectedEnvelopeType}. ` +
        `A signature that is not address bound is replayable across addresses.`,
    );
  }
}

/**
 * The contract argument `expire_at` and the host field
 * `signature_expiration_ledger` hold different numbers.
 *
 * Both fields bound the voucher and the effective lifetime is the smaller of
 * the two. The contract cannot read the host field, so the contract cannot
 * catch the divergence. This error is where it is caught.
 */
export class DeadlineMismatchError extends VoucherError {
  constructor(
    readonly signatureExpirationLedger: number,
    readonly expireAt: number,
  ) {
    super(
      `signature_expiration_ledger is ${signatureExpirationLedger} and expire_at ` +
        `is ${expireAt}. The voucher would live ` +
        `${Math.min(signatureExpirationLedger, expireAt)} ledgers, not the number ` +
        `the payer chose. Both fields must come from one computed value.`,
    );
  }
}

/** The requested lifetime falls outside the window the contract accepts. */
export class ExpiryWindowError extends VoucherError {
  constructor(
    readonly lifetimeLedgers: number,
    readonly maxLifetimeLedgers: number,
  ) {
    super(
      `the voucher asks for ${lifetimeLedgers} ledgers of lifetime and the ` +
        `contract accepts 1 to ${maxLifetimeLedgers}. The contract would refuse ` +
        `the redeem after the payer signed it.`,
    );
  }
}

/** The amount falls outside the window that the contract accepts. */
export class AmountWindowError extends VoucherError {
  constructor(
    readonly amount: bigint,
    readonly maxAmount: bigint,
  ) {
    super(
      `the voucher carries ${amount} stroops and the contract accepts 1 to ` +
        `${maxAmount}. The contract would refuse the redeem after the payer ` +
        `signed it.`,
    );
  }
}

/** The installed `@stellar/stellar-sdk` is not the version this code reads. */
export class SdkVersionError extends VoucherError {
  constructor(
    readonly found: string,
    readonly expectedMajor: number,
    readonly expectedMinorMin: number,
  ) {
    super(
      `@stellar/stellar-sdk ${found} is installed and this code needs ` +
        `${expectedMajor}.${expectedMinorMin} or a later ${expectedMajor}.x. ` +
        `Major ${expectedMajor + 1} changes XDR attribute access from a method ` +
        `to a property, and a minor below ${expectedMinorMin} lacks part of the ` +
        `CAP-71 surface.`,
    );
  }
}
