import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export async function verifyRelease(origin, expectedRevision, { fetchImpl = fetch, wait = delay, attempts = 20 } = {}) {
  if (!origin || !/^[0-9a-f]{40}$/.test(expectedRevision ?? '')) {
    throw new Error('Usage: node scripts/verify-release.mjs <origin> <full-commit-sha>');
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const [live, ready] = await Promise.all([
        fetchImpl(`${origin.replace(/\/$/, '')}/api/v1/health`, { signal: AbortSignal.timeout(5000) }),
        fetchImpl(`${origin.replace(/\/$/, '')}/api/v1/ready`, { signal: AbortSignal.timeout(5000) }),
      ]);
      const data = await live.json();
      const readiness = await ready.json();
      if (live.ok && ready.ok && readiness.status === 'ok' && data.commit === expectedRevision) return;
    } catch {
      // Startup/refused sockets are expected within this bounded readiness window.
    }
    await wait(2000);
  }
  throw new Error('Release never became ready at the exact validated revision. Operator recovery required.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [origin, revision] = process.argv.slice(2);
  await verifyRelease(origin, revision);
  console.log(`Readiness and revision verified: ${revision}`);
}
