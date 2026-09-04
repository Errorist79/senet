/**
 * Measure what a passkey voucher weighs, and say what decides it.
 *
 * Ten bytes of headroom at symbol version 24 matter only when the size is
 * fixed. A WebAuthn assertion carries a DER signature, whose length moves with
 * its values, and it carries the client data, which holds the origin as text.
 * So the size may depend on the name that served the page, and it may move
 * between two signatures from one key.
 *
 * The check mints several vouchers on one origin and measures each entry. It
 * then takes the signature apart, so the answer comes from bytes rather than
 * from an argument.
 *
 *   ENV_FILE=/path/to/.env CHROME_PATH=/path/to/chrome MINTS=5 \
 *     ORIGIN=https://senet.hoodrun.io npm run size-check --workspace @senet/server
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc, xdr } from '@stellar/stellar-sdk';
import { PAYLOAD_PREFIX_BYTES } from '@senet/core';
import { launch } from 'puppeteer-core';
import { FeePayer, createApiHandler, loadEnvFile, readConfig } from '../src/index.js';
import { serveBuiltApplication } from './serve-build.js';

/** How many vouchers the check mints when the environment names no count. */
const DEFAULT_MINTS = 5;

/** The amount of each voucher, in XLM, as a person types it. */
const AMOUNT_XLM = '0.1';

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

/** One part of a signature, named and measured. */
interface Part {
  readonly path: string;
  readonly kind: string;
  readonly bytes: number;
  /** The text, when the part carries readable text. */
  readonly text?: string;
}

/**
 * Take one signature value apart.
 *
 * The walk names each part by where it sits, so a reader compares two runs
 * part by part rather than only by their totals.
 */
function describeValue(value: xdr.ScVal, path: string, into: Part[]): void {
  const kind = value.switch().name;
  const bytes = value.toXDR().length;
  if (kind === 'scvBytes') {
    const raw = value.bytes();
    const text = raw.toString('utf8');
    // Client data is JSON, and it carries the origin that the browser saw.
    const readable = /^[\x20-\x7e]+$/.test(text) ? text : undefined;
    into.push(readable === undefined ? { path, kind, bytes } : { path, kind, bytes, text: readable });
    return;
  }
  into.push({ path, kind, bytes });
  if (kind === 'scvVec') {
    (value.vec() ?? []).forEach((one, index) => describeValue(one, `${path}[${index}]`, into));
    return;
  }
  if (kind === 'scvMap') {
    for (const pair of value.map() ?? []) {
      const key = pair.key();
      const name = key.switch().name === 'scvSymbol' ? key.sym().toString() : key.switch().name;
      describeValue(pair.val(), `${path}.${name}`, into);
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = readConfig();
  const chromePath = required('CHROME_PATH');
  const mints = Number(process.env['MINTS'] ?? DEFAULT_MINTS);
  const outPath = process.argv[2] ?? resolve(process.cwd(), 'size-check.json');
  const named = process.env['ORIGIN'];
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`${DIST} holds no build. Run the application build first.`);
  }

  let close = (): void => {};
  let origin = named ?? '';
  if (named === undefined || named === '') {
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
    origin = `http://localhost:${address.port}`;
    close = () => service.close();
  }
  console.log(`origin     ${origin}`);
  console.log(`host       ${new URL(origin).hostname} (${new URL(origin).hostname.length} characters)`);

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

    await page.click('#nav-payer');
    await page.waitForSelector('#payer-mint', { timeout: STEP_TIMEOUT_MS });
    for (let index = 0; index < mints; index += 1) {
      await page.evaluate(() => {
        const field = document.getElementById('payer-amount');
        if (field instanceof HTMLInputElement) field.value = '';
      });
      await page.type('#payer-amount', AMOUNT_XLM);
      await page.click('#payer-mint');
      await page.waitForFunction(
        (want: number) => document.querySelectorAll('#payer-list .voucher').length >= want,
        { timeout: STEP_TIMEOUT_MS },
        index + 1,
      );
    }

    const payloads = await page.evaluate(() => {
      const raw = window.localStorage.getItem('senet.vouchers');
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((one) => {
        const fields: Record<string, unknown> = { ...one };
        return typeof fields['payloadBase64'] === 'string' ? fields['payloadBase64'] : '';
      });
    });

    // The check takes every entry apart, because one entry shows no variance.
    const measured: { bytes: number; parts: Part[] }[] = [];
    for (const payloadBase64 of payloads) {
      if (payloadBase64 === '') continue;
      const payload = Buffer.from(payloadBase64, 'base64');
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(payload.subarray(PAYLOAD_PREFIX_BYTES));
      const parts: Part[] = [];
      describeValue(entry.credentials().addressV2().signature(), 'signature', parts);
      measured.push({ bytes: entry.toXDR().length, parts });
    }
    const sizes = measured.map((one) => one.bytes);
    const smallest = Math.min(...sizes);
    const largest = Math.max(...sizes);
    console.log(`entries    ${sizes.length}: ${sizes.join(', ')}`);
    console.log(`entry size ${smallest} to ${largest}, spread ${largest - smallest}`);

    // The part that moves is the one worth naming, so this compares the parts
    // of the smallest entry against the parts of the largest.
    const small = measured.find((one) => one.bytes === smallest);
    const large = measured.find((one) => one.bytes === largest);
    for (const part of small?.parts ?? []) {
      const other = large?.parts.find((one) => one.path === part.path);
      const moved = other === undefined ? 'absent in the largest' : `${other.bytes - part.bytes}`;
      console.log(
        `  ${part.path.padEnd(40)} ${part.kind.padEnd(10)} ${String(part.bytes).padStart(4)}  moves ${moved}`,
      );
    }
    for (const part of large?.parts ?? []) {
      if ((small?.parts ?? []).some((one) => one.path === part.path)) continue;
      console.log(`  ${part.path.padEnd(40)} ${part.kind.padEnd(10)} ${String(part.bytes).padStart(4)}  only in the largest`);
    }
    const clientData = small?.parts.find((one) => one.path.endsWith('client_data_json'))?.text;
    if (clientData !== undefined) console.log(`client data ${clientData}`);

    const record = {
      ranAt: new Date().toISOString(),
      origin,
      host: new URL(origin).hostname,
      hostLength: new URL(origin).hostname.length,
      mints: sizes.length,
      entryBytes: sizes,
      smallestEntry: smallest,
      largestEntry: largest,
      payloadBytes: largest + PAYLOAD_PREFIX_BYTES,
      entries: measured,
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`record written to ${outPath}`);
  } finally {
    await browser.close();
    close();
  }
}

await main();
