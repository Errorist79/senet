// Extend the shared ledger entries before a user request has to.
//
//   ENV_FILE=/opt/senet/.env OPERATOR_SECRET=... node deploy/extend-ttl.mjs
//
// The timer `senet-extend-ttl.timer` runs this every hour. It reads the TTL of
// the voucher instance, the voucher code and the shared wallet code. It extends
// each entry to the maximum TTL when a user request would pay for that
// extension within two days.
//
// The voucher contract extends its instance and code to 30 days during a
// redemption, when less than one day remains. Source:
// `contracts/senet-voucher/src/lib.rs`, `INSTANCE_TTL_THRESHOLD_LEDGERS` and
// `INSTANCE_TTL_EXTEND_TO_LEDGERS`. The passkey-kit wallet extends its instance
// and its shared code to the maximum TTL during an authentication. It does so
// when the entry sits more than 120,960 ledgers below the maximum. Source: passkey-kit
// `contracts/smart-wallet/src/storage.rs`. `deploy/ttl-policy.mjs` turns both
// rules into numbers, and `deploy/verify.mjs` reads the same numbers.
//
// An operator account pays. It is a testnet account that friendbot funds, and
// its secret lives only on the host, in `OPERATOR_SECRET`. This script prints
// the public key and never the secret.
//
// Friendbot funds only an account that does not exist yet. A low balance
// therefore gets a new account from friendbot, which then merges into the
// operator account.
//
// A failure ends the run with a status other than zero, and systemd records
// the unit as failed. If the timer stops, `deploy/verify.mjs` fails one day
// before a request would pay.

import {
  Contract, Keypair, Operation, SorobanDataBuilder, TransactionBuilder, rpc, xdr,
} from '@stellar/stellar-sdk';
import {
  STROOPS_PER_XLM, accountBalanceStroops, friendbotFund, loadEnvFile, readConfig,
} from '@senet/server';
import { LEDGERS_PER_DAY, TIMER_LEAD_LEDGERS, maxTtl, sharedEntries } from './ttl-policy.mjs';

/**
 * The balance below which the operator account gets a top-up, in stroops.
 *
 * The largest extension of one run takes the shared wallet code from nothing
 * to the maximum TTL. At 10,000 stroops per KB, the highest rent rate below
 * the target state size, that costs about 650 XLM. 2,000 XLM covers it three
 * times.
 */
const OPERATOR_MIN_BALANCE_STROOPS = 2_000n * STROOPS_PER_XLM;

/** The inclusion bid of each operator transaction, in stroops. */
const OPERATOR_INCLUSION_FEE_STROOPS = '10000';

/** How many times the script asks whether a transaction reached a ledger. */
const RESULT_ATTEMPTS = 30;

/** How long the script waits between two of those questions, in milliseconds. */
const RESULT_INTERVAL_MS = 2000;

loadEnvFile();
const config = readConfig();
const secret = process.env['OPERATOR_SECRET'];
if (secret === undefined || secret === '') {
  throw new Error('the environment holds no OPERATOR_SECRET. The unit reads it from /opt/senet/operator.env.');
}
const operator = Keypair.fromSecret(secret);
const chain = new rpc.Server(config.rpcUrl);
const network = config.voucher.network;
console.log(`operator ${operator.publicKey()}`);

/** Wait until the network knows an account. */
async function waitForAccount(address) {
  for (let attempt = 0; attempt < RESULT_ATTEMPTS; attempt += 1) {
    try {
      return await chain.getAccount(address);
    } catch {
      await new Promise((done) => { setTimeout(done, RESULT_INTERVAL_MS); });
    }
  }
  throw new Error(`the network never showed the account ${address}`);
}

/** Sign one transaction with one key, send it, and wait for its ledger. */
async function submit(transaction, signer, label) {
  transaction.sign(signer);
  const sent = await chain.sendTransaction(transaction);
  if (sent.status !== 'PENDING') {
    throw new Error(`${label}: the network refused the transaction with ${sent.status}`);
  }
  for (let attempt = 0; attempt < RESULT_ATTEMPTS; attempt += 1) {
    const result = await chain.getTransaction(sent.hash);
    if (result.status === 'SUCCESS') {
      console.log(`${label} ${sent.hash} in ledger ${result.ledger}, declared fee ${transaction.fee}`);
      return;
    }
    if (result.status === 'FAILED') throw new Error(`${label}: transaction ${sent.hash} failed`);
    await new Promise((done) => { setTimeout(done, RESULT_INTERVAL_MS); });
  }
  throw new Error(`${label}: transaction ${sent.hash} reached no ledger`);
}

/** Simulate, assemble, sign and send one Soroban operation from the operator. */
async function sendSoroban(operation, data, label) {
  const source = await chain.getAccount(operator.publicKey());
  const raw = new TransactionBuilder(source, { fee: OPERATOR_INCLUSION_FEE_STROOPS, networkPassphrase: network })
    .addOperation(operation).setSorobanData(data).setTimeout(60).build();
  const simulation = await chain.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(simulation)) throw new Error(`${label}: ${simulation.error}`);
  await submit(rpc.assembleTransaction(raw, simulation).build(), operator, label);
}

/** Create the operator account, or top it up when its balance runs low. */
async function fundOperator() {
  const balance = await accountBalanceStroops(config.horizonUrl, operator.publicKey());
  if (balance === null) {
    await friendbotFund(config.friendbotUrl, operator.publicKey());
    await waitForAccount(operator.publicKey());
    console.log('friendbot created the operator account');
    return;
  }
  console.log(`balance  ${balance / STROOPS_PER_XLM} XLM`);
  if (balance >= OPERATOR_MIN_BALANCE_STROOPS) return;
  const donor = Keypair.random();
  if (!(await friendbotFund(config.friendbotUrl, donor.publicKey()))) {
    throw new Error('friendbot refused to fund a new account for the top-up');
  }
  const source = await waitForAccount(donor.publicKey());
  const merge = new TransactionBuilder(source, { fee: OPERATOR_INCLUSION_FEE_STROOPS, networkPassphrase: network })
    .addOperation(Operation.accountMerge({ destination: operator.publicKey() })).setTimeout(60).build();
  await submit(merge, donor, 'top-up');
}

const archival = (await chain.getLedgerEntries(xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({
  configSettingId: xdr.ConfigSettingId.configSettingStateArchival(),
})))).entries[0]?.val.configSetting().stateArchivalSettings();
if (archival === undefined) throw new Error('the RPC holds no state archival settings');
const maxEntryTtl = archival.maxEntryTtl();

const instanceKey = new Contract(config.voucher.contractId).getFootprint();
const [instance] = (await chain.getLedgerEntries(instanceKey)).entries;
if (instance === undefined) throw new Error(`the RPC holds no instance of ${config.voucher.contractId}`);
const voucherCodeHash = instance.val.contractData().val().instance().executable().wasmHash();
const entries = sharedEntries(
  { contractId: config.voucher.contractId, voucherCodeHash, walletWasmHash: config.walletWasmHash },
  maxEntryTtl,
);
const keyOf = (entry) => (entry.kind === 'instance'
  ? instanceKey
  : xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(entry.id, 'hex') })));

const head = (await chain.getLatestLedger()).sequence;
const found = (await chain.getLedgerEntries(...entries.map(keyOf))).entries;
const liveUntil = new Map(found.map((one) => [one.key.toXDR('base64'), one.liveUntilLedgerSeq]));
const archived = [];
const due = [];
for (const entry of entries) {
  const key = keyOf(entry);
  const until = liveUntil.get(key.toXDR('base64'));
  if (until === undefined) throw new Error(`the RPC holds no entry for ${entry.name}`);
  const left = until - head;
  const isDue = left < entry.window + TIMER_LEAD_LEDGERS;
  console.log(`${entry.name.padEnd(22)} ${(left / LEDGERS_PER_DAY).toFixed(1)} days left, `
    + `a request pays below ${(entry.window / LEDGERS_PER_DAY).toFixed(1)}, ${isDue ? 'due' : 'not due'}`);
  if (left < 0) archived.push(key);
  if (isDue) due.push(key);
}

if (due.length === 0) {
  console.log('nothing is due');
} else {
  await fundOperator();
  if (archived.length > 0) {
    await sendSoroban(Operation.restoreFootprint({}), new SorobanDataBuilder().setReadWrite(archived).build(), 'restore');
  }
  await sendSoroban(
    Operation.extendFootprintTtl({ extendTo: maxTtl(maxEntryTtl) }),
    new SorobanDataBuilder().setReadOnly(due).build(),
    `extend ${due.length} entries to ${maxTtl(maxEntryTtl)} ledgers`,
  );
}
