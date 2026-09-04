// Refresh the archive of every transaction that the manifest names.
//
// This command reads the network and rewrites the archive files. It produces
// no transaction. Run `scripts/run-evidence.mjs` to produce a new set.
//
// Run it with `node scripts/archive-evidence.mjs`.

import { archiveManifest, readManifest } from './evidence-set.mjs';

const manifest = readManifest();
const incomplete = await archiveManifest(manifest);

console.log(`\narchived ${manifest.rows.length} rows into scripts/out/evidence`);
if (incomplete > 0) {
  console.log(`${incomplete} row(s) carry no meta, because the RPC server dropped them.`);
  process.exitCode = 1;
}
