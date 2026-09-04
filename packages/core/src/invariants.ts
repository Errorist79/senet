import { buildAuthorizationEntryPreimage, xdr } from '@stellar/stellar-sdk';
import {
  AUTH_ENVELOPE_TYPE_WITH_ADDRESS,
  CREDENTIAL_TYPE_ADDRESS_V2,
  EXPECTED_SDK_MAJOR,
  EXPECTED_SDK_MINOR_MIN,
} from './constants.js';
import type { VoucherConfig } from './config.js';
import {
  CredentialTypeError,
  DeadlineMismatchError,
  SdkVersionError,
  VoucherFormatError,
} from './errors.js';

/**
 * Refuse an `@stellar/stellar-sdk` release that this code cannot read.
 *
 * The SDK publishes no version constant, so the caller supplies the version
 * that it installed. The service reads the version from the installed package.
 * The application bundler writes the version in at build time.
 */
export function assertSdkVersion(version: string): string {
  const [major, minor] = version.split('.', 2).map(Number);
  if (
    major !== EXPECTED_SDK_MAJOR ||
    minor === undefined ||
    !Number.isFinite(minor) ||
    minor < EXPECTED_SDK_MINOR_MIN
  ) {
    throw new SdkVersionError(version, EXPECTED_SDK_MAJOR, EXPECTED_SDK_MINOR_MIN);
  }
  return version;
}

/** The discriminant of an entry's credential union. */
export function credentialDiscriminant(entry: xdr.SorobanAuthorizationEntry): number {
  return entry.credentials().switch().value;
}

/**
 * The address credentials of an entry, under either address arm.
 *
 * A voucher always carries address credentials. The source-account arm carries
 * none, so that arm is a format failure and not a missing value.
 */
export function addressCredentials(
  entry: xdr.SorobanAuthorizationEntry,
): xdr.SorobanAddressCredentials {
  const credentials = entry.credentials();
  switch (credentials.switch().value) {
    case xdr.SorobanCredentialsType.sorobanCredentialsAddressV2().value:
      return credentials.addressV2();
    case xdr.SorobanCredentialsType.sorobanCredentialsAddress().value:
      return credentials.address();
    default:
      throw new VoucherFormatError(
        `the entry carries ${credentials.switch().name} credentials, and a ` +
          `voucher needs address credentials that name the payer.`,
      );
  }
}

/**
 * The envelope type of the preimage that this entry's signature covers.
 *
 * The number is the one that the pinned SDK computes. This code does not
 * assume it.
 */
export function authEnvelopeType(
  entry: xdr.SorobanAuthorizationEntry,
  network: string,
): number {
  const validUntilLedgerSeq = addressCredentials(entry).signatureExpirationLedger();
  return buildAuthorizationEntryPreimage(entry, validUntilLedgerSeq, network).switch().value;
}

/**
 * Refuse an entry whose signature is not bound to the payer's address.
 *
 * Legacy `ADDRESS` credentials sign a preimage that omits the address which
 * authorizes the call. One signature then serves every address. The check
 * covers the credential arm and the envelope type, because a future SDK
 * release could keep one and change the other.
 */
export function assertAddressV2(
  config: VoucherConfig,
  entry: xdr.SorobanAuthorizationEntry,
): void {
  const discriminant = credentialDiscriminant(entry);
  const envelopeType = authEnvelopeType(entry, config.network);
  if (
    discriminant !== CREDENTIAL_TYPE_ADDRESS_V2 ||
    envelopeType !== AUTH_ENVELOPE_TYPE_WITH_ADDRESS
  ) {
    throw new CredentialTypeError(
      discriminant,
      envelopeType,
      CREDENTIAL_TYPE_ADDRESS_V2,
      AUTH_ENVELOPE_TYPE_WITH_ADDRESS,
    );
  }
}

/**
 * Refuse an entry whose two deadlines disagree.
 *
 * `expire_at` is a contract argument and `signature_expiration_ledger` is a
 * host field. Both bound the voucher, and the effective lifetime is the
 * smaller of the two. Contract code cannot read the host field. The contract
 * therefore cannot refuse a voucher that the host field truncates.
 */
export function assertDeadlinesAligned(
  entry: xdr.SorobanAuthorizationEntry,
  expireAt: number,
): number {
  const signatureExpirationLedger = addressCredentials(entry).signatureExpirationLedger();
  if (signatureExpirationLedger !== expireAt) {
    throw new DeadlineMismatchError(signatureExpirationLedger, expireAt);
  }
  return signatureExpirationLedger;
}
