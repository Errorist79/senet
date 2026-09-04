/// <reference lib="webworker" />

import { RELEASE_PATH } from './config.js';

/**
 * The service worker.
 *
 * A payer mints a voucher with no network, so the application itself must open
 * with no network. The worker holds the shell files and serves them from the
 * cache. It never holds a service reply, because a stale balance or a stale
 * ledger is worse than no answer.
 */

/**
 * What the shell files hash to, which the build writes in here.
 *
 * A browser compares the bytes of this file to decide whether a worker is new.
 * An earlier version named no build, so every release compiled to the same
 * bytes. No release was ever new, and the cache served the first build for
 * ever. One path then remained to a newer build: a person deletes the
 * application, and loses the account with it.
 *
 * The value is the hash of the shell files themselves. The worker therefore
 * changes when the application changes, and it stays the same when a release
 * carries no change to what a person runs.
 */
declare const SHELL_BUILD: string;

/** The cache name. A change here drops every earlier file at the next start. */
const CACHE = `senet-shell-${SHELL_BUILD}`;

/** The files that the application needs to open. */
const SHELL = ['/', '/index.html', '/app.js', '/app.css', '/manifest.webmanifest'];

/** The prefix of every path that the worker must never hold. */
const LIVE_PREFIX = '/api/';

/** The worker's own global scope, checked rather than assumed. */
function workerScope(): ServiceWorkerGlobalScope {
  if (!(self instanceof ServiceWorkerGlobalScope)) {
    throw new Error('this file runs only as a service worker');
  }
  return self;
}

const scope = workerScope();

/**
 * Take the shell, and take over.
 *
 * The worker becomes the active one as soon as it installs. It does not claim
 * a page that is already open. A person therefore keeps the version that they
 * started with, until they start the application again.
 *
 * That pair is what makes a swap safe without any test of whether it is safe.
 * A person can hold a minted voucher on the screen, or wait for a payment to
 * answer. Nothing about the open page changes, and neither one stops.
 */
scope.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (cache) => {
        await cache.addAll(SHELL);
        // The identity of this build, taken at the same moment as the files it
        // describes. A page that reads it over the network later reads whatever
        // the origin serves then, which names a build that nobody is running.
        //
        // This stays outside `addAll` on purpose. A deployment that publishes
        // no identity must still get a worker, and `addAll` refuses the whole
        // set when one file is missing.
        await cache.add(RELEASE_PATH).catch(() => {
          // The footer says that the build is unknown, and everything else works.
        });
      })
      .then(() => scope.skipWaiting()),
  );
});

// The caches of earlier builds go. This worker never calls `clients.claim`. A
// page that another worker controls keeps that worker, and it keeps the cache
// of that worker, until the next start.
//
// That page loses its cache here, while it is still open. Today it never
// notices, because the shell holds everything and a loaded page asks only for
// the service, which no worker answers. A reload reaches the new worker and
// the new cache, which a measurement confirmed.
//
// This becomes a real fault the day the application loads anything after the
// first paint: a font, an image, a split bundle, a second page. Such a request
// would reach the deleted cache of the old worker, and it would fail with no
// network and no message. A person who adds such a request must also keep the
// previous cache here, in the same change.
scope.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))),
      ),
  );
});

scope.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== scope.location.origin) return;
  if (url.pathname.startsWith(LIVE_PREFIX)) return;

  // Every lookup names this build's cache. A search across all the caches can
  // answer from an earlier build, which is the fault that this worker exists
  // to end. A worker serves the files of its own build, or it serves none.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit !== undefined) return hit;
      try {
        const response = await fetch(event.request);
        if (response.ok) await cache.put(event.request, response.clone());
        return response;
      } catch {
        // The device is offline and the cache does not hold this path. The
        // shell is the only page, so it answers every navigation.
        const shell = await cache.match('/index.html');
        if (shell !== undefined) return shell;
        return new Response('offline', { status: 503, statusText: 'offline' });
      }
    }),
  );
});
