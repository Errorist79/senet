/**
 * Run the service.
 *
 * It listens on the loopback interface. The web server in front of it
 * terminates TLS and proxies `/api/`.
 *
 *   ENV_FILE=/path/to/.env npm start --workspace @senet/server
 */
import { createServer } from 'node:http';
import { rpc } from '@stellar/stellar-sdk';
import {
  FeePayer,
  MIN_CHANNEL_BALANCE_STROOPS,
  createApiHandler,
  loadEnvFile,
  readConfig,
} from '../src/index.js';

/** The port the service listens on when the environment names none. */
const DEFAULT_PORT = 8791;

/** The interface the service listens on when the environment names none. */
const DEFAULT_HOST = '127.0.0.1';

async function main(): Promise<void> {
  loadEnvFile();
  const config = readConfig();
  const port = Number(process.env['API_PORT'] ?? DEFAULT_PORT);
  const host = process.env['API_HOST'] ?? DEFAULT_HOST;

  const feePayer = await new FeePayer(config).start();
  const server = new rpc.Server(config.rpcUrl);
  const service = createServer(createApiHandler({ config, feePayer, server }));

  service.on('error', (failure: NodeJS.ErrnoException) => {
    if (failure.code === 'EADDRINUSE') {
      console.error(`${host}:${port} is already in use. Stop that service, or set API_PORT.`);
    } else {
      console.error(`the service could not listen on ${host}:${port}: ${failure.message}`);
    }
    process.exitCode = 1;
  });

  service.listen(port, host, () => {
    console.log(`senet service on http://${host}:${port}`);
    console.log(`  contract   ${config.voucher.contractId}`);
    console.log(`  token      ${config.voucher.tokenId}`);
    console.log(`  channels   ${feePayer.addresses.join(', ')}`);
    const limits = feePayer.contractLimits;
    if (limits !== null) {
      console.log(`  limits     ${limits.maxAmountStroops} stroops, ${limits.maxTtlLedgers} ledgers`);
    }
  });

  const low = await feePayer.lowChannels();
  for (const address of low) {
    console.log(`  LOW        ${address} holds less than ${MIN_CHANNEL_BALANCE_STROOPS} stroops`);
  }
}

await main();
