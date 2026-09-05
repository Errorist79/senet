// Read a voucher sized code, in a real browser, through the deployed page.
//
//   CHROME_PATH=/path/to/chrome node deploy/scan-check.mjs [perModule] [origin]
//
// Every other check here runs the decoder in node. That proves the library and
// it does not prove the application: the base64 that the build writes in, the
// middle square that the loop cuts, the frame that the page asks for, and the
// loop that now waits for a decode are all browser code, and none of them runs
// under node.
//
// This check feeds Chrome a video file that holds a version 23 symbol, at a
// stated number of pixels for each module, and then drives the merchant screen
// exactly as a merchant drives it. A read here means the whole chain works. It
// says nothing about a lens, which is what a phone is for.
//
// The symbol carries random bytes rather than a signed voucher, because no
// unattended run can sign one. The merchant screen therefore refuses it, and
// the refusal is the proof: the scanner read the bytes off the camera and
// handed them to the voucher reader, which is the whole path under test. A
// camera that reads nothing produces no refusal at all.

import { existsSync, writeFileSync } from 'node:fs';
import { launch } from 'puppeteer-core';
import qrcode from 'qrcode-generator';

const ORIGIN = process.argv[3] ?? 'https://senet.hoodrun.io';
const CHROME = process.env['CHROME_PATH'] ?? '';
const VIDEO = '/tmp/senet-code.y4m';

/** How many bytes a real voucher takes. */
const PAYLOAD_BYTES = 792;
/** The quiet zone that the payer screen draws, in modules, on each side. */
const QUIET_MODULES = 4;
/** How many frames the file holds. Chrome plays it and then repeats it. */
const FRAMES = 60;

/** How long the check waits for the scanner to read one frame. */
const READ_TIMEOUT_MS = 30_000;

/** Pixels for each module that the video carries. The caller may name one. */
const PER_MODULE = Number(process.argv[2] ?? 3);

/** Grey levels of a lit screen in a photograph, rather than 0 and 255. */
const DARK = 30;
const LIGHT = 225;
/** The grey around the code. A phone body is darker than its screen. */
const SURROUND = 90;

function symbol() {
  let state = 20260905;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const bytes = new Uint8Array(PAYLOAD_BYTES);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(random() * 256);

  qrcode.stringToBytes = (text) => Array.from(text, (one) => one.charCodeAt(0) & 0xff);
  let latin1 = '';
  for (const byte of bytes) latin1 += String.fromCharCode(byte);
  const made = qrcode(0, 'M');
  made.addData(latin1, 'Byte');
  made.make();
  return made;
}

/** Write the code into a video file that Chrome plays as a camera. */
function writeVideo() {
  const made = symbol();
  const modules = made.getModuleCount();
  const total = modules + QUIET_MODULES * 2;
  const codeSide = Math.round(total * PER_MODULE);
  // Chrome wants even numbers for a 4:2:0 picture.
  const width = Math.ceil((codeSide * 2) / 2) * 2;
  const height = Math.ceil((codeSide * 1.34) / 2) * 2;

  const luma = new Uint8Array(width * height).fill(SURROUND);
  const left = Math.floor((width - codeSide) / 2);
  const top = Math.floor((height - codeSide) / 2);
  for (let row = 0; row < codeSide; row += 1) {
    for (let column = 0; column < codeSide; column += 1) {
      const module = Math.floor(row / PER_MODULE) - QUIET_MODULES;
      const cell = Math.floor(column / PER_MODULE) - QUIET_MODULES;
      const dark =
        module >= 0 && module < modules && cell >= 0 && cell < modules && made.isDark(module, cell);
      luma[(top + row) * width + left + column] = dark ? DARK : LIGHT;
    }
  }
  const chroma = new Uint8Array((width / 2) * (height / 2)).fill(128);

  const parts = [Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420\n`)];
  for (let frame = 0; frame < FRAMES; frame += 1) {
    parts.push(Buffer.from('FRAME\n'), Buffer.from(luma), Buffer.from(chroma), Buffer.from(chroma));
  }
  writeFileSync(VIDEO, Buffer.concat(parts));
  return { width, height, modules, version: (modules - 17) / 4, codeSide };
}

async function main() {
  if (CHROME === '' || !existsSync(CHROME)) {
    console.error('CHROME_PATH names no browser, so this check cannot run');
    process.exit(1);
  }
  const made = writeVideo();
  console.log(
    `video ${made.width} by ${made.height}, version ${made.version}, ` +
      `${made.codeSide} pixels wide, ${PER_MODULE} for each module`,
  );

  const browser = await launch({
    executablePath: CHROME,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${VIDEO}`,
    ],
  });
  try {
    const context = browser.defaultBrowserContext();
    await context.overridePermissions(ORIGIN, ['camera']);
    const page = await browser.newPage();
    const failures = [];
    page.on('pageerror', (caught) => failures.push(String(caught)));
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(message.text());
    });

    await page.goto(ORIGIN, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#nav-merchant', { visible: true, timeout: 10_000 });
    await page.click('#nav-merchant');
    await page.waitForSelector('#merchant-scan', { visible: true, timeout: 10_000 });

    const startedAt = Date.now();
    await page.click('#merchant-scan');
    // The scanner stops itself on the first read, so the panel filling is the
    // event to wait for. A camera that never reads leaves it empty.
    await page.waitForFunction(
      () => (document.getElementById('merchant-result')?.textContent ?? '').length > 0,
      { timeout: READ_TIMEOUT_MS },
    ).catch(() => undefined);
    const readMs = Date.now() - startedAt;
    const panel = await page.evaluate(
      () => document.getElementById('merchant-result')?.textContent ?? '',
    );

    console.log(`\npanel after ${readMs} ms: ${panel.trim().replace(/\s+/g, ' ') || '(nothing)'}`);
    if (failures.length > 0) console.log('browser errors:', failures.slice(0, 5));

    // A refusal names the reason that the voucher reader gave. Any of those
    // means the bytes arrived. A camera fault names itself instead, and an
    // empty panel means no frame ever decoded.
    const cameraFault = /camera/i.test(panel);
    const decoded = panel.length > 0 && !cameraFault ? 1 : 0;

    if (cameraFault) {
      console.error('\nthe page reported a camera fault, so no frame reached the decoder');
      process.exit(1);
    }
    if (decoded === 0) {
      console.error(
        `\nthe browser read nothing in ${READ_TIMEOUT_MS} ms, so the scanner path is broken`,
      );
      process.exit(1);
    }
    console.log(`\nthe browser read the code through the application path, in ${readMs} ms`);
  } finally {
    await browser.close();
  }
}

main();
