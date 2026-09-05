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
//
// The command that archives a row from a browser is its twin, and the body that
// both of them run lives in `evidence-set.mjs`. The two differ in the tree they
// write to and in who made the row.

import { DEVICE_CHECK_DIR, archiveScreenRow, loadEnv } from './evidence-set.mjs';

/** The screens that a device row can come from. */
const SCREENS = ['account', 'payer', 'merchant'];

// This command produces no fixed set of rows, and that is the honest answer
// rather than a missing one. Every row here comes from a hash that a person
// carried back from a phone, so the names cannot be known before the run. The
// rows it writes are marked as device rows, and a check exempts those on the
// ground that no script can produce a passkey signature.
if (process.argv.includes('--list')) process.exit(0);

loadEnv();

await archiveScreenRow({
  dir: DEVICE_CHECK_DIR,
  producer: 'device',
  namePrefix: 'device',
  producedBy: 'scripts/archive-device-row.mjs',
  screens: SCREENS,
  argv: process.argv.slice(2),
  notes: {
    account:
      'A person created an account on a phone. The passkey of that phone is the '
      + 'only key that signs for it.',
    redeem: (redeem) =>
      redeem.payer === redeem.recipient
        ? 'A phone signed this voucher with a passkey. The payer then voided it, '
          + 'and redeemed it to their own address.'
        : 'A phone signed this voucher with a passkey. A second phone scanned the '
          + 'code and redeemed it to an address that the payer never saw.',
  },
});
