/**
 * Prove that a returning person reaches a newer build.
 *
 * Every other check in this repository opens the application in a fresh
 * browser. A fresh browser holds no worker and no cache, so it takes the newest
 * build by definition. The one state that hides an update fault is the state
 * that a real person is always in: they already ran an earlier build, and a
 * worker of that build controls the page.
 *
 * That state is why the application shipped with no update path at all. Every
 * check passed, and the only way to a newer build was to delete the application
 * and lose the account with it.
 *
 * This check holds that state, and it holds it across two browser sessions.
 * The first session installs one build and then closes. The second session
 * opens the second build against the profile that the first one left. A phone
 * is always in that state. A session that ended hours ago installed the worker
 * that controls it.
 *
 * An earlier version of this check installed and updated inside one session. It
 * passed while the restart did nothing on a real phone, so a pass in one
 * session proves less than it appears to.
 *
 * The check asks three questions:
 *
 * - does the application refuse to swap itself without permission?
 * - does it offer the person the new version?
 * - does the restart deliver the new build?
 *
 *   CHROME_PATH=/path/to/chrome npm run update-check --workspace @senet/server
 */
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { launch } from 'puppeteer-core';
import { serveBuiltApplication } from './serve-build.js';

/** How long the check waits for a browser to do one thing. */
const STEP_TIMEOUT_MS = 60_000;

/** What the second build calls itself, so a reader can tell them apart. */
const NEXT_TITLE = 'Senet next';

/** What the first build calls itself. */
const FIRST_TITLE = 'Senet';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', '..', '..', 'app', 'dist');

/** Read a variable that the check cannot run without. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set, and the check needs it`);
  }
  return value;
}

/**
 * Copy the build, and make it a different build.
 *
 * The change is the smallest one that a person could see: the page names
 * itself differently. The worker's identity changes with it, because a worker
 * that carries the same bytes is the fault that this check exists for.
 */
function copyAsNextBuild(from: string, to: string): string {
  cpSync(from, to, { recursive: true });

  const workerPath = join(to, 'sw.js');
  const worker = readFileSync(workerPath, 'utf8');
  const identity = /senet-shell-([0-9a-f]+)/.exec(worker);
  if (identity === null) {
    throw new Error('the worker carries no build identity, so no release can reach a person');
  }
  writeFileSync(workerPath, worker.replace(identity[0], `${identity[0]}-next`));

  const pagePath = join(to, 'index.html');
  const page = readFileSync(pagePath, 'utf8');
  if (!page.includes(`<title>${FIRST_TITLE}</title>`)) {
    throw new Error('the page does not name itself, so the check cannot tell the builds apart');
  }
  writeFileSync(pagePath, page.replace(`<title>${FIRST_TITLE}</title>`, `<title>${NEXT_TITLE}</title>`));
  return identity[0];
}

async function main(): Promise<void> {
  const chromePath = required('CHROME_PATH');
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`${DIST} holds no build. Run the application build first.`);
  }

  const work = mkdtempSync(join(tmpdir(), 'senet-update-'));
  const firstBuild = join(work, 'first');
  const next = join(work, 'next');
  cpSync(DIST, firstBuild, { recursive: true });
  const identity = copyAsNextBuild(DIST, next);
  console.log(`first      ${identity}`);
  console.log(`next       ${identity}-next`);

  // The served directory changes under the browser, which is what a deployment
  // does to a phone that is already running the application.
  let served = firstBuild;
  const service = createServer((request, response) => {
    serveBuiltApplication(served, request, response);
  });
  await new Promise<void>((listening) => {
    service.listen(0, '127.0.0.1', listening);
  });
  const address = service.address();
  if (address === null || typeof address === 'string') throw new Error('the service took no port');
  const origin = `http://localhost:${address.port}`;
  console.log(`origin     ${origin}`);

  // One profile, two sessions. The profile is what carries the worker from the
  // first session into the second, as a phone carries it across a day.
  const profile = join(work, 'profile');
  const start = () =>
    launch({
      executablePath: chromePath,
      userDataDir: profile,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

  try {
    const first = await start();
    try {
      const page = await first.newPage();
      await page.goto(origin, { waitUntil: 'load' });
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null, {
        timeout: STEP_TIMEOUT_MS,
      });
      console.log('installed  the worker of the first build controls the page');
    } finally {
      await first.close();
    }
    console.log('closed     the session ended, and the profile keeps the worker');

    served = next;
    const second = await start();
    try {
      const page = await second.newPage();
      await page.goto(origin, { waitUntil: 'load' });

      // The state that matters, read from the browser rather than assumed. A
      // report of a dead button needs to say what the page held at the press.
      const before = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return {
          controller: navigator.serviceWorker.controller !== null,
          waiting: registration?.waiting !== undefined && registration?.waiting !== null,
          installing: registration?.installing !== undefined && registration?.installing !== null,
          active: registration?.active !== undefined && registration?.active !== null,
        };
      });
      console.log(
        `state      controller ${before.controller}, waiting ${before.waiting}, ` +
          `installing ${before.installing}, active ${before.active}`,
      );

      await page.waitForFunction(() => document.getElementById('update-bar')?.hidden === false, {
        timeout: STEP_TIMEOUT_MS,
      });
      console.log('offered    the application says a new version is ready');

      const heldTitle = await page.title();
      if (heldTitle !== FIRST_TITLE) {
        throw new Error(
          `the application swapped itself without asking: it already shows ${heldTitle}`,
        );
      }
      console.log('held       the new build waits, and the first build keeps the screen');

      await page.click('#update-restart');
      await page.waitForFunction((wanted: string) => document.title === wanted, {
        timeout: STEP_TIMEOUT_MS,
      }, NEXT_TITLE);
      console.log(`restarted  the application now shows ${await page.title()}`);

      const barAfter = await page.evaluate(
        () => document.getElementById('update-bar')?.hidden ?? true,
      );
      if (barAfter === false) {
        throw new Error('the application offers an update that it took a moment ago');
      }
      console.log('a returning person reaches the newer build, and chooses when');
    } finally {
      await second.close();
    }
  } finally {
    service.close();
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
