/**
 * The redemption listener.
 *
 * It reads the contract's events and posts one message per redemption. Two
 * modes, one body of code:
 *
 *   npm run listen --workspace @senet/server            reads to the end and exits
 *   npm run listen --workspace @senet/server -- forever runs until it stops
 *
 * The first is what a written path runs, so every step of that path is a
 * command that ends. The second is what the service unit runs.
 *
 * A cursor that aged out ends the process with status 78 and does not restart
 * it. The network keeps about seven days of history. A cursor older than that
 * names a ledger that nobody holds, and every redemption in between is
 * unreadable. A listener that jumped to the present would drop those
 * redemptions and look healthy, which is the worst shape of this failure. It
 * is an incident, and it exits like one.
 */
import { rpc } from '@stellar/stellar-sdk';
import {
  EXIT_CURSOR_AGED_OUT,
  isCursorTooOld,
  isLoopbackUrl,
  loadEnvFile,
  postToWebhook,
  readConfig,
  readListenerConfig,
  readPosition,
  runListener,
} from '../src/index.js';
import type { RunUntil } from '../src/index.js';

async function main(): Promise<void> {
  loadEnvFile();
  const config = readConfig();
  const listener = readListenerConfig();
  const until: RunUntil = process.argv[2] === 'forever' ? 'forever' : 'quiet';
  // A plain HTTP endpoint passes only when it never leaves this machine.
  const server = new rpc.Server(config.rpcUrl, { allowHttp: isLoopbackUrl(config.rpcUrl) });

  // A first start with no position reads from the configured ledger, or from
  // the present. It never reads the whole chain.
  const held = readPosition(config.listenerStatePath);
  const firstLedger = listener.startLedger ?? (await server.getLatestLedger()).sequence;

  console.log(`contract   ${config.voucher.contractId}`);
  console.log(`webhook    ${listener.webhookUrl}`);
  console.log(`state      ${config.listenerStatePath}`);
  console.log(`from       ${held === null ? `ledger ${firstLedger}` : `cursor ${held.cursor}`}`);
  console.log(`mode       ${until}`);

  const outcome = await runListener(
    {
      server,
      contractId: config.voucher.contractId,
      statePath: config.listenerStatePath,
      deliver: postToWebhook(listener.webhookUrl),
    },
    until,
    firstLedger,
  );

  console.log(`polls      ${outcome.polls}`);
  console.log(`delivered  ${outcome.delivered}`);
  if (outcome.stuckOn !== null) {
    // The position did not move, so the feed still holds the event. The run
    // ends non-zero, so that a person or a pipeline sees the refusal.
    console.error(`stuck on   ${outcome.stuckOn}, which no receiver would take`);
    process.exitCode = 1;
    return;
  }
  console.log('caught up  the feed holds nothing newer');
}

try {
  await main();
} catch (caught) {
  if (isCursorTooOld(caught)) {
    console.error(
      'the stored cursor names a ledger that the network no longer keeps. ' +
        'Every redemption between that ledger and now is unreadable, so this ' +
        'listener stops rather than skip them. A person decides what to do.',
    );
    process.exit(EXIT_CURSOR_AGED_OUT);
  }
  throw caught;
}
