// Archive one redemption that a person made on a phone.
//
// A script cannot produce such a row, because a passkey signature needs a
// person, a device and a gesture. What a person carries back from a run is the
// transaction hash and what they read on the screen. Everything else sits in
// the transaction, so this command reads it from the network.
//
//   node scripts/archive-device-row.mjs <hash> \
//     --screen merchant \
//     --title "Paid" \
//     --advice "The ledger holds the payment. Give the goods to the payer." \
//     --value "Ledger=4494766" --value "Fee charged=0.0027364 XLM"
//
// The command writes nothing until a caller asks for it. It first prints the row
// that it would write, and it compares every figure that a person read against
// the chain. Add `--write` to archive the row. A test run leaves a person tired,
// and a command that writes first and reports second archives the wrong thing.

import fs from 'node:fs';
import path from 'node:path';
import { Networks } from '@stellar/stellar-sdk';
import {
  DEVICE_CHECK_DIR, ENDPOINTS, archiveRow, compareShownToChain, describeRedeem,
  deriveShownClaims, loadEnv, readManifest, writeManifest,
} from './evidence-set.mjs';

/** The screens that a device row can come from. */
const SCREENS = ['account', 'payer', 'merchant'];

/** How many characters of a hash name a row that carries no voucher. */
const HASH_NAME_LENGTH = 12;

function usage(problem) {
  console.error(`${problem}\n`);
  console.error('  node scripts/archive-device-row.mjs <hash> --screen <name> \\');
  console.error('    --title "<what the screen said>" --advice "<the sentence under it>" \\');
  console.error('    [--value "Label=value"] [--note "<what this row shows>"] [--write]');
  console.error(`\n  a screen is one of: ${SCREENS.join(', ')}`);
  process.exit(1);
}

function readArguments(argv) {
  const [hash, ...rest] = argv;
  if (hash === undefined) usage('name the transaction hash');
  const options = { hash, values: {}, write: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--write') {
      options.write = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) usage(`${flag} carries no value`);
    index += 1;
    if (flag === '--screen') options.screen = value;
    else if (flag === '--title') options.title = value;
    else if (flag === '--advice') options.advice = value;
    else if (flag === '--note') options.note = value;
    else if (flag === '--value') {
      const split = value.indexOf('=');
      if (split < 1) usage(`--value takes "Label=value", and it carries ${value}`);
      options.values[value.slice(0, split)] = value.slice(split + 1);
    } else usage(`${flag} is not an option of this command`);
  }
  if (!/^[0-9a-f]{64}$/.test(options.hash)) usage(`${options.hash} is not a transaction hash`);
  if (options.screen === undefined) usage('name the screen with --screen');
  if (!SCREENS.includes(options.screen)) usage(`--screen takes one of: ${SCREENS.join(', ')}`);
  if (options.title === undefined) usage('give the title with --title');
  if (options.advice === undefined) usage('give the sentence with --advice');
  return options;
}

/** What an account row shows. A deployment carries no voucher and no recipient. */
function noteForAccount() {
  return 'A person created an account on a phone. The passkey of that phone is '
    + 'the only key that signs for it.';
}

/** What the row shows, taken from the transaction rather than from a person. */
function noteFor(redeem) {
  if (redeem.payer === redeem.recipient) {
    return 'A phone signed this voucher with a passkey. The payer then voided it, '
      + 'and redeemed it to their own address.';
  }
  return 'A phone signed this voucher with a passkey. A second phone scanned the '
    + 'code and redeemed it to an address that the payer never saw.';
}

loadEnv();
const options = readArguments(process.argv.slice(2));

const described = await describeRedeem(options.hash);
if (described === null) {
  console.error(`the network holds no transaction ${options.hash}`);
  console.error('A hash that a phone showed reaches the network within a few seconds.');
  console.error('The RPC server keeps about seven days, so an older run needs Horizon.');
  process.exit(1);
}
// The account screen deploys an account, which calls no contract function. Every
// other screen redeems, and a row from one of those has to be a redemption.
const isAccount = options.screen === 'account';
if (!isAccount && described.redeem === null) {
  const called = described.functionName ?? described.hostFunction;
  console.error(`${options.hash} carries ${called}, and a ${options.screen} row needs a redeem`);
  process.exit(1);
}
if (isAccount && described.redeem !== null) {
  console.error(`${options.hash} is a redemption, so it is not an account row`);
  process.exit(1);
}

const configuredContract = process.env.CONTRACT_ID;
const { redeem } = described;
// A redemption takes its name from the voucher that both parties share. A
// deployment has no voucher, so it takes the first characters of its own hash.
const name = isAccount
  ? `device-account-${options.hash.slice(0, HASH_NAME_LENGTH)}`
  : `device-${options.screen}-${redeem.voucherId}`;
const row = {
  name,
  hash: options.hash,
  note: options.note ?? (isAccount ? noteForAccount() : noteFor(redeem)),
  producer: 'device',
  screen: options.screen,
  ...(described.contractId === null ? {} : { contractId: described.contractId }),
  shown: { title: options.title, advice: options.advice, values: options.values },
};

// The archive step needs the Horizon summary to compare a figure that a person
// read, so the preview asks for it before anything reaches disk.
const summary = await fetch(`${ENDPOINTS.horizonUrl}/transactions/${options.hash}`);
const horizon = summary.ok ? await summary.json() : null;
const shown = compareShownToChain(options.values, horizon, options.hash);

console.log(`\nthis command would write ${name}`);
console.log(`  into        scripts/out/device-check/`);
console.log(`  hash        ${options.hash}`);
console.log(`  contract    ${described.contractId ?? 'none, this transaction deploys one'}`);
// The account that pays for a deployment signs it. The passkey of the new
// account signs nothing here, so a note about the scheme would mislead.
console.log(`  signature   ${described.signature}${isAccount || described.signature === 'secp256r1' ? '' : '   NOT A PASSKEY'}`);
if (isAccount) {
  console.log(`  deployer    ${described.payer}`);
} else {
  console.log(`  payer       ${redeem.payer}`);
  console.log(`  recipient   ${redeem.recipient}${redeem.payer === redeem.recipient ? '   the payer voided it' : ''}`);
  console.log(`  amount      ${redeem.amount} stroops`);
  console.log(`  voucher     ${redeem.voucherId}`);
}
console.log(`  ledger      ${horizon?.ledger ?? 'unknown'}`);
console.log(`  outcome     ${horizon?.successful === true ? 'SUCCESS' : 'FAILED'}`);
console.log(`  note        ${row.note}`);
console.log(`  screen      ${options.title} / ${options.advice}`);
console.log(`  figures     ${shown.checked} compared against the chain`);
for (const problem of shown.problems) console.log(`  PROBLEM     ${problem}`);

if (configuredContract !== undefined && described.contractId !== null
  && described.contractId !== configuredContract) {
  console.log(`  NOTE        this contract is not the one that .env names, ${configuredContract}`);
}

if (shown.problems.length > 0) {
  console.error('\nnothing written. A figure on the screen does not match the chain.');
  process.exit(1);
}

if (!options.write) {
  console.log('\nnothing written. Add --write to archive this row.');
  process.exit(0);
}

const manifest = fs.existsSync(path.join(DEVICE_CHECK_DIR, 'manifest.json'))
  ? readManifest(DEVICE_CHECK_DIR)
  : {
      network: process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET,
      contractId: described.contractId ?? configuredContract ?? '',
      producedAt: new Date().toISOString(),
      rows: [],
    };

const rows = manifest.rows.filter((each) => each.name !== name).concat([row]);
rows.sort((left, right) => left.name.localeCompare(right.name));
const written = { ...manifest, producedAt: new Date().toISOString(), rows };

await archiveRow(DEVICE_CHECK_DIR, row, written.contractId, ENDPOINTS);
writeManifest(DEVICE_CHECK_DIR, written);

const checked = deriveShownClaims(DEVICE_CHECK_DIR, written);
console.log(`\narchived ${name}`);
console.log(`  the tree now holds ${written.rows.length} rows`);
console.log(`  ${checked.checked} figures across the tree match the chain`);
for (const problem of checked.problems) console.log(`  PROBLEM ${problem}`);
if (checked.problems.length > 0) process.exitCode = 1;
