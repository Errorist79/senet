// Archive one row that a person made in a browser, against the public name.
//
// A script cannot produce such a row. The application builds the transaction
// in the page, and a passkey signs it. A person carries back the hash and what
// the screen said. Everything else sits in the transaction, so this command
// reads it from the network and compares the two.
//
//   node scripts/archive-app-row.mjs <hash> \
//     --screen merchant \
//     --title "Paid" \
//     --advice "The ledger holds the payment. Give the goods to the payer." \
//     --value "Ledger=4494766" --value "Fee charged=0.0027364 XLM"
//
// The command writes nothing until a caller asks for it. It first prints the
// row that it would write, and it compares every figure that a person read
// against the chain. Add `--write` to archive the row.
//
// The command that archives a row from a phone is its twin, and the body that
// both of them run lives in `evidence-set.mjs`. The two differ in the tree they
// write to and in who made the row.

import { APP_CHECK_DIR, archiveScreenRow, loadEnv } from './evidence-set.mjs';

/** The screens that an application row can come from. */
const SCREENS = ['account', 'payer', 'merchant'];

// This command produces no fixed set of rows, and that is the honest answer
// rather than a missing one. Every row here comes from a hash that a person
// carried back from a browser, so the names cannot be known before the run.
// This command marks each row that it writes as a browser row, and a check
// exempts those, because no script can produce a passkey signature.
if (process.argv.includes('--list')) process.exit(0);

loadEnv();

await archiveScreenRow({
  dir: APP_CHECK_DIR,
  producer: 'browser',
  namePrefix: 'app',
  producedBy: 'scripts/archive-app-row.mjs',
  screens: SCREENS,
  argv: process.argv.slice(2),
  notes: {
    account:
      'A person created a passkey account in a browser on the public name. The '
      + 'registration signed the deployment, the fee-payer service paid for it, and '
      + 'the account screen showed the account and its balance.',
    redeem: (redeem) =>
      redeem.payer === redeem.recipient
        ? 'The application built the transaction in a browser and submitted it '
          + 'through the fee-payer service. The payer voided the voucher to their '
          + 'own address.'
        : 'The application built the transaction in a browser and submitted it '
          + 'through the fee-payer service. The merchant screen showed the result.',
  },
});
