/**
 * Scan a voucher with the camera, and take the payment.
 *
 * The check mints one voucher, draws its code into a video file, and starts a
 * browser whose camera reads that file. The merchant screen then does what a
 * merchant does: it opens the camera, reads the code, shows what the voucher
 * is worth, and takes the payment.
 *
 * A check that pasted the bytes would prove everything except the part that a
 * merchant uses, so this one goes through the camera.
 *
 *   ENV_FILE=/path/to/.env CHROME_PATH=/path/to/chrome \
 *     npm run scan-check --workspace @senet/server -- out.json
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import {
  LIFETIMES,
  MIN_REMAINING_LEDGERS,
  ed25519Signer,
  encodeVoucher,
  randomNonce,
  randomVoucherId,
  signVoucher,
} from '@senet/core';
import type { Voucher } from '@senet/core';
import { launch } from 'puppeteer-core';
import { FeePayer, createApiHandler, loadEnvFile, readConfig } from '../src/index.js';
import { describeSymbol, writeSymbolVideo } from './fake-camera.js';
import { serveBuiltApplication } from './serve-build.js';

/** The amount of the voucher, in stroops. One tenth of an XLM. */
const AMOUNT_STROOPS = 1_000_000n;

/** The lifetime of the voucher. The check finishes long before it passes. */
const LIFETIME_LEDGERS = LIFETIMES['15m'];

/**
 * The lifetime of the voucher that the screen must refuse.
 *
 * A merchant needs `MIN_REMAINING_LEDGERS` of life to survive the simulation
 * and the submission. This is below that, so the screen refuses it at the scan
 * rather than taking a voucher that expires during the payment.
 */
const TOO_SHORT_LEDGERS = MIN_REMAINING_LEDGERS - 1;

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
  const config = readConfig();
  const payerSecret = required('PAYER_SECRET');
  const merchant = required('MERCHANT_ADDRESS');
  const chromePath = required('CHROME_PATH');
  const outPath = process.argv[2] ?? resolve(process.cwd(), 'scan-check.json');
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

  // The payer signs with an ed25519 key here. A passkey payer produces a
  // larger entry, and the library test holds the code version for that size.
  const latest = await server.getLatestLedger();
  const voucher: Voucher = {
    payer: Keypair.fromSecret(payerSecret).publicKey(),
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
  const payload = encodeVoucher(config.voucher, entry);
  const drawn = describeSymbol(payload);

  console.log(`origin     ${origin}`);
  console.log(`voucher    ${voucher.voucherId} for ${voucher.amount} stroops`);
  console.log(`payload    ${payload.length} bytes, code version ${drawn.version}`);

  const refusedVoucher: Voucher = {
    payer: voucher.payer,
    amount: AMOUNT_STROOPS,
    voucherId: randomVoucherId(),
    expireAt: latest.sequence + TOO_SHORT_LEDGERS,
  };
  const refusedPayload = encodeVoucher(
    config.voucher,
    await signVoucher(
      config.voucher,
      refusedVoucher,
      randomNonce(),
      ed25519Signer(config.voucher, payerSecret),
    ),
  );

  try {
    // A voucher with too little life left never reaches the service.
    const refused = await scanOnce(chromePath, origin, merchant, refusedPayload, false);
    console.log(`refused    ${refused.title}: ${refused.values['Reason'] ?? 'none'}`);
    if (refused.values['Reason'] !== 'RemainingLifeError') {
      throw new Error(`the screen refused for ${refused.values['Reason'] ?? 'no reason'}`);
    }

    const paid = await scanOnce(chromePath, origin, merchant, payload, true);
    const outcome = paid.values['Outcome'] ?? '';
    const hash = paid.values['Transaction'] ?? null;
    console.log(`outcome    ${outcome}`);
    console.log(`hash       ${hash ?? 'none'}`);

    const record = {
      ranAt: new Date().toISOString(),
      origin,
      contractId: config.voucher.contractId,
      network: config.voucher.network,
      voucherId: voucher.voucherId.toString(),
      amountStroops: voucher.amount.toString(),
      payloadBytes: payload.length,
      codeVersion: drawn.version,
      scannedByCamera: true,
      refusedVoucherId: refusedVoucher.voucherId.toString(),
      refusedLifetimeLedgers: TOO_SHORT_LEDGERS,
      refused,
      paid,
      transactionHash: hash,
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`record written to ${outPath}`);
    if (outcome !== 'SUCCESS') process.exitCode = 1;
  } finally {
    service.close();
  }
}

/**
 * Scan one code in a fresh browser, and give back what the screen showed.
 *
 * The browser takes its camera file when it starts, so one voucher needs one
 * browser. `take` says whether the check presses the button that pays.
 */
async function scanOnce(
  chromePath: string,
  origin: string,
  merchant: string,
  payload: Uint8Array,
  take: boolean,
): Promise<PanelText> {
  const videoPath = join(tmpdir(), `senet-voucher-${payload.length}-${Date.now()}.y4m`);
  writeSymbolVideo(videoPath, payload);
  const browser = await launch({
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // The camera reads the file instead of a device, and the page never has
      // to ask a person for permission.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${videoPath}`,
    ],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (failure: unknown) =>
      console.log(`  page error: ${failure instanceof Error ? failure.message : String(failure)}`),
    );
    await page.goto(`${origin}#merchant`, { waitUntil: 'load' });
    await page.waitForSelector('#merchant-scan', { timeout: STEP_TIMEOUT_MS });
    await page.type('#merchant-recipient', merchant);
    await page.click('#merchant-scan');
    await page.waitForSelector('#merchant-result .result', { timeout: STEP_TIMEOUT_MS });

    if (take) {
      const offered = await readPanel(page);
      if (offered === null) throw new Error('the screen showed no voucher');
      console.log(`scanned    ${offered.title}, ${offered.advice}`);
      await page.click('#merchant-result .submit');
      await page.waitForSelector('#merchant-result .result-good, #merchant-result .result-bad', {
        timeout: STEP_TIMEOUT_MS,
      });
    }
    const shown = await readPanel(page);
    if (shown === null) throw new Error('the screen showed nothing');
    return shown;
  } finally {
    await browser.close();
    rmSync(videoPath, { force: true });
  }
}

/** What a panel shows, as a person reads it. */
interface PanelText {
  readonly title: string;
  readonly advice: string;
  readonly values: Record<string, string>;
}

/** What the merchant panel shows, as a person reads it. */
async function readPanel(page: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['newPage']>>) {
  return page.evaluate(() => {
    const box = document.querySelector('#merchant-result .result');
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
  });
}

await main();
