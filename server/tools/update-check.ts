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
 * - does the button say what to do when the handover does not happen?
 * - does the bar go away when the version it announced has arrived?
 *
 * The last one exists because a person pressed a button that did nothing. A
 * check runs the handover on a browser that performs it, so it can never meet
 * that failure by accident. This one therefore serves a worker that ignores the
 * message, which is the same silence from the page's side.
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

/** The commits that the served builds claim, so the footer has one to show. */
const FIRST_COMMIT = 'aaaaaaa1111111111111111111111111111111111';
const NEXT_COMMIT = 'bbbbbbb2222222222222222222222222222222222';
const LATER_COMMIT = 'ccccccc3333333333333333333333333333333333';

/**
 * What the page sends a worker that waits.
 *
 * The value sits here as a literal on purpose. It is the wire between the page
 * and the worker. A check that imports the same constant as the product cannot
 * notice that the product changed it.
 */
const SKIP_WAITING = 'senet.skip-waiting';

/** Publish a build identity, as the real deployment does. */
function writeRelease(dir: string, commit: string): void {
  const identity = { commit, release: '20260101T000000Z', publishedAt: '2026-01-01T00:00:00Z' };
  writeFileSync(join(dir, 'release.json'), `${JSON.stringify(identity, null, 2)}\n`);
}

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
function copyAsNextBuild(from: string, to: string, suffix: string, deaf = false): string {
  cpSync(from, to, { recursive: true });

  const workerPath = join(to, 'sw.js');
  const worker = readFileSync(workerPath, 'utf8');
  const identity = /senet-shell-([0-9a-f]+)/.exec(worker);
  if (identity === null) {
    throw new Error('the worker carries no build identity, so no release can reach a person');
  }
  let written = worker.replace(identity[0], `${identity[0]}-${suffix}`);
  if (deaf) {
    // A worker that never hands over, which is what the phone showed. The
    // handover is the only part that this removes.
    const handover = /\w+\.skipWaiting\(\)/.exec(written);
    if (handover === null) {
      throw new Error('the worker calls no skipWaiting, so this check cannot silence it');
    }
    written = written.replace(handover[0], 'void 0');
  }
  writeFileSync(workerPath, written);

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
  const deaf = join(work, 'deaf');
  const later = join(work, 'later');
  cpSync(DIST, firstBuild, { recursive: true });
  writeRelease(firstBuild, FIRST_COMMIT);
  const identity = copyAsNextBuild(DIST, next, 'next');
  writeRelease(next, NEXT_COMMIT);
  copyAsNextBuild(DIST, deaf, 'deaf', true);
  writeRelease(deaf, NEXT_COMMIT);
  // A third identity, so that the browser sees a worker that it never held. A
  // copy of an earlier build carries the same worker, and nothing would wait.
  copyAsNextBuild(DIST, later, 'later');
  writeRelease(later, LATER_COMMIT);
  console.log(`first      ${identity}`);
  console.log(`next       ${identity}-next`);
  console.log(`deaf       ${identity}-deaf, a build that never hands over`);

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

      const shownBefore = await buildFact(page);
      console.log(`identity   the footer shows ${shownBefore}`);
      if (!shownBefore.includes(FIRST_COMMIT.slice(0, 7))) {
        throw new Error(`the footer names ${shownBefore}, and the first build is running`);
      }

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
      // The result the person reads. A report of a restart is worth less than
      // a string on their own screen that changes when they act.
      await page.waitForFunction(
        (wanted: string) =>
          (document.getElementById('fact-build')?.textContent ?? '').includes(wanted),
        { timeout: STEP_TIMEOUT_MS },
        NEXT_COMMIT.slice(0, 7),
      );
      console.log(`identity   the footer now shows ${await buildFact(page)}`);
      console.log('a returning person reaches the newer build, and chooses when');
    } finally {
      await second.close();
    }

    // The version that the bar announced arrives while the page stays open.
    // The bar must then go away, because it announces a thing that happened.
    // A person who reads it after the fact presses a button with nothing left
    // to do, which is what the phone showed.
    served = later;
    const fourth = await start();
    try {
      const page = await fourth.newPage();
      await page.goto(origin, { waitUntil: 'load' });
      await page.waitForFunction(() => document.getElementById('update-bar')?.hidden === false, {
        timeout: STEP_TIMEOUT_MS,
      });
      console.log('offered    the application says a new version is ready');

      // The worker takes over without the person pressing anything, which is
      // what a relaunch does. The page stays as it is.
      await page.evaluate(async (message: string) => {
        const registration = await navigator.serviceWorker.getRegistration();
        registration?.waiting?.postMessage(message);
      }, SKIP_WAITING);
      await page.waitForFunction(
        () => navigator.serviceWorker.controller !== null,
        { timeout: STEP_TIMEOUT_MS },
      );
      await page.waitForFunction(() => document.getElementById('update-bar')?.hidden === true, {
        timeout: STEP_TIMEOUT_MS,
      });
      console.log('cleared    the bar went away when the new version arrived');
    } finally {
      await fourth.close();
    }

    // The handover fails, and the application must still say what works.
    served = deaf;
    const third = await start();
    try {
      const page = await third.newPage();
      await page.goto(origin, { waitUntil: 'load' });
      await page.waitForFunction(() => document.getElementById('update-bar')?.hidden === false, {
        timeout: STEP_TIMEOUT_MS,
      });
      await page.click('#update-restart');
      await page.waitForFunction(
        () => (document.getElementById('update-text')?.textContent ?? '').includes('App Switcher'),
        { timeout: STEP_TIMEOUT_MS },
      );
      const said = await page.evaluate(
        () => document.getElementById('update-text')?.textContent ?? '',
      );
      console.log(`advised    ${said.trim()}`);
      const stillOffers = await page.evaluate(
        () => document.getElementById('update-restart')?.hidden ?? true,
      );
      if (stillOffers === false) {
        throw new Error('the application still offers a button that does nothing');
      }
      console.log('the button never stays dead, and the advice always works');
    } finally {
      await third.close();
    }
  } finally {
    service.close();
    rmSync(work, { recursive: true, force: true });
  }
}

/** The build identity that the footer shows, as a person reads it. */
async function buildFact(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['newPage']>>,
): Promise<string> {
  await page.waitForFunction(
    () => !(document.getElementById('fact-build')?.textContent ?? '').includes('unknown'),
    { timeout: STEP_TIMEOUT_MS },
  );
  return page.evaluate(() => document.getElementById('fact-build')?.textContent ?? '');
}

await main();
