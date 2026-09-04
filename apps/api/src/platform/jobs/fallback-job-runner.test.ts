import { uuidv7 } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { env } from '../common/env.js';
import { FallbackJobRunner } from './fallback-job-runner.service.js';
import { JobRegistry, type JobContext, type JobHandler, type JobResult } from './job-handler.js';
import { SCHEDULED_JOBS, type JobPayloads } from './queue.registry.js';

/**
 * The Postgres fallback job queue, exercised directly against a real
 * database (no Redis involved at all — this is the path a deployment with
 * no Redis at all uses for every recurring and enqueued job).
 *
 * Uses `purge-expired-files` as the stand-in job name throughout, matching
 * `job-resilience.test.ts`'s own convention — the point under test is the
 * queue mechanics, not any one handler's business logic, so a stub handler
 * for a real job name is enough.
 */

const pool = new Pool({ connectionString: env.DATABASE_URL });
const db = drizzle(pool);

const insertedJobIds: string[] = [];

class StubHandler implements JobHandler<'purge-expired-files'> {
  readonly jobName = 'purge-expired-files';
  runCount = 0;
  shouldFail = false;

  run(_payload: JobPayloads['purge-expired-files'], _context: JobContext): Promise<JobResult> {
    this.runCount += 1;
    if (this.shouldFail) throw new Error('stub handler failure');
    return Promise.resolve({ ran: true });
  }
}

function newFallback(): { fallback: FallbackJobRunner; stub: StubHandler } {
  const registry = new JobRegistry();
  const stub = new StubHandler();
  registry.register(stub);
  return { fallback: new FallbackJobRunner(db, registry), stub };
}

async function rowFor(id: string): Promise<{ state: string; attempts: number; last_error: string | null } | undefined> {
  const rows = await db.execute<{ state: string; attempts: number; last_error: string | null }>(
    sql`SELECT state, attempts, last_error FROM fallback_jobs WHERE id = ${id}`,
  );
  return rows.rows[0];
}

afterEach(async () => {
  for (const id of insertedJobIds) {
    await db.execute(sql`DELETE FROM fallback_jobs WHERE id = ${id}`);
  }
  insertedJobIds.length = 0;
});

afterAll(async () => {
  await pool.end();
});

describe('FallbackJobRunner.enqueue + workerTick', () => {
  it('runs a job through the real JobRegistry seam and marks it done', async () => {
    const { fallback, stub } = newFallback();
    const id = await fallback.enqueue('purge-expired-files', { requestedAt: new Date().toISOString() });
    insertedJobIds.push(id);

    await fallback.workerTick();

    expect(stub.runCount).toBe(1);
    const row = await rowFor(id);
    expect(row?.state).toBe('DONE');
    expect(row?.attempts).toBe(1);
  });

  it('dedups by jobId the way BullMQ ignores a repeated add', async () => {
    const { fallback } = newFallback();
    const jobId = `test-${uuidv7()}`;

    const first = await fallback.enqueue('purge-expired-files', { requestedAt: new Date().toISOString() }, { jobId });
    const second = await fallback.enqueue('purge-expired-files', { requestedAt: new Date().toISOString() }, { jobId });
    insertedJobIds.push(first);

    expect(second).toBe(first);
    const rows = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM fallback_jobs WHERE external_job_id = ${jobId}`,
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it('requeues a failed attempt under the cap, with a future run_after', async () => {
    const { fallback, stub } = newFallback();
    stub.shouldFail = true;
    const id = await fallback.enqueue('purge-expired-files', { requestedAt: new Date().toISOString() });
    insertedJobIds.push(id);

    const before = Date.now();
    await fallback.workerTick();

    const row = await db.execute<{ state: string; attempts: number; run_after: string; last_error: string | null }>(
      sql`SELECT state, attempts, run_after, last_error FROM fallback_jobs WHERE id = ${id}`,
    );
    const claimed = row.rows[0];
    expect(claimed?.state).toBe('QUEUED');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.last_error).toContain('stub handler failure');
    // BullMQ's own formula: 2^(attemptsMade-1) * 2000ms; first failure is 2000ms out.
    expect(new Date(claimed?.run_after ?? 0).getTime()).toBeGreaterThan(before + 1_500);
  });

  it('fails permanently once attempts reach the cap', async () => {
    const { fallback, stub } = newFallback();
    stub.shouldFail = true;

    // Seeded one attempt below the cap (5), due immediately, rather than
    // waiting out four real exponential-backoff delays.
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO fallback_jobs (job_name, payload, attempts) VALUES ('purge-expired-files', '{"requestedAt":"2026-01-01T00:00:00.000Z"}'::jsonb, 4) RETURNING id
    `);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('seed insert returned no row');
    insertedJobIds.push(id);

    await fallback.workerTick();

    const row = await rowFor(id);
    expect(row?.state).toBe('FAILED');
    expect(row?.attempts).toBe(5);
  });

  it('hands an abandoned claim back to the queue', async () => {
    const { fallback } = newFallback();
    const id = await fallback.enqueue('purge-expired-files', { requestedAt: new Date().toISOString() });
    insertedJobIds.push(id);

    await db.execute(sql`
      UPDATE fallback_jobs SET state = 'CLAIMED', claimed_by = 'stale-test', claimed_at = ${new Date(Date.now() - 10 * 60 * 1000)}
       WHERE id = ${id}
    `);

    await fallback.workerTick();

    const row = await rowFor(id);
    // Requeued, then immediately reclaimed and run by the same tick.
    expect(row?.state).toBe('DONE');
  });
});

describe('FallbackJobRunner.activate', () => {
  it('seeds a schedule row per SCHEDULED_JOBS entry with a future next_run_at', async () => {
    // Seeding is what is under test, so it starts from nothing. Left in place,
    // a row an earlier run seeded is simply overdue by now -- which is a
    // correct state, and the subject of the test below.
    await db.execute(sql`DELETE FROM fallback_job_schedules`);
    const { fallback } = newFallback();
    try {
      await fallback.activate();

      const rows = await db.execute<{ scheduler_id: string; next_run_at: string }>(
        sql`SELECT scheduler_id, next_run_at FROM fallback_job_schedules`,
      );
      const bySchedulerId = new Map(rows.rows.map((r) => [r.scheduler_id, r]));
      for (const scheduled of SCHEDULED_JOBS) {
        const row = bySchedulerId.get(scheduled.schedulerId);
        expect(row, `missing schedule row for ${scheduled.schedulerId}`).toBeDefined();
        expect(new Date(row?.next_run_at ?? 0).getTime()).toBeGreaterThan(Date.now());
      }
    } finally {
      // Stops the timers `activate()` started, so this test does not keep
      // the process alive waiting for a 30s/5s/1h tick that nothing asserts on.
      fallback.onApplicationShutdown();
    }
  });

  it('leaves an overdue schedule where it is, so a missed sweep still runs', async () => {
    // `activate()` inserts ON CONFLICT DO NOTHING on purpose. If the process
    // was down over a sweep's hour, its row is in the past, and pushing it
    // forward at boot would silently skip the run -- the retention purge and
    // the exception sweep would be quietly missed by any deployment that
    // happened to restart across their window. The scheduler tick is what
    // moves a row on, after it has enqueued the run it was due.
    const first = SCHEDULED_JOBS[0];
    expect(first).toBeDefined();
    const overdue = new Date(Date.now() - 60 * 60 * 1000);
    await db.execute(sql`DELETE FROM fallback_job_schedules`);
    await db.execute(sql`
      INSERT INTO fallback_job_schedules (scheduler_id, next_run_at) VALUES (${first?.schedulerId ?? ''}, ${overdue})
    `);

    const { fallback } = newFallback();
    try {
      await fallback.activate();
      const rows = await db.execute<{ next_run_at: string }>(
        sql`SELECT next_run_at FROM fallback_job_schedules WHERE scheduler_id = ${first?.schedulerId ?? ''}`,
      );
      expect(new Date(rows.rows[0]?.next_run_at ?? 0).getTime()).toBe(overdue.getTime());
    } finally {
      fallback.onApplicationShutdown();
    }
  });
});

/**
 * H-07. Two API processes each run the scheduler; a due schedule must fire
 * once. As read-then-insert-then-advance it fired once per process -- but
 * only when the other process fell into the sub-millisecond gap between the
 * read and the insert, which two ticks fired together never did in this
 * harness. So the gap is forced: the first tick runs inside a transaction
 * that is held open, the second must wait on the row and then find it no
 * longer due. With the three statements back in, the second's read sees the
 * old row and two jobs land.
 */
describe('FallbackJobRunner.schedulerTick under two instances', () => {
  it('fires a due schedule exactly once when the second tick arrives while the first still holds it', async () => {
    const first = SCHEDULED_JOBS[0];
    expect(first).toBeDefined();
    const jobName = first?.jobName ?? '';
    await db.execute(sql`DELETE FROM fallback_job_schedules`);
    await db.execute(sql`
      INSERT INTO fallback_job_schedules (scheduler_id, next_run_at) VALUES (${first?.schedulerId ?? ''}, now() - interval '1 hour')
    `);
    const before = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM fallback_jobs WHERE job_name = ${jobName}`);

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');
      const a = newFallback().fallback;
      const b = newFallback().fallback;
      await a.schedulerTick(drizzle(clientA));
      // B blocks on A's row until A commits, then re-reads it.
      const second = b.schedulerTick(drizzle(clientB));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await clientA.query('COMMIT');
      await second;
      await clientB.query('COMMIT');
    } finally {
      clientA.release();
      clientB.release();
    }

    const after = await db.execute<{ id: string }>(sql`SELECT id FROM fallback_jobs WHERE job_name = ${jobName} ORDER BY created_at DESC`);
    const added = after.rows.length - (before.rows[0]?.n ?? 0);
    insertedJobIds.push(...after.rows.slice(0, Math.max(0, added)).map((r) => r.id));
    expect(added).toBe(1);
  });
});
