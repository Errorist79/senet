/**
 * Drive the merchant screen through all three states of a confirmation.
 *
 * A submission that returns says the network accepted a transaction. Only the
 * contract's event says that the payment happened. The screen once said `paid`
 * on the strength of the first. It now waits for the second, and this check
 * exists for that reason.
 *
 * Each run begins from a submitted payment with no confirmation yet. That is
 * the state a merchant is in when they look at the screen.
 *
 * The third state is the one that matters here. A bound long enough that it
 * never fires is a state that no check can reach, and a person would meet it
 * first. This check reaches it on purpose, and it holds the feed silent to do
 * so.
 *
 *   CHROME_PATH=/path/to/chrome npm run confirm-check --workspace @senet/server
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { launch } from 'puppeteer-core';
import {
  LIFETIMES,
  TESTNET_CONTRACT_ID,
  ed25519Signer,
  encodeVoucher,
  nativeTokenId,
  randomNonce,
  randomVoucherId,
  signVoucher,
} from '@senet/core';
import { serveBuiltApplication } from './serve-build.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', '..', '..', 'app', 'dist');

/** How long the check waits for a state that should arrive in seconds. */
const STEP_TIMEOUT_MS = 60_000;

/** What the feed reports that the chain published, when it reports at all. */
const CONFIRMED_HASH = '44b7f187cb84a113401795268092570c86b7743828464e561ffca759b3ef3514';
const SUBMITTED_HASH = '0000000000000000000000000000000000000000000000000000000000000001';
const RECIPIENT = 'GC45NTB4OWWPE5FTJ5DI3IHLLGVNB3VCGFANCFAHKFVIVRK6C2PHLSSZ';

/** The ledger that the stub service reports, so the voucher outlives it. */
const LEDGER = 4507468;

/** Read a variable that the check cannot run without. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set, and the check needs it`);
  }
  return value;
}

/** The text of the confirmation line, whatever state it is in. */
async function confirmationLine(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['newPage']>>,
): Promise<string> {
  return page.evaluate(
    () => document.querySelector('.confirming, .confirmed')?.textContent ?? '',
  );
}

async function main(): Promise<void> {
  const chromePath = required('CHROME_PATH');
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`${DIST} holds no build. Run the application build first.`);
  }

  // A real voucher, signed here, so that the screen runs its own decode and
  // its own submission. A check that reached into the screen and drew a result
  // would prove that a drawing works. It would prove nothing about the path
  // that a merchant takes.
  const payer = Keypair.random();
  const voucherConfig = {
    network: Networks.TESTNET,
    contractId: TESTNET_CONTRACT_ID,
    tokenId: nativeTokenId(Networks.TESTNET),
  };
  const voucher = {
    payer: payer.publicKey(),
    amount: 5_000_000n,
    voucherId: randomVoucherId(),
    expireAt: LEDGER + LIFETIMES['15m'],
  };
  const entry = await signVoucher(
    voucherConfig,
    voucher,
    randomNonce(),
    ed25519Signer(voucherConfig, payer.secret()),
  );
  const payload = Buffer.from(encodeVoucher(voucherConfig, entry)).toString('base64');
  const voucherId = voucher.voucherId.toString();

  let confirms = false;
  const service = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const send = (value: unknown): void => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/api/config') {
      send({
        network: Networks.TESTNET,
        networkTag: 'testnet',
        contractId: TESTNET_CONTRACT_ID,
        tokenId: nativeTokenId(Networks.TESTNET),
        rpcUrl: 'https://soroban-testnet.stellar.org',
        walletWasmHash: '00',
      });
      return;
    }
    if (url.pathname === '/api/ledger') {
      send({ sequence: LEDGER, readAtIso: '2026-09-05T00:00:00Z' });
      return;
    }
    if (url.pathname === '/api/redeem') {
      send({
        outcome: 'SUCCESS',
        stage: 'poll',
        hash: SUBMITTED_HASH,
        ledger: LEDGER + 1,
        feeChargedStroops: '47743',
        voucherId,
        amountStroops: '5000000',
        payer: payer.publicKey(),
        recipient: RECIPIENT,
      });
      return;
    }
    if (url.pathname === '/api/redemption') {
      send({
        voucherId: voucherId,
        redemption: confirms
          ? {
              voucher_id: voucherId,
              payer: RECIPIENT,
              recipient: RECIPIENT,
              amount: '5000000',
              expire_at: 4507999,
              tx_hash: CONFIRMED_HASH,
              ledger: 4507470,
              ledger_closed_at: '2026-09-05T00:00:05Z',
              event_id: 'e1',
            }
          : null,
      });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      send({});
      return;
    }
    serveBuiltApplication(DIST, request, response);
  });
  await new Promise<void>((up) => service.listen(0, '127.0.0.1', up));
  const address = service.address();
  if (address === null || typeof address === 'string') throw new Error('the service took no port');
  const origin = `http://localhost:${address.port}`;
  console.log(`origin     ${origin}`);

  const browser = await launch({
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    // A check that hides why the screen did nothing turns one failure into a
    // second investigation.
    page.on('console', (message) => console.log(`  page: ${message.text()}`));
    page.on('pageerror', (failure: unknown) =>
      console.log(`  page error: ${failure instanceof Error ? failure.message : String(failure)}`),
    );
    await page.goto(`${origin}#merchant`, { waitUntil: 'load' });

    /** Take the payment the way a merchant takes it, by the pasted code. */
    async function submit(): Promise<void> {
      await page.waitForSelector('#merchant-payload', { timeout: STEP_TIMEOUT_MS });
      await page.evaluate(
        (values: { recipient: string; payload: string }) => {
          const details = document.querySelector('#screen-merchant details');
          if (details instanceof HTMLDetailsElement) details.open = true;
          const set = (id: string, value: string): void => {
            const field = document.getElementById(id);
            if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
              throw new Error(`the screen holds no field ${id}`);
            }
            field.value = value;
            field.dispatchEvent(new Event('input', { bubbles: true }));
          };
          set('merchant-recipient', values.recipient);
          set('merchant-payload', values.payload);
        },
        { recipient: RECIPIENT, payload },
      );
      await page.click('#screen-merchant details .submit');
      await page.waitForSelector('#merchant-result .result', { timeout: STEP_TIMEOUT_MS });
      const said = await page.evaluate(() => {
        const box = document.querySelector('#merchant-result .result');
        return {
          title: box?.querySelector('.result-title')?.textContent ?? '',
          advice: box?.querySelector('.result-advice')?.textContent ?? '',
        };
      });
      console.log(`offered    ${said.title}: ${said.advice}`);
      // The paste shows what the voucher is worth. Taking it is a second
      // press, which is the one a merchant makes.
      await page.click('#merchant-result .submit');
      await page.waitForSelector('#merchant-result .result-good, #merchant-result .result-bad', {
        timeout: STEP_TIMEOUT_MS,
      });
      const outcome = await page.evaluate(
        () => document.querySelector('#merchant-result .result-title')?.textContent ?? '',
      );
      console.log(`took       ${outcome}`);
    }

    // The first state: submitted, and the chain has not spoken.
    await submit();
    await page.waitForSelector('.confirming', { timeout: STEP_TIMEOUT_MS });
    const waiting = await confirmationLine(page);
    console.log(`waiting    ${waiting}`);
    if (!waiting.includes('Waiting for the chain')) {
      throw new Error(`the screen says ${waiting} while it waits`);
    }

    // The second state: the feed speaks, and the screen takes the chain's hash.
    confirms = true;
    await page.waitForSelector('.confirmed', { timeout: STEP_TIMEOUT_MS });
    const confirmed = await confirmationLine(page);
    console.log(`confirmed  ${confirmed}`);
    const shown = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#merchant-result .detail'));
      const row = rows.find(
        (one) => one.querySelector('.detail-label')?.textContent === 'Confirmed hash',
      );
      const value = row?.querySelector('.detail-value');
      return value instanceof HTMLElement ? (value.dataset['full'] ?? '') : '';
    });
    console.log(`hash       ${shown}`);
    // The two hashes differ on purpose. This one assertion therefore says two
    // things: the screen shows the chain's hash, and it does not show the
    // submission's. A second test for the submission's hash could never fire
    // after this one, and the compiler said so.
    if (shown !== CONFIRMED_HASH) {
      throw new Error(
        `the screen shows ${shown}. The chain published ${CONFIRMED_HASH}, and the ` +
          `submission returned ${SUBMITTED_HASH}. The screen must show the first.`,
      );
    }

    // The third state: the feed never speaks. This is why the bound is short
    // enough to reach.
    confirms = false;
    await page.reload({ waitUntil: 'load' });
    await submit();
    await page.waitForFunction(
      () => (document.querySelector('.confirming')?.className ?? '').includes('confirming-late'),
      { timeout: STEP_TIMEOUT_MS },
    );
    const late = await confirmationLine(page);
    console.log(`late       ${late}`);
    if (late.toLowerCase().includes('failed')) {
      throw new Error('the screen calls a successful submission a failure');
    }
    if (!late.includes('has not confirmed it yet')) {
      throw new Error(`the screen says ${late} when the feed never speaks`);
    }
    console.log('the screen confirms from the chain, and it stops waiting with words');
  } finally {
    await browser.close();
    service.close();
  }
}

await main();
