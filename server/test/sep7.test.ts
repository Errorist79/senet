import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair } from '@stellar/stellar-sdk';
import { RP_ID } from '../src/config.js';
import { assertSigningKeyPublished, checkSigningKey } from '../src/sep7.js';

/**
 * The boundary between what this service signs with and what the domain says.
 *
 * A case that begins from agreement proves nothing. A check that always agreed
 * would pass such a case. Every case here therefore begins from a
 * disagreement, and each one names what disagrees.
 */

test('a key that the domain does not publish refuses the service', async () => {
  const stranger = Keypair.random().secret();
  const seen = await checkSigningKey(stranger, RP_ID);
  assert.equal(seen.agree, false);
  await assert.rejects(
    () => assertSigningKeyPublished(stranger, RP_ID),
    (caught: unknown) => {
      const message = caught instanceof Error ? caught.message : '';
      // The message must name both keys. An operator who reads only that this
      // failed then has to go and find the two values that disagree.
      assert.ok(message.includes(Keypair.fromSecret(stranger).publicKey()));
      assert.ok(message.includes(seen.published ?? 'nothing'));
      return true;
    },
  );
});

test('a domain that publishes nothing refuses the service, and says so', async () => {
  const stranger = Keypair.random().secret();
  await assert.rejects(
    () => assertSigningKeyPublished(stranger, 'example.com'),
    (caught: unknown) => {
      const message = caught instanceof Error ? caught.message : '';
      assert.ok(message.includes('publishes no URI_REQUEST_SIGNING_KEY'));
      return true;
    },
  );
});
