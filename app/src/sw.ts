/// <reference lib="webworker" />

import { SKIP_WAITING } from './config.js';

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
 * Take the shell, and then wait.
 *
 * The worker does not take over on its own. A person can hold a minted voucher
 * on the screen, or wait for a merchant's submission to answer. A swap at that
 * moment ends a payment in progress, and the screen that the swap destroys is
 * the person's only evidence of it. The application offers the person a restart
 * instead, and this worker waits until they take it.
 */
scope.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

/** The person chose the moment. Take over now. */
scope.addEventListener('message', (event) => {
  if (event.data === SKIP_WAITING) void scope.skipWaiting();
});

scope.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => scope.clients.claim()),
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
