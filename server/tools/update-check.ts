/**
 * Prove that a returning person reaches a newer build, and that nobody is
 * interrupted to deliver it.
 *
 * Every other check in this repository opens the application in a fresh
 * browser. A fresh browser holds no worker and no cache, so it takes the newest
 * build by definition. The one state that hides an update fault is the state
 * that a real person is always in: they already ran an earlier build, and a
 * worker of that build controls the page.
 *
 * This check holds that state across three browser sessions, because the update
 * path spans them. A build installs during one session and arrives at the next
 * start, which is how a person meets it.
 *
 * The three questions:
 *
 * - does a session that is already open keep the version that it started with?
 * - does the next start deliver the newer build?
 * - does the footer name the build that is running, in both sessions?
 * - does the worker hold the identity, so that it reads with no network?
 *
 * The first question is the safety rule. A payment application must not replace
 * itself while a payment is in progress. This build holds that rule by never
 * touching a page that is already open.
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

/** How long the check gives the new worker to install and take over. */
const SETTLE_MS = 5_000;

/** The commits that the served builds claim, so the footer has one to show. */
const FIRST_COMMIT = 'aaaaaaa1111111111111111111111111111111111';
const NEXT_COMMIT = 'bbbbbbb2222222222222222222222222222222222';


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
function copyAsNextBuild(from: string, to: string, suffix: string): string {
  cpSync(from, to, { recursive: true });

  const workerPath = join(to, 'sw.js');
  const worker = readFileSync(workerPath, 'utf8');
  const identity = /senet-shell-([0-9a-f]+)/.exec(worker);
  if (identity === null) {
    throw new Error('the worker carries no build identity, so no release can reach a person');
  }
  const written = worker.replace(identity[0], `${identity[0]}-${suffix}`);
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
  cpSync(DIST, firstBuild, { recursive: true });
  writeRelease(firstBuild, FIRST_COMMIT);
  const identity = copyAsNextBuild(DIST, next, 'next');
  writeRelease(next, NEXT_COMMIT);
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

  // One profile, three sessions. The profile is what carries the worker between
  // them, as a phone carries it across a day.
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
      // The worker becomes active, and it does not claim this page. A page
      // that registers a worker therefore never gets a controller. The next
      // start does, which is the whole point of the design.
      await waitForActiveWorker(page);
      console.log('installed  the worker of the first build is active');

      // The identity must live in the cache beside the files that it names.
      // A worker that fetches it later reads whatever the origin serves then,
      // and a device with no network reads nothing at all.
      const held = await page.evaluate(async () => (await caches.match('/release.json')) !== undefined);
      if (!held) {
        throw new Error('the worker holds no build identity, so a device with no network cannot read one');
      }
      console.log('identity   the worker holds it, beside the files that it names');
    } finally {
      await first.close();
    }
    console.log('closed     the session ended, and the profile keeps the worker');

    served = next;
    const second = await start();
    try {
      const page = await second.newPage();
      await page.goto(origin, { waitUntil: 'load' });
      console.log(`identity   the footer shows ${await buildFact(page)}`);

      // The new worker installs and becomes the active one during this session.
      // The page must not notice.
      await page.waitForFunction(
        async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return registration !== undefined;
        },
        { timeout: STEP_TIMEOUT_MS },
      );
      await new Promise((rest) => setTimeout(rest, SETTLE_MS));

      const heldTitle = await page.title();
      if (heldTitle !== FIRST_TITLE) {
        throw new Error(`the application replaced itself under an open session: ${heldTitle}`);
      }
      const heldIdentity = await buildFact(page);
      if (!heldIdentity.includes(FIRST_COMMIT.slice(0, 7))) {
        throw new Error(`the footer moved under an open session: ${heldIdentity}`);
      }
      if ((await page.$('#update-bar')) !== null) {
        throw new Error('the application asks a person about a version, which it must not');
      }
      console.log('undisturbed the open session keeps the build that it started with');
    } finally {
      await second.close();
    }

    const third = await start();
    try {
      const page = await third.newPage();
      await page.goto(origin, { waitUntil: 'load' });
      const title = await page.title();
      if (title !== NEXT_TITLE) {
        throw new Error(`the next start served ${title}, and the newer build was ready`);
      }
      const shown = await buildFact(page);
      console.log(`identity   the footer now shows ${shown}`);
      if (!shown.includes(NEXT_COMMIT.slice(0, 7))) {
        throw new Error(`the footer names ${shown}, and the newer build is running`);
      }
      console.log('delivered  the next start carries the newer build');
    } finally {
      await third.close();
    }
    console.log('a person gets the newer build, and nothing interrupts them to do it');
  } finally {
    service.close();
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Wait until a worker is active, whether or not it controls this page.
 *
 * The poll runs here rather than in the page. A predicate that returns a
 * promise is a truthy value in the page, so a wait on one passes at once and
 * proves nothing.
 */
async function waitForActiveWorker(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['newPage']>>,
): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration?.active?.state ?? null;
    });
    if (state === 'activated') return;
    await new Promise((rest) => setTimeout(rest, 500));
  }
  throw new Error('no worker became active, so the application caches nothing');
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
