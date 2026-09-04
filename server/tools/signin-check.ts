/**
 * Prove that a person who reinstalls the application gets their account back.
 *
 * Removing a web application from a home screen removes its storage with it.
 * The passkey stays in the authenticator, and the account keeps its funds on
 * chain. Only the record of the link between them goes, and until now the
 * application offered no way to rebuild it. A person's only path forward was to
 * make another account and abandon the previous one.
 *
 * The check holds exactly that state. It creates an account, throws away
 * everything that the device stored, and then signs in with the passkey that
 * survived. The account address that comes back must be the same one.
 *
 * The virtual authenticator lives as long as the browser, which is what makes
 * this measurable: the passkey survives the wipe, as it does on a phone.
 *
 *   ENV_FILE=/path/to/.env CHROME_PATH=/path/to/chrome \
 *     npm run signin-check --workspace @senet/server
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from '@stellar/stellar-sdk';
import { launch } from 'puppeteer-core';
import { FeePayer, createApiHandler, loadEnvFile, readConfig } from '../src/index.js';
import { serveApplication } from './serve-build.js';

/** How long the check waits for a step that reaches the network. */
const STEP_TIMEOUT_MS = 150_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', '..', '..', 'app', 'dist');

/** Read a variable that the check cannot run without. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set, and the check needs it`);
  }
  return value;
}

async function main(): Promise<void> {
  loadEnvFile();
  const chromePath = required('CHROME_PATH');
  const config = readConfig();
  const server = new rpc.Server(config.rpcUrl);
  const feePayer = await new FeePayer(config).start();
  const served = await serveApplication(DIST, createApiHandler({ config, feePayer, server }));
  console.log(`origin     ${served.origin}`);

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
    page.on('console', (message) => console.log(`  page: ${message.text()}`));
    page.on('pageerror', (failure: unknown) =>
      console.log(`  page error: ${failure instanceof Error ? failure.message : String(failure)}`),
    );

    await page.goto(served.origin, { waitUntil: 'load' });
    await page.waitForSelector('#account-create', { timeout: STEP_TIMEOUT_MS });
    await page.type('#account-name', 'Senet sign in check');
    await page.click('#account-create');
    await page.waitForSelector('#account-panel .result', { timeout: STEP_TIMEOUT_MS });
    const created = await address(page);
    if (created === null) throw new Error('the account screen showed no address');
    console.log(`created    ${created}`);

    // The person removes the application from the home screen. The storage
    // goes with it, and the passkey stays in the authenticator.
    await page.evaluate(() => window.localStorage.clear());
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#account-signin', { timeout: STEP_TIMEOUT_MS });
    const forgotten = await address(page);
    if (forgotten !== null) {
      throw new Error(`the device still shows an account after the wipe: ${forgotten}`);
    }
    console.log('wiped      the device holds no account, and offers a sign in');

    await page.click('#account-signin');
    await page.waitForSelector('#account-panel .result', { timeout: STEP_TIMEOUT_MS });
    const recovered = await address(page);
    if (recovered === null) {
      const said = await page.evaluate(
        () => document.querySelector('#account-panel .result-advice')?.textContent ?? '',
      );
      throw new Error(`the sign in found no account. The screen said: ${said}`);
    }
    console.log(`signed in  ${recovered}`);

    // A sign in returns the account and no voucher. The screen must say so,
    // because a person who reads nothing assumes that everything came back.
    const notice = await page.evaluate(
      () => document.querySelector('#account-panel .notice')?.textContent ?? '',
    );
    if (!notice.includes('does not have the vouchers')) {
      throw new Error('the screen implies that the sign in restored everything');
    }
    console.log('said       what the sign in gives back, and what it does not');

    if (recovered !== created) {
      throw new Error(`the sign in found ${recovered}, and the account was ${created}`);
    }
    console.log('a person who reinstalls the application gets the same account back');
  } finally {
    await browser.close();
    served.close();
  }
}

/** The account address that the screen shows, when it shows one. */
async function address(page: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['newPage']>>) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#account-panel .detail'));
    const row = rows.find((one) => one.querySelector('.detail-label')?.textContent === 'Address');
    const shown = row?.querySelector('.detail-value');
    if (!(shown instanceof HTMLElement)) return null;
    return shown.dataset['full'] ?? shown.textContent;
  });
}

await main();
