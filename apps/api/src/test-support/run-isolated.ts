import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';

import { loadDotEnvFiles } from '../platform/common/dotenv.js';

/** NFR-08 / M-16: fixtures must never be written into a developer's database. */
async function main(): Promise<void> {
  loadDotEnvFiles();
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for the local test database server.');
  const url = new URL(source);
  if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.port !== '55432') {
    throw new Error('Isolated tests require the local development Postgres on port 55432; remote/production hosts are refused.');
  }
  const name = `vyuha_test_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.href });
  await admin.connect();
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.href, max: 1 });
    try {
      await migrate(drizzle(pool), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
    } finally {
      await pool.end();
    }
    console.log(`Isolated API test database: ${name}`);
    const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: url.href, JOBS_QUEUE_PREFIX: name },
    });
    const stop = (): void => { child.kill('SIGTERM'); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      process.exitCode = await new Promise<number>((accept, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => { accept(code ?? 1); });
      });
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally {
    try {
      // Only this invocation's generated identifier. No FORCE, no session
      // termination: a leaked connection leaves the scratch DB for inspection.
      if (created) {
        await admin.query(`DROP DATABASE "${name}"`);
        console.log(`Removed isolated test database: ${name}`);
      }
    } finally {
      await admin.end();
    }
  }
}

main().catch((error: unknown) => {
  console.error('Isolated API verification failed:', error);
  process.exitCode = 1;
});
