// Receive the listener's webhook messages and write down what arrived.
//
//   node scripts/webhook-receiver.mjs [--port 8792] [--dir scripts/out/webhook]
//
// The listener posts one message per redemption. This command is the other end
// of that post during an evidence run. It answers every request, and it stores
// the request rather than a note that a request happened.
//
// It stores the body byte for byte. A receiver that parsed the message and
// stored the fields would record what it understood, and the claim in the
// evidence is that a particular message arrived, not that a reader of it
// reached particular conclusions.
//
// It is a capture tool for a measured run. It is not the merchant's endpoint
// and it authenticates nobody.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Where a capture goes when the caller names no directory. */
const DEFAULT_DIR = path.join('scripts', 'out', 'webhook');

/** The port that the receiver listens on when the caller names none. */
const DEFAULT_PORT = 8792;

/** The loopback address. The receiver never faces the public network. */
const HOST = '127.0.0.1';

/** A body larger than this is refused rather than held in memory. */
const BODY_LIMIT_BYTES = 64 * 1024;

function readArguments(argv) {
  const options = { port: DEFAULT_PORT, dir: DEFAULT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      console.error(`${flag} carries no value`);
      process.exit(1);
    }
    index += 1;
    if (flag === '--port') options.port = Number(value);
    else if (flag === '--dir') options.dir = value;
    else {
      console.error(`${flag} is not an option of this command`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    console.error(`${options.port} is not a port`);
    process.exit(1);
  }
  return options;
}

/** Read the body, refusing one that is too large to be a redemption message. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error(`the body passed ${BODY_LIMIT_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/**
 * Name a capture after the voucher that it reports.
 *
 * A message that names no voucher still gets a file, named after its digest.
 * A run that captures nothing because it could not name something is worse
 * than a run that captures a message it did not understand.
 */
function nameFor(body, digest, receivedAt) {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.voucher_id === 'string') {
      return `webhook-${parsed.voucher_id}`;
    }
  } catch {
    // The body is not JSON. The digest still names it, and the file still holds
    // every byte, so a person can see what the listener actually sent.
  }
  return `webhook-${receivedAt.replaceAll(':', '').replace(/\..*/, '')}-${digest.slice(0, 8)}`;
}

const options = readArguments(process.argv.slice(2));
mkdirSync(options.dir, { recursive: true });

let count = 0;

const server = createServer(async (request, response) => {
  const receivedAt = new Date().toISOString();
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`${receivedAt}  REFUSED  ${detail}`);
    response.writeHead(413).end();
    return;
  }

  const digest = createHash('sha256').update(body).digest('hex');
  const headers = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(', ');
  }

  const delivery = {
    receivedAt,
    method: request.method ?? '',
    path: request.url ?? '',
    headers,
    bodySha256: digest,
    body: body.toString('utf8'),
  };

  const name = nameFor(body, digest, receivedAt);
  const file = path.join(options.dir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(delivery, null, 2)}\n`);
  count += 1;

  console.log(`${receivedAt}  ${delivery.method} ${delivery.path}  ${body.length} bytes  -> ${file}`);

  // The listener treats a failed post as undelivered and retries, so this
  // answer decides whether the cursor moves. It answers only after the capture
  // reaches the disk, because a message that this command accepted and lost is
  // a message that nothing will send again.
  response.writeHead(204).end();
});

server.listen(options.port, HOST, () => {
  console.log(`the receiver holds ${HOST}:${options.port}`);
  console.log(`captures go to ${options.dir}`);
  console.log('stop it with Ctrl-C\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nthe receiver captured ${count} messages`);
    server.close(() => process.exit(0));
  });
}
