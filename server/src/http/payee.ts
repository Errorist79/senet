import { buildPayUri, signUri } from '@senet/core';
import type { ServerConfig } from '../config.js';
import { badRequest, requireString } from './transport.js';

/**
 * The payee-presented payment request.
 *
 * A payee names the payment that they want, and this signs the request so that
 * a wallet can tell it came from this domain. The payer's wallet reads
 * `origin_domain`, fetches that domain's Stellar information file, and checks
 * the signature against the key that the file publishes.
 *
 * The signing key never leaves the service. A request is the artefact rather
 * than a claim about one, so whatever signs has to hold the key.
 */

/** One signed request, and the domain that a wallet will ask about it. */
export interface PayeeReply {
  readonly uri: string;
  readonly originDomain: string;
}

/**
 * Build and sign one payee-presented request.
 *
 * The route takes the two configuration values that it reads. It does not take
 * the whole context. A function that states what it needs is a function that a
 * test calls directly. It needs no fee-payer and no network client.
 */
export function payeeRoute(
  config: Pick<ServerConfig, 'rpId' | 'sep7SigningSecret'>,
  body: Record<string, unknown>,
): PayeeReply {
  const destination = requireString(body, 'destination');
  const amount = requireString(body, 'amount');
  if (!/^[0-9]+(\.[0-9]{1,7})?$/.test(amount)) {
    throw badRequest('BAD_AMOUNT', 'amount is an XLM figure with up to seven decimal places');
  }
  const message = typeof body['msg'] === 'string' ? body['msg'] : undefined;

  // The origin domain is the relying party, and one constant names both. One
  // host serves the application, the passkey and the published file, so the
  // three names are one name. A deployment that splits them must split this
  // too. A second constant here would be a second definition of one value,
  // and it would be free to drift from the first.
  const originDomain = config.rpId;

  const uri = buildPayUri(
    message === undefined
      ? { destination, amount, originDomain }
      : { destination, amount, originDomain, msg: message },
  );
  return { uri: signUri(uri, config.sep7SigningSecret), originDomain };
}
