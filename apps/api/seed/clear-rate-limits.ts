import { Pool } from 'pg';
import { Redis } from 'ioredis';

import { loadDotEnvFiles } from '../src/platform/common/dotenv.js';

loadDotEnvFiles();

async function clearPostgresLimits(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('⚠️ DATABASE_URL is not set; skipping Postgres rate limit reset.');
    return;
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query('DELETE FROM rate_limit_fallback_attempts RETURNING *');
    console.log(`✅ Cleared ${result.rowCount ?? 0} rate-limit records from Postgres (rate_limit_fallback_attempts).`);
  } catch (err: any) {
    console.error('❌ Failed to clear Postgres rate limits:', err.message);
  } finally {
    await pool.end();
  }
}

async function clearRedisLimits(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log('ℹ️ REDIS_URL not configured; skipping Redis rate limit reset.');
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
      console.log(`✅ Cleared ${keys.length} rate-limit keys from Redis:`, keys);
    } else {
      console.log('✅ No rate-limit failure keys found in Redis.');
    }
    await redis.quit();
  } catch (err: any) {
    console.log(`ℹ️ Redis skipped (${err.message ?? 'unreachable'}). Continuing with Postgres.`);
    try {
      redis?.disconnect();
    } catch {}
  }
}

async function main(): Promise<void> {
  console.log('\n--- Resetting Rate Limits ---');
  await clearPostgresLimits();
  await clearRedisLimits();
  console.log('🎉 Rate limits reset complete. Webhooks and logins can proceed immediately.\n');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
