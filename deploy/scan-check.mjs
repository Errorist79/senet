// Read codes with the camera, in a real browser, through the deployed page.
//
//   CHROME_PATH=/path/to/chrome node deploy/scan-check.mjs [case ...] [perModule] [origin]
//
// Every other check here runs the decoder in node. That proves the library. It
// does not prove the application. These four parts are browser code, and node
// runs none of them:
//
// - the base64 that the build writes in;
// - the middle square that the loop cuts;
// - the frame that the page asks for;
// - the loop that now waits for a decode.
//
// Each case feeds Chrome a video file that holds one symbol, at a stated number
// of pixels for each module. The case then drives a screen exactly as a person
// drives it. A result here means the whole chain works. It says nothing about a
// lens, which is what a phone is for.
//
// The cases:
//
// - merchant: a symbol of random bytes, of the size that a passkey voucher
//   takes, on the merchant screen. The screen refuses the bytes. The refusal
//   is the proof that the scanner read the bytes and handed them to the voucher
//   reader. A camera that reads nothing produces no refusal at all.
// - release: a camera that shows no symbol, on both screens. Each camera must
//   close when a person leaves its screen or presses stop.
// - request: a request that the deployed service signed, on the payee screen.
//   The screen must judge it signed and offer to pay it.
// - no-network and public-network: the same request with its network removed
//   or replaced. The screen must refuse both and offer no payment.
// - voucher: a voucher that a fresh key signed, on the payee screen. The screen
//   must refuse it as a voucher.
// - pay: one browser makes a request on the payee screen, and a second browser
//   scans the code that the first one drew and pays it. This case creates two
//   passkey accounts and spends testnet funds, so it runs only when named.
//
// With no case named, every case except `pay` runs.

import { existsSync, writeFileSync } from 'node:fs';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import {
  LIFETIMES,
  ed25519Signer,
  encodeVoucher,
  parseUri,
  randomNonce,
  randomVoucherId,
  requestNetwork,
  signVoucher,
} from '@senet/core';
import { launch } from 'puppeteer-core';
import qrcode from 'qrcode-generator';

const CASES = ['merchant', 'release', 'request', 'no-network', 'public-network', 'voucher', 'pay'];
/** The cases that spend testnet funds, which run only when a person names them. */
const SPENDING = new Set(['pay']);

const ARGS = process.argv.slice(2);
const IS_NUMBER = /^\d+(\.\d+)?$/;
// Chrome treats `http://localhost` as a secure context, which the Secure
// Contexts specification permits. A build that a local server serves can
// therefore face this check before it reaches the origin.
const IS_ORIGIN = /^https?:\/\//;
const ORIGIN = ARGS.find((one) => IS_ORIGIN.test(one)) ?? 'https://senet.hoodrun.io';
/** Pixels for each module that the video carries. The caller may name one. */
const PER_MODULE = Number(ARGS.find((one) => IS_NUMBER.test(one)) ?? 3);
const NAMED = ARGS.filter((one) => CASES.includes(one));
const STRANGE = ARGS.filter(
  (one) => !CASES.includes(one) && !IS_ORIGIN.test(one) && !IS_NUMBER.test(one),
);
const RUN = NAMED.length > 0 ? NAMED : CASES.filter((one) => !SPENDING.has(one));

const CHROME = process.env['CHROME_PATH'] ?? '';
const VIDEO = '/tmp/senet-code.y4m';

/** How many bytes a real passkey voucher takes. */
const PAYLOAD_BYTES = 792;
/** The quiet zone that the application draws, in modules, on each side. */
const QUIET_MODULES = 4;
/** How many frames the file holds. Chrome plays it and then repeats it. */
const FRAMES = 60;

/** How long the check waits for the scanner to read one frame. */
const READ_TIMEOUT_MS = 30_000;
/** How long the check waits for a step that reaches the network. */
const STEP_TIMEOUT_MS = 150_000;

/** Grey levels of a lit screen in a photograph, rather than 0 and 255. */
const DARK = 30;
const LIGHT = 225;
/** The grey around the code. A phone body is darker than its screen. */
const SURROUND = 90;

/** The amount that each request asks for, in XLM. */
const REQUEST_AMOUNT = '1';
/** Stroops in one XLM. */
const STROOPS_PER_XLM = 10_000_000n;
/** Where the application links a transaction. */
const EXPLORER_TRANSACTION = 'https://stellar.expert/explorer/testnet/tx/';

/** The words that the payee screen shows for a request for the public network. */
const PUBLIC_TITLE = 'This request is for the public Stellar network';
/** The camera faults that the merchant screen names. None of them is a read. */
const CAMERA_FAULTS = ['refused', 'missing', 'unsupported', 'failed'];

/** The two screens that scan, and the elements that a person uses on each. */
const MERCHANT = {
  nav: '#nav-merchant',
  button: '#merchant-scan',
  video: '#merchant-video',
  panel: '#merchant-result',
};
const PAYEE = {
  nav: '#nav-payee',
  button: '#payee-scan',
  video: '#payee-video',
  panel: '#payee-read-panel',
};

const problems = [];

/** Record one fault, and say it. */
function expect(holds, message) {
  if (holds) return;
  problems.push(message);
  console.error(`  PROBLEM: ${message}`);
}

/** Random bytes from a fixed seed, so that every run draws the same symbol. */
function randomBytes() {
  let state = 20260905;
  const bytes = new Uint8Array(PAYLOAD_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = Math.floor((state / 4294967296) * 256);
  }
  return bytes;
}

/**
 * Bytes as a symbol, in Byte mode at level M.
 *
 * The mode and the level are those of `encodeBytes` in the application, which
 * draws both vouchers and requests this way.
 */
function symbolOf(bytes) {
  qrcode.stringToBytes = (text) => Array.from(text, (one) => one.charCodeAt(0) & 0xff);
  let latin1 = '';
  for (const byte of bytes) latin1 += String.fromCharCode(byte);
  const made = qrcode(0, 'M');
  made.addData(latin1, 'Byte');
  made.make();
  return { size: made.getModuleCount(), isDark: (row, column) => made.isDark(row, column) };
}

/** Write a grid of modules into a video file that Chrome plays as a camera. */
function writeVideo(grid) {
  const total = grid.size + QUIET_MODULES * 2;
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
        module >= 0 && module < grid.size && cell >= 0 && cell < grid.size && grid.isDark(module, cell);
      luma[(top + row) * width + left + column] = dark ? DARK : LIGHT;
    }
  }
  const chroma = new Uint8Array((width / 2) * (height / 2)).fill(128);

  const parts = [Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420\n`)];
  for (let frame = 0; frame < FRAMES; frame += 1) {
    parts.push(Buffer.from('FRAME\n'), Buffer.from(luma), Buffer.from(chroma), Buffer.from(chroma));
  }
  writeFileSync(VIDEO, Buffer.concat(parts));
  console.log(
    `  video ${width} by ${height}, version ${(grid.size - 17) / 4}, ` +
      `${codeSide} pixels wide, ${PER_MODULE} for each module`,
  );
}

/** Ask the deployed service, and give back its JSON. */
async function service(path, body) {
  const response = await fetch(`${ORIGIN}/api${path}`, body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const fields = await response.json();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${JSON.stringify(fields)}`);
  return fields;
}

/**
 * Open one page of the application in a browser.
 *
 * A page that signs gets a virtual authenticator, which answers a passkey
 * ceremony as a phone does after a person confirms it.
 */
async function openPage(browser, { passkey }) {
  const page = await browser.newPage();
  page.on('pageerror', (caught) => console.log(`  browser error: ${String(caught)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`  browser error: ${message.text()}`);
  });
  if (passkey) {
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
  }
  // The page drops a stream from its preview when it closes the camera. The
  // check keeps every stream that the page opens, so it can still ask later
  // whether each track ended.
  await page.evaluateOnNewDocument(() => {
    window.heldStreams = [];
    const media = navigator.mediaDevices;
    if (media === undefined) return;
    const open = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints) => {
      const stream = await open(constraints);
      window.heldStreams.push(stream);
      return stream;
    };
  });
  await page.goto(ORIGIN, { waitUntil: 'networkidle2' });
  await page.waitForSelector(PAYEE.nav, { visible: true, timeout: 10_000 });
  return page;
}

/** Run one step in a browser whose camera shows one grid of modules. */
async function withCamera(grid, options, step) {
  writeVideo(grid);
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
    await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['camera']);
    return await step(await openPage(browser, options));
  } finally {
    await browser.close();
  }
}

/** Read the result box under one selector, as a person sees it. */
function readBox(page, selector) {
  return page.evaluate((wanted) => {
    const box = document.querySelector(wanted);
    if (box === null) return null;
    const rows = {};
    for (const row of box.querySelectorAll('.detail')) {
      const value = row.querySelector('.detail-value');
      const link = row.querySelector('a.detail-link');
      rows[row.querySelector('.detail-label')?.textContent ?? ''] = {
        full: value?.dataset.full ?? value?.textContent ?? '',
        link: link === null ? null : { text: link.textContent, href: link.href },
      };
    }
    return {
      title: box.querySelector('.result-title')?.textContent ?? '',
      advice: box.querySelector('.result-advice')?.textContent ?? '',
      text: (box.textContent ?? '').replace(/\s+/g, ' ').trim(),
      buttons: [...box.querySelectorAll('button')].map((button) => button.textContent ?? ''),
      rows,
    };
  }, selector);
}

/** Wait until the preview of one screen shows a live camera. */
function cameraRuns(page, screen) {
  return page
    .waitForFunction(
      (selector) => {
        const preview = document.querySelector(selector);
        const stream = preview?.srcObject;
        if (!(stream instanceof MediaStream) || preview.videoWidth === 0) return false;
        return stream.getVideoTracks().some((track) => track.readyState === 'live');
      },
      { timeout: READ_TIMEOUT_MS },
      screen.video,
    )
    .then(() => true)
    .catch(() => false);
}

/** How many cameras the page opened so far. A later state reads only the ones after it. */
function camerasOpened(page) {
  return page.evaluate(() => window.heldStreams.length);
}

/**
 * Whether one screen opened a camera after a mark, and whether every camera
 * that it opened after the mark stopped.
 *
 * A stop means three things: each track ended, the preview holds no stream,
 * and the preview is hidden.
 */
function cameraState(page, screen, mark) {
  return page.evaluate(
    (selector, from) => {
      const preview = document.querySelector(selector);
      const tracks = window.heldStreams.slice(from).flatMap((stream) => stream.getTracks());
      return {
        opened: tracks.length > 0,
        closed:
          tracks.every((track) => track.readyState === 'ended') &&
          preview?.srcObject === null &&
          preview.hidden,
      };
    },
    screen.video,
    mark,
  );
}

/** Press a scan button and wait for the panel under it to show a result. */
async function scan(page, screen) {
  await page.click(screen.nav);
  await page.waitForSelector(screen.button, { visible: true, timeout: 10_000 });
  const mark = await camerasOpened(page);
  const startedAt = Date.now();
  await page.click(screen.button);
  // While the camera runs, the panel holds a line of guidance. A result, of
  // any kind, replaces it with a `.result` box. That box is the event.
  await page.waitForSelector(`${screen.panel} .result`, { timeout: READ_TIMEOUT_MS }).catch(() => undefined);
  const box = await readBox(page, `${screen.panel} .result`);
  console.log(`  after ${Date.now() - startedAt} ms: ${box === null ? '(the panel stayed empty)' : box.text}`);
  const camera = await cameraState(page, screen, mark);
  expect(!camera.opened || camera.closed, 'the camera kept running after the screen showed a result');
  return box;
}

/**
 * A camera that a person leaves, or stops, must close.
 *
 * The video shows no symbol, so no read closes the camera in its place.
 */
async function releaseCase() {
  const blank = { size: 21, isDark: () => false };
  await withCamera(blank, { passkey: false }, async (page) => {
    await page.click(PAYEE.nav);
    const left = await camerasOpened(page);
    await page.click(PAYEE.button);
    expect(await cameraRuns(page, PAYEE), 'the payee camera never ran');
    await page.click(MERCHANT.nav);
    const behind = await cameraState(page, PAYEE, left);
    expect(behind.opened && behind.closed, 'the payee camera kept running behind another screen');

    const stopped = await camerasOpened(page);
    await page.click(MERCHANT.button);
    expect(await cameraRuns(page, MERCHANT), 'the merchant camera never ran');
    await page.click(MERCHANT.button);
    const after = await cameraState(page, MERCHANT, stopped);
    expect(after.opened && after.closed, 'the merchant camera kept running after stop');
    const label = await page.$eval(MERCHANT.button, (button) => button.textContent);
    expect(label === 'Scan a voucher', `the stopped scan button says '${label}'`);
  });
}

/** A request that the deployed service signed, for a destination that nobody pays. */
async function signedRequest(chain) {
  const reply = await service('/payee-request', {
    destination: Keypair.random().publicKey(),
    amount: REQUEST_AMOUNT,
  });
  const asked = requestNetwork(parseUri(reply.uri));
  expect(asked === chain.network, `the service signed a request for "${asked}", and it runs on "${chain.network}"`);
  return reply.uri;
}

/** The text bytes of a request, as the payee screen draws them. */
function requestSymbol(uri) {
  return symbolOf(new TextEncoder().encode(uri));
}

async function merchantCase() {
  const box = await withCamera(symbolOf(randomBytes()), { passkey: false }, (page) =>
    scan(page, MERCHANT),
  );
  expect(box !== null, `the merchant screen read nothing in ${READ_TIMEOUT_MS} ms`);
  const named = box?.rows['Reason']?.full ?? '';
  expect(!CAMERA_FAULTS.includes(named), `the camera itself failed with '${named}', so nothing was read`);
}

async function requestCase(chain) {
  const uri = await signedRequest(chain);
  const domain = parseUri(uri).fields['origin_domain'];
  const box = await withCamera(requestSymbol(uri), { passkey: false }, (page) =>
    scan(page, PAYEE),
  );
  expect(box?.title === `${domain} signed this request`, `the payee screen did not judge the request signed`);
  expect(
    box?.buttons.includes(`Pay ${REQUEST_AMOUNT} XLM`) === true,
    'the payee screen offered no payment for a signed request',
  );
}

/** A request that names another network, or none, must not be payable. */
async function wrongNetworkCase(chain, change) {
  const uri = await signedRequest(chain);
  const changed = change(uri);
  expect(changed !== uri, 'the fault that this case plants changed nothing in the request');
  const box = await withCamera(requestSymbol(changed), { passkey: false }, (page) => scan(page, PAYEE));
  expect(box?.title === PUBLIC_TITLE, 'the payee screen did not refuse the network of the request');
  expect(
    box !== null && !box.buttons.some((text) => text.startsWith('Pay ')),
    'the payee screen offered to pay a request for another network',
  );
}

/** Remove the network from a request. SEP-7 then reads it as public. */
function dropNetwork(uri) {
  return uri.replace(/&network_passphrase=[^&]*/, '');
}

/** Name the public network in a request. */
function publicNetwork(uri) {
  const param = new URLSearchParams({ network_passphrase: Networks.PUBLIC }).toString();
  return uri.replace(/network_passphrase=[^&]*/, param);
}

async function voucherCase(chain) {
  const config = { network: chain.network, contractId: chain.contractId, tokenId: chain.tokenId };
  const payer = Keypair.random();
  const { sequence } = await service('/ledger');
  const entry = await signVoucher(
    config,
    {
      payer: payer.publicKey(),
      amount: STROOPS_PER_XLM,
      voucherId: randomVoucherId(),
      expireAt: sequence + LIFETIMES['15m'],
    },
    randomNonce(),
    ed25519Signer(config, payer.secret()),
  );
  const box = await withCamera(symbolOf(encodeVoucher(config, entry)), { passkey: false }, (page) =>
    scan(page, PAYEE),
  );
  expect(
    box?.advice.startsWith('This code is a voucher, not a payment request.') === true,
    'the payee screen did not refuse the voucher as a voucher',
  );
}

/**
 * Create a passkey account on one page, and give back its address.
 *
 * The service deploys the account, so this waits for a ledger.
 */
async function createAccount(page, name) {
  await page.click('#nav-account');
  await page.waitForSelector('#account-name', { visible: true, timeout: 10_000 });
  await page.type('#account-name', name);
  await page.click('#account-create');
  await page.waitForFunction(
    () => {
      const title = document.querySelector('#account-panel .result-title')?.textContent;
      return title === 'Your account' || title === 'That did not work';
    },
    { timeout: STEP_TIMEOUT_MS },
  );
  const box = await readBox(page, '#account-panel .result');
  if (box?.title !== 'Your account') throw new Error(`no account for ${name}: ${box?.text ?? ''}`);
  return box.rows['Address']?.full ?? '';
}

/**
 * Press the button that adds test funds, and wait until the balance covers a payment.
 *
 * A new account can show a balance of zero before the funds arrive. Any
 * amount therefore proves nothing. The wait ends at an amount that pays the
 * request, and it gives back the balance that the screen shows.
 */
async function addFunds(page, wanted) {
  await page.click('#account-panel .result button.submit-quiet');
  await page.waitForFunction(
    (least) => {
      for (const row of document.querySelectorAll('#account-panel .detail')) {
        if (row.querySelector('.detail-label')?.textContent !== 'Balance') continue;
        const shown = /^(\d+)\.(\d{7}) XLM$/.exec(row.querySelector('.detail-value')?.textContent ?? '');
        return shown !== null && BigInt(`${shown[1]}${shown[2]}`) >= BigInt(least);
      }
      return false;
    },
    { timeout: STEP_TIMEOUT_MS },
    wanted,
  );
  return (await readBox(page, '#account-panel .result'))?.rows['Balance']?.full ?? '';
}

/**
 * Copy the modules of the code that the payee screen drew.
 *
 * The page draws a white quiet zone of four modules. The finder pattern then
 * makes the first dark pixel on the diagonal the corner of the symbol. That
 * pixel gives the scale. The centre of each module then gives its colour.
 */
async function copyCode(page) {
  const copied = await page.evaluate((quiet) => {
    const canvas = document.querySelector('#payee-panel canvas.code');
    const context = canvas?.getContext('2d') ?? null;
    if (canvas === null || context === null) return null;
    const side = canvas.width;
    const pixels = context.getImageData(0, 0, side, side).data;
    const dark = (x, y) => pixels[(y * side + x) * 4] < 128;
    let corner = 0;
    while (corner < side && !dark(corner, corner)) corner += 1;
    const scale = corner / quiet;
    const size = side / scale - quiet * 2;
    const rows = [];
    for (let row = 0; row < size; row += 1) {
      let line = '';
      for (let column = 0; column < size; column += 1) {
        const x = Math.floor((quiet + column + 0.5) * scale);
        const y = Math.floor((quiet + row + 0.5) * scale);
        line += dark(x, y) ? '1' : '0';
      }
      rows.push(line);
    }
    return { scale, size, rows };
  }, QUIET_MODULES);
  if (copied === null || !Number.isInteger(copied.scale) || (copied.size - 17) % 4 !== 0) {
    throw new Error(`the payee screen drew no code that this check can copy: ${JSON.stringify(copied)}`);
  }
  return { size: copied.size, isDark: (row, column) => copied.rows[row][column] === '1' };
}

/** Ask the network what it holds for one transaction. */
async function transactionStatus(rpcUrl, hash) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: { hash } }),
  });
  const reply = await response.json();
  return reply.result?.status ?? `no status: ${JSON.stringify(reply)}`;
}

async function payCase(chain) {
  const wanted = (BigInt(REQUEST_AMOUNT) * STROOPS_PER_XLM).toString();
  // The payee's phone makes the request and draws it. It needs no camera.
  const payeeBrowser = await launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  let grid;
  let payee;
  try {
    const page = await openPage(payeeBrowser, { passkey: true });
    payee = await createAccount(page, 'scan check payee');
    await page.click(PAYEE.nav);
    await page.type('#payee-amount', REQUEST_AMOUNT);
    await page.type('#payee-message', 'scan check');
    await page.click('#payee-ask');
    await page.waitForSelector('#payee-panel canvas.code', { timeout: STEP_TIMEOUT_MS });
    grid = await copyCode(page);
  } finally {
    await payeeBrowser.close();
  }
  console.log(`  the payee ${payee} drew a code of ${grid.size} modules`);

  // The payer's camera shows that code. The payer reads it, pays it, and reads the result.
  const paid = await withCamera(grid, { passkey: true }, async (page) => {
    await createAccount(page, 'scan check payer');
    console.log(`  the payer holds ${await addFunds(page, wanted)}`);
    const judged = await scan(page, PAYEE);
    expect(judged?.title.endsWith('signed this request') === true, 'the payer did not see a signed request');
    await page.click(`${PAYEE.panel} .result button.submit`);
    await page.waitForFunction(
      (selector) => {
        const title = document.querySelector(selector)?.textContent;
        return title === 'Paid' || title === 'Not paid' || title === 'That did not work';
      },
      { timeout: STEP_TIMEOUT_MS },
      `${PAYEE.panel} .result-title`,
    );
    const box = await readBox(page, `${PAYEE.panel} .result`);
    console.log(`  ${box?.text ?? '(no result)'}`);
    return box;
  });

  expect(paid?.title === 'Paid', `the payment ended as '${paid?.title ?? 'nothing'}'`);
  const row = paid?.rows['Transaction'];
  const hash = row?.full ?? '';
  expect(/^[0-9a-f]{64}$/.test(hash), `the Paid result shows no transaction hash: '${hash}'`);
  expect(row?.link?.text === 'open', 'the transaction row carries no open link');
  expect(row?.link?.href === `${EXPLORER_TRANSACTION}${hash}`, `the open link goes to ${row?.link?.href}`);

  // The screen is a claim. The network is the fact.
  const status = await transactionStatus(chain.rpcUrl, hash);
  expect(status === 'SUCCESS', `the network reports ${status} for ${hash}`);
  const balance = await service(`/balance?address=${encodeURIComponent(payee)}`);
  expect(balance.balanceStroops === wanted, `the payee holds ${balance.balanceStroops}, not ${wanted}`);
  console.log(`  the network reports ${status} for ${hash}, and the payee holds ${balance.balanceStroops} stroops`);
}

async function main() {
  if (CHROME === '' || !existsSync(CHROME)) {
    console.error('CHROME_PATH names no browser, so this check cannot run');
    process.exit(1);
  }
  if (STRANGE.length > 0) {
    console.error(`unknown arguments ${STRANGE.join(', ')}. The cases are ${CASES.join(', ')}`);
    process.exit(1);
  }
  const chain = await service('/config');
  const runners = {
    merchant: () => merchantCase(),
    release: () => releaseCase(),
    request: () => requestCase(chain),
    'no-network': () => wrongNetworkCase(chain, dropNetwork),
    'public-network': () => wrongNetworkCase(chain, publicNetwork),
    voucher: () => voucherCase(chain),
    pay: () => payCase(chain),
  };
  for (const name of RUN) {
    console.log(`\n${name}`);
    const before = problems.length;
    try {
      await runners[name]();
    } catch (caught) {
      expect(false, `${name} stopped: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
    console.log(`  ${problems.length === before ? 'passed' : 'FAILED'}`);
  }
  const skipped = CASES.filter((one) => !RUN.includes(one));
  console.log(`\n${RUN.length} cases against ${ORIGIN}, ${problems.length} problems`);
  // A run that leaves a case out says so, because a passing line covers only what ran.
  if (skipped.length > 0) console.log(`not run: ${skipped.join(', ')}`);
  if (problems.length > 0) process.exitCode = 1;
}

main();
