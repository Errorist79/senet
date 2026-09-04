import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair } from '@stellar/stellar-sdk';
import { parseUri, verifyUri } from '@senet/core';
import { payeeRoute } from '../src/http/payee.js';

/**
 * The request that this domain produces.
 *
 * Every case verifies against a key rather than against a shape. A request
 * that looks right and carries a signature nobody can check is the fault that
 * this whole task exists to prevent.
 */

const signer = Keypair.random();

/** The two values that the route reads, and nothing else. */
const config = { rpId: 'senet.hoodrun.io', sep7SigningSecret: signer.secret() };

test('the request carries this domain, and its signature checks against the key', () => {
  const reply = payeeRoute(config, { destination: signer.publicKey(), amount: '1.5' });
  const parsed = parseUri(reply.uri);
  assert.equal(parsed.operation, 'pay');
  assert.equal(parsed.fields['origin_domain'], 'senet.hoodrun.io');
  assert.equal(parsed.fields['amount'], '1.5');
  const checked = verifyUri(reply.uri, signer.publicKey());
  assert.equal(checked.verified, true);
});

test('another key does not verify the same request', () => {
  const reply = payeeRoute(config, { destination: signer.publicKey(), amount: '1' });
  const checked = verifyUri(reply.uri, Keypair.random().publicKey());
  assert.equal(checked.verified, false);
});

test('the route refuses an amount that is not a figure, and signs nothing', () => {
  for (const amount of ['', 'lots', '1.12345678', '-1']) {
    assert.throws(() =>
      payeeRoute(config, { destination: signer.publicKey(), amount }),
    );
  }
});
