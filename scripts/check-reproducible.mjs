// Ask whether the code in the repository still produces the archive that it holds.
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
// The repository makes its promise to somebody who clones it. A producer that
// exists only in an editor is a producer that they never get.
//
// WHAT THIS COMPARES, AND WHAT IT LEAVES ALONE
//
// It compares one thing: the set of row names that a producer says it makes,
// against the set of row names that the archive holds. Both directions, so a
// row with no producer fails, and a producer with no row fails.
//
// It does not compare the `note` on a row. A note is a person's sentence about
// what the row shows, and it is not a fact that the run derives. Both archive
// commands offer `--note` on the command line, which invites a person to write
// one. A check that held a note against the sentence its producer carries
// today would refuse a row that says what somebody meant it to say.
//
// That leaves a real gap, and naming it is the point of this paragraph. A
// producer and its archive can drift apart on prose alone, and nothing here
// notices. It happened. Somebody rewrote a note in `run-evidence.mjs` while
// the committed row kept the old wording. This check reported zero failures
// throughout, because it never read that field.
//
// So a clean report from this command says that every row names live code. It
// does not say that every word in the archive is current, and no check in this
// repository says that.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './evidence-set.mjs';

/**
 * Where this check unpacks `HEAD`.
 *
 * It sits inside the repository on purpose. Node finds a package when it walks
 * up from the file that imports it. An export placed here therefore resolves
 * against the dependencies that the repository already installed, and this
 * check needs no install of its own.
 */
const EXPORT_DIR = path.join(ROOT, '.reproducible-check');

/** Where the archive trees live, relative to the root of the repository. */
const ARCHIVE_ROOT = path.join('scripts', 'out');


/**
 * Find every archive tree in the export, and read the producer each one names.
 *
 * This check finds the producers rather than carrying a list of them. A list
 * inside this file would come from the copy that happens to run. A producer
 * that HEAD holds, and a stale copy lacks, would then leave a whole tree
 * unchecked and quiet. That is not hypothetical. The first version of this
 * check carried a list of two while the repository held four trees. It
 * reported no failures over forty four percent of the rows.
 *
 * A search of the export leaves only this one script to trust. A stale script
 * is a loud failure rather than a quiet gap, because it is one file that
 * either runs or does not.
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
  let archive;
  try {
    archive = execFileSync('git', ['archive', 'HEAD'], {
      cwd: ROOT,
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // A tag on the remote produces a downloadable archive, so a reader can
    // arrive holding a folder rather than a checkout. That reader met a stack
    // trace here. This check compares the archive against the history of the
    // repository, and a folder carries no history, so it says what it needs.
    console.error('this check needs a git checkout, and this folder is not one.');
    console.error('It compares the evidence against the history of this repository.');
    console.error('A downloaded archive carries the files and none of the history.');
    console.error('Clone the repository, then run this command inside the clone.');
    process.exit(1);
  }
  execFileSync('tar', ['-x', '-C', EXPORT_DIR], { input: archive });
}

/**
 * Ask a producer which rows it would write.
 *
 * The producer answers for itself, and this check searches no source for
 * names. A search finds a string that looks like a row name, and it misses one
 * that the code builds from parts. It also cannot tell a live name from a name
 * in a comment.
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

/**
 * Ask whether HEAD carries the gate that enforces the language rules.
 *
 * The gate ran for two weeks from a directory that git never tracked, through
 * a hook that git tracks no more. A stranger who cloned this repository got the
 * rule and nothing that keeps it. Every row that said the gate passes rested on
 * a file that the artifact does not carry.
 *
 * A note recorded that gap and nobody acted on it for two weeks. Somebody who
 * already cares reads a note once. This check asks on every run.
 */
function gateInExport() {
  const gate = path.join(EXPORT_DIR, 'scripts', 'check-language.mjs');
  if (!existsSync(gate)) {
    check(false, 'HEAD does not carry scripts/check-language.mjs, so a clone cannot check its own text');
    return;
  }
  try {
    execFileSync('node', [gate], { cwd: EXPORT_DIR, encoding: 'utf8' });
    check(true, 'the language gate runs from HEAD alone and reports clean');
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    check(false, `the language gate refuses HEAD: ${detail.split('\n')[0]}`);
  }
}

try {
  exportHead();
  gateInExport();

  console.log(`reading HEAD, unpacked into ${path.relative(ROOT, EXPORT_DIR)}`);
  console.log('this needs the repository and nothing else, so its answer is about the product\n');

  const trees = treesInExport();
  console.log(`HEAD holds ${trees.length} archive trees\n`);

  for (const tree of trees) {
    const manifest = JSON.parse(readFileSync(path.join(EXPORT_DIR, tree, 'manifest.json'), 'utf8'));

    // A tree that names no producer is the gap this check exists to close. It
    // fails here, and this check never skips it, because a skipped tree reads
    // as a tree with nothing wrong.
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
        // An earlier version asserted that the device command existed, which
        // passed for every tree while it held for only one. The device command
        // archives no row from a browser check, and the line said otherwise.
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
  if (failures === 0) {
    console.log('every row in the archive names code that HEAD still carries');
    // The boundary travels with the result. A reader who sees only the line
    // above takes it for more than it says. That is how a check that covers
    // less than a reader believes stays comfortable.
    console.log('this compares row names only, and never the note on a row');
  }
} finally {
  rmSync(EXPORT_DIR, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
