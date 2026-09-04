/**
 * Mint a voucher in a browser, show its code, and void it.
 *
 * The check runs the whole payer path in one browser session, because a
 * passkey lives inside the authenticator that made it. It creates an account
 * and funds it. It then mints a voucher with the passkey, reads the code that
 * the screen drew, voids the voucher, and records the transaction.
 *
 * It also stands as the smoke driver: it loads the built application in a
 * browser and mints.
 *
 *   ENV_FILE=/path/to/.env CHROME_PATH=/path/to/chrome \
 *     npm run payer-check --workspace @senet/server -- out.json
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from '@stellar/stellar-sdk';
import { launch } from 'puppeteer-core';
import type { Page } from 'puppeteer-core';
import { FeePayer, createApiHandler, loadEnvFile, readConfig } from '../src/index.js';
import { serveBuiltApplication } from './serve-build.js';

/** The amount that the check mints, in XLM, as a person types it. */
const AMOUNT_XLM = '0.1';

/** How long the check waits for a step that reaches the network. */
const STEP_TIMEOUT_MS = 150_000;

/**
 * A phone viewport, in CSS pixels.
 *
 * The session happens on phones. The check therefore measures a screen that a
 * person holds, and not a window that happens to be wide enough.
 */
const PHONE_WIDTH = 390;
const PHONE_HEIGHT = 844;

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

/** What a panel shows, as a person reads it. */
interface PanelText {
  readonly title: string;
  readonly advice: string;
  readonly values: Record<string, string>;
}

/** Read one result panel. */
async function readPanel(page: Page, panelId: string): Promise<PanelText | null> {
  return page.evaluate((id: string) => {
    const box = document.querySelector(`#${id} .result`);
    if (box === null) return null;
    const values: Record<string, string> = {};
    for (const row of Array.from(box.querySelectorAll('.detail'))) {
      const label = row.querySelector('.detail-label')?.textContent ?? '';
      const shown = row.querySelector('.detail-value');
      const value =
        shown instanceof HTMLElement ? (shown.dataset['full'] ?? shown.textContent ?? '') : '';
      if (label !== '') values[label] = value;
    }
    return {
      title: box.querySelector('.result-title')?.textContent ?? '',
      advice: box.querySelector('.result-advice')?.textContent ?? '',
      values,
    };
  }, panelId);
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = readConfig();
  const chromePath = required('CHROME_PATH');
  const outPath = process.argv[2] ?? resolve(process.cwd(), 'payer-check.json');
  const shots = process.env['SCREENSHOT_DIR'] ?? dirname(outPath);
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
  const origin = `http://localhost:${address.port}`;
  console.log(`origin     ${origin}`);

  mkdirSync(shots, { recursive: true });
  const browser = await launch({
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: PHONE_WIDTH, height: PHONE_HEIGHT, deviceScaleFactor: 2 });
    page.on('pageerror', (failure: unknown) =>
      console.log(`  page error: ${failure instanceof Error ? failure.message : String(failure)}`),
    );
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

    // One account, funded, so the payer holds something to spend.
    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForSelector('#account-create', { timeout: STEP_TIMEOUT_MS });
    await page.click('#account-create');
    await page.waitForSelector('#account-panel .result-good', { timeout: STEP_TIMEOUT_MS });
    await page.click('#account-panel .submit-quiet');
    await page.waitForFunction(
      () => {
        const rows = Array.from(document.querySelectorAll('#account-panel .detail'));
        const row = rows.find((one) => one.querySelector('.detail-label')?.textContent === 'Balance');
        return /^[1-9]/.test(row?.querySelector('.detail-value')?.textContent ?? '');
      },
      { timeout: STEP_TIMEOUT_MS },
    );
    const account = await readPanel(page, 'account-panel');
    if (account === null) throw new Error('the account screen showed nothing');
    console.log(`account    ${account.values['Address'] ?? 'none'}`);
    await page.screenshot({ path: join(shots, 'payer-1-account.png') });

    // The mint itself, which makes no network call.
    await page.click('#nav-payer');
    await page.waitForSelector('#payer-mint', { timeout: STEP_TIMEOUT_MS });
    await page.type('#payer-amount', AMOUNT_XLM);
    await page.click('#payer-mint');
    await page.waitForSelector('#payer-panel .result-good', { timeout: STEP_TIMEOUT_MS });
    const minted = await readPanel(page, 'payer-panel');
    if (minted === null) throw new Error('the payer screen showed no voucher');
    // The size line is what a person photographs. The check reads that same
    // text, rather than a detail row that only a machine would open.
    const codeSize = await page.evaluate(
      () => document.querySelector('#payer-panel .code-size')?.textContent ?? '',
    );
    console.log(`minted     ${minted.title}, ${codeSize === '' ? 'no size shown' : codeSize}`);
    await page.evaluate(() => {
      document.querySelector('#payer-panel .result')?.scrollIntoView({ block: 'start' });
    });
    await page.screenshot({ path: join(shots, 'payer-2-code.png') });

    // The session photographs three things at once: the size line, the level
    // control and the code. A photograph carries them together only when they
    // span no more than one screen. A picture revealed the fault that put the
    // size line out of frame. Nothing else would catch it coming back, so this
    // states the rule as a measurement.
    const layout = await page.evaluate(() => {
      const boxes: DOMRect[] = [];
      for (const selector of ['.code-size', '.levels', 'canvas.code']) {
        const found = document.querySelector(`#payer-panel ${selector}`);
        if (found === null) return null;
        boxes.push(found.getBoundingClientRect());
      }
      return {
        spanPx: Math.round(Math.max(...boxes.map((b) => b.bottom)) - Math.min(...boxes.map((b) => b.top))),
        widestPx: Math.round(Math.max(...boxes.map((b) => b.right))),
        viewportHeightPx: window.innerHeight,
        viewportWidthPx: window.innerWidth,
        scrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    if (layout === null) throw new Error('the code, its size line or its control is missing');
    console.log(
      `layout     ${layout.spanPx} of ${layout.viewportHeightPx} tall, widest ${layout.widestPx} of ${layout.viewportWidthPx}`,
    );
    if (layout.spanPx > layout.viewportHeightPx) {
      throw new Error(
        `the size line, the control and the code span ${layout.spanPx} pixels on a ` +
          `${layout.viewportHeightPx} pixel screen, so one photograph cannot carry all three`,
      );
    }
    if (layout.scrollsSideways) throw new Error('the page scrolls sideways on a phone');

    // The session compares the two error correction levels, so the check draws
    // both and records what each one shows.
    const levels: Record<string, string> = { M: codeSize };
    const others = await page.$$('#payer-panel .levels-button');
    for (const button of others) {
      const label = await button.evaluate((one) => one.textContent ?? '');
      if (label !== 'Level L') continue;
      await button.click();
      const shown = await page.evaluate(
        () => document.querySelector('#payer-panel .code-size')?.textContent ?? '',
      );
      levels['L'] = shown;
      console.log(`level L    ${shown}`);
      await page.evaluate(() => {
        document.querySelector('#payer-panel .result')?.scrollIntoView({ block: 'start' });
      });
      await page.screenshot({ path: join(shots, 'payer-2-code-level-l.png') });
    }
    // The voucher goes back to the level that the product ships.
    for (const button of await page.$$('#payer-panel .levels-button')) {
      const label = await button.evaluate((one) => one.textContent ?? '');
      if (label === 'Level M') await button.click();
    }

    // The void, which pays the voucher back to the payer's own account.
    await page.click('#payer-list .link-button:last-of-type');
    await page.waitForSelector('#payer-panel .result-good, #payer-panel .result-bad', {
      timeout: STEP_TIMEOUT_MS,
    });
    const voided = await readPanel(page, 'payer-panel');
    if (voided === null) throw new Error('the payer screen showed no result');
    const outcome = voided.values['Outcome'] ?? '';
    const hash = voided.values['Transaction'] ?? null;
    console.log(`void       ${voided.title}, ${outcome}`);
    console.log(`hash       ${hash ?? 'none'}`);
    await page.screenshot({ path: join(shots, 'payer-3-void.png') });

    const record = {
      ranAt: new Date().toISOString(),
      origin,
      contractId: config.voucher.contractId,
      network: config.voucher.network,
      amountXlm: AMOUNT_XLM,
      account: account.values['Address'] ?? null,
      minted,
      codeSize,
      levels,
      layout,
      voided,
      transactionHash: hash,
      screenshots: [
        'payer-1-account.png',
        'payer-2-code.png',
        'payer-2-code-level-l.png',
        'payer-3-void.png',
      ],
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`record written to ${outPath}`);
    if (outcome !== 'SUCCESS') process.exitCode = 1;
  } finally {
    await browser.close();
    service.close();
  }
}

await main();
