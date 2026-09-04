import { Keypair } from '@stellar/stellar-sdk';
import { STELLAR_TOML_PATH, readUriSigningKey } from '@senet/core';

/**
 * The key that signs a payee-presented payment request.
 *
 * A wallet reads `origin_domain` from a request, fetches that domain's Stellar
 * information file, takes `URI_REQUEST_SIGNING_KEY` from it, and checks the
 * signature against that key. Two separate things therefore have to be true,
 * and they fail for different reasons.
 *
 * The first is that this key signed this request. That never decays, and a
 * check of it passes for ever once it passes at all.
 *
 * The second is that the domain publishes this key. **That decays**, because
 * the published file and the signing key live in different places and either
 * one can move. A request can pass every offline check, and still carry the
 * signature of a key that no wallet on earth could find.
 *
 * Only the second one needs guarding, so the service asserts it at start. A
 * service that produces unverifiable requests should not run, and the failure
 * belongs where an operator sees it rather than where a wallet does.
 */

/** What the domain publishes, and what this service holds. */
export interface SigningKeyCheck {
  readonly holds: string;
  readonly published: string | null;
  readonly agree: boolean;
}

/** Read the key that a domain publishes, or nothing when it publishes none. */
export async function fetchPublishedSigningKey(domain: string): Promise<string | null> {
  const response = await fetch(`https://${domain}${STELLAR_TOML_PATH}`);
  if (!response.ok) return null;
  return readUriSigningKey(await response.text());
}

/** Compare the key that this service signs with against the published one. */
export async function checkSigningKey(
  secret: string,
  domain: string,
): Promise<SigningKeyCheck> {
  const holds = Keypair.fromSecret(secret).publicKey();
  const published = await fetchPublishedSigningKey(domain);
  return { holds, published, agree: published !== null && published === holds };
}

/**
 * Refuse to start when the domain publishes another key.
 *
 * The message names both keys, because an operator who reads only that this
 * failed has to go and find the two values that disagree.
 */
export async function assertSigningKeyPublished(secret: string, domain: string): Promise<void> {
  const seen = await checkSigningKey(secret, domain);
  if (seen.agree) return;
  if (seen.published === null) {
    throw new Error(
      `${domain} publishes no URI_REQUEST_SIGNING_KEY, so no wallet can verify a ` +
        `request that this service signs. This service holds ${seen.holds}.`,
    );
  }
  throw new Error(
    `${domain} publishes ${seen.published} and this service signs with ${seen.holds}. ` +
      `Every request that it produced would fail in a wallet, and it would fail ` +
      `nowhere else.`,
  );
}
