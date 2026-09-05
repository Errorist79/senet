// Ask whether the code in the repository can still produce the archive it holds.
//
//   node scripts/check-reproducible.mjs
//
// The funded promise is that the whole evidence set re-runs with one command. A
// row can quietly outlive the code that made it: the archive keeps the row, the
// producer leaves the repository, and every other check still passes because
// every other check reads rows rather than producers. The archive then looks
// healthier the longer that goes unnoticed.
//
// That is not a hypothetical. It happened here for an hour. A committed row sat
// in the set while the code that produced it was absent from the repository,
// and nothing said so.
//
// This check reads both sides from `HEAD` rather than from the working tree.
// The promise is made to somebody who clones the repository, and a producer
// that exists only in an editor is a producer they do not get.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './evidence-set.mjs';

/**
 * Where `HEAD` is unpacked.
 *
 * It sits inside the repository on purpose. Node finds a package by walking up
 * from the file that imports it, so an export placed here resolves against the
 * dependencies that are already installed, and the check needs no install of
 * its own.
 */
const EXPORT_DIR = path.join(ROOT, '.reproducible-check');

/** Where the archive trees live, relative to the root of the repository. */
const ARCHIVE_ROOT = path.join('scripts', 'out');


/**
 * Find every archive tree in the export, and read the producer each one names.
 *
 * The list of producers is discovered rather than carried. A list inside this
 * file is read from the copy that happens to be running, so a producer added at
 * HEAD and missing from a stale copy leaves a whole tree silently unchecked.
 * That is not hypothetical: the first version of this check carried a list of
 * two while the repository held four trees, and it reported no failures over
 * forty four percent of the rows.
 *
 * Discovering them from the export leaves only this script unbootstrapped, and
 * a stale script is a loud failure rather than a quiet gap, because it is one
 * file that either runs or does not.
 */
function treesInExport() {
  const root = path.join(EXPORT_DIR, ARCHIVE_ROOT);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(ARCHIVE_ROOT, entry.name))
    .filter((tree) => existsSync(path.join(EXPORT_DIR, tree, 'manifest.json')));
}

let failures = 0;
let exempt = 0;
function check(condition, message) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!condition) failures += 1;
}

/** Unpack `HEAD` so that the check reads the repository and not the desk. */
function exportHead() {
  rmSync(EXPORT_DIR, { recursive: true, force: true });
  mkdirSync(EXPORT_DIR, { recursive: true });
  const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: ROOT, maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', EXPORT_DIR], { input: archive });
}

/**
 * Ask a producer which rows it would write.
 *
 * The producer answers for itself rather than being searched for names. A
 * search finds a string that looks like a row name and misses one that the code
 * builds from parts, and it cannot tell a live name from one in a comment.
 *
 * A listing must answer from the export alone. That is stronger than needing no
 * environment file, and it rules out one thing that is easy to miss: a value
 * imported from a workspace resolves through the installed dependencies, which
 * point at the working tree rather than at the export. A listing built from
 * such a value reports the names on somebody's desk while the archive beside it
 * came from a commit. A producer here therefore names what it produces without
 * importing it.
 */
function producedBy(command) {
  const output = execFileSync('node', [path.join(EXPORT_DIR, command), '--list'], {
    cwd: EXPORT_DIR,
    encoding: 'utf8',
  });
  return output.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

try {
  exportHead();

  console.log(`reading HEAD, unpacked into ${path.relative(ROOT, EXPORT_DIR)}\n`);

  const trees = treesInExport();
  console.log(`HEAD holds ${trees.length} archive trees\n`);

  for (const tree of trees) {
    const manifest = JSON.parse(readFileSync(path.join(EXPORT_DIR, tree, 'manifest.json'), 'utf8'));

    // A tree that names no producer is the gap this check exists to close. It
    // fails here rather than being skipped, because a skipped tree reads as a
    // tree with nothing wrong.
    const command = manifest.producedBy;
    if (typeof command !== 'string' || command === '') {
      check(false, `${tree} names no producer, so nothing can say whether HEAD still makes its ${manifest.rows.length} rows`);
      continue;
    }
    if (!existsSync(path.join(EXPORT_DIR, command))) {
      check(false, `${tree} names ${command}, which HEAD does not carry`);
      continue;
    }

    let claimed;
    try {
      claimed = producedBy(command);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      check(false, `${command} cannot say what it produces: ${detail.split('\n')[0]}`);
      continue;
    }
    console.log(`  ${command} produces ${claimed.length} rows`);
    console.log(`  ${tree} holds ${manifest.rows.length} rows\n`);
    const producer = { command, tree };

    for (const row of manifest.rows) {
      // A device row is one that no script can produce, because a passkey needs
      // a person. It is reproducible in the sense that matters: a command takes
      // the hash a person carried back and rebuilds the row from the chain.
      if (row.producer === 'device' || row.producer === 'browser') {
        // A person made this row, so its name arrives with the run and no
        // listing can carry it in advance. The gate for such a row is the one
        // above: the tree names a producer and that producer answers. There is
        // nothing further to test here, so this reports rather than pretends.
        //
        // It used to assert that the device command existed, which passed for
        // every tree while being true of only one. A row from a browser check
        // is not archived by the device command, and the line said it was.
        exempt += 1;
        console.log(`  --    ${row.name} is a ${row.producer} row, and ${command} cannot name it before the run`);
        continue;
      }
      check(claimed.includes(row.name),
        claimed.includes(row.name)
          ? `${row.name} is produced by ${producer.command}`
          : `${row.name} is in the archive and ${producer.command} does not produce it`);
    }

    // The other direction. A producer that claims a row the archive lacks means
    // the set was never fully run, which is a different fault and worth naming.
    for (const name of claimed) {
      if (!manifest.rows.some((row) => row.name === name)) {
        check(false, `${producer.command} produces ${name} and the archive does not hold it`);
      }
    }
  }

  console.log(`\n${failures} failed, ${exempt} rows exempt because a person made them`);
  if (failures === 0) console.log('every row in the archive names code that HEAD still carries');
} finally {
  rmSync(EXPORT_DIR, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
