import { STELLAR_TOML_PATH, parseUri, readUriSigningKey, verifyUri } from '@senet/core';

/**
 * Whether a payee-presented request came from the domain that it names.
 *
 * A wallet reads `origin_domain` from a request, fetches that domain's Stellar
 * information file, takes the published key, and checks the signature. This
 * does the same, and it fetches the domain itself rather than asking our own
 * service what the domain publishes.
 *
 * That difference matters. A screen that asked our service for the key would
 * verify our claim rather than the domain's. It would answer `verified` on a
 * domain that publishes nothing, whenever our service happened to hold the
 * right key. It would then be green in the very case that it exists to catch.
 *
 * Four outcomes, because they need four different sentences and only one of
 * them is good news. Two of them are not failures of the request:
 *
 * - a request that names no domain carries nobody's word, and SEP-7 permits
 *   such a request;
 * - a domain that does not answer leaves the request unjudged.
 *
 * Neither of those is a forgery, and neither may read as one. Neither is a
 * verification either.
 */

/** What a reader can say about one request. */
export type Judgement =
  | { readonly kind: 'signed'; readonly domain: string }
  | { readonly kind: 'unsigned' }
  | { readonly kind: 'refused'; readonly domain: string; readonly reason: string }
  | { readonly kind: 'unjudged'; readonly domain: string; readonly why: string };

/** The fields that a payment request carries. */
export interface RequestDetails {
  readonly operation: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** Read what a request carries. This judges nothing. */
export function readRequest(uri: string): RequestDetails {
  return parseUri(uri);
}

/**
 * Judge one request against the domain that it names.
 *
 * A domain that answers nothing produces `unjudged` and never `refused`. The
 * two look the same to a person who reads only a colour. They call for
 * opposite actions: one means do not pay, and the other means find out more.
 */
export async function judgeRequest(uri: string): Promise<Judgement> {
  const parsed = parseUri(uri);
  const domain = parsed.fields['origin_domain'];
  if (domain === undefined || domain === '') return { kind: 'unsigned' };

  let published: string | null;
  try {
    const response = await fetch(`https://${domain}${STELLAR_TOML_PATH}`);
    if (!response.ok) {
      return { kind: 'unjudged', domain, why: `it answered ${response.status}` };
    }
    published = readUriSigningKey(await response.text());
  } catch {
    // A domain that refuses the request, or that a browser will not let this
    // page read, leaves the signature unchecked. That is not a forgery.
    return { kind: 'unjudged', domain, why: 'this device could not reach it' };
  }
  if (published === null) {
    return { kind: 'unjudged', domain, why: 'it publishes no signing key' };
  }

  const checked = verifyUri(uri, published);
  if (checked.verified) return { kind: 'signed', domain };
  return { kind: 'refused', domain, reason: checked.reason };
}

/** What a person reads for one judgement. */
export interface JudgementText {
  readonly tone: 'good' | 'bad' | 'wait';
  readonly title: string;
  readonly advice: string;
}

/**
 * The words for each outcome.
 *
 * Four states, three colours, and the colour says what to do rather than how
 * unusual the state is. **Amber means check the payment yourself. Red means do
 * not pay.**
 *
 * `signed` is the only green, because the domain vouched for where the money
 * goes. `refused` is the only red, because somebody's word failed. `unsigned`
 * and `unjudged` are both amber, and they ask the same thing of a person by
 * different routes: nobody vouched, so read the details yourself.
 *
 * A colour that says what to do survives. A colour that says how unusual
 * something is decays, because every state can argue that it is unusual.
 *
 * The amber on `unsigned` rests on one assumption: an unsigned request is not
 * the ordinary case. This application always signs, so an unsigned request is
 * one that came from somewhere else and chose not to sign. **A world where
 * most requests carry no signature makes amber the default state, and amber
 * then stops meaning anything. Revisit this choice in such a world.**
 */
export function judgementText(judged: Judgement): JudgementText {
  if (judged.kind === 'signed') {
    return {
      tone: 'good',
      title: `${judged.domain} signed this request`,
      advice: `The domain publishes the key that signed it, so this request came from ${judged.domain}.`,
    };
  }
  if (judged.kind === 'refused') {
    return {
      tone: 'bad',
      title: `${judged.domain} did not sign this request`,
      advice:
        `The request names ${judged.domain}, and that domain's key does not match ` +
        `the signature. Somebody changed the request, or it never came from there. ` +
        `Do not pay it.`,
    };
  }
  if (judged.kind === 'unsigned') {
    return {
      tone: 'wait',
      title: 'Nobody signed this request',
      advice:
        'The request names no domain, so there is nothing to check it against. ' +
        'A request may do that. You are trusting whoever handed it to you.',
    };
  }
  return {
    tone: 'wait',
    title: `This device cannot check ${judged.domain}`,
    advice:
      `The request names ${judged.domain}, and ${judged.why}. The request is ` +
      `neither proved nor disproved. Check the payment details yourself before ` +
      `you pay, or try again with a working network.`,
  };
}
