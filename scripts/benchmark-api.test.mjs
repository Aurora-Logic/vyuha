import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmark } from './benchmark-api.mjs';

test('reports non-2xx as failures and bounds concurrent requests', async () => {
  let active = 0;
  let peak = 0;
  const result = await benchmark({ origin: 'http://127.0.0.1:3000', paths: ['/api/v1/ready'], concurrency: 3, requests: 12,
    fetchImpl: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response('{}', { status: 503 });
    },
  });
  assert.equal(peak, 3);
  assert.equal(result.results[0].errors, 12);
  assert.equal(result.passed, false);
});

test('refuses remote targets and credential-bearing routes', async () => {
  await assert.rejects(benchmark({ origin: 'https://example.com', paths: ['/api/v1/ready'] }), /loopback/);
  await assert.rejects(benchmark({ origin: 'http://localhost:3000', paths: ['/api/v1/portal/secret'] }), /credential/);
});
