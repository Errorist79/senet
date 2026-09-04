/// <reference lib="webworker" />

/**
 * The service worker.
 *
 * A payer mints a voucher with no network, so the application itself must open
 * with no network. The worker holds the shell files and serves them from the
 * cache. It never holds a service reply, because a stale balance or a stale
 * ledger is worse than no answer.
 */

/** The cache name. A change here drops every earlier file at the next start. */
const CACHE = 'senet-shell-1';

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

scope.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => scope.skipWaiting()),
  );
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

  event.respondWith(
    caches.match(event.request).then(async (hit) => {
      if (hit !== undefined) return hit;
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(event.request, response.clone());
        }
        return response;
      } catch {
        // The device is offline and the cache does not hold this path. The
        // shell is the only page, so it answers every navigation.
        const shell = await caches.match('/index.html');
        if (shell !== undefined) return shell;
        return new Response('offline', { status: 503, statusText: 'offline' });
      }
    }),
  );
});
