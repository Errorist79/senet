// Build the application into `dist`.
//
// The web server publishes `dist` and it names four files: index.html, app.js,
// app.css and sw.js. These names never change, because the cache rules in the
// web server configuration depend on them.
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { VOUCHER_ERROR_NAMES } from '@senet/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, 'src');
const DIST = join(HERE, 'dist');

/** The files that the build copies without a change. */
const COPIED = ['index.html', 'app.css', 'manifest.webmanifest', 'icon.svg'];

/** The oldest browsers that the application supports. */
const TARGETS = ['chrome120', 'safari17', 'firefox121'];

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

await build({
  entryPoints: [join(SOURCE, 'main.ts')],
  outfile: join(DIST, 'app.js'),
  bundle: true,
  format: 'esm',
  target: TARGETS,
  minify: true,
  sourcemap: true,
  logLevel: 'info',
});

// The worker is its own entry point. It must sit at the root of the origin,
// because a worker controls only the paths under its own directory.
await build({
  entryPoints: [join(SOURCE, 'sw.ts')],
  outfile: join(DIST, 'sw.js'),
  bundle: true,
  format: 'iife',
  target: TARGETS,
  minify: true,
  logLevel: 'info',
});

for (const name of COPIED) cpSync(join(SOURCE, name), join(DIST, name));

// The errors that a screen can put in front of a person. The library raises
// others, and the bundler drops a class that this application never reaches.
// A missing name is therefore a fault only for the ones that a screen shows.
const SHOWN_BY_THE_SCREENS = [
  'VoucherFormatError',
  'PayloadVersionError',
  'NetworkMismatchError',
  'CredentialTypeError',
  'DeadlineMismatchError',
  'RemainingLifeError',
  // The payer screen adds `ExpiryWindowError` and `AmountWindowError` when it
  // lands, because only a mint raises them.
];

// A bundler renames a class. These names are what a person reads as the reason
// a payment stopped, so the build checks that each one survived into the
// artifact. A unit test cannot catch this, because nothing minifies the code
// that a unit test runs.
const unpublished = SHOWN_BY_THE_SCREENS.filter((name) => !VOUCHER_ERROR_NAMES.includes(name));
if (unpublished.length > 0) {
  throw new Error(`the library publishes no error named ${unpublished.join(', ')}`);
}
const bundle = readFileSync(join(DIST, 'app.js'), 'utf8');
const lost = SHOWN_BY_THE_SCREENS.filter((name) => !bundle.includes(name));
if (lost.length > 0) {
  throw new Error(
    `the build lost these error names: ${lost.join(', ')}. ` +
      `A person would read a meaningless name instead of the reason.`,
  );
}

console.log(`built ${DIST}, with ${SHOWN_BY_THE_SCREENS.length} error names intact`);
