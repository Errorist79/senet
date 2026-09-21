// Refresh the archive of every transaction that the trees name.
//
// This command reads the network and updates transaction archives.
// An incomplete refresh preserves complete historical evidence and reports a failure.
// It skips manifests that explicitly mark a derived analysis.
// Run the producer that the analysis manifest names to update that analysis.
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
let transactionTrees = 0;
const problems = [];
for (const dir of trees) {
  console.log(`\n${path.basename(dir)}`);
  const header = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (header?.kind === 'derived-analysis') {
    if (typeof header.producedBy !== 'string' || header.producedBy.length === 0 || !Array.isArray(header.rows)) {
      throw new Error(`${dir}: derived analysis needs a producer and rows`);
    }
    console.log(`  skipped derived analysis; run ${header.producedBy} to update it`);
    continue;
  }
  const manifest = readManifest(dir);
  transactionTrees += 1;
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

console.log(`\nread ${archived} transaction rows across ${transactionTrees} trees`);
for (const problem of problems) console.log(`PROBLEM: ${problem}`);
if (incomplete > 0) {
  console.log(`${incomplete} refresh result(s) lack complete RPC or Horizon evidence. Historical files can still contain the earlier evidence.`);
  process.exitCode = 1;
}
if (problems.length > 0) throw new Error('a screen showed a figure that the chain does not support');
