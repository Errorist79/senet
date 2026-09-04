/**
 * Create a passkey account in a real browser, and record what it produced.
 *
 * The check serves the built application and the service from one origin, and
 * it attaches a virtual authenticator to the browser. Chrome's authenticator
 * runs the same WebAuthn path that a phone runs, so the registration, the
 * deployment and the balance are real; only the fingerprint is not.
 *
 * A relying party is a domain and not an address, and the browser derives it
 * from the origin. This check therefore serves on `localhost`, where the
 * browser derives `localhost`. Only a run against the public name proves the
 * relying party that people really use.
 *
 * `ORIGIN` drives a deployment that already runs, on its own name, which is
 * the only way to prove the real relying party. Without it the check serves
 * the build itself on `localhost`.
 *
 *   ENV_FILE=/path/to/.env CHROME_PATH=/path/to/chrome \
 *     ORIGIN=https://example.test npm run account-check --workspace @senet/server -- out.json
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from '@stellar/stellar-sdk';
import { launch } from 'puppeteer-core';
import { FeePayer, createApiHandler, loadEnvFile, readConfig } from '../src/index.js';
import { serveBuiltApplication } from './serve-build.js';

/** The relying party that a browser accepts on a loopback origin. */
const LOOPBACK_RP_ID = 'localhost';

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

/** Serve the build and the service on one loopback origin, for a local check. */
async function serveLocally(): Promise<{ origin: string; close: () => void }> {
  const config = readConfig();
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`${DIST} holds no build. Run the application build first.`);
  }
  const server = new rpc.Server(config.rpcUrl);
  const feePayer = await new FeePayer(config).start();
  const answer = createApiHandler({ config, feePayer, server });
  const service = createServer((request, response) => {
    if ((request.url ?? '/').startsWith('/api/')) answer(request, response);
    else serveBuiltApplication(DIST, request, response);
  });
  await new Promise<void>((listening) => {
    service.listen(0, '127.0.0.1', listening);
  });
  const address = service.address();
  if (address === null || typeof address === 'string') throw new Error('the service took no port');
  return {
    origin: `http://${LOOPBACK_RP_ID}:${address.port}`,
    close: () => service.close(),
  };
}

async function main(): Promise<void> {
  loadEnvFile();
  const chromePath = required('CHROME_PATH');
  const outPath = process.argv[2] ?? resolve(process.cwd(), 'account-check.json');
  const named = process.env['ORIGIN'];
  const served = named === undefined || named === '' ? await serveLocally() : null;
  const origin = served?.origin ?? named ?? '';
  const service = { close: () => served?.close() };
  console.log(`origin     ${origin}`);

  const browser = await launch({
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    const session = await page.createCDPSession();
    await session.send('WebAuthn.enable');
    // A platform authenticator that holds a resident key and reports the user
    // as verified, which is what a phone's own authenticator reports.
    const { authenticatorId } = await session.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    console.log(`authenticator ${authenticatorId}`);

    page.on('console', (message) => console.log(`  page: ${message.text()}`));
    page.on('pageerror', (failure: unknown) =>
      console.log(`  page error: ${failure instanceof Error ? failure.message : String(failure)}`),
    );
    page.on('requestfailed', (request) =>
      console.log(`  request failed: ${request.url()} ${request.failure()?.errorText ?? ''}`),
    );

    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForSelector('#account-create', { timeout: STEP_TIMEOUT_MS });
    await page.type('#account-name', 'Senet check');
    await page.click('#account-create');
    await page.waitForSelector('#account-panel .result', { timeout: STEP_TIMEOUT_MS });

    const created = await read(page);
    if (created === null) throw new Error('the account screen showed no result');
    if (created.title !== 'Your account') {
      throw new Error(`the account screen said: ${created.title}. ${created.advice}`);
    }
    console.log(`address    ${created.values['Address'] ?? 'none'}`);
    console.log(`deployed   ${created.values['Created by'] ?? 'none'}`);

    // The account starts with nothing, so the check funds it and reads again.
    await page.click('#account-panel .submit-quiet');
    // Wait for an amount above zero. A test that accepts any value except the
    // word `reading` matches the balance from before the funds arrive.
    await page.waitForFunction(
      () => {
        const rows = Array.from(document.querySelectorAll('#account-panel .detail'));
        const row = rows.find((one) => one.querySelector('.detail-label')?.textContent === 'Balance');
        const shown = row?.querySelector('.detail-value')?.textContent ?? '';
        return /^[1-9]/.test(shown) && shown.includes('XLM');
      },
      { timeout: STEP_TIMEOUT_MS },
    );
    const funded = await read(page);
    if (funded === null) throw new Error('the account screen showed no balance');
    console.log(`balance    ${funded.values['Balance'] ?? 'none'}`);

    const record = {
      ranAt: new Date().toISOString(),
      origin,
      relyingParty: new URL(origin).hostname,
      screen: funded,
      note: 'A virtual authenticator ran the WebAuthn ceremony. Everything on chain is real.',
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`record written to ${outPath}`);
  } finally {
    await browser.close();
    service.close();
  }
}

/** What the account panel shows, as a person reads it. */
async function read(page: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['newPage']>>) {
  return page.evaluate(() => {
    const box = document.querySelector('#account-panel .result');
    if (box === null) return null;
    const values: Record<string, string> = {};
    for (const row of Array.from(box.querySelectorAll('.detail'))) {
      const label = row.querySelector('.detail-label')?.textContent ?? '';
      const shown = row.querySelector('.detail-value');
      // A row shows a shortened identifier and keeps the whole one beside it.
      const value =
        shown instanceof HTMLElement ? (shown.dataset['full'] ?? shown.textContent ?? '') : '';
      if (label !== '') values[label] = value;
    }
    return {
      title: box.querySelector('.result-title')?.textContent ?? '',
      advice: box.querySelector('.result-advice')?.textContent ?? '',
      values,
    };
  });
}

await main();
