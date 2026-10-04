// Check the public deployment from outside the host.
//
// Every check below reaches the name over the public network, so it proves what
// a phone sees rather than what the host believes. A request made on the host
// itself would pass while the certificate, the name or the web server were
// wrong.
//
//   CHROME_PATH=/path/to/chrome node deploy/verify.mjs [https://senet.hoodrun.io]
//   CHROME_PATH=/path/to/chrome node deploy/verify.mjs --complete
//
// The browser check needs Chrome, which `CHROME_PATH` names. Without that
// variable the command runs every other check and names the one that it
// skipped, in the summary and not only in passing.
//
// `--complete` refuses a run that skipped anything. Use it on the host, where
// every file and the browser are present. A release that a person tags needs
// the whole suite. So does a reproduction on a clean machine. Neither wants
// the part of the suite that the machine happened to allow.

import { launch } from 'puppeteer-core';
import { Contract, rpc, xdr } from '@stellar/stellar-sdk';
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
 * The service runs from one link and the web server serves another. A release
 * that holds this file is therefore the one that the service runs. Comparing it
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

/**
 * How many days of TTL the voucher contract and the wallet code must keep.
 *
 * The voucher contract extends its own TTL during a redemption, and only when
 * less than one day remains. An idle contract therefore archives when its TTL
 * runs out. Thirty days give a person time to extend it before that happens.
 */
const TTL_DAYS_MIN = 30;

/** Milliseconds in one day, to turn a count of ledgers into days. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** A common phone viewport. The session runs on phones, not on a desktop. */
const PHONE = Object.freeze({ width: 390, height: 844 });

/**
 * The bytes that a passkey voucher really carries.
 *
 * A signed entry measures 792 bytes, and the payload carries a five byte prefix
 * in front of it. The length decides the symbol version, so a code drawn from
 * any other length would sit at a density that no payer ever sees.
 */
const PAYLOAD_BYTES = 797;

/** Elements that every screen carries, which must never need a sideways scroll. */
const ALWAYS_ON_SCREEN = Object.freeze([
  ['the ledger reading', '#ledger'],
  ['the pay button', '#nav-payer'],
  ['the account fact', '#fact-device'],
  ['the service fact', '#fact-service'],
  ['the ledger fact', '#fact-ledger'],
]);

/**
 * What only a stored voucher puts on the screen.
 *
 * This list held three entries. Two of them, the size line and the level
 * control, named a measurement surface that the application no longer carries.
 * A selector that can never match makes a check that can never fail. The block
 * that held it ran for nobody, so neither fact ever reached a person.
 *
 * The block runs now. The check stores a voucher and paints it, so a selector
 * that goes stale takes the run down with it.
 */
const CODE_SELECTOR = 'canvas.code';

const SESSION_ELEMENTS = Object.freeze([
  ['the code', CODE_SELECTOR],
]);

const args = process.argv.slice(2);
// Every check must run. A deployment that this run tags, or a reproduction on
// a clean machine, cannot accept a number that quietly counts fewer checks.
const COMPLETE = args.includes('--complete');
const origin = args.find((one) => !one.startsWith('--')) ?? DEFAULT_ORIGIN;
/**
 * How many checks this suite may leave out of reach.
 *
 * `outOfReach` names something that no setup can supply, so `--complete`
 * cannot refuse it the way that it refuses a skip. That makes it the one place
 * where a check can stop and nothing complains. It is how a check goes quiet.
 * The size line and the level control sat in such a block, with selectors that
 * could no longer match anything. The block ran for nobody, so neither fact
 * ever reached a person.
 *
 * The number is zero. Every check in this suite reaches its subject today.
 * The last one that did not now stores a voucher and paints it, rather than a
 * wait for a person to mint one.
 *
 * A new entry pushes the total past zero and `--complete` refuses the run.
 * Raising this number is an edit to this line, it shows in a diff, and whoever
 * raises it owes a reason. Reaching the subject is nearly always cheaper than
 * the reason.
 */
const NOT_REACHED_ALLOWED = 0;

const problems = [];
const skipped = [];
const unreachable = [];
let checks = 0;

function check(holds, message) {
  checks += 1;
  if (!holds) problems.push(message);
}

/**
 * Record a check that did not run.
 *
 * A skipped check counts nothing and reports nothing, so the final number
 * shrinks and the last sentence still says that everything answered. That
 * happened once. Somebody set `CHROME_PATH` and did not export it. The whole
 * browser check fell away, and the run said that it answered every check over
 * twenty fewer of them. A skip is now a fact that the summary carries, and `--complete`
 * refuses the run outright.
 */
function skip(what) {
  skipped.push(what);
  console.log(`  SKIPPED ${what}`);
}

/**
 * Record a check that this run cannot reach by its nature.
 *
 * The difference from `skip` is the fix. A skip names something that a person
 * can supply: a browser, a file that only the host holds. Run it in the right
 * place with the right variable and the check runs. This names something that
 * no setup supplies, because the run would have to mint a voucher with a
 * passkey, and no unattended run does that.
 *
 * Keep this list at the two entries that it has. Anything a person can repair
 * by a different command line is a skip. A move into this list, to make a run
 * pass, is the exact fault that this pair exists to stop.
 */
function outOfReach(what) {
  unreachable.push(what);
  console.log(`  NOT REACHED ${what}`);
}

console.log(`checking ${origin}`);
console.log('this reads a running origin, so anybody can run it against ours\n');

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
  'a cache may hold sw.js, so a new build cannot reach a device that holds the old worker',
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
// This reads everything here from outside the host, through the status route.
// The route is a view of the file that the listener writes, and the two live
// in different processes. So this asks whether the view carries anything at
// all.
//
// A route that answers with nothing while the listener runs is the failure
// worth a check here. It means that the writer and the reader name different
// files, and it looks perfectly healthy until somebody needs it.
//
// `deploy/listener-check.mjs` judges the state itself on the host, and it
// reads the file rather than the view. That check stays there on purpose. A
// reader that could only reach the route would learn nothing about a healthy
// listener whenever the service in front of it was down.
// The forwarded header, read from the configuration this host serves.
//
// The service identifies a caller by the first entry of that header, and it
// keys its budget on that entry. The web server must therefore set the header
// rather than append to what a caller sent.
//
// The deployment refuses to install a configuration that appends. This asks a
// different question: whether the configuration that the host serves right now
// still says so. That catches an edit made on the host rather than in a
// commit.
//
// It is a host-side read. Every other line here comes from outside the host,
// and this one cannot, because the file is not public. It says so rather than
// letting a reader take it for something the origin answered.
const SERVED_NGINX = '/etc/nginx/sites-available/senet';
const APPENDS = /^[ \t]*proxy_set_header[ \t]+X-Forwarded-For[ \t]+\$proxy_add_x_forwarded_for/m;
const SETS = /^[ \t]*proxy_set_header[ \t]+X-Forwarded-For[ \t]+\$remote_addr/m;
if (existsSync(SERVED_NGINX)) {
  const served = readFileSync(SERVED_NGINX, 'utf8');
  // `check` here speaks only when it fails, so the message describes the fault
  // rather than the healthy state. The report below names the healthy state,
  // beside the other facts, because a host-side read has to say that it is one.
  check(SETS.test(served) && !APPENDS.test(served),
    APPENDS.test(served)
      ? 'the served configuration appends to X-Forwarded-For, so a caller names itself'
      : 'the served configuration does not set X-Forwarded-For from the connection');
} else {
  skip(`the forwarded header, because ${SERVED_NGINX} is not readable from here`);
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
      ? 'the listener does not hold the cursor on an event that it cannot deliver'
      : `the listener cannot deliver ${listener.stuckOn}`);
  check(typeof listener.ageMs === 'number' && listener.ageMs <= LISTENER_AGE_MAX_MS,
    typeof listener.ageMs === 'number'
      ? `the cursor was written ${Math.round(listener.ageMs / 1000)} seconds ago`
      : 'the status route gives the cursor no age, so nothing here shows a stopped listener');
} else {
  skip('everything about the listener, because the status route reports none');
}

// The ledger entries that every payment needs, and how long the network keeps
// them.
//
// A contract instance and its code stay live only for their TTL. An archived
// voucher contract makes the first redemption pay to restore it. On 4 October
// 2026 that restore asked for 26.5 million stroops. The service refused the
// fee, so every redemption failed while every other check here passed.
//
// The wallet code is here because every passkey account runs it. After that
// code archives, a new account cannot deploy.
//
// This asks the RPC that the service names, from outside the host.
async function readTtl() {
  const chain = new rpc.Server(config.rpcUrl);
  const instanceKey = new Contract(config.contractId).getFootprint();
  const [instance] = (await chain.getLedgerEntries(instanceKey)).entries;
  if (instance === undefined) throw new Error(`the RPC holds no instance of ${config.contractId}`);
  const codeKey = (hash) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash }));
  const named = [
    ['the voucher instance', instanceKey],
    ['the voucher code', codeKey(instance.val.contractData().val().instance().executable().wasmHash())],
    ['the wallet code', codeKey(Buffer.from(config.walletWasmHash, 'hex'))],
  ];
  const head = (await chain.getLatestLedger()).sequence;
  const { entries } = await chain.getLedgerEntries(...named.map(([, key]) => key));
  const liveUntil = new Map(entries.map((entry) => [entry.key.toXDR('base64'), entry.liveUntilLedgerSeq]));
  return named.map(([name, key]) => {
    const until = liveUntil.get(key.toXDR('base64'));
    const days = until === undefined ? null : ((until - head) * core.LEDGER_TARGET_CLOSE_MS) / DAY_MS;
    return { name, until, days };
  });
}

let ttl = [];
try {
  ttl = await readTtl();
} catch (error) {
  check(false, `the TTL of the contract entries is unknown: ${error instanceof Error ? error.message : String(error)}`);
}
for (const { name, days } of ttl) {
  check(days !== null && days >= TTL_DAYS_MIN,
    days === null ? `${name} is absent from the RPC, so no payment can use it`
      : days < 0 ? `${name} is archived, so the next call that needs it pays to restore it`
        : `${name} keeps ${days.toFixed(1)} days of TTL, and the limit is ${TTL_DAYS_MIN}`);
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
} else {
  skip('the relying party that the service serves, because it serves none');
}

// The origin names the commit that it serves. A content search cannot tell a
// release that lacks a change from a check that looks for the wrong string.
// A deployment therefore answers the question, and nobody infers it.
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
} else {
  // This is the skew between the two links, and it disappears every time a
  // person runs this from a laptop. It said nothing while it disappeared.
  //
  // One skip for each check above, rather than one for the pair. A reader
  // counts the checks in a run on the host and in a run from a clone. Two
  // checks that did not run, recorded as one, leave a check unaccounted for.
  // That is the arithmetic this file exists to keep honest.
  const why = `because ${SERVICE_RELEASE} is not readable from here, so this run is not on the host`;
  skip(`the commit skew between the origin and the service, ${why}`);
  skip(`the release skew between the origin and the service, ${why}`);
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
if (existsSync(SERVED_NGINX)) {
  const served = readFileSync(SERVED_NGINX, 'utf8');
  console.log(`  forwarded ${SETS.test(served) && !APPENDS.test(served) ? 'set from the connection' : 'NOT set from the connection'}`
    + '   read on the host, from the configuration that it serves');
}
console.log(`  listener ${listener?.cursor ?? 'no cursor'}`
  + `${listener?.stuckOn === null || listener?.stuckOn === undefined ? '' : `, stuck on ${listener.stuckOn}`}`
  + '   read from outside the host, through the status route');
console.log(`  ttl      ${ttl.map(({ name, until, days }) =>
  `${name} until ledger ${until ?? 'unknown'}, ${days === null ? 'unknown' : days.toFixed(1)} days`).join('; ')}`);
console.log(`           read from ${config.rpcUrl}, the RPC that the service names (the limit is ${TTL_DAYS_MIN} days)`);
console.log(`  errors     ${carried.length} of ${errorNames.length} typed names carried as text`);
console.log(`  relying party ${RP_ID}, declared in the release`);
console.log('                the browser derives the real one from the origin');

// The worker and the manifest decide whether a phone installs the application.
// Only a browser answers that, so this check drives one.
const chromePath = process.env.CHROME_PATH;
if (chromePath === undefined || chromePath === '') {
  console.log('');
  skip('the browser check, because CHROME_PATH names no browser');
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
    // Only an application that runs shows that, so the check reads its own words.
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
    // Geometry, which a reader of text cannot answer. A line that falls out of
    // frame renders correct text in a place that nobody can photograph. So the
    // check measures where each element sits, rather than what it says.
    await page.setViewport(PHONE);

    // A code appears only after a payer mints one, and no unattended run signs
    // a passkey. The panel that draws it does not need one: it reads a stored
    // voucher and paints its payload. So the check stores a voucher of the size
    // that a passkey really produces. The code that it measures is then the
    // code that a payer sees.
    //
    // This is why the block below runs at all. It used to sit out of reach, and
    // two of the three elements it named had stopped existing without anything
    // saying so.
    await page.evaluate(
      (payload) => {
        window.localStorage.setItem(
          'senet.vouchers',
          JSON.stringify([
            {
              voucherId: 'a'.repeat(32),
              amountStroops: '10000000',
              expireAt: 1,
              mintedAtMs: 0,
              payloadBase64: payload,
              state: 'active',
              voidHash: null,
            },
          ]),
        );
      },
      Buffer.from(
        Uint8Array.from({ length: PAYLOAD_BYTES }, (unused, at) => (at * 31 + 7) & 0xff),
      ).toString('base64'),
    );
    await page.goto(origin, { waitUntil: 'load' });
    await page.click('#nav-payer');
    // The list draws one row for the stored voucher, and its `Show` button
    // paints the code.
    const painted = await page
      .waitForSelector('#payer-list button', { visible: true, timeout: 10_000 })
      .then(async (button) => {
        await button.click();
        await page.waitForSelector(CODE_SELECTOR, { visible: true, timeout: 10_000 });
        return true;
      })
      .catch(() => false);
    check(painted, 'a stored voucher drew no code, so the payer screen cannot show one');

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
      console.log('');
      const named = SESSION_ELEMENTS.map(([label]) => label).join(', ');
      outOfReach(`the geometry of ${named}, because this run mints no voucher`);
    } else {
      const boxes = shown.map(([label]) => frame.seen[label]);
      const top = Math.min(...boxes.map((box) => box.top));
      const bottom = Math.max(...boxes.map((box) => box.bottom));
      check(bottom - top <= frame.height,
        `the code spans ${Math.round(bottom - top)} pixels, and the viewport is `
        + `${frame.height}, so a phone cannot show it whole`);
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

console.log(`\n${checks} checks, ${skipped.length} skipped, ${unreachable.length} out of reach`);
for (const problem of problems) console.log(`PROBLEM: ${problem}`);
for (const one of skipped) console.log(`SKIPPED: ${one}`);
for (const one of unreachable) console.log(`NOT REACHED: ${one}`);
if (problems.length > 0) {
  throw new Error(`${problems.length} of ${checks} checks failed`);
}
if (COMPLETE && unreachable.length > NOT_REACHED_ALLOWED) {
  throw new Error(
    `${unreachable.length} checks are out of reach and this suite allows ` +
      `${NOT_REACHED_ALLOWED}. A check that nothing can reach is a check that ` +
      `nothing enforces. Make the new one reachable, or raise ` +
      `NOT_REACHED_ALLOWED in this file and say why.`,
  );
}
if (skipped.length > 0) {
  if (COMPLETE) {
    throw new Error(
      `${skipped.length} checks did not run, and --complete demands all of them`,
    );
  }
  console.log(`the deployment answers the ${checks} checks that ran, and ${skipped.length} did not run`);
} else {
  console.log(`the deployment answers every check that this run can reach, and ${checks} ran`);
}
