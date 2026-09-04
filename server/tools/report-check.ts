/**
 * Prove that the camera report runs, before a person carries it to a phone.
 *
 * This check cannot say whether a camera reads a code. It feeds Chrome a
 * perfect raster of a symbol, in focus, centred and evenly lit, through a file.
 * A file has no lens, no focus, no exposure and no motion. Every camera check
 * in this repository therefore passes by construction, and none of them can
 * fail for the reason that a phone fails.
 *
 * This check covers the instrument alone. It proves that the screen finds the
 * cameras, opens one, reports what the stream delivers, measures the sharpness
 * and decodes a frame. A person then takes a working instrument to a phone, and
 * the phone supplies the truth that no file can.
 *
 *   CHROME_PATH=/path/to/chrome npm run report-check --workspace @senet/server
 */
import { createServer } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { launch } from 'puppeteer-core';
import { writeSymbolVideo } from './fake-camera.js';
import { serveBuiltApplication } from './serve-build.js';

/**
 * The size of the payload that the check draws.
 *
 * A passkey voucher measures this on a phone, so the symbol has the density
 * that a merchant meets.
 */
const PAYLOAD_BYTES = 792;

/** How long the check waits for the screen to finish one measurement. */
const STEP_TIMEOUT_MS = 90_000;

/** What the report must state before a person carries it to a phone. */
const REQUIRED = ['can ask', 'camera', 'settings', 'decoder', 'read', 'sharpness'];

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
  const chromePath = required('CHROME_PATH');
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`${DIST} holds no build. Run the application build first.`);
  }

  const payload = new Uint8Array(PAYLOAD_BYTES);
  crypto.getRandomValues(payload);
  const videoPath = join(tmpdir(), `senet-report-${Date.now()}.y4m`);
  const drawn = writeSymbolVideo(videoPath, payload);
  console.log(`symbol     version ${drawn.version}, ${drawn.modulePixels} pixels a module`);

  const service = createServer((request, response) => {
    serveBuiltApplication(DIST, request, response);
  });
  await new Promise<void>((listening) => {
    service.listen(0, '127.0.0.1', listening);
  });
  const address = service.address();
  if (address === null || typeof address === 'string') throw new Error('the service took no port');
  const origin = `http://localhost:${address.port}`;
  console.log(`origin     ${origin}`);

  const browser = await launch({
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
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
    await page.goto(`${origin}#camera`, { waitUntil: 'load' });
    await page.waitForSelector('#report-find', { timeout: STEP_TIMEOUT_MS });
    await page.click('#report-find');
    await page.waitForFunction(
      () => (document.getElementById('report-output')?.textContent ?? '').includes('first read'),
      { timeout: STEP_TIMEOUT_MS },
    );
    const text = await page.evaluate(
      () => document.getElementById('report-output')?.textContent ?? '',
    );
    console.log(`\n${text}\n`);

    const missing = REQUIRED.filter((word) => !text.includes(word));
    if (missing.length > 0) {
      throw new Error(`the report states no ${missing.join(', no ')}`);
    }
    if (text.includes('first read never')) {
      throw new Error('the screen decoded nothing from a symbol that a file drew perfectly');
    }
    const buttons = await page.$$('#report-cameras button');
    console.log(`cameras    ${buttons.length} offered for a separate measurement`);
    if (buttons.length === 0) {
      throw new Error('the screen offers no camera to measure');
    }
    console.log('the camera report runs, and a person can carry it to a phone');
  } finally {
    await browser.close();
    service.close();
    rmSync(videoPath, { force: true });
  }
}

await main();
