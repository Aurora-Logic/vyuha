import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { verifyRelease } from './verify-release.mjs';

const revision = 'a'.repeat(40);
const wait = async () => {};
function probe(commit = revision, status = 'ok') {
  return async (url) => new Response(JSON.stringify(url.endsWith('/health') ? { commit } : { status }));
}

test('accepts only healthy services at the exact checked revision', async () => {
  await verifyRelease('https://app.example.test', revision, { fetchImpl: probe(), wait, attempts: 1 });
});
test('rejects a healthy but wrong revision', async () => {
  await assert.rejects(verifyRelease('https://app.example.test', revision, { fetchImpl: probe('b'.repeat(40)), wait, attempts: 2 }), /exact validated revision/);
});
test('rejects degraded readiness even if the revision is correct', async () => {
  await assert.rejects(verifyRelease('https://app.example.test', revision, { fetchImpl: probe(revision, 'degraded'), wait, attempts: 1 }));
});
test('bounds malformed response retries', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('not JSON'); };
  await assert.rejects(verifyRelease('https://app.example.test', revision, { fetchImpl, wait, attempts: 3 }));
  assert.equal(calls, 6);
});
test('deployment refuses a branch name before touching a server', () => {
  const result = spawnSync('bash', ['scripts/deploy-systemd.sh', '/missing', 'main', 'vyuha', '/current', 'https://example.test', '/backup', '/api/v1'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /full validated commit SHA/);
});
test('workflow pins every external action and never deploys a moving branch tip', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const actions = [...workflow.matchAll(/uses:\s+(\S+)/g)].map((match) => match[1]);
  assert.ok(actions.length >= 3);
  for (const action of actions) assert.match(action, /@[a-f0-9]{40}$/);
  assert.doesNotMatch(workflow, /git pull/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /DEPLOY_SHA: \$\{\{ github.sha \}\}/);
});
