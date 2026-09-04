import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Networks } from '@stellar/stellar-sdk';
import { TESTNET_CONTRACT_ID, nativeTokenId } from '@senet/core';
import type { VoucherConfig } from '@senet/core';

/** The Soroban RPC that the service reads and submits through. */
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';

/** Horizon, which serves the balance of a classic account. */
export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/** Everything that the service needs to run. */
export interface ServerConfig {
  /** The chain identities that the library binds a voucher to. */
  readonly voucher: VoucherConfig;
  readonly rpcUrl: string;
  readonly horizonUrl: string;
  /** One funded secret key per channel account. */
  readonly channelSecrets: readonly string[];
}

/**
 * Read a `.env` file into the process environment.
 *
 * The keys stay on the host and they never enter the repository. `ENV_FILE`
 * names the file when the working directory is not the one that holds it. A
 * missing file is not a failure, because a deployment may set the variables
 * another way.
 */
export function loadEnvFile(path?: string): void {
  const file = path ?? process.env['ENV_FILE'] ?? resolve(process.cwd(), '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Read a variable that the service cannot run without. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set, and the service cannot start without it`);
  }
  return value;
}

/** Read a variable that carries a default. */
function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * Build the configuration from the environment.
 *
 * The channel secrets are the one value with no default. A service with no
 * channel account cannot pay a fee, so it refuses to start rather than fail on
 * the first request.
 */
export function readConfig(): ServerConfig {
  const network = optional('NETWORK_PASSPHRASE', Networks.TESTNET);
  const channelSecrets = required('FEEPAYER_CHANNELS')
    .split(',')
    .map((secret) => secret.trim())
    .filter((secret) => secret !== '');
  if (channelSecrets.length === 0) {
    throw new Error('FEEPAYER_CHANNELS is empty, and the service cannot pay any fee');
  }
  if (new Set(channelSecrets).size !== channelSecrets.length) {
    throw new Error(
      'FEEPAYER_CHANNELS names one key twice. Two channels that share a key ' +
        'share a sequence number, and every second transaction fails.',
    );
  }
  return {
    voucher: {
      network,
      contractId: optional('CONTRACT_ID', TESTNET_CONTRACT_ID),
      tokenId: optional('TOKEN_ID', nativeTokenId(network)),
    },
    rpcUrl: optional('RPC_URL', TESTNET_RPC_URL),
    horizonUrl: optional('HORIZON_URL', TESTNET_HORIZON_URL),
    channelSecrets,
  };
}
