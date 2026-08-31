#!/usr/bin/env node
/**
 * Reports what has shipped since the newest release the Updates page names.
 *
 * The changelog went 728 commits and eighteen days stale without anything
 * noticing. `changelog.test.ts` checks that every entry is *correct* — its
 * route exists, its tour step exists, its permission matches the navigation —
 * but nothing checked whether entries were *missing*, and a release note
 * nobody wrote is invisible by definition.
 *
 * Advisory, not a gate. It exits zero even when it finds a gap, because
 * "describe this well" is editorial work and a build that refuses to pass
 * until somebody writes prose gets bypassed rather than obeyed. Run it when
 * closing a phase:
 *
 *   pnpm --filter @vyuha/web check:changelog
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHANGELOG = fileURLToPath(new URL('../src/features/updates/changelog.ts', import.meta.url));
const source = readFileSync(CHANGELOG, 'utf8');

const dates = [...source.matchAll(/date: '(\d{4}-\d{2}-\d{2})'/gu)].map((m) => m[1]);
const newest = dates.slice().sort().at(-1);

if (!newest) {
  console.error('check-changelog: no release dates found in changelog.ts.');
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

// Only what a reader could notice: the web app and the contracts it renders.
const log = git(
  'log',
  `--since=${newest}`,
  '--pretty=%s%n%b',
  '--',
  'apps/web/src',
  'packages/shared/src',
);

const shipped = new Set([...log.matchAll(/REQ-[A-Z]+-\d+/gu)].map((m) => m[0]));
const described = new Set([...source.matchAll(/REQ-[A-Z]+-\d+/gu)].map((m) => m[0]));
const undescribed = [...shipped].filter((req) => !described.has(req)).sort();

const commits = git('log', `--since=${newest}`, '--oneline', '--', 'apps/web/src', 'packages/shared/src')
  .split('\n')
  .filter(Boolean).length;

console.log(`check-changelog: newest release is ${newest}.`);
console.log(`  ${String(commits)} commits to the web app or the shared contracts since then.`);

if (undescribed.length === 0) {
  console.log('  Every REQ id shipped since then is mentioned in the changelog.');
  process.exit(0);
}

console.log(`  ${String(undescribed.length)} REQ ids shipped since then are not mentioned:`);
console.log(`    ${undescribed.join(', ')}`);
console.log('\n  Not every REQ deserves a release note — a refactor and a fix to a fix do');
console.log('  not. This is a list to read, not a list to clear.');
