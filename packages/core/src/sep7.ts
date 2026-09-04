import { Keypair } from '@stellar/stellar-sdk';
import { UriFormatError } from './errors.js';

/**
 * SEP-7 `web+stellar:` request URIs: build, sign, verify and parse.
 *
 * A signature proves which domain produced the request. A wallet reads
 * `origin_domain`, fetches that domain's Stellar information file, takes
 * `URI_REQUEST_SIGNING_KEY`, and verifies the signature over the request.
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */

/** Where the Stellar information file sits, relative to the domain root. */
export const STELLAR_TOML_PATH = '/.well-known/stellar.toml';

/** The URI scheme that SEP-7 registers. */
export const SEP7_SCHEME = 'web+stellar:';

/** The prefix that SEP-7 puts in front of a request before it signs it. */
const SEP7_SIGNING_PREFIX = 'stellar.sep.7 - URI Scheme';

/** The query parameter that carries the signature. It is always last. */
const SIGNATURE_PARAM = 'signature';

/** The width of the zero padding in a SEP-7 signature payload, in bytes. */
const SIGNING_PAD_BYTES = 36;

/** The value of the last padding byte, which SEP-7 fixes at 4. */
const SIGNING_PAD_MARKER = 4;

/** The fields of a `pay` request. A request needs the destination only. */
export interface PayUriFields {
  readonly destination: string;
  readonly amount?: string;
  readonly assetCode?: string;
  readonly assetIssuer?: string;
  readonly memo?: string;
  readonly memoType?: string;
  readonly msg?: string;
  readonly originDomain?: string;
}

/** A request split into the text that a signature covers and the signature. */
export interface SignedParts {
  readonly signed: string;
  readonly signature: string;
}

/** What a request carries, read back. */
export interface ParsedUri {
  readonly operation: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * The result of a verification.
 *
 * A wallet must tell a person which of the failures happened, so this reports
 * a reason rather than a boolean.
 */
export type UriVerification =
  | { readonly verified: true; readonly signedText: string }
  | { readonly verified: false; readonly reason: string };

/**
 * The bytes that a SEP-7 signature covers.
 *
 * The payload is 35 zero bytes, then the byte 4, then the prefix joined to the
 * request with no separator. `uri` must already carry `origin_domain`, and it
 * must not carry a signature.
 */
function signaturePayload(uri: string): Buffer {
  const padding = Buffer.alloc(SIGNING_PAD_BYTES);
  padding[SIGNING_PAD_BYTES - 1] = SIGNING_PAD_MARKER;
  return Buffer.concat([padding, Buffer.from(`${SEP7_SIGNING_PREFIX}${uri}`, 'utf8')]);
}

/**
 * Build an unsigned `pay` request.
 *
 * Every value goes through `URLSearchParams`, so a caller passes plain text
 * and escapes nothing itself.
 */
export function buildPayUri(fields: PayUriFields): string {
  if (fields.destination === '') {
    throw new UriFormatError('a pay request needs a destination');
  }
  const params = new URLSearchParams();
  params.set('destination', fields.destination);
  const optional: readonly [string, string | undefined][] = [
    ['amount', fields.amount],
    ['asset_code', fields.assetCode],
    ['asset_issuer', fields.assetIssuer],
    ['memo', fields.memo],
    ['memo_type', fields.memoType],
    ['msg', fields.msg],
    ['origin_domain', fields.originDomain],
  ];
  for (const [name, value] of optional) {
    if (value !== undefined && value !== '') params.set(name, value);
  }
  return `${SEP7_SCHEME}pay?${params.toString()}`;
}

/**
 * Sign a request, and append the signature as the last parameter.
 *
 * SEP-7 puts the signature last so that a wallet recovers the signed text by
 * cutting the request at the signature parameter.
 */
export function signUri(uri: string, signerSecret: string): string {
  if (uri.includes(`&${SIGNATURE_PARAM}=`)) {
    throw new UriFormatError('the request already carries a signature');
  }
  const signature = Keypair.fromSecret(signerSecret).sign(signaturePayload(uri));
  return `${uri}&${SIGNATURE_PARAM}=${encodeURIComponent(signature.toString('base64'))}`;
}

/** Split a signed request, or report nothing when it carries no signature. */
export function splitSignature(uri: string): SignedParts | null {
  const marker = `&${SIGNATURE_PARAM}=`;
  const at = uri.indexOf(marker);
  if (at === -1) return null;
  return {
    signed: uri.slice(0, at),
    signature: decodeURIComponent(uri.slice(at + marker.length)),
  };
}

/** Read the operation and the parameters out of a request. */
export function parseUri(uri: string): ParsedUri {
  if (!uri.startsWith(SEP7_SCHEME)) {
    throw new UriFormatError(`the request does not use the ${SEP7_SCHEME} scheme`);
  }
  const rest = uri.slice(SEP7_SCHEME.length);
  const mark = rest.indexOf('?');
  const operation = mark === -1 ? rest : rest.slice(0, mark);
  const params = new URLSearchParams(mark === -1 ? '' : rest.slice(mark + 1));
  const fields: Record<string, string> = {};
  for (const [name, value] of params) fields[name] = value;
  return { operation, fields };
}

/** Verify a signed request against a domain's request signing key. */
export function verifyUri(uri: string, signingKeyPublic: string | null): UriVerification {
  const parts = splitSignature(uri);
  if (parts === null) {
    return { verified: false, reason: 'the request carries no signature' };
  }
  if (signingKeyPublic === null || signingKeyPublic === '') {
    return { verified: false, reason: 'the domain publishes no request signing key' };
  }
  let matches = false;
  try {
    matches = Keypair.fromPublicKey(signingKeyPublic).verify(
      signaturePayload(parts.signed),
      Buffer.from(parts.signature, 'base64'),
    );
  } catch {
    return { verified: false, reason: 'the signing key is not a valid public key' };
  }
  return matches
    ? { verified: true, signedText: parts.signed }
    : { verified: false, reason: 'the signature does not match the request' };
}

/**
 * Read the request signing key out of a Stellar information file.
 *
 * This reads one known key from a small file that a domain publishes about
 * itself. A whole file parser would be a dependency for one line, so the
 * reader is deliberately narrow: it matches the key at the start of a line,
 * outside any table, under either quoting style.
 */
export function readUriSigningKey(tomlText: string): string | null {
  const found = tomlText.match(/^\s*URI_REQUEST_SIGNING_KEY\s*=\s*["']([A-Z0-9]+)["']/m);
  return found?.[1] ?? null;
}
