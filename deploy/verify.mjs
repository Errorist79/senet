// Check the public deployment from outside the host.
//
// Every check below reaches the name over the public network, so it proves what
// a phone sees rather than what the host believes. A request made on the host
// itself would pass while the certificate, the name or the web server were
// wrong.
//
//   CHROME_PATH=/path/to/chrome node deploy/verify.mjs [https://senet.hoodrun.io]
//
// The browser check needs Chrome, which `CHROME_PATH` names. Without that
// variable the command runs every other check and says that it skipped one.

import { launch } from 'puppeteer-core';

/** The name that serves the application, when the caller names none. */
const DEFAULT_ORIGIN = 'https://senet.hoodrun.io';

/** The headers that every response must carry. */
const COMMON_HEADERS = {
  'permissions-policy': 'camera=(self), publickey-credentials-get=(self)',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

/** The paths that must answer, including one that the shell has to catch. */
const PATHS = [
  '/', '/index.html', '/app.js', '/app.css', '/sw.js', '/manifest.webmanifest',
  '/icon.svg', '/.well-known/stellar.toml', '/api/config', '/a/path/that/the/shell/catches',
];

const origin = process.argv[2] ?? DEFAULT_ORIGIN;
const problems = [];
let checks = 0;

function check(holds, message) {
  checks += 1;
  if (!holds) problems.push(message);
}

console.log(`checking ${origin}\n`);

// A fetch over HTTPS fails when the certificate is absent, expired, or issued
// for another name, so this also checks the certificate.
for (const path of PATHS) {
  const response = await fetch(origin + path);
  check(response.ok, `${path} answered ${response.status}`);
  for (const [header, value] of Object.entries(COMMON_HEADERS)) {
    check(response.headers.get(header) === value, `${path} carries no ${header}`);
  }
  console.log(`  ${String(response.status).padEnd(4)}${path}`);
}

// A device that installed an old worker reaches a new build only when the web
// server never caches the worker.
const worker = await fetch(`${origin}/sw.js`);
check(
  (worker.headers.get('cache-control') ?? '').includes('no-store'),
  'sw.js may be cached, so a new build cannot reach a device that holds the old worker',
);
check(worker.headers.get('service-worker-allowed') === '/', 'sw.js may not control the origin');

// A wallet reads this file from its own page, so it needs the header.
const toml = await fetch(`${origin}/.well-known/stellar.toml`);
check(
  (toml.headers.get('content-type') ?? '').startsWith('text/plain'),
  'stellar.toml does not answer as text',
);
check(toml.headers.get('access-control-allow-origin') === '*', 'stellar.toml refuses another origin');

/**
 * Read one route as JSON, and record a problem when it answers something else.
 *
 * A name that serves another site answers HTML here. The check reports that as
 * a named failure and carries on. A crash tells a reader less than a list of
 * what is wrong.
 */
async function readJson(path) {
  const response = await fetch(origin + path);
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    problems.push(`${path} answered ${response.status} and no JSON`);
    return {};
  }
}

// The application reads the chain identities from the service, so the service
// has to answer and to name the contract.
const config = await readJson('/api/config');
check(typeof config.contractId === 'string' && config.contractId.startsWith('C'),
  'the service names no contract');
const status = await readJson('/api/status');
check(Object.keys(status.channels ?? {}).length > 0, 'the service holds no channel account');

// A passkey binds to the relying party that created it, so that identifier must
// be the name itself. The application takes it from the service rather than from
// its own bundle, so the served value is the one that decides, and a check that
// reads the bundle alone proves nothing.
const host = new URL(origin).hostname;
check(typeof config.rpId === 'string' && config.rpId.length > 0,
  'the service names no relying party, so the application cannot make a passkey');
check(config.rpId === host,
  `the service names the relying party ${config.rpId}, and the origin is ${host}`);

// A literal in the bundle would override the served value, so it is a second
// place where the identifier can drift.
const bundle = await (await fetch(`${origin}/app.js`)).text();
const named = [...bundle.matchAll(/rpId\s*:\s*["'`]([^"'`]+)["'`]/g)].map((found) => found[1]);
check(named.every((value) => value === host),
  `the bundle names a relying party other than ${host}: ${named.join(', ')}`);

console.log(`\n  contract ${config.contractId}`);
console.log(`  channels ${Object.keys(status.channels ?? {}).length}`);
console.log(`  relying party ${config.rpId ?? '(the service names none)'}, from the service`);

// The worker and the manifest decide whether a phone installs the application.
// Only a browser answers that, so this check drives one.
const chromePath = process.env.CHROME_PATH;
if (chromePath === undefined || chromePath === '') {
  console.log('\n  SKIPPED the browser check, because CHROME_PATH names no browser');
} else {
  const browser = await launch({
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: 'load' });
    const state = await page.evaluate(async () => {
      const secure = window.isSecureContext;
      let scope = null;
      let active = false;
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        scope = registration.scope;
        active = registration.active !== null;
      } catch (failure) {
        return { secure, scope: null, active: false, manifest: null, failure: String(failure) };
      }
      const link = document.querySelector('link[rel="manifest"]');
      let manifest = null;
      if (link !== null) {
        try {
          manifest = await (await fetch(link.getAttribute('href'))).json();
        } catch {
          manifest = null;
        }
      }
      return { secure, scope, active, manifest, failure: null };
    });
    if (state.failure !== null) problems.push(`the worker did not register: ${state.failure}`);

    // The application reads its chain settings from the service at start. A
    // service that is older than the application answers without some of them,
    // and the page then loads and looks healthy while account creation refuses.
    // Only the running application shows that, so the check reads its own words.
    const started = await page.evaluate(() => ({
      text: document.body.innerText,
      chain: window.localStorage.getItem('senet.chain'),
    }));
    check(!/did not answer/i.test(started.text),
      'the application says the service did not answer, so the two releases disagree');
    check(started.chain !== null,
      'the application stored no chain settings, so it cannot mint or redeem');
    check(state.secure, 'the page is not a secure context, so no passkey works there');
    check(state.active, 'the service worker did not become active');
    check(state.scope === `${origin}/`, `the worker controls ${state.scope} and not the whole origin`);
    const manifest = state.manifest ?? {};
    for (const field of ['name', 'start_url', 'display']) {
      check(manifest[field] !== undefined, `the manifest names no ${field}`);
    }
    check(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'the manifest holds no icon');
    console.log(`\n  secure context ${state.secure}`);
    console.log(`  worker active  ${state.active}, scope ${state.scope}`);
    console.log(`  manifest       ${manifest.name}, ${manifest.display}, ${(manifest.icons ?? []).length} icon`);
  } finally {
    await browser.close();
  }
}

console.log(`\n${checks} checks`);
for (const problem of problems) console.log(`PROBLEM: ${problem}`);
if (problems.length > 0) {
  throw new Error(`${problems.length} of ${checks} checks failed`);
}
console.log('the deployment answers every check');
