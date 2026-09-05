#!/usr/bin/env node
/**
 * Fails when a static file the document or the manifest references is not in
 * the service worker's offline cache policy.
 *
 * The failure this exists to stop is quiet. A file left out is fetched from the
 * network like anything else, so online it is invisible; offline it is a
 * `net::ERR_FAILED` on every load, in the same console where a real error has
 * to be noticed. `/icons/favicon.svg` was referenced by `index.html` from the
 * day the icons landed and was never in the list.
 *
 * Scope, so a failure here reads quickly: only same-origin, non-hashed static
 * paths are checked. The build's own output under `/assets` is derived from the
 * bundle by the vite plugin and cannot go stale, so it is deliberately not
 * checked here — there is nothing a person could forget.
 *
 * Dependency-free and source-reading, like `check-guide-anchors.mjs` beside it.
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const INDEX_HTML = join(WEB_ROOT, 'index.html');
const MANIFEST = join(WEB_ROOT, 'public/manifest.webmanifest');
const WORKER = join(WEB_ROOT, 'src/lib/offline/service-worker.js');

const html = await readFile(INDEX_HTML, 'utf8');
const manifestText = await readFile(MANIFEST, 'utf8');
const worker = await readFile(WORKER, 'utf8');

/**
 * Referenced paths, from both files.
 *
 * `/src/...` is skipped: those are the entry modules, which the build replaces
 * with hashed names under `/assets` and the plugin then precaches by name.
 */
function referenced() {
  const found = new Map();

  const add = (path, where) => {
    if (!path.startsWith('/') || path.startsWith('//')) return;
    if (path.startsWith('/src/') || path.startsWith('/assets/')) return;
    found.set(path, where);
  };

  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/gu)) add(match[1], 'index.html');
  for (const match of manifestText.matchAll(/"src":\s*"([^"]+)"/gu)) {
    add(match[1], 'manifest.webmanifest');
  }

  return found;
}

/** Every explicit non-hashed path the worker installs or caches on demand. */
function cacheCandidates() {
  const listed = new Set();
  for (const name of ['PRECACHE_CRITICAL', 'RUNTIME_OPTIONAL']) {
    const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`, 'u').exec(worker);
    if (!block) {
      console.error(`check-precache: could not find ${name} in service-worker.js.`);
      process.exit(1);
    }
    for (const literal of block[1].matchAll(/'([^']+)'/gu)) listed.add(literal[1]);
  }
  return listed;
}

const wanted = referenced();
const listed = cacheCandidates();

const missing = [...wanted].filter(([path]) => !listed.has(path));

// A listed file that does not exist would fail the install itself, which is a
// worse failure than the one above and just as easy to check here.
const absent = [];
for (const path of listed) {
  if (path === '/') continue;
  try {
    await access(join(WEB_ROOT, 'public', path));
  } catch {
    absent.push(path);
  }
}

if (missing.length > 0 || absent.length > 0) {
  console.error('check-precache: FAILED\n');
  for (const [path, where] of missing) {
    console.error(
      `  ${path} is referenced by ${where} but is not precached.\n` +
        '    Every offline load will log net::ERR_FAILED for it.\n' +
        '    Add it to RUNTIME_OPTIONAL in src/lib/offline/service-worker.js.\n',
    );
  }
  for (const path of absent) {
    console.error(
      `  ${path} is precached but no such file exists in public/.\n` +
        '    Nothing serves it, so it can only ever fail.\n',
    );
  }
  process.exit(1);
}

console.log(
  `check-precache: ${String(wanted.size)} referenced static file(s), all cacheable offline; ` +
    `${String(listed.size)} entries listed, all present.`,
);
