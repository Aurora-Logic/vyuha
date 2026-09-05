#!/usr/bin/env node
/**
 * Fails when `dist/` is not the bundle that ships.
 *
 * Vite decides `isProduction` from `process.env.NODE_ENV`, not from the build
 * command and not from `--mode`. So any ambient NODE_ENV that is not
 * `production` silently produces a development bundle from `vite build`, and
 * the only outward sign is that it is bigger. CI set `NODE_ENV: test` at the
 * workflow level - correctly, for the integration tests - and the build step
 * inherited it, so the gate compiled something nobody ships and the two worst
 * defects found that week were visible only in a real production build.
 *
 * Measured on this repo, same source, only NODE_ENV differing:
 *
 *   NODE_ENV=test   entry chunk 2,491,639 bytes, 4,133 jsxDEV, 132 absolute
 *                   paths of the build machine's checkout, sample employees
 *                   "A. Nair" / "E-1004" and the dev-only /patterns page
 *   NODE_ENV unset  1,972,430 bytes, and zero of all four
 *
 * Four claims, each derived from source rather than written down here, so a
 * rename cannot quietly retire one:
 *
 *   1. no development JSX runtime
 *   2. no absolute path from the build machine
 *   3. no dev-only route, and none of its sample data
 *   4. the service worker precaches the document's startup assets
 *
 * (4) is here rather than in `check-precache.mjs` because that script reads
 * source and the list it would need does not exist in source: it is computed
 * in `generateBundle`, so it exists only in a build.
 *
 * Dependency-free and reads only the build output, like the check scripts
 * beside it. Usage: `node scripts/check-production-bundle.mjs [dist-dir]`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DIST = process.argv[2] ?? join(WEB_ROOT, 'dist');

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

/** Every emitted file, so nothing can hide in a chunk this script forgot. */
async function emitted(dir, prefix = '') {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(...(await emitted(join(dir, entry.name), `${name}/`)));
    else found.push({ name, path: join(dir, entry.name) });
  }
  return found;
}

let files;
try {
  files = await emitted(DIST);
} catch {
  console.error(
    `check-production-bundle: no build output at ${DIST}.\n` +
      '  Run `pnpm --filter @vyuha/web build` first.',
  );
  process.exit(1);
}

const TEXT = /\.(js|css|html|json|webmanifest|map)$/;
const text = new Map();
for (const file of files.filter((f) => TEXT.test(f.name))) {
  text.set(file.name, await readFile(file.path, 'utf8'));
}

function countAcross(needle) {
  let total = 0;
  const where = [];
  for (const [name, body] of text) {
    let n = 0;
    let at = body.indexOf(needle);
    while (at !== -1) {
      n += 1;
      at = body.indexOf(needle, at + needle.length);
    }
    if (n > 0) {
      total += n;
      where.push(`${name} (${String(n)})`);
    }
  }
  return { total, where };
}

// ---------------------------------------------------------------- 1. jsxDEV
//
// The clearest signal there is: `jsx-dev-runtime` is only ever reachable when
// React's development build is compiled in, and it carries the source location
// of every element with it.
const jsxDev = countAcross('jsxDEV');
if (jsxDev.total > 0) {
  fail(
    `the development JSX runtime is compiled in: ${String(jsxDev.total)} jsxDEV reference(s) in ${jsxDev.where.join(', ')}.\n` +
      '    vite build was run with NODE_ENV set to something other than production.',
  );
} else {
  notes.push('no jsxDEV');
}

// ------------------------------------------------- 2. build-machine paths
//
// Derived from where this script is, so it is the checkout that actually built
// the bundle rather than a pattern guessed in advance - it catches
// /home/runner/work/... on a runner exactly as it catches a laptop.
const leaked = countAcross(REPO_ROOT.replace(/\/$/, ''));
if (leaked.total > 0) {
  fail(
    `the build machine's checkout path is in the bundle ${String(leaked.total)} time(s): ${leaked.where.join(', ')}.\n` +
      `    Looking for ${REPO_ROOT.replace(/\/$/, '')}`,
  );
} else {
  notes.push('no build-machine paths');
}

// ------------------------------- 3. the dev-only route and its sample data
//
// Read out of App.tsx rather than named here. A route mounted behind
// `import.meta.env.DEV` is a route that must not exist in this bundle, and the
// page behind it is where the sample employees live (CLAUDE.md section 6).
const appSource = await readFile(join(WEB_ROOT, 'src/App.tsx'), 'utf8');

const devOnly = [
  ...appSource.matchAll(
    /import\.meta\.env\.DEV\s*\?\s*\(?\s*<Route\s+path=["']([^"']+)["']\s+element=\{<(\w+)/gu,
  ),
].map((match) => ({ route: match[1], component: match[2] }));

if (devOnly.length === 0) {
  fail(
    'no `import.meta.env.DEV ? <Route .../>` was found in src/App.tsx.\n' +
      '    Either the dev-only route moved, or this check has quietly stopped\n' +
      '    checking anything. Point it at wherever the route lives now.',
  );
}

for (const { route, component } of devOnly) {
  const imported = new RegExp(
    `import\\s*\\{[^}]*\\b${component}\\b[^}]*\\}\\s*from\\s*'@/([^']+)'`,
    'u',
  ).exec(appSource);
  if (!imported) {
    fail(`could not resolve where ${component} (route "${route}") is imported from in App.tsx.`);
    continue;
  }

  let pageSource = null;
  for (const candidate of [`${imported[1]}.tsx`, `${imported[1]}/index.tsx`]) {
    pageSource = await readFile(join(WEB_ROOT, 'src', candidate), 'utf8').catch(() => null);
    if (pageSource !== null) break;
  }
  if (pageSource === null) {
    fail(`could not read the source of ${component} (route "${route}") to derive its markers.`);
    continue;
  }

  // Element ids: unique to this page and present in the compiled output as
  // written, so they say whether the module reached the bundle at all.
  const ids = [...pageSource.matchAll(/\bid="([^"]+)"/gu)].map((m) => m[1]);

  // Sample rows: the identifiers CLAUDE.md section 6 forbids shipping.
  // Restricted to values that look like a record rather than a word, so a
  // generic label ('General', 'Present') cannot collide with the rest of the app.
  const sampleBlock = /const SAMPLE_\w+[^=]*=\s*\[([\s\S]*?)\n\];/u.exec(pageSource);
  const samples = [...(sampleBlock?.[1] ?? '').matchAll(/'([^']+)'/gu)]
    .map((m) => m[1])
    .filter((value) => /\d/u.test(value) || /^[A-Z]\.\s/u.test(value));

  if (ids.length === 0 && samples.length === 0) {
    fail(
      `derived no markers from ${component}: the check for route "${route}" would pass\n` +
        '    against any bundle at all, which is worse than no check.',
    );
    continue;
  }

  const present = [...new Set([...ids, ...samples])]
    .map((marker) => ({ marker, ...countAcross(marker) }))
    .filter((entry) => entry.total > 0);

  if (present.length > 0) {
    fail(
      `the dev-only route "${route}" is in the bundle: ${present
        .map((e) => `${JSON.stringify(e.marker)} in ${e.where.join(', ')}`)
        .join('; ')}.\n` +
        '    `import.meta.env.DEV` folded to true, so the sample data shipped.',
    );
  } else {
    notes.push(
      `dev-only route "${route}" absent (${String(ids.length)} id(s) and ${String(samples.length)} sample identifier(s) checked)`,
    );
  }
}

// ---------------------------------------- 4. the worker precaches the build
//
// The list is computed in `generateBundle`, so it exists only in a build - the
// dev server renders the worker with an empty one. Nothing that reads source
// can see this, which is why an empty precache shipped once already: the
// worker installed, the shell was cached, and the entry chunk was not, so the
// first offline load served a document and then ERR_FAILED on its own script.
const worker = text.get('sw.js');
if (worker === undefined) {
  fail('sw.js was not emitted, so the app has no service worker at all.');
} else {
  const criticalBlock = /const BUILD_CRITICAL = (\[[^\]]*\]);/u.exec(worker);
  if (!criticalBlock) {
    fail('sw.js has no BUILD_CRITICAL array; the vite plugin did not stamp the precache in.');
  } else {
    let critical;
    try {
      critical = JSON.parse(criticalBlock[1]);
    } catch {
      critical = null;
    }

    // What this document asks for before a route can render. The Punch route's
    // additional static closure is covered by splitPrecache's graph test; the
    // production offline harness proves the emitted set can boot.
    const document = text.get('index.html') ?? '';
    const mustHold = [
      ...document.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/gu),
    ]
      .map((match) => match[1])
      .filter((url) => url !== undefined)
      .sort();

    if (!Array.isArray(critical) || critical.length === 0) {
      fail(
        'the service worker precaches nothing from this build: BUILD_CRITICAL is empty.\n' +
          '    A first install would cache the shell and not the script that fills it,\n' +
          `    so the first offline load is a blank page. Expected at least ${String(mustHold.length)} startup file(s).`,
      );
    } else {
      const missing = mustHold.filter((url) => !critical.includes(url));
      const unknown = critical.filter((url) => !files.some((f) => `/${f.name}` === url));
      if (missing.length > 0 || unknown.length > 0) {
        fail(
          'the service worker precache does not match this build.\n' +
            (missing.length > 0 ? `    emitted but not precached: ${missing.join(', ')}\n` : '') +
            (unknown.length > 0 ? `    precached but not emitted: ${unknown.join(', ')}\n` : ''),
        );
      } else {
        notes.push(`precache holds all ${String(mustHold.length)} startup code and stylesheet file(s)`);
      }
    }
  }
}

// ----------------------------------------------------------------- report
if (failures.length > 0) {
  console.error('check-production-bundle: FAILED\n');
  for (const message of failures) console.error(`  ${message}\n`);
  console.error(
    '  This build is not what ships. `vite build` reads NODE_ENV, not the build\n' +
      '  mode, so check what NODE_ENV was set to when it ran.\n',
  );
  process.exit(1);
}

console.log(
  `check-production-bundle: ${String(files.length)} emitted file(s) in ${relative(WEB_ROOT, DIST) || DIST}; ` +
    `${notes.join('; ')}.`,
);
