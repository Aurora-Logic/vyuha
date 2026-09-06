import { pathToFileURL } from 'node:url';

/** Bounded GET-only load probe; credentials and response bodies never enter its output. */
export async function benchmark({ origin, paths, token, concurrency = 10, requests = 200, budgetMs = 1500, fetchImpl = fetch }) {
  const url = new URL(origin);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use a loopback origin against an isolated representative dataset.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64 || !Number.isInteger(requests) || requests < 1 || requests > 100000 || !Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new Error('Invalid bounds: concurrency 1–64, requests 1–100000, positive latency budget.');
  }
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== 'string' || !path.startsWith('/api/v1/') || /auth|portal|invite|reset|token|signature/i.test(path) || new URL(path, url).origin !== url.origin)) {
    throw new Error('Provide explicit API GET paths without credentials or credential routes.');
  }
  let next = 0;
  const samples = paths.map((path) => ({ path, durations: [], errors: 0 }));
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
    while (next < requests) {
      const index = next++;
      const sample = samples[index % samples.length];
      const began = performance.now();
      try {
        const response = await fetchImpl(new URL(sample.path, url), {
          headers: token ? { authorization: `Bearer ${token}` } : {},
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        await response.arrayBuffer();
        if (!response.ok) sample.errors += 1;
      } catch { sample.errors += 1; }
      sample.durations.push(performance.now() - began);
    }
  }));
  const results = samples.map(({ path, durations, errors }) => {
    durations.sort((a, b) => a - b);
    const percentile = (fraction) => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)] ?? null;
    return { path, requests: durations.length, errors, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
  });
  return { concurrency, requests, budgetMs, elapsedMs: performance.now() - started, results,
    passed: results.every((row) => row.requests > 0 && row.errors === 0 && row.p95 <= budgetMs) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await benchmark({
    origin: process.env.BENCH_ORIGIN ?? 'http://127.0.0.1:3000',
    paths: JSON.parse(process.env.BENCH_PATHS ?? '[]'),
    token: process.env.BENCH_TOKEN,
    concurrency: Number(process.env.BENCH_CONCURRENCY ?? 10),
    requests: Number(process.env.BENCH_REQUESTS ?? 200),
    budgetMs: Number(process.env.BENCH_BUDGET_MS ?? 1500),
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
