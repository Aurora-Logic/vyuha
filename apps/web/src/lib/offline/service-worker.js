/// <reference lib="webworker" />
/**
 * The service worker (REQ-D-10, technical design section 8).
 *
 * Hand-written. `vite-plugin-pwa` and Workbox are both dependencies and
 * CLAUDE.md section 6 forbids adding one without asking; this file is small
 * enough that the trade is not close.
 *
 * Plain JavaScript, and not part of the application bundle. It is served at the
 * origin root by the `serviceWorker()` plugin in `vite.config.ts`, which is
 * also what substitutes `SW_VERSION` below. Keeping it outside the bundle means
 * a build that fails to compile still leaves a worker that can be replaced.
 *
 * Two rules govern everything here.
 *
 * 1. **No API response is ever cached, or even intercepted.** Attendance that
 *    silently goes stale is worse than an error, because an error is visible.
 *    An `/api/` request does not call `respondWith` at all, so the browser
 *    handles it exactly as it would with no worker installed - the same
 *    failures, the same statuses, the same timing. There is no cache-control
 *    header, no expiry, and no code path that could be tuned into caching one.
 *
 * 2. **The app stays replaceable.** The cache name carries the build's version,
 *    every cache from a different version is deleted on activate, and the new
 *    worker takes control immediately rather than waiting for every tab to
 *    close. The HTML is fetched network-first, so a reload after a deploy
 *    always sees the new asset names.
 */

/** Replaced at build time with a hash of the emitted bundle. See vite.config.ts. */
const VERSION = '__SW_VERSION__';

const CACHE_PREFIX = 'vyuha-shell-';
const SHELL_CACHE = CACHE_PREFIX + VERSION;

/** The document every route falls back to; this is a single-page app. */
const SHELL_URL = new URL('/', self.location.href).href;

/**
 * The build's own output, stamped in by the `serviceWorker()` plugin in
 * vite.config.ts. Empty in development, where there are no chunk names at all
 * and every module is fetched individually.
 *
 * Derived rather than written down. The names carry a content hash, so a
 * hand-kept list would be wrong after the first component edit - and wrong
 * silently, which is how this failed before: the chunks were left out
 * altogether "because their names change every build", and cached only as they
 * were fetched. That works from the second controlled load onwards. On the
 * first, every module is fetched before a worker exists to see it, so nothing
 * held the entry bundle, and an offline reload served the shell and then
 * ERR_FAILED on the script - a blank page, no sign-in, no sight of the punch
 * waiting in the queue. That is the walk from a desk to a gate with no signal.
 */
const BUILD_CRITICAL = __SW_BUILD_CRITICAL__;

/**
 * What must be present for the app to start with no network at all. If any of
 * these is missing the install fails, and that is the right trade: a worker
 * that cannot serve the app offline is worse than no worker, because it looks
 * like one that can.
 */
const PRECACHE_CRITICAL = ['/', ...BUILD_CRITICAL];

/**
 * Non-hashed static files that become cache-first after their first request.
 * They are deliberately not fetched during install: an optional icon should
 * neither delay worker activation nor make a newly deployed shell compete
 * with every lazy route for bandwidth (H-13). Hashed build assets follow the
 * same on-demand path through `IMMUTABLE` below.
 *
 * Everything `index.html` and the manifest reference is here, and
 * `scripts/check-precache.mjs` fails the lint if that ever stops being true.
 * The favicon was the one that was missed, and it cost a `net::ERR_FAILED` on
 * an offline load before it had ever been requested. Once requested under a
 * controlling worker, it is retained with the rest of this version's shell.
 */
const RUNTIME_OPTIONAL = [
  '/manifest.webmanifest',
  '/icons/favicon.svg',
  '/icons/apple-touch-icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
];

/**
 * Content-hashed build output. The name changes whenever the bytes change, so
 * these may be served from the cache without checking - and a stale one is
 * impossible, because a stale one is a different file name.
 */
const IMMUTABLE = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

/** Rule 1, stated as a predicate so it can be read in one place. */
function isApi(url) {
  return url.origin !== self.location.origin || url.pathname.startsWith('/api/');
}

/** One handle, opened once, rather than a `caches.open` per request. */
let shellCache = null;
function openShell() {
  shellCache ??= caches.open(SHELL_CACHE);
  return shellCache;
}

/**
 * Writes to the cache off the critical path.
 *
 * Never awaited before a response is returned. Making every request wait for a
 * cache write measurably slows a cold load — in development that is several
 * hundred module requests each paying for a disk write — and the cost is
 * invisible until something downstream times out. `waitUntil` keeps the worker
 * alive until the write finishes without holding the page up for it.
 */
function cacheInBackground(event, key, response) {
  // A 206, a redirect, or an opaque cross-origin response cannot be replayed
  // usefully and `cache.put` rejects on some of them outright.
  if (response.status !== 200 || response.type !== 'basic') return;
  if (isApi(new URL(event.request.url))) return; // belt and braces for rule 1
  const copy = response.clone();
  event.waitUntil(openShell().then((cache) => cache.put(key, copy)));
}

/**
 * Navigations: network first, shell second.
 *
 * Network first rather than cache first because the HTML names the asset
 * bundle. Serving a cached document after a deploy would point the browser at
 * chunk names that no longer exist, which is the failure this whole file is
 * written to avoid.
 */
async function handleNavigation(event) {
  try {
    const response = await fetch(event.request);
    // Stored under '/' rather than under the requested route: every route in
    // this app is served the same document, and keeping one copy means a route
    // visited for the first time while offline still finds a shell.
    cacheInBackground(event, SHELL_URL, response);
    return response;
  } catch (cause) {
    const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    // Nothing cached and no network. Rethrowing produces the browser's own
    // offline page, which is more honest than a blank 200 we invented.
    throw cause;
  }
}

async function cacheFirst(event) {
  const cached = await caches.match(event.request, { cacheName: SHELL_CACHE });
  if (cached) return cached;
  const response = await fetch(event.request);
  cacheInBackground(event, event.request, response);
  return response;
}

async function networkFirst(event) {
  try {
    const response = await fetch(event.request);
    cacheInBackground(event, event.request, response);
    return response;
  } catch (cause) {
    const cached = await caches.match(event.request, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw cause;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await openShell();
      await cache.addAll(PRECACHE_CRITICAL);
      // Do not wait for every tab to close. A worker that sits in `waiting`
      // for days is how a broken deploy becomes unfixable, and this app is
      // opened at a gate and left open.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );
      // Take over the pages that are already open, so their next request for a
      // document goes through this worker rather than the old one.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // A write is never a cache candidate, and intercepting one would put this
  // worker in the path of a punch upload for no benefit.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Rule 1. No `respondWith`, so the request is handled as though no worker
  // were installed at all.
  if (isApi(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (IMMUTABLE.test(url.pathname) || RUNTIME_OPTIONAL.includes(url.pathname)) {
    event.respondWith(cacheFirst(event));
    return;
  }

  event.respondWith(networkFirst(event));
});

/**
 * Lets the page ask which build is serving it. Used by the update check in
 * `register-service-worker.ts` and by the verification harness, which
 * otherwise has no way to tell one worker from another.
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'VERSION') {
    event.source?.postMessage({ type: 'VERSION', version: VERSION, cache: SHELL_CACHE });
  }
});
