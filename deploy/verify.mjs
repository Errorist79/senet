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
// The name that the deployed release declares. A commit is the only thing that
// changes it, and that is why a check against the origin is worth having.
import { RP_ID } from '@senet/server';
// The typed errors, so the check asks the bundle for the vocabulary that the
// library declares rather than for a list written out here.
import * as core from '@senet/core';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The identity of the release that this checker runs from.
 *
 * The service runs from one link and the web server serves another, so a
 * release that this file sits inside is the one the service runs. Comparing it
 * against the identity that the origin serves shows a skew between the two.
 */
const SERVICE_RELEASE = fileURLToPath(new URL('../app/dist/release.json', import.meta.url));

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

/**
 * How long the listener's cursor may go unwritten before this check fails.
 *
 * Ten minutes, which matches the check that reads the file on the host. The two
 * measure the same property from opposite sides, so one limit serves both.
 */
const LISTENER_AGE_MAX_MS = 10 * 60 * 1000;

/** A common phone viewport. The session runs on phones, not on a desktop. */
const PHONE = Object.freeze({ width: 390, height: 844 });

/** Elements that every screen carries, which must never need a sideways scroll. */
const ALWAYS_ON_SCREEN = Object.freeze([
  ['the ledger reading', '#ledger'],
  ['the pay button', '#nav-payer'],
  ['the account fact', '#fact-device'],
  ['the service fact', '#fact-service'],
  ['the ledger fact', '#fact-ledger'],
]);

/** What the measurement session photographs. A voucher creates all three. */
const SESSION_ELEMENTS = Object.freeze([
  ['the size line', '.code-size'],
  ['the level control', '.levels'],
  ['the code', 'canvas.code'],
]);

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

// The listener, as the origin reports it.
//
// Everything here is read from outside the host, through the status route. The
// route is a view of the file that the listener writes, and the two live in
// different processes, so this asks whether the view carries anything at all.
// A route that answers with nothing while the listener runs is the failure
// worth catching here: it means the writer and the reader name different
// files, and it looks perfectly healthy until somebody needs it.
//
// The state itself is judged on the host by `deploy/listener-check.mjs`, which
// reads the file rather than the view. That check stays there on purpose. A
// reader that could only reach the route would learn nothing about a healthy
// listener whenever the service in front of it was down.
// The forwarded header, read from the configuration this host serves.
//
// The service identifies a caller by the first entry of that header and keys
// its budget on it, so the header has to be set by the web server rather than
// appended to what a caller sent. The deployment refuses to install a
// configuration that appends. This asks a different question: whether the
// configuration the host is serving right now still says so, which catches an
// edit made on the host rather than in a commit.
//
// It is a host-side read. Every other line here comes from outside the host,
// and this one cannot, because the file is not public. It says so rather than
// letting a reader take it for something the origin answered.
const SERVED_NGINX = '/etc/nginx/sites-available/senet';
const APPENDS = /^[ \t]*proxy_set_header[ \t]+X-Forwarded-For[ \t]+\$proxy_add_x_forwarded_for/m;
const SETS = /^[ \t]*proxy_set_header[ \t]+X-Forwarded-For[ \t]+\$remote_addr/m;
if (existsSync(SERVED_NGINX)) {
  const served = readFileSync(SERVED_NGINX, 'utf8');
  check(SETS.test(served) && !APPENDS.test(served),
    APPENDS.test(served)
      ? 'the served configuration appends to X-Forwarded-For, so a caller names itself'
      : SETS.test(served)
        ? 'the served configuration sets X-Forwarded-For from the connection   read on the host'
        : 'the served configuration does not set X-Forwarded-For at all');
} else {
  console.log(`  SKIPPED the forwarded header, because ${SERVED_NGINX} is not readable from here`);
}

const listener = status.listener ?? null;
check(listener !== null, 'the status route reports no listener at all');
if (listener !== null) {
  check(typeof listener.cursor === 'string',
    listener.cursor === null
      ? 'the status route reports no cursor, so it is reading a file that nothing writes'
      : `the status route names the cursor ${listener.cursor}`);
  check(listener.stuckOn === null,
    listener.stuckOn === null
      ? 'the listener is not held on an event that it cannot deliver'
      : `the listener cannot deliver ${listener.stuckOn}`);
  check(typeof listener.ageMs === 'number' && listener.ageMs <= LISTENER_AGE_MAX_MS,
    typeof listener.ageMs === 'number'
      ? `the cursor was written ${Math.round(listener.ageMs / 1000)} seconds ago`
      : 'the status route gives the cursor no age, so nothing here shows a stopped listener');
}

// A passkey binds to the domain that created it. The browser derives that
// domain from the origin which served the page, and nothing in the application
// can change it. This check therefore reads a declaration and not a value that
// the application uses, so it is an early warning and not a proof.
//
// It compares the origin against the constant that the deployed release
// declares. A constant earns a check because only a commit changes it. A value
// that an operator supplies earns much less. An operator who moves the name
// supplies the new name. The two then agree, and the check passes while the
// move goes unrecorded.
const host = new URL(origin).hostname;
check(RP_ID === host,
  `the deployed release declares the relying party ${RP_ID}, and this origin is ${host}`);

// The service serves the constant itself, and no environment value overrides
// it, so this holds the two together rather than guarding an override.
if (typeof config.rpId === 'string') {
  check(config.rpId === RP_ID,
    `the service serves the relying party ${config.rpId}, and the release declares ${RP_ID}`);
}

// The origin names the commit it serves. A content search cannot tell a release
// that lacks a change from a check that looks for the wrong string, so a
// deployment answers the question instead of leaving it to inference.
const release = await readJson('/release.json');
check(typeof release.commit === 'string' && /^[0-9a-f]{40}$/.test(release.commit),
  `the origin names no commit, and it answered ${JSON.stringify(release.commit)}`);
// The application and the service run from two links. A release identity that
// the service directory carries, and one that the origin serves, disagree when
// those links point at different releases.
const servedByService = existsSync(SERVICE_RELEASE)
  ? JSON.parse(readFileSync(SERVICE_RELEASE, 'utf8'))
  : null;
if (servedByService !== null) {
  check(servedByService.commit === release.commit,
    `the origin serves commit ${release.commit} and the service runs ${servedByService.commit}`);
  check(servedByService.release === release.release,
    `the origin serves release ${release.release} and the service runs ${servedByService.release}`);
}

// The merchant screen shows the name of a typed error, so the bundle has to
// carry that vocabulary as text. A bundler renames a class, and a name taken
// from the constructor then reaches a person as two meaningless letters. Every
// unit test still passes, because Node minifies nothing. The fault lives in the
// artifact alone, and only a check against the artifact finds it.
const bundleText = await (await fetch(`${origin}/app.js`)).text();
const errorNames = Object.keys(core).filter((name) => name.endsWith('Error'));
check(errorNames.length > 0, 'the library declares no typed error, so this check reads nothing');
// The bundle carries only the errors that the application can raise, because
// the bundler drops the rest. The count therefore means nothing. The presence
// of any name means everything, because a bundler that renames a class renames
// every one, and no name at all would survive.
const carried = errorNames.filter((name) => bundleText.includes(name));
check(carried.length > 0,
  `the bundle carries no text for any of the ${errorNames.length} typed errors, `
  + 'so a person reads a renamed class instead of a reason');

// A literal in the bundle would be a second place where the name can drift.
const named = [...bundleText.matchAll(/rpId\s*:\s*["'`]([^"'`]+)["'`]/g)].map((found) => found[1]);
check(named.every((value) => value === host),
  `the bundle names a relying party other than ${host}: ${named.join(', ')}`);

console.log(`\n  commit   ${release.commit ?? 'the origin names none'}`);
console.log(`  release  ${release.release ?? 'unnamed'}, published ${release.publishedAt ?? 'at an unknown time'}`);
console.log(`  contract ${config.contractId}`);
console.log(`  channels ${Object.keys(status.channels ?? {}).length}`);
console.log(`  listener ${listener?.cursor ?? 'no cursor'}`
  + `${listener?.stuckOn === null || listener?.stuckOn === undefined ? '' : `, stuck on ${listener.stuckOn}`}`
  + '   read from outside the host, through the status route');
console.log(`  errors     ${carried.length} of ${errorNames.length} typed names carried as text`);
console.log(`  relying party ${RP_ID}, declared in the release`);
console.log('                the browser derives the real one from the origin');

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
    // Geometry, which reading text cannot answer. A line that falls out of frame
    // renders correct text in a place that nobody can photograph, so the check
    // measures where each element sits rather than what it says.
    await page.setViewport(PHONE);
    await page.goto(origin, { waitUntil: 'load' });
    const frame = await page.evaluate((selectors) => {
      const seen = {};
      for (const [label, selector] of selectors) {
        const node = document.querySelector(selector);
        if (node === null) {
          seen[label] = null;
          continue;
        }
        const box = node.getBoundingClientRect();
        seen[label] = {
          top: box.top, bottom: box.bottom, left: box.left, right: box.right,
          width: box.width, height: box.height,
        };
      }
      return {
        seen,
        width: window.innerWidth,
        height: window.innerHeight,
        pageWidth: document.documentElement.scrollWidth,
      };
    }, [...ALWAYS_ON_SCREEN, ...SESSION_ELEMENTS]);

    // A page that scrolls sideways on a phone is a fault on every screen of it.
    check(frame.pageWidth <= frame.width + 1,
      `the page is ${frame.pageWidth} wide inside a viewport of ${frame.width}, so it scrolls sideways`);

    for (const [label] of ALWAYS_ON_SCREEN) {
      const box = frame.seen[label];
      if (box === null) {
        check(false, `${label} is absent from the page`);
        continue;
      }
      check(box.width > 0 && box.height > 0, `${label} renders with no size`);
      check(box.left >= 0 && box.right <= frame.width + 1,
        `${label} sits from ${Math.round(box.left)} to ${Math.round(box.right)}, outside a viewport of ${frame.width}`);
    }

    // The session photographs these three together, and they exist only after a
    // person mints a voucher. A check that cannot reach them says so.
    const shown = SESSION_ELEMENTS.filter(([label]) => frame.seen[label] !== null);
    if (shown.length === 0) {
      console.log(`\n  SKIPPED the geometry of ${SESSION_ELEMENTS.length} elements that a`
        + ' voucher creates, because this check makes no account');
    } else {
      const boxes = shown.map(([label]) => frame.seen[label]);
      const top = Math.min(...boxes.map((box) => box.top));
      const bottom = Math.max(...boxes.map((box) => box.bottom));
      check(bottom - top <= frame.height,
        `the code, its size line and its control span ${Math.round(bottom - top)} pixels, `
        + `and the viewport is ${frame.height}, so a photograph cannot hold them together`);
      for (const [label] of shown) {
        const box = frame.seen[label];
        check(box.left >= 0 && box.right <= frame.width + 1,
          `${label} sits outside a viewport of ${frame.width}`);
      }
    }
    console.log(`\n  phone ${PHONE.width} by ${PHONE.height}: page ${frame.pageWidth} wide, `
      + `${ALWAYS_ON_SCREEN.length} elements measured`);

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
