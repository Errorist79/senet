/**
 * Judge real requests in a browser, against the live domain.
 *
 * The screen fetches the origin domain's file itself, so this check must use
 * the real domain rather than a fixture. A fixture would prove that the
 * signature arithmetic works, which never decays, and would say nothing about
 * the half that does: whether the domain still publishes the key that signs.
 *
 * Four of the five states run here. The fifth, a request that names no
 * domain, needs no network and a unit test covers it.
 *
 * The screen judges the network of a request against the network that the
 * service reports. The page therefore runs with the service on its own origin.
 *
 *   ENV_FILE=/path/to/.env CHROME_PATH=/path/to/chrome \
 *     npm run payee-check --workspace @senet/server
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from '@stellar/stellar-sdk';
import { launch } from 'puppeteer-core';
import { FeePayer, createApiHandler, loadEnvFile, payeeRoute, readConfig } from '../src/index.js';
import { serveApplication } from './serve-build.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', '..', '..', 'app', 'dist');
const STEP_TIMEOUT_MS = 60_000;

/** A funded testnet address, which is only ever the destination here. */
const DESTINATION = 'GC45NTB4OWWPE5FTJ5DI3IHLLGVNB3VCGFANCFAHKFVIVRK6C2PHLSSZ';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  loadEnvFile();
  const chromePath = required('CHROME_PATH');
  const config = readConfig();

  const signed = payeeRoute(config, { destination: DESTINATION, amount: '1.5' });
  // The same request with one character of the amount changed. The signature
  // still covers the original, so the domain's key refuses this one.
  const tampered = signed.uri.replace('amount=1.5', 'amount=9.5');
  // A domain that publishes no such file leaves the request unjudged.
  const elsewhere = signed.uri.replace(
    `origin_domain=${config.rpId}`,
    'origin_domain=example.com',
  );
  // The same request without its network. SEP-7 reads that as the public
  // network, so the screen refuses it before it checks the signature.
  const unnamed = signed.uri.replace(/&network_passphrase=[^&]*/, '');

  const feePayer = await new FeePayer(config).start();
  const server = new rpc.Server(config.rpcUrl);
  const served = await serveApplication(DIST, createApiHandler({ config, feePayer, server }));
  const origin = served.origin;
  console.log(`origin     ${origin}`);
  console.log(`domain     ${config.rpId}`);

  const browser = await launch({
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (failure: unknown) =>
      console.log(`  page error: ${failure instanceof Error ? failure.message : String(failure)}`),
    );
    await page.goto(`${origin}#payee`, { waitUntil: 'load' });

    /** Paste one request, and read what the screen says about it. */
    async function judge(uri: string): Promise<{ tone: string; title: string }> {
      await page.evaluate((value: string) => {
        const details = document.querySelector('#screen-payee details');
        if (details instanceof HTMLDetailsElement) details.open = true;
        const field = document.getElementById('payee-uri');
        if (!(field instanceof HTMLTextAreaElement)) throw new Error('no request field');
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const panel = document.getElementById('payee-read-panel');
        if (panel !== null) panel.replaceChildren();
      }, uri);
      // The form holds the scan button as well, so this names the paste button.
      await page.click('#payee-read-form details .submit');
      await page.waitForSelector('#payee-read-panel .result', { timeout: STEP_TIMEOUT_MS });
      return page.evaluate(() => {
        const box = document.querySelector('#payee-read-panel .result');
        const tone = (box?.className ?? '').replace('result ', '');
        return { tone, title: box?.querySelector('.result-title')?.textContent ?? '' };
      });
    }

    const good = await judge(signed.uri);
    console.log(`signed     ${good.tone}  ${good.title}`);
    if (good.tone !== 'result-good' || !good.title.includes(config.rpId)) {
      throw new Error(`the screen said ${good.title} about a request this domain signed`);
    }

    const bad = await judge(tampered);
    console.log(`tampered   ${bad.tone}  ${bad.title}`);
    if (bad.tone !== 'result-bad') {
      throw new Error(`the screen said ${bad.title} about a changed request`);
    }

    const unknown = await judge(elsewhere);
    console.log(`elsewhere  ${unknown.tone}  ${unknown.title}`);
    if (unknown.tone !== 'result-wait') {
      throw new Error(`the screen said ${unknown.title} about a domain it cannot reach`);
    }
    if (unknown.title.toLowerCase().includes('did not sign')) {
      throw new Error('the screen called an unreachable domain a forgery');
    }

    if (unnamed === signed.uri) throw new Error('the signed request carries no network to remove');
    const noNetwork = await judge(unnamed);
    console.log(`no network ${noNetwork.tone}  ${noNetwork.title}`);
    if (noNetwork.tone !== 'result-bad' || !noNetwork.title.includes('public Stellar network')) {
      throw new Error(`the screen said ${noNetwork.title} about a request with no network`);
    }
    console.log('the screen judges a request the way a wallet does');
  } finally {
    await browser.close();
    served.close();
  }
}

await main();
