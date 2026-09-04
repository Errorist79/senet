// Refresh the archive of every transaction that the trees name.
//
// This command reads the network and rewrites the archive files. It produces no
// transaction, so it is safe to run at any time. Run `scripts/run-evidence.mjs`
// or `scripts/run-load-check.mjs` to produce a new set.
//
// Run it with `node scripts/archive-evidence.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import {
  ENDPOINTS, OUT_DIR, archiveManifest, deriveShownClaims, readManifest,
} from './evidence-set.mjs';

const trees = fs.existsSync(OUT_DIR)
  ? fs.readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(OUT_DIR, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'manifest.json')))
  : [];

if (trees.length === 0) throw new Error(`${OUT_DIR} holds no tree with a manifest`);

let incomplete = 0;
let archived = 0;
const problems = [];
for (const dir of trees) {
  console.log(`\n${path.basename(dir)}`);
  const manifest = readManifest(dir);
  incomplete += await archiveManifest(dir, manifest, ENDPOINTS);
  archived += manifest.rows.length;
  // A row that carries what a screen showed also carries a claim. The check
  // compares each figure against the chain, so no claim stays untested.
  const shown = deriveShownClaims(dir, manifest);
  if (shown.checked > 0) {
    console.log(`  checked ${shown.checked} figures that a screen showed`);
    problems.push(...shown.problems);
  }
}

console.log(`\narchived ${archived} rows across ${trees.length} trees`);
for (const problem of problems) console.log(`PROBLEM: ${problem}`);
if (incomplete > 0) {
  console.log(`${incomplete} row(s) carry no meta, because the RPC server dropped them.`);
  process.exitCode = 1;
}
if (problems.length > 0) throw new Error('a screen showed a figure that the chain does not support');
