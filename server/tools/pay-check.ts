/**
 * Pay a payee-presented request end to end, and record the hash.
 *
 * A person creates a passkey account. The service signs a request that names a
 * destination. The screen judges that request against the live domain, and the
 * passkey authorizes the payment. The fee-payer submits it.
 *
 * **This proves the path for one shape of signature: the one that Chrome's
 * virtual authenticator produces.** A real phone's passkey signs a larger
 * assertion, which the camera work established. A payment entry is also not a
 * voucher entry. This check speaks for neither difference. The two-phone
 * session answers both.
 *
 *   ENV_FILE=/path/to/.env CHROME_PATH=/path/to/chrome \
 *     npm run pay-check --workspace @senet/server -- out.json
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from '@stellar/stellar-sdk';
import { launch } from 'puppeteer-core';
import {
  FeePayer,
  createApiHandler,
  loadEnvFile,
  payeeRoute,
  readConfig,
} from '../src/index.js';
import { serveApplication } from './serve-build.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', '..', '..', 'app', 'dist');
const STEP_TIMEOUT_MS = 150_000;

/** The amount that the request asks for, small enough to repeat cheaply. */
const AMOUNT_XLM = '0.5';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  loadEnvFile();
  const chromePath = required('CHROME_PATH');
  const merchant = required('MERCHANT_ADDRESS');
  const outPath = process.argv[2] ?? resolve(process.cwd(), 'pay-check.json');
  const config = readConfig();
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`${DIST} holds no build. Run the application build first.`);
  }

  const server = new rpc.Server(config.rpcUrl);
  const feePayer = await new FeePayer(config).start();
  const served = await serveApplication(DIST, createApiHandler({ config, feePayer, server }));
  console.log(`origin     ${served.origin}`);

  // A real signed request, from the service that holds the published key.
  const request = payeeRoute(config, { destination: merchant, amount: AMOUNT_XLM });
  console.log(`request    signed by ${request.originDomain}`);

  const browser = await launch({
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    const session = await page.createCDPSession();
    await session.send('WebAuthn.enable');
    await session.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    page.on('pageerror', (failure: unknown) =>
      console.log(`  page error: ${failure instanceof Error ? failure.message : String(failure)}`),
    );

    // The payer needs an account and a balance before it can pay anything.
    await page.goto(served.origin, { waitUntil: 'load' });
    await page.waitForSelector('#account-create', { timeout: STEP_TIMEOUT_MS });
    await page.type('#account-name', 'Senet pay check');
    await page.click('#account-create');
    await page.waitForSelector('#account-panel .result', { timeout: STEP_TIMEOUT_MS });
    await page.click('#account-panel .submit-quiet');
    await page.waitForFunction(
      () => {
        const rows = Array.from(document.querySelectorAll('#account-panel .detail'));
        const row = rows.find((one) => one.querySelector('.detail-label')?.textContent === 'Balance');
        const shown = row?.querySelector('.detail-value')?.textContent ?? '';
        return /^[1-9]/.test(shown) && shown.includes('XLM');
      },
      { timeout: STEP_TIMEOUT_MS },
    );
    const payer = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#account-panel .detail'));
      const row = rows.find((one) => one.querySelector('.detail-label')?.textContent === 'Address');
      const value = row?.querySelector('.detail-value');
      return value instanceof HTMLElement ? (value.dataset['full'] ?? '') : '';
    });
    console.log(`payer      ${payer}`);

    // The payee screen judges the request, then pays it.
    await page.click('#nav-payee');
    await page.evaluate((uri: string) => {
      const details = document.querySelector('#screen-payee details');
      if (details instanceof HTMLDetailsElement) details.open = true;
      const field = document.getElementById('payee-uri');
      if (!(field instanceof HTMLTextAreaElement)) throw new Error('no request field');
      field.value = uri;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }, request.uri);
    await page.click('#payee-read-form .submit');
    await page.waitForSelector('#payee-read-panel .result', { timeout: STEP_TIMEOUT_MS });
    const judged = await page.evaluate(
      () => document.querySelector('#payee-read-panel .result-title')?.textContent ?? '',
    );
    console.log(`judged     ${judged}`);
    if (!judged.includes(request.originDomain)) {
      throw new Error(`the screen said ${judged} about a request this domain signed`);
    }

    await page.click('#payee-read-panel .submit');
    // The judgement panel already carries a tone, so waiting for one matches
    // at once and proves nothing. The payment writes an Outcome row, and only
    // the payment writes it.
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('#payee-read-panel .detail')).some(
          (one) => one.querySelector('.detail-label')?.textContent === 'Outcome',
        ),
      { timeout: STEP_TIMEOUT_MS },
    );
    const paid = await page.evaluate(() => {
      const box = document.querySelector('#payee-read-panel .result');
      const rows = Array.from(box?.querySelectorAll('.detail') ?? []);
      const value = (label: string): string => {
        const row = rows.find((one) => one.querySelector('.detail-label')?.textContent === label);
        const shown = row?.querySelector('.detail-value');
        return shown instanceof HTMLElement ? (shown.dataset['full'] ?? shown.textContent ?? '') : '';
      };
      return {
        title: box?.querySelector('.result-title')?.textContent ?? '',
        outcome: value('Outcome'),
        hash: value('Transaction'),
      };
    });
    console.log(`outcome    ${paid.outcome}`);
    console.log(`hash       ${paid.hash || 'none'}`);
    if (paid.outcome !== 'SUCCESS' || paid.hash === '') {
      throw new Error(`the payment answered ${paid.outcome || paid.title}`);
    }

    const record = {
      ranAt: new Date().toISOString(),
      origin: served.origin,
      originDomain: request.originDomain,
      network: config.voucher.network,
      tokenId: config.voucher.tokenId,
      requestUri: request.uri,
      payer,
      recipient: merchant,
      amountXlm: AMOUNT_XLM,
      transactionHash: paid.hash,
      signedBy: 'a virtual authenticator, which signs a smaller assertion than a phone',
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`record written to ${outPath}`);
    console.log('the smart account paid a request that this screen judged');
  } finally {
    await browser.close();
    served.close();
  }
}

await main();
