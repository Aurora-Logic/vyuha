#!/usr/bin/env node
/**
 * Drives the *production* build offline, through a real service worker.
 *
 * The browser gate beside this one (`verify-ui.mjs`) runs against the vite dev
 * server, deliberately: the pattern gallery it drives is mounted in development
 * only. But the dev server renders `/sw.js` with an empty precache - the list
 * is computed in `generateBundle`, so it exists only in a build - and the
 * worker CI loaded therefore contained, literally, `const BUILD_CRITICAL = [];`.
 * The commit that precaches the build's own output was structurally invisible
 * to the only browser check there was, and `check-precache.mjs` reads source
 * and deliberately does not look at `/assets`. So this exists: same browser,
 * same protocol, but a static server over `dist/` rather than a dev server.
 *
 * The one check that matters is the last one: offline, reload, and the app has
 * to start. Getting it to mean that took four attempts, and each of the first
 * three passed against a deliberately emptied precache. They are written down
 * here because every one of them is a trap the next person will fall into:
 *
 *   - Storage is cleared, and the page is loaded exactly once while online.
 *     That document is not controlled by the worker - the worker is installing
 *     while it loads - so the fetch handler never sees its requests and cannot
 *     cache them on the way past. Asserted, via `__controlledAtStart`, rather
 *     than assumed.
 *   - The reload is waited on by a stamp that has to disappear, not by "React
 *     is mounted". Navigating to the URL already open leaves the old document
 *     intact for a moment, and the old document is mounted.
 *   - Chrome's HTTP cache is emptied. `Network.setCacheDisabled` alone is not
 *     enough: the override does not survive into a freshly navigated document.
 *   - The server is shut down, and this is the one that matters most.
 *     `Network.emulateNetworkConditions` applies to the *page's* target, and a
 *     service worker is a target of its own - so the `fetch()` inside its fetch
 *     handler ignored "offline" entirely and pulled the entry chunk over the
 *     real network from this very script's server. With nothing listening, the
 *     cache is the only thing left that can answer.
 *
 * If the precache is ever emptied again, the document is served from the cache
 * and its own script is not, and this reports a blank page - verified by doing
 * exactly that.
 *
 * No API and no database. Offline with no session renders the sign-in form,
 * which is all the proof needed that the bundle ran.
 *
 * Usage:
 *   pnpm --filter @vyuha/web build
 *   chrome --remote-debugging-port=9222 --headless=new --user-data-dir=/tmp/x
 *   node apps/web/scripts/verify-offline.mjs
 *
 * Environment: VERIFY_CDP (default http://127.0.0.1:9222),
 *              VERIFY_OFFLINE_PORT (default 5199),
 *              VERIFY_DIST (default apps/web/dist).
 */

import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = process.env.VERIFY_DIST ?? join(WEB_ROOT, 'dist');
const PORT = Number(process.env.VERIFY_OFFLINE_PORT ?? 5199);
const CDP = process.env.VERIFY_CDP ?? 'http://127.0.0.1:9222';
const ORIGIN = `http://localhost:${String(PORT)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------- static server
//
// Dependency-free, and it has to get two headers right or the whole exercise
// is theatre: `/sw.js` must never be served from the HTTP cache, and it needs
// a JavaScript content type or the browser refuses to register it.
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function serve() {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', ORIGIN).pathname);
    // Traversal is not a threat here, but a `..` that escaped `dist` would
    // make this test read files that are not in the build, which is worse than
    // a security problem: it is a green light for something untrue.
    const wanted = pathname.replace(/\/+/gu, '/').replace(/(^|\/)\.\.(?=\/|$)/gu, '');

    const sendFile = async (file) => {
      const body = await readFile(join(DIST, file));
      const headers = { 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' };
      if (file === 'sw.js') {
        headers['Cache-Control'] = 'no-store';
        headers['Service-Worker-Allowed'] = '/';
      }
      res.writeHead(200, headers).end(body);
    };

    void (async () => {
      if (wanted !== '/') {
        try {
          await sendFile(wanted.replace(/^\//u, ''));
          return;
        } catch {
          // Falls through to the single-page document, like any static host.
        }
      }
      try {
        await sendFile('index.html');
      } catch {
        res.writeHead(404).end('not found');
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// -------------------------------------------------------------- CDP session
class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.requests = [];

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Network.requestWillBeSent') {
        this.requests.push({ id: msg.params.requestId, url: msg.params.request.url, failed: null });
      }
      if (msg.method === 'Network.loadingFailed') {
        const request = this.requests.find((r) => r.id === msg.params.requestId);
        if (request) request.failed = msg.params.errorText;
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.consoleErrors.push(msg.params.entry.text.slice(0, 200));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 25000);
    });
  }

  /**
   * Never throws. A probe that throws takes the summary down with it, and the
   * summary is the only thing anybody reads out of a CI artifact.
   */
  async eval(expression) {
    try {
      const res = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) return null;
      return res.result.value;
    } catch {
      return null;
    }
  }

  async waitFor(expression, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.eval(expression);
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(150);
    }
  }

  async offline(on) {
    await this.send('Network.emulateNetworkConditions', {
      offline: on,
      latency: 0,
      downloadThroughput: on ? 0 : -1,
      uploadThroughput: on ? 0 : -1,
    });
  }
}

async function firstPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await (await fetch(`${CDP}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Chrome is not listening yet.
    }
    await sleep(250);
  }
  throw new Error(`No CDP page target on ${CDP}`);
}

// ------------------------------------------------------------------- checks
const server = await serve();
console.log(`serving ${DIST} on ${ORIGIN}`);

const target = await firstPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
const s = new Session(ws);
await s.send('Page.enable');
await s.send('Runtime.enable');
await s.send('Log.enable');
await s.send('Network.enable');
// The single most important line in this file. With the HTTP cache live, the
// entry chunk is served from memory on the offline reload and the last check
// passes against an empty precache.
await s.send('Network.setCacheDisabled', { cacheDisabled: true });

let exitCode = 1;
try {
  const emitted = await readdir(join(DIST, 'assets')).catch(() => null);
  if (emitted === null) {
    check('The production build exists', false, `no assets directory under ${DIST}`);
  } else {
    check('The production build exists', true, `${String(emitted.length)} file(s) under assets/`);
  }

  // ------------------------------------------------- the worker as served
  const workerSource = await fetch(`${ORIGIN}/sw.js`).then((r) => (r.ok ? r.text() : null));
  const criticalMatch = workerSource ? /const BUILD_CRITICAL = (\[[^\]]*\]);/u.exec(workerSource) : null;
  let precached = [];
  try {
    precached = JSON.parse(criticalMatch?.[1] ?? '[]');
  } catch {
    precached = [];
  }

  const codeAndStyle = (emitted ?? [])
    .filter((name) => /\.(js|css)$/u.test(name))
    .map((name) => `/assets/${name}`)
    .sort();

  check(
    'The served worker precaches this build, not an empty list',
    precached.length > 0 && precached.every((url) => codeAndStyle.includes(url)),
    precached.length === 0
      ? 'BUILD_CRITICAL is empty — this is what the dev server serves, and what CI used to check'
      : `${String(precached.length)} critical entries from ${String(codeAndStyle.length)} emitted code and stylesheet file(s)`,
  );

  // ------------------------------------------ a genuinely first install
  //
  // Recorded at document start, because `clients.claim()` sets `controller` a
  // moment later and by the time anything could be evaluated it is non-null
  // either way. What decides whether this test is valid is whether the worker
  // was controlling when the entry chunk was requested - if it was, the fetch
  // handler cached the chunk on the way past and the precache is not what the
  // offline boot proves.
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__controlledAtStart = !!navigator.serviceWorker.controller;`,
  });

  await s.send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await s.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await s.send('Page.navigate', { url: `${ORIGIN}/` });

  const activated = await s.waitFor(
    `navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false)`,
    20000,
  );
  check('The worker installs and activates on a first visit', Boolean(activated));

  check(
    'That first visit was uncontrolled, so only the precache can explain what follows',
    (await s.eval(`window.__controlledAtStart`)) === false,
    'a controlled document would have had its chunks cached by the fetch handler instead',
  );

  const cacheState = await s.eval(`(async () => {
    const names = await caches.keys();
    const shell = names.find(n => n.startsWith('vyuha-shell-'));
    if (!shell) return JSON.stringify({ names, held: [] });
    const cache = await caches.open(shell);
    const held = (await cache.keys()).map(r => new URL(r.url).pathname).sort();
    return JSON.stringify({ names, shell, held });
  })()`);
  const cached = cacheState === null ? { names: [], held: [] } : JSON.parse(cacheState);

  const notHeld = precached.filter((url) => !cached.held.includes(url));
  check(
    'The install really put the critical build closure in the cache',
    precached.length > 0 && notHeld.length === 0,
    notHeld.length === 0
      ? `${String(cached.held.length)} entries in ${String(cached.shell ?? 'no cache')}`
      : `missing ${JSON.stringify(notHeld)}`,
  );

  // Rule 1 of the worker: an API response is never cached, or even
  // intercepted. Asserted against the cache itself rather than against the
  // code that is supposed to prevent it.
  check(
    'No API response was cached',
    cached.held.every((path) => !path.startsWith('/api/')),
    cached.held.filter((p) => p.startsWith('/api/')).join(', ') || 'nothing under /api/',
  );

  // ---------------------------------------------- the check this file is for
  //
  // Not a second online load first. The document above was loaded while the
  // worker was still installing, so it was never controlled and its requests
  // never reached the fetch handler - which means nothing here can have been
  // cached on the way past. What answers now is the precache or nothing.
  // The server is shut down rather than the browser being told it is offline,
  // and that is the difference between this checking something and not.
  //
  // `Network.emulateNetworkConditions` applies to the page's target. A service
  // worker is a target of its own, so the `fetch()` inside its fetch handler is
  // not covered by it: with the page "offline", the worker cheerfully fetched
  // the entry chunk over the real network from the very server this script is
  // running, answered the page with 200, and the check passed against a
  // deliberately emptied precache. Chrome's HTTP cache had to go too - the
  // `setCacheDisabled` override does not survive into a freshly navigated
  // document either.
  //
  // With nothing listening on the port, the cache is the only thing that can
  // answer. Asserted, not assumed, before going on.
  await s.send('Network.clearBrowserCache');
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const stillServing = await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(2000) })
    .then(() => true)
    .catch(() => false);
  check(
    'The server is really down before the offline check runs',
    !stillServing,
    stillServing ? `something is still answering on ${ORIGIN}` : `nothing is listening on ${ORIGIN}`,
  );

  await s.offline(true);
  s.requests.length = 0;
  s.consoleErrors.length = 0;

  // Stamped before navigating, and waited on afterwards. Navigating to the URL
  // already open leaves the old document intact for a moment, so polling only
  // for "React is mounted" is answered by the page being left - which reported
  // a successful offline boot against a deliberately emptied precache. The
  // stamp disappearing is what proves a new document.
  const stamp = `offline-${String(Date.now())}`;
  await s.eval(`window.__offlineStamp = ${JSON.stringify(stamp)}; true`);

  await s.send('Page.navigate', { url: `${ORIGIN}/` });
  await s.offline(true); // Chrome does not re-push the override into a new document.
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });

  const mounted = await s.waitFor(
    `(() => {
       if (window.__offlineStamp === ${JSON.stringify(stamp)}) return false;
       const r = document.getElementById('root');
       return !!r && Object.keys(r).some(k => k.startsWith('__reactContainer')) && r.innerHTML.length > 0; })()`,
    20000,
  );

  const rendered = await s.eval(`JSON.stringify({
    signIn: !!document.querySelector('#email'),
    bodyLength: document.body.innerHTML.length,
    offline: navigator.onLine === false,
  })`);
  const view = rendered === null ? { signIn: false, bodyLength: 0, offline: false } : JSON.parse(rendered);

  check(
    'A first install boots with no signal at all',
    Boolean(mounted) && view.signIn && view.offline,
    Boolean(mounted) && view.signIn
      ? `React mounted from the cache and rendered the sign-in form (${String(view.bodyLength)} bytes of body)`
      : `mounted=${String(Boolean(mounted))} signIn=${String(view.signIn)} offline=${String(view.offline)} — ` +
        'the document came from the cache and its own script did not',
  );

  // Counting requests would prove nothing: CDP reports a request the worker
  // answered from the cache exactly as it reports one that went out. What
  // separates them is whether it failed - offline, anything that actually
  // reached for the network did.
  const deadAssets = s.requests.filter((r) => r.url.includes('/assets/') && r.failed !== null);
  check(
    'Nothing the app needs to start failed while offline',
    deadAssets.length === 0,
    deadAssets.length === 0
      ? `${String(s.requests.filter((r) => r.url.includes('/assets/')).length)} asset request(s), all answered by the worker`
      : deadAssets.map((r) => `${new URL(r.url).pathname} ${r.failed}`).join(', '),
  );

  await s.offline(false);
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
  if (failed.length > 0) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  exitCode = failed.length > 0 || results.length === 0 ? 1 : 0;
  server.closeAllConnections();
  server.close();
  ws.close();
}

process.exit(exitCode);
