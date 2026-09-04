// Build the application into `dist`.
//
// The web server publishes `dist` and it names four files: index.html, app.js,
// app.css and sw.js. These names never change, because the cache rules in the
// web server configuration depend on them.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

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

console.log(`built ${DIST}`);
