import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';

import { loadDotEnvFiles } from '../platform/common/dotenv.js';

function dockerPg(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((accept, reject) => {
    const child = spawn('docker', ['compose', '-f', resolve('../../docker/docker-compose.yml'), 'exec', '-T', 'postgres', ...args]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) accept(Buffer.concat(stdout));
      else reject(new Error(`Local recovery command failed: ${Buffer.concat(stderr).toString()}`));
    });
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
}

async function tableCounts(url: string): Promise<Record<string, string>> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const tables = await client.query<{ schemaname: string; tablename: string }>(
      "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2",
    );
    const counts: Record<string, string> = {};
    for (const row of tables.rows) {
      const schema = row.schemaname.replaceAll('"', '""');
      const table = row.tablename.replaceAll('"', '""');
      const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${schema}"."${table}"`);
      counts[`${row.schemaname}.${row.tablename}`] = result.rows[0]?.count ?? 'missing';
    }
    return counts;
  } finally { await client.end(); }
}

async function main(): Promise<void> {
  loadDotEnvFiles();
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '55432' || url.username !== 'vyuha') {
    throw new Error('Rehearsal is restricted to the local development Docker Postgres; no existing database is dumped or restored.');
  }
  const source = `vyuha_dr_${randomUUID().replaceAll('-', '')}`;
  const restored = `${source}_restore`;
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.href });
  await admin.connect();
  const created: string[] = [];
  try {
    for (const name of [source, restored]) {
      await admin.query(`CREATE DATABASE "${name}"`);
      created.push(name);
    }
    url.pathname = `/${source}`;
    const pool = new Pool({ connectionString: url.href, max: 1 });
    try {
      await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
      await pool.query('CREATE TABLE recovery_probe (id int PRIMARY KEY, value text NOT NULL)');
      await pool.query("INSERT INTO recovery_probe VALUES (1, 'synthetic recovery probe'), (2, 'second probe')");
    } finally { await pool.end(); }
    const expected = await tableCounts(url.href);
    const archive = await dockerPg(['pg_dump', '-U', 'vyuha', '-d', source, '--format=custom']);
    await dockerPg(['pg_restore', '--list'], archive);
    await dockerPg(['pg_restore', '-U', 'vyuha', '-d', restored, '--no-owner', '--exit-on-error'], archive);
    url.pathname = `/${restored}`;
    const actual = await tableCounts(url.href);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Restored table counts do not match the source.');
    console.log(JSON.stringify({ result: 'PASS', tables: Object.keys(actual).length, probeRows: actual['public.recovery_probe'], archiveBytes: archive.length, scope: 'synthetic local database; not a production/off-host restore' }));
  } finally {
    try {
      for (const name of created.reverse()) {
        await admin.query(`DROP DATABASE "${name}"`);
        console.log(`Removed rehearsal database: ${name}`);
      }
    } finally { await admin.end(); }
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
