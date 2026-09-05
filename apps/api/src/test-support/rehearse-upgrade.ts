import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';

import { loadDotEnvFiles } from '../platform/common/dotenv.js';
import { migrationPreflight } from '../platform/db/migration-preflight.js';

/** F-04 / NFR-08: synthetic populated upgrade, confined to a disposable local DB. */
async function main(): Promise<void> {
  loadDotEnvFiles();
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.port !== '55432') {
    throw new Error('Upgrade rehearsal requires local Postgres on port 55432.');
  }
  const name = `vyuha_upgrade_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.href });
  const folder = await mkdtemp(resolve(tmpdir(), 'vyuha-upgrade-'));
  let created = false;
  let pool: Pool | undefined;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.href, max: 1 });
    const db = drizzle(pool);
    const source = resolve('drizzle');
    await cp(source, folder, { recursive: true });
    const journalPath = resolve(folder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { idx: number }[] };
    const through = async (idx: number): Promise<void> => {
      await writeFile(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= idx) }));
      await migrate(db, { migrationsFolder: folder });
    };
    await through(90);
    const org = randomUUID();
    const returnId = randomUUID();
    await pool.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, 'Synthetic upgrade fixture']);
    await pool.query(`INSERT INTO sales_documents (org_id, doc_type, number, date, customer_name, return_id)
      VALUES ($1, 'SALES_ORDER', 'UPGRADE-1', '2026-09-05', 'Synthetic customer', $2)`, [org, returnId]);
    await pool.query(`INSERT INTO fallback_jobs (job_name, payload, state, attempts)
      VALUES ('recompute-day', '{"fixture":true}', 'RUNNING', 2)`);
    // Prove preflight rejects a real conflicting record and does not alter it.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO sales_documents (org_id, doc_type, number, date, customer_name, return_id)
        VALUES ($1, 'SALES_ORDER', 'UPGRADE-DUPLICATE', '2026-09-05', 'Synthetic customer', $2)`, [org, returnId]);
      await assert.rejects(migrationPreflight(drizzle(client)), /duplicate live replacement/);
      const duplicates = await client.query('SELECT id FROM sales_documents WHERE return_id = $1', [returnId]);
      assert.equal(duplicates.rowCount, 2);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    await migrationPreflight(db);
    const started = performance.now();
    await through(93);
    await pool.query(`INSERT INTO notification_outbox (org_id, event_type, audience, payload, state)
      VALUES ($1, 'fixture', '{}', '{"preserve":true}', 'ENQUEUED'),
             ($1, 'fixture', '{}', '{"preserve":true}', 'PENDING')`, [org]);
    await through(94);
    const outcomes = await pool.query<{ state: string; progress: unknown; payload: unknown }>('SELECT state, progress, payload FROM notification_outbox ORDER BY state');
    assert.deepEqual(outcomes.rows.map((row: { state: string }) => row.state), ['LEGACY_ENQUEUED', 'PENDING']);
    for (const row of outcomes.rows) {
      assert.deepEqual(row.progress, {});
      assert.deepEqual(row.payload, { preserve: true });
    }
    const jobs = await pool.query('SELECT state, attempts, claim_generation FROM fallback_jobs');
    assert.deepEqual(jobs.rows, [{ state: 'RUNNING', attempts: 2, claim_generation: 0 }]);
    const documents = await pool.query('SELECT number, return_id FROM sales_documents');
    assert.deepEqual(documents.rows, [{ number: 'UPGRADE-1', return_id: returnId }]);
    await assert.rejects(pool.query(`INSERT INTO sales_documents (org_id, doc_type, number, date, customer_name, return_id)
      VALUES ($1, 'SALES_ORDER', 'UPGRADE-DUPLICATE', '2026-09-05', 'Synthetic customer', $2)`, [org, returnId]), /duplicate key/);
    await through(94);
    console.log(JSON.stringify({ result: 'passed', baseline: '0090', upgradedThrough: '0094', elapsedMs: Math.round(performance.now() - started), checks: ['duplicate preflight preserves records', 'existing document and running job preserved', 'legacy notification held', 'pending notification retained', 'replacement uniqueness enforced', 'repeat migration is a no-op'] }, null, 2));
  } finally {
    await pool?.end();
    try {
      if (created) await admin.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
      await rm(folder, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  console.error('Local upgrade rehearsal failed:', error);
  process.exitCode = 1;
});
