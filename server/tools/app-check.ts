/**
 * Drive the application in a real browser, and record what it produced.
 *
 * The check serves the built application and the service from one origin. It
 * opens the page in a browser, mints one voucher, pastes it into the merchant
 * screen and presses the button. It then reads the outcome and the hash out of
 * the screen. The record is what a person sees, and not what a script calls.
 *
 *   ENV_FILE=/path/to/.env CHROME_PATH=/path/to/chrome \
 *     npm run app-check --workspace @senet/server -- out.json
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { rpc } from '@stellar/stellar-sdk';
import { LIFETIMES, ed25519Signer, randomNonce, randomVoucherId, signVoucher } from '@senet/core';
import type { Voucher } from '@senet/core';
import { launch } from 'puppeteer-core';
import { FeePayer, createApiHandler, loadEnvFile, readConfig } from '../src/index.js';

/** The amount of the voucher, in stroops. One tenth of an XLM. */
const AMOUNT_STROOPS = 1_000_000n;

/** The lifetime of the voucher. The check finishes long before it passes. */
const LIFETIME_LEDGERS = LIFETIMES['15m'];

/** How long the check waits for the screen to show a result. */
const RESULT_TIMEOUT_MS = 150_000;

/** The files that the built application publishes, and their media types. */
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

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

/**
 * Serve one file out of the built application.
 *
 * The path comes from the browser, so the reader refuses anything that leaves
 * the build directory. A path that names no file becomes the shell, because
 * the application is one page.
 */
function serveFile(request: IncomingMessage, response: ServerResponse): void {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const wanted = path === '/' ? '/index.html' : path;
  const file = resolve(join(DIST, wanted));
  const safe = file.startsWith(`${DIST}/`) && existsSync(file) && statSync(file).isFile();
  // A path that names no file becomes the shell, which is what the web server
  // in front of the real deployment also does.
  const chosen = safe ? file : join(DIST, 'index.html');
  const dot = chosen.lastIndexOf('.');
  response.writeHead(200, {
    'Content-Type': TYPES[chosen.slice(dot)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Service-Worker-Allowed': '/',
  });
  createReadStream(chosen).pipe(response);
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = readConfig();
  const payerSecret = required('PAYER_SECRET');
  const payer = required('PAYER_PUBLIC');
  const recipient = required('RECIPIENT');
  const chromePath = required('CHROME_PATH');
  const outPath = process.argv[2] ?? resolve(process.cwd(), 'app-check.json');
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`${DIST} holds no build. Run the application build first.`);
  }

  const server = new rpc.Server(config.rpcUrl);
  const feePayer = await new FeePayer(config).start();
  // The service answers `/api/`, and everything else is the built application,
  // so the browser reaches both from one origin.
  const answer = createApiHandler({ config, feePayer, server });
  const api = createServer((request, response) => {
    if ((request.url ?? '/').startsWith('/api/')) answer(request, response);
    else serveFile(request, response);
  });
  await new Promise<void>((listening) => {
    api.listen(0, '127.0.0.1', listening);
  });
  const address = api.address();
  if (address === null || typeof address === 'string') throw new Error('the service took no port');
  const origin = `http://127.0.0.1:${address.port}`;

  const latest = await server.getLatestLedger();
  const voucher: Voucher = {
    payer,
    amount: AMOUNT_STROOPS,
    voucherId: randomVoucherId(),
    expireAt: latest.sequence + LIFETIME_LEDGERS,
  };
  const entry = await signVoucher(
    config.voucher,
    voucher,
    randomNonce(),
    ed25519Signer(config.voucher, payerSecret),
  );
  console.log(`origin     ${origin}`);
  console.log(`voucher    ${voucher.voucherId} for ${voucher.amount} stroops`);

  const browser = await launch({
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: 'load' });
    const workerReady = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active !== null;
    });
    await page.type('#merchant-payload', entry.toXDR('base64'));
    await page.type('#merchant-recipient', recipient);
    await page.click('#merchant-submit');
    await page.waitForSelector('.result', { timeout: RESULT_TIMEOUT_MS });

    const shown = await page.evaluate(() => {
      const box = document.querySelector('.result');
      if (box === null) return null;
      const values: Record<string, string> = {};
      for (const row of Array.from(box.querySelectorAll('.detail'))) {
        const label = row.querySelector('.detail-label')?.textContent ?? '';
        const value = row.querySelector('.detail-value')?.textContent ?? '';
        if (label !== '') values[label] = value;
      }
      return {
        title: box.querySelector('.result-title')?.textContent ?? '',
        advice: box.querySelector('.result-advice')?.textContent ?? '',
        tone: box.className,
        values,
      };
    });
    if (shown === null) throw new Error('the screen showed no result');

    const outcome = shown.values['Outcome'] ?? '';
    // The screen shortens a hash for a person to read, and the link carries the
    // whole one. The record keeps the whole hash as its own field, because an
    // archive row must not hide a chain fact inside a URL.
    const explorerUrl = await page.evaluate(() => {
      const link = document.querySelector('.detail-link');
      return link instanceof HTMLAnchorElement ? link.href : null;
    });
    const hash = explorerUrl === null ? null : (explorerUrl.split('/').pop() ?? null);
    const record = {
      ranAt: new Date().toISOString(),
      origin,
      contractId: config.voucher.contractId,
      network: config.voucher.network,
      serviceWorkerActive: workerReady,
      voucherId: voucher.voucherId.toString(),
      amountStroops: voucher.amount.toString(),
      payer,
      recipient,
      transactionHash: hash,
      screen: shown,
      explorerUrl,
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);

    console.log(`worker     ${workerReady ? 'active' : 'not active'}`);
    console.log(`screen     ${shown.title}: ${shown.advice}`);
    console.log(`outcome    ${outcome}`);
    console.log(`hash       ${hash ?? 'none'}`);
    console.log(`record written to ${outPath}`);
    if (outcome !== 'SUCCESS') process.exitCode = 1;
  } finally {
    await browser.close();
    api.close();
  }
}

await main();
