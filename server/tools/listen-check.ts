/**
 * Kill a real listener, and prove that no redemption goes twice or missing.
 *
 * The unit tests model a restart with a second read of the position file. That
 * model is honest as far as it goes. It is also the kind of model that agrees
 * with whoever wrote it. A real restart loses timers, retry
 * counts and everything else that the process held in memory. Only a real
 * process proves that none of those mattered.
 *
 * So this check starts the listener as a child process and kills it with
 * SIGKILL, which gives it no chance to tidy up. It kills it at the moment that
 * matters: after the receiver accepted some events and before it accepted the
 * rest. The receiver counts what it got across both lives.
 *
 * The feed is a local RPC that serves a fixed set of events, because the check
 * must choose when a batch is half delivered. The event shapes come from a
 * real redemption on testnet, and a separate check reads the real network.
 *
 *   npm run listen-check --workspace @senet/server
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { REDEEMED_TOPIC, readPosition } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTEN = resolve(HERE, 'listen.js');

/** How many events the feed holds. */
const EVENT_COUNT = 6;

/** How many the receiver accepts before the check kills the listener. */
const ACCEPT_BEFORE_KILL = 3;

/** A payer and a merchant, in the form that the network really returns. */
const PAYER = 'GAF5LEIT3GWHRMYX2UEOVOGCQMDSJVM3A7WSXO3TCC2GRND6EHCLGFXJ';
const MERCHANT = 'GC45NTB4OWWPE5FTJ5DI3IHLLGVNB3VCGFANCFAHKFVIVRK6C2PHLSSZ';

/** One event, in the base64 shape that the network sends over JSON-RPC. */
function rawEvent(index: number): Record<string, unknown> {
  const id = `001930351576354816${index}-000000000${index}`;
  const value = nativeToScVal({
    payer: nativeToScVal(PAYER, { type: 'address' }),
    recipient: nativeToScVal(MERCHANT, { type: 'address' }),
    amount: nativeToScVal(5_000_000n, { type: 'i128' }),
    expire_at: nativeToScVal(4_494_629, { type: 'u32' }),
  });
  return {
    type: 'contract',
    ledger: 4494450 + index,
    ledgerClosedAt: '2026-09-04T04:23:57Z',
    contractId: 'CADGZVNCAFRHJ44P33RODTVXGXCX5EMVCYFHYFMGWNFYVILC556XGWBY',
    id,
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: `00000000000000000000000000000000000000000000000000000000000000${index}0`,
    topic: [
      nativeToScVal(REDEEMED_TOPIC, { type: 'symbol' }).toXDR('base64'),
      nativeToScVal(BigInt(index + 1), { type: 'u64' }).toXDR('base64'),
    ],
    value: value.toXDR('base64'),
  };
}

/** Read a JSON body. */
async function body(stream: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/** One field of a value of unknown shape, when that value is a record. */
function field(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null;
  const fields: Record<string, unknown> = { ...source };
  return fields[key];
}

/** The identifier of an event, from a message of unknown shape. */
function eventId(message: unknown): string | null {
  const value = field(message, 'event_id');
  return typeof value === 'string' ? value : null;
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'senet-listen-'));
  const statePath = join(work, 'listener.json');
  const events = Array.from({ length: EVENT_COUNT }, (_unused, index) => rawEvent(index));

  // The feed. It answers from a cursor, as the network does, so the listener's
  // own resume logic decides what it sees after a restart.
  const feed = createServer((request, response) => {
    void (async () => {
      const asked: unknown = await body(request);
      const from = field(field(field(asked, 'params'), 'pagination'), 'cursor');
      const after =
        typeof from === 'string' ? events.findIndex((one) => one['id'] === from) : -1;
      const page = events.slice(after + 1);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            events: page,
            cursor: page.length > 0 ? page[page.length - 1]?.['id'] : (from ?? 'quiet-0'),
            latestLedger: 4507159,
            oldestLedger: 4386200,
            latestLedgerCloseTime: '1784671886',
            oldestLedgerCloseTime: '1784066056',
          },
        }),
      );
    })();
  });
  await new Promise<void>((up) => feed.listen(0, '127.0.0.1', up));
  const feedPort = (() => {
    const address = feed.address();
    if (address === null || typeof address === 'string') throw new Error('the feed took no port');
    return address.port;
  })();

  // The receiver. It writes what it accepted before it answers, because the
  // answer is what moves the listener's position.
  const accepted: string[] = [];
  let refuseAfter = ACCEPT_BEFORE_KILL;
  const receiver = createServer((request, response) => {
    void (async () => {
      const id = eventId(await body(request));
      if (id === null) {
        response.writeHead(400).end();
        return;
      }
      if (accepted.length >= refuseAfter) {
        // The listener must hold its position here rather than move past it.
        response.writeHead(500).end();
        return;
      }
      accepted.push(id);
      response.writeHead(204).end();
    })();
  });
  await new Promise<void>((up) => receiver.listen(0, '127.0.0.1', up));
  const receiverPort = (() => {
    const address = receiver.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the receiver took no port');
    }
    return address.port;
  })();

  const environment = {
    ...process.env,
    FEEPAYER_CHANNELS: 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB',
    RPC_URL: `http://127.0.0.1:${feedPort}`,
    WEBHOOK_URL: `http://127.0.0.1:${receiverPort}`,
    LISTENER_STATE_FILE: statePath,
    LISTENER_START_LEDGER: '4494450',
  };

  /** Run the listener as a real process, and give back how it ended. */
  function run(
    kill: boolean,
  ): Promise<{ code: number | null; signal: string | null; said: string }> {
    return new Promise((done) => {
      const child = spawn(process.execPath, [LISTEN], {
        env: environment,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      // A child that dies of its own accord must say why. A check that hides
      // the reason turns one failure into a second investigation, which is
      // what the first version of this check did to me.
      let said = '';
      child.stderr.on('data', (chunk: Buffer) => {
        said += String(chunk);
      });
      if (kill) {
        const watch = setInterval(() => {
          if (accepted.length >= ACCEPT_BEFORE_KILL) {
            clearInterval(watch);
            // SIGKILL, so the process gets no chance to write on the way out.
            // What survives is what it wrote before this moment.
            child.kill('SIGKILL');
          }
        }, 5);
        child.on('exit', () => clearInterval(watch));
      }
      child.on('close', (code, signal) => done({ code, signal, said }));
    });
  }

  try {
    const first = await run(true);
    console.log(`first life  accepted ${accepted.length}, ended by ${first.signal ?? first.code}`);
    if (first.signal !== 'SIGKILL') {
      throw new Error(
        `the check did not kill the listener, so it proves nothing. ` +
          `It ended with ${first.code} and said: ${first.said.trim() || 'nothing'}`,
      );
    }
    const held = readPosition(statePath);
    console.log(`position    ${held?.cursor ?? 'none'}`);
    if (held === null) {
      throw new Error('the killed listener left no position, so a restart repeats everything');
    }

    const beforeRestart = [...accepted];
    refuseAfter = EVENT_COUNT;
    const second = await run(false);
    console.log(`second life accepted ${accepted.length}, ended with ${second.code}`);

    const unique = new Set(accepted);
    console.log(`delivered   ${accepted.length} messages, ${unique.size} of them different`);
    if (unique.size !== accepted.length) {
      const twice = accepted.filter((id, at) => accepted.indexOf(id) !== at);
      throw new Error(`a restart delivered ${twice.join(', ')} twice`);
    }
    if (unique.size !== EVENT_COUNT) {
      throw new Error(`the receiver saw ${unique.size} of ${EVENT_COUNT} redemptions`);
    }
    for (const id of beforeRestart) {
      if (accepted.indexOf(id) >= beforeRestart.length) {
        throw new Error(`${id} arrived again after the restart`);
      }
    }
    console.log('a killed listener repeats nothing and loses nothing');
  } finally {
    feed.close();
    receiver.close();
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
