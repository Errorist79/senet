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
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

/** The command that archives a row which no script can produce. */
const DEVICE_COMMAND = 'scripts/archive-device-row.mjs';

/** The producers, and how to ask each one what it makes. */
const PRODUCERS = Object.freeze([
  { command: 'scripts/run-evidence.mjs', tree: path.join('scripts', 'out', 'evidence') },
]);

let failures = 0;
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

  for (const producer of PRODUCERS) {
    const manifestPath = path.join(EXPORT_DIR, producer.tree, 'manifest.json');
    if (!existsSync(manifestPath)) {
      check(false, `${producer.tree} holds no manifest at HEAD`);
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    let claimed;
    try {
      claimed = producedBy(producer.command);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      check(false, `${producer.command} cannot say what it produces: ${detail.split('\n')[0]}`);
      continue;
    }
    console.log(`  ${producer.command} produces ${claimed.length} rows`);
    console.log(`  ${producer.tree} holds ${manifest.rows.length} rows\n`);

    for (const row of manifest.rows) {
      // A device row is one that no script can produce, because a passkey needs
      // a person. It is reproducible in the sense that matters: a command takes
      // the hash a person carried back and rebuilds the row from the chain.
      if (row.producer === 'device' || row.producer === 'browser') {
        check(existsSync(path.join(EXPORT_DIR, DEVICE_COMMAND)),
          `${row.name} is a ${row.producer} row, and ${DEVICE_COMMAND} exists to archive it`);
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

  console.log(`\n${failures} failed`);
  if (failures === 0) console.log('every row in the archive names code that HEAD still carries');
} finally {
  rmSync(EXPORT_DIR, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
