/**
 * Generate and fund a fresh set of testnet keys, and print the `.env` lines.
 *
 * The service must not inherit keys from anywhere else. This tool is the whole
 * procedure, and it creates every account role that the repository names. A
 * developer with an empty host reaches a running service, and the README is
 * the only document that they read.
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
  TESTNET_RPC_URL,
  accountBalanceStroops,
  friendbotFund,
  waitForFunds,
} from '../src/index.js';

/** Channel accounts to generate when the operator names no count. */
const DEFAULT_CHANNEL_COUNT = 6;

/** Generate one funded account. */
async function account(role: string): Promise<Keypair> {
  const keypair = Keypair.random();
  await friendbotFund(TESTNET_FRIENDBOT_URL, keypair.publicKey());
  const balance = await waitForFunds(() =>
    accountBalanceStroops(TESTNET_HORIZON_URL, keypair.publicKey()),
  );
  if (balance === null) {
    throw new Error(`${keypair.publicKey()} carries no balance after the funding`);
  }
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
  const submitter = await account('submitter');
  const merchant = await account('merchant');
  const secondMerchant = await account('merchant 2');

  console.error('');
  console.error('Paste the lines below into the .env file on the host.');
  console.log(`FEEPAYER_CHANNELS=${channels.map((key) => key.secret()).join(',')}`);
  console.log(`PAYER_SECRET=${payer.secret()}`);
  console.log(`SUBMITTER_SECRET=${submitter.secret()}`);
  // A merchant receives funds and it signs nothing, so the file keeps its
  // address. A secret for an account that never signs is a liability with no
  // purpose. The payer's address is absent for a related reason, because it
  // derives from the secret, and a copy can disagree with its own source.
  console.log(`MERCHANT_ADDRESS=${merchant.publicKey()}`);
  console.log(`SECOND_MERCHANT_ADDRESS=${secondMerchant.publicKey()}`);
  console.log(`SEP7_SIGNING_SECRET=${Keypair.random().secret()}`);
  console.log('CONTRACT_ID=');
  console.log(`RPC_URL=${TESTNET_RPC_URL}`);
  console.log(`HORIZON_URL=${TESTNET_HORIZON_URL}`);
  console.error('Publish the SEP-7 public key at your HTTPS origin before you use signed payment requests.');
}

await main();
