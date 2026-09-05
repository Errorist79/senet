// Build the application into `dist`.
//
// The web server publishes `dist` and it names four files: index.html, app.js,
// app.css and sw.js. These names never change, because the cache rules in the
// web server configuration depend on them.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
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

// The decoder's WebAssembly, carried inside the bundle.
//
// The library loads this file from a public network address by default, and a
// payer with no network cannot reach one. A file beside the bundle would be a
// request after the first paint. The service worker warns against one, because
// it would reach the deleted cache of an earlier worker. Base64 inside
// the bundle costs about a third more bytes than the file, and it removes both
// faults: the shell already holds the bundle, and the worker already caches it.
const require = createRequire(import.meta.url);
const DECODER_WASM = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
const ZXING_WASM_BASE64 = readFileSync(DECODER_WASM).toString('base64');

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
  define: { ZXING_WASM_BASE64: JSON.stringify(ZXING_WASM_BASE64) },
  logLevel: 'info',
});

// The decoder must survive into the artifact. Without it the scanner loads
// nothing, and the failure appears only when a merchant points a camera.
const built = readFileSync(join(DIST, 'app.js'), 'utf8');
if (!built.includes(ZXING_WASM_BASE64.slice(0, 64))) {
  throw new Error('the build carries no decoder, so the scanner would read nothing');
}

for (const name of COPIED) cpSync(join(SOURCE, name), join(DIST, name));

// What a person actually runs, as one value.
//
// A browser compares the bytes of sw.js to decide whether a worker is new. The
// worker names this hash, so it changes when the application changes and stays
// the same when a release carries no change. Without it, every release compiled
// to the same worker and no release was ever new. One path then remained to a
// newer build: a person deletes the application, and loses the account with it.
const SHELL_FILES = ['app.js', 'app.css', 'index.html'];
const shell = createHash('sha256');
for (const name of SHELL_FILES) shell.update(readFileSync(join(DIST, name)));
const SHELL_BUILD = shell.digest('hex').slice(0, 16);

// The worker is its own entry point. It must sit at the root of the origin,
// because a worker controls only the paths under its own directory.
await build({
  entryPoints: [join(SOURCE, 'sw.ts')],
  outfile: join(DIST, 'sw.js'),
  bundle: true,
  format: 'iife',
  target: TARGETS,
  minify: true,
  define: { SHELL_BUILD: JSON.stringify(SHELL_BUILD) },
  logLevel: 'info',
});

// A worker that does not carry the identity cannot report itself as new, and
// the fault is silent: the application keeps working and never updates again.
const worker = readFileSync(join(DIST, 'sw.js'), 'utf8');
if (!worker.includes(SHELL_BUILD)) {
  throw new Error(
    `the worker carries no build identity, so no release after this one can ever reach a person`,
  );
}

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
  'ExpiryWindowError',
  'AmountWindowError',
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

console.log(`built ${DIST}, shell ${SHELL_BUILD}, with ${SHOWN_BY_THE_SCREENS.length} error names intact`);
