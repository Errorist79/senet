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
 * A failed poll ends the process, and the exit status tells the service
 * manager what to do next:
 *
 * - Status 78 means that the position aged out. The service manager does not
 *   restart the listener. The network keeps about seven days of history, and
 *   every redemption between the position and that window is unreadable. A
 *   listener that jumped to the present would drop those redemptions and look
 *   healthy, which is the worst shape of this failure. It is an incident, and
 *   it exits like one.
 * - Status 1 means any other failure. The service manager starts the listener
 *   again, and the listener resumes from its stored position. A restart
 *   therefore repeats no delivered redemption and skips none.
 *
 * The listener chooses between the two by a measurement of the ledger range,
 * and not by the code of the refusal. A wrong choice of status 1 costs a loop
 * of restarts, which the checks on the stored position report. A wrong choice
 * of status 78 stops the merchant feed until a person acts.
 */
import { rpc } from '@stellar/stellar-sdk';
import {
  EXIT_CURSOR_AGED_OUT,
  findAgedOut,
  isLoopbackUrl,
  loadEnvFile,
  postToWebhook,
  readConfig,
  readListenerConfig,
  readPosition,
  runListener,
} from '../src/index.js';
import type { RunOutcome, RunUntil } from '../src/index.js';

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

  let outcome: RunOutcome;
  try {
    outcome = await runListener(
      {
        server,
        contractId: config.voucher.contractId,
        statePath: config.listenerStatePath,
        deliver: postToWebhook(listener.webhookUrl),
      },
      until,
      firstLedger,
    );
  } catch (caught) {
    const agedOut = await findAgedOut(server, config.listenerStatePath, firstLedger);
    // Anything that the range does not prove leaves with status 1, and the
    // service manager starts the listener again.
    if (agedOut === null) throw caught;
    console.error(caught);
    console.error(
      `the listener reads from ledger ${agedOut.ledger}, and the network keeps ` +
        `nothing older than ledger ${agedOut.oldestKept}. Every redemption ` +
        'between those two ledgers is unreadable, so this listener stops rather ' +
        'than skip them. A person decides what to do.',
    );
    process.exit(EXIT_CURSOR_AGED_OUT);
  }

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

await main();
