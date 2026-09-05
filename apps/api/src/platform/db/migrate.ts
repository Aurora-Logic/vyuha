import { resolve } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { loadDotEnvFiles } from '../common/dotenv.js';

/**
 * Applies pending migrations. Run on deploy, forward-only (technical design
 * §17).
 *
 * Deliberately its own process rather than something the API does at boot: two
 * instances starting together would race, and a failed migration should stop
 * the deploy rather than leave a half-migrated database serving traffic.
 */
async function main(): Promise<void> {
  loadDotEnvFiles();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    application_name: 'vyuha-migrate',
    options: '-c lock_timeout=10000 -c statement_timeout=120000',
  });

  try {
    const started = Date.now();

    // Fail with a bounded lock timeout instead of killing unrelated users'
    // legitimate transactions. Serialize migration runners on this database.
    await pool.query('SELECT pg_advisory_lock(8073115240912002)');
    await migrate(drizzle(pool), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
    console.log(`migrations applied in ${String(Date.now() - started)}ms`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('migration failed:', error);
  process.exit(1);
});
