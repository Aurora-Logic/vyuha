import { Pool } from 'pg';
import { Redis } from 'ioredis';

import { loadDotEnvFiles } from '../src/platform/common/dotenv.js';

loadDotEnvFiles();

async function clearPostgresLimits(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('Warning: DATABASE_URL is not set; skipping Postgres rate limit reset.');
    return;
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query('DELETE FROM rate_limit_fallback_attempts RETURNING *');
    console.log(`Done: Cleared ${result.rowCount ?? 0} rate-limit records from Postgres (rate_limit_fallback_attempts).`);
  } catch (err) {
    console.error('Failed: Failed to clear Postgres rate limits:', (err instanceof Error ? err.message : String(err)));
  } finally {
    await pool.end();
  }
}

async function clearRedisLimits(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log('REDIS_URL not configured; skipping Redis rate limit reset.');
    return;
  }

  let redis: Redis | null = null;
  try {
    redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      connectTimeout: 1500,
      retryStrategy: () => null, // Do not auto-reconnect/loop if Redis is unreachable
      enableOfflineQueue: false,
    });

    // Suppress unhandled EventEmitter errors on connection failure
    redis.on('error', () => {});

    await redis.connect();
    const keys = await redis.keys('*failures*');
    if (keys.length > 0) {
      await redis.del(...keys);
      console.log(`Done: Cleared ${keys.length} rate-limit keys from Redis:`, keys);
    } else {
      console.log('Done: No rate-limit failure keys found in Redis.');
    }
    await redis.quit();
  } catch (err) {
    console.log(`Redis skipped (${(err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err)) || 'unreachable'}). Continuing with Postgres.`);
    try {
      redis?.disconnect();
    } catch {
      // Best effort: a closed client is nothing to report.
    }
  }
}

async function main(): Promise<void> {
  console.log('\n--- Resetting Rate Limits ---');
  await clearPostgresLimits();
  await clearRedisLimits();
  console.log('Rate limits reset complete. Webhooks and logins can proceed immediately.\n');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
