/**
 * Generate and fund a fresh set of testnet keys, and print the `.env` lines.
 *
 * The service must not inherit keys from anywhere else. This tool is the whole
 * procedure. A developer with an empty host reaches a running service, and the
 * README is the only document that they read.
 *
 * It prints to standard output and it writes no file, so it can never lose a
 * key that a `.env` already holds. Read what it prints, then paste it in.
 *
 *   npm run new-keys --workspace @senet/server
 *   CHANNEL_COUNT=8 npm run new-keys --workspace @senet/server
 */
import { Keypair } from '@stellar/stellar-sdk';
import {
  TESTNET_FRIENDBOT_URL,
  TESTNET_HORIZON_URL,
  accountBalanceStroops,
} from '../src/index.js';

/** Channel accounts to generate when the operator names no count. */
const DEFAULT_CHANNEL_COUNT = 6;

/** How many times the tool asks Horizon whether an account exists. */
const CONFIRM_ATTEMPTS = 10;

/** How long the tool waits between two of those questions, in milliseconds. */
const CONFIRM_INTERVAL_MS = 1000;

/** Ask friendbot to create and fund one account. */
async function fund(address: string): Promise<void> {
  const response = await fetch(`${TESTNET_FRIENDBOT_URL}?addr=${address}`);
  // Friendbot answers 400 when the account already exists. That is not a
  // failure here, because the account then holds a balance already.
  if (!response.ok && response.status !== 400) {
    throw new Error(`friendbot answered ${response.status} for ${address}`);
  }
}

/** Wait until Horizon reports a balance, so the caller knows the key works. */
async function confirm(address: string): Promise<bigint> {
  for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt += 1) {
    const balance = await accountBalanceStroops(TESTNET_HORIZON_URL, address);
    if (balance !== null) return balance;
    await new Promise((wake) => setTimeout(wake, CONFIRM_INTERVAL_MS));
  }
  throw new Error(`${address} carries no balance after friendbot funded it`);
}

/** Generate one funded account. */
async function account(role: string): Promise<Keypair> {
  const keypair = Keypair.random();
  await fund(keypair.publicKey());
  const balance = await confirm(keypair.publicKey());
  console.error(`${role.padEnd(10)} ${keypair.publicKey()} ${balance} stroops`);
  return keypair;
}

async function main(): Promise<void> {
  const count = Number(process.env['CHANNEL_COUNT'] ?? DEFAULT_CHANNEL_COUNT);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`CHANNEL_COUNT is ${count}, and it must be a whole number above zero`);
  }
  console.error('funding fresh testnet accounts');

  const channels: Keypair[] = [];
  for (let index = 0; index < count; index += 1) {
    // One at a time, because friendbot rate limits a burst.
    channels.push(await account(`channel ${index + 1}`));
  }
  const payer = await account('payer');
  const recipient = await account('recipient');

  console.error('');
  console.error('Paste the lines below into the .env file on the host.');
  console.log(`FEEPAYER_CHANNELS=${channels.map((key) => key.secret()).join(',')}`);
  console.log(`PAYER_SECRET=${payer.secret()}`);
  console.log(`PAYER_PUBLIC=${payer.publicKey()}`);
  console.log(`RECIPIENT=${recipient.publicKey()}`);
}

await main();
