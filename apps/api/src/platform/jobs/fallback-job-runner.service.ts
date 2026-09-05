import { randomUUID } from 'node:crypto';

import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { CronExpressionParser } from 'cron-parser';
import { sql } from 'drizzle-orm';

import { describeError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { JobRegistry } from './job-handler.js';
import type { EnqueueOptions } from './job-runner.service.js';
import { DEFAULT_JOB_OPTIONS, SCHEDULED_JOBS, type JobName, type JobPayloads } from './queue.registry.js';

/**
 * The Postgres fallback for BullMQ, active only when `JobRunner` could not
 * reach Redis at boot (`job-runner.service.ts`'s `onApplicationBootstrap`).
 *
 * Mirrors `sync_jobs`'s claim shape exactly (`FOR UPDATE SKIP LOCKED`,
 * attempts incremented at claim time -- matching both `sync-agent.service.ts`
 * and BullMQ's own `attemptsMade` semantic, which increments when a worker
 * *starts* an attempt, not only on failure) rather than inventing a new one.
 * Execution goes through the same `JobRegistry` BullMQ uses
 * (`registry.get(jobName)!.run(payload, context)`), so no handler changes
 * anywhere: every job written for BullMQ runs unchanged here.
 *
 * No `setInterval`/`@Cron` exists anywhere else in this codebase -- this is
 * the first in-process polling timer, built as a self-rescheduling
 * `setTimeout` chain so ticks can never overlap and a rejection inside one
 * can never become an unhandled rejection.
 *
 * The mode decision (BullMQ vs. this) is boot-latched for a process's whole
 * lifetime, matching `JOBS_WORKER_ENABLED`'s own boot-time-only semantics: if
 * Redis comes back mid-session this keeps running until the next restart, by
 * design -- a deliberate future cutover, not a live hot-swap.
 */

const SCHEDULER_TICK_MS = 30_000;
const WORKER_TICK_MS = 5_000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** How long a `DONE` row survives, for `external_job_id` dedup parity with BullMQ's `removeOnComplete`. */
const DONE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** A claim older than this is presumed abandoned (a crashed process) and is handed back to the queue. */
const STALE_CLAIM_MS = 5 * 60 * 1000;
/** Jobs claimed and run per worker tick -- close to BullMQ's `concurrency: 2` workers for latency-sensitive paths (password resets, exports) that pass through `enqueue()`. */
const JOBS_PER_TICK = 5;

type ClaimedRow = {
  id: string;
  job_name: string;
  payload: unknown;
  attempts: number;
  claim_generation: number;
};

@Injectable()
export class FallbackJobRunner implements OnApplicationShutdown {
  private readonly logger = new Logger(FallbackJobRunner.name);
  private readonly instanceId = randomUUID();
  private active = false;
  private stopped = false;
  private schedulerTimer: NodeJS.Timeout | undefined;
  private workerTimer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly registry: JobRegistry,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  /**
   * Postgres's own clock, not the API process's. `claimOne()`'s due-check
   * and every timestamp column here (`run_after`, `claimed_at`, `updated_at`)
   * are set via SQL `now()`; a delay or cutoff computed from `Date.now()`
   * instead would silently race whatever skew exists between the two hosts
   * — found live against this project's own dev database, whose clock runs
   * seconds ahead of the API host's, which made every retry backoff look
   * already-elapsed the instant it was written.
   */
  private async dbNow(): Promise<Date> {
    const rows = await this.db.execute<{ now: string | Date }>(sql`SELECT now() AS now`);
    const now = rows.rows[0]?.now;
    if (now === undefined) throw new Error('SELECT now() returned no row.');
    return new Date(now);
  }

  /** Idempotent. Upserts the schedule table from `SCHEDULED_JOBS` and starts the scheduler/worker/cleanup timers. */
  async activate(): Promise<void> {
    if (this.active) return;
    this.active = true;

    const now = await this.dbNow();
    for (const scheduled of SCHEDULED_JOBS) {
      const nextRunAt = CronExpressionParser.parse(scheduled.pattern, { currentDate: now }).next().toDate();
      await this.db.execute(sql`
        INSERT INTO fallback_job_schedules (scheduler_id, next_run_at)
        VALUES (${scheduled.schedulerId}, ${nextRunAt})
        ON CONFLICT (scheduler_id) DO NOTHING
      `);
    }

    this.scheduleNext('scheduler');
    this.scheduleNext('worker');
    this.scheduleNext('cleanup');
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    for (const timer of [this.schedulerTimer, this.workerTimer, this.cleanupTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Mirrors `JobRunner.enqueue()`'s signature, so call sites need no change. */
  async enqueue<TName extends JobName>(
    jobName: TName,
    payload: JobPayloads[TName],
    options: EnqueueOptions = {},
  ): Promise<string> {
    const delayMs = options.delayMs ?? 0;
    const payloadJson = JSON.stringify(payload);

    if (options.jobId !== undefined) {
      const existing = await this.db.execute<{ id: string }>(sql`
        INSERT INTO fallback_jobs (job_name, payload, run_after, external_job_id)
        VALUES (${jobName}, ${payloadJson}::jsonb, now() + (${delayMs} * interval '1 millisecond'), ${options.jobId})
        ON CONFLICT (job_name, external_job_id) WHERE external_job_id IS NOT NULL
        DO NOTHING
        RETURNING id
      `);
      if (existing.rows[0] !== undefined) return existing.rows[0].id;

      // Another call already holds this jobId — BullMQ's `add` returns the
      // existing job in that case, so this mirrors it rather than erroring.
      const current = await this.db.execute<{ id: string }>(sql`
        SELECT id FROM fallback_jobs WHERE job_name = ${jobName} AND external_job_id = ${options.jobId}
      `);
      const id = current.rows[0]?.id;
      if (id !== undefined) return id;
    }

    const inserted = await this.db.execute<{ id: string }>(sql`
      INSERT INTO fallback_jobs (job_name, payload, run_after, external_job_id)
      VALUES (${jobName}, ${payloadJson}::jsonb, now() + (${delayMs} * interval '1 millisecond'), ${options.jobId ?? null})
      RETURNING id
    `);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('Fallback job insert returned no row.');
    return id;
  }

  async countsByState(): Promise<Record<string, number>> {
    const rows = await this.db.execute<{ state: string; count: number }>(
      sql`SELECT state, count(*)::int AS count FROM fallback_jobs GROUP BY state`,
    );
    return Object.fromEntries(rows.rows.map((row) => [row.state, row.count]));
  }

  private scheduleNext(kind: 'scheduler' | 'worker' | 'cleanup'): void {
    if (this.stopped) return;
    const [tick, intervalMs] =
      kind === 'scheduler'
        ? [() => this.schedulerTick(), SCHEDULER_TICK_MS]
        : kind === 'worker'
          ? [() => this.workerTick(), WORKER_TICK_MS]
          : [() => this.cleanupTick(), CLEANUP_INTERVAL_MS];

    const timer = setTimeout(() => {
      void tick()
        .catch((error: unknown) => {
          this.logger.error({ msg: `Fallback ${kind} tick failed.`, reason: describeError(error) });
        })
        .finally(() => this.scheduleNext(kind));
    }, intervalMs);

    if (kind === 'scheduler') this.schedulerTimer = timer;
    else if (kind === 'worker') this.workerTimer = timer;
    else this.cleanupTimer = timer;
  }

  /**
   * The Postgres analog of BullMQ's `upsertJobScheduler`: enqueue whatever
   * schedule has come due. Public so a test can run one tick directly rather
   * than waiting `SCHEDULER_TICK_MS` for the timer to fire — the same reason
   * `JobRunner.startWorkers()` is public.
   */
  /** `executor` lets a test run the claim inside an explicit transaction; production passes nothing. */
  async schedulerTick(executor: Pick<Database, 'execute'> = this.db): Promise<void> {
    const now = await this.dbNow();

    for (const scheduled of SCHEDULED_JOBS) {
      const nextRunAt = CronExpressionParser.parse(scheduled.pattern, { currentDate: now }).next().toDate();
      // One statement: advancing the schedule is the claim, and the job is
      // inserted only for the instance whose UPDATE moved it. As three
      // statements -- read, insert, advance -- two API processes that both
      // read "due" both inserted, and a sweep ran twice (H-07). Same literal
      // payload installSchedules() uses for every scheduled job today.
      await executor.execute(sql`
        WITH due AS (
          UPDATE fallback_job_schedules
             SET next_run_at = ${nextRunAt}, last_run_at = now()
           WHERE scheduler_id = ${scheduled.schedulerId} AND next_run_at <= now()
           RETURNING scheduler_id
        )
        INSERT INTO fallback_jobs (job_name, payload)
        SELECT ${scheduled.jobName}, ${JSON.stringify({ requestedAt: now.toISOString() })}::jsonb FROM due
      `);
    }
  }

  /** Public for the same reason `schedulerTick` is. */
  async workerTick(): Promise<void> {
    await this.requeueStaleClaims();
    for (let i = 0; i < JOBS_PER_TICK; i += 1) {
      const claimed = await this.claimOne();
      if (claimed === null) return;
      await this.runClaimed(claimed);
    }
  }

  private async requeueStaleClaims(): Promise<void> {
    await this.db.execute(sql`
      UPDATE fallback_jobs SET state = 'QUEUED', claimed_by = NULL, claimed_at = NULL, updated_at = now()
       WHERE state = 'CLAIMED' AND claimed_at < now() - (${STALE_CLAIM_MS} * interval '1 millisecond')
    `);
  }

  private async claimOne(): Promise<ClaimedRow | null> {
    const rows = await this.db.execute<ClaimedRow>(sql`
      UPDATE fallback_jobs
         SET state = 'CLAIMED', claimed_by = ${this.instanceId}, claimed_at = now(),
             claim_generation = claim_generation + 1, attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM fallback_jobs
          WHERE state = 'QUEUED' AND run_after <= now()
          ORDER BY run_after
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id, job_name, payload, attempts, claim_generation
    `);
    return rows.rows[0] ?? null;
  }

  private async runClaimed(row: ClaimedRow): Promise<void> {
    const handler = this.registry.get(row.job_name);
    if (handler === null) {
      await this.markFailed(row, `No handler is registered for job "${row.job_name}".`);
      return;
    }

    // A job that legitimately outlives STALE_CLAIM_MS used to be handed back
    // to the queue while still running, and ran twice. Renew the claim while
    // the handler runs; a process that dies stops renewing, which is what the
    // stale sweep is for (H-07).
    const renew = setInterval(() => {
      void this.db
        .execute(sql`UPDATE fallback_jobs SET claimed_at = now()
          WHERE id = ${row.id} AND claimed_by = ${this.instanceId}
            AND claim_generation = ${row.claim_generation} AND state = 'CLAIMED'`)
        .catch((error: unknown) => {
          this.logger.warn({ msg: 'Could not renew a fallback job claim', jobId: row.id, reason: describeError(error) });
        });
    }, Math.floor(STALE_CLAIM_MS / 3));
    try {
      const result = await handler.run(row.payload as JobPayloads[JobName], {
        jobId: row.id,
        attempt: row.attempts,
      });
      clearInterval(renew);
      const completed = await this.db.execute<{ id: string }>(sql`
        UPDATE fallback_jobs
           SET state = 'DONE', claimed_by = NULL, claimed_at = NULL, updated_at = now()
         WHERE id = ${row.id} AND claimed_by = ${this.instanceId}
           AND claim_generation = ${row.claim_generation} AND state = 'CLAIMED'
         RETURNING id
      `);
      if (completed.rows.length === 0) {
        this.logLostLease(row, 'completion');
        return;
      }
      this.logger.log({ msg: 'Fallback job completed', jobName: row.job_name, jobId: row.id, ...result });
    } catch (error: unknown) {
      clearInterval(renew);
      const reason = describeError(error);
      const attempts = DEFAULT_JOB_OPTIONS.attempts ?? 5;
      const baseDelay = typeof DEFAULT_JOB_OPTIONS.backoff === 'object' ? (DEFAULT_JOB_OPTIONS.backoff.delay ?? 2000) : 2000;

      if (row.attempts < attempts) {
        // BullMQ's own exponential formula: delayMs = 2^(attemptsMade-1) * baseDelay.
        const delayMs = Math.round(2 ** (row.attempts - 1) * baseDelay);
        const requeued = await this.db.execute<{ id: string }>(sql`
          UPDATE fallback_jobs
             SET state = 'QUEUED', run_after = now() + (${delayMs} * interval '1 millisecond'),
                 claimed_by = NULL, claimed_at = NULL,
                 last_error = ${reason.slice(0, 500)}, updated_at = now()
           WHERE id = ${row.id} AND claimed_by = ${this.instanceId}
             AND claim_generation = ${row.claim_generation} AND state = 'CLAIMED'
           RETURNING id
        `);
        if (requeued.rows.length === 0) {
          this.logLostLease(row, 'retry');
          return;
        }
        this.logger.warn({ msg: 'Fallback job attempt failed; it will be retried.', jobName: row.job_name, jobId: row.id, attempt: row.attempts, of: attempts, reason });
      } else {
        if (await this.markFailed(row, reason)) {
          this.logger.error({ msg: 'Fallback job failed permanently.', jobName: row.job_name, jobId: row.id, attempt: row.attempts, reason });
        }
      }
    }
  }

  private async markFailed(row: ClaimedRow, reason: string): Promise<boolean> {
    const failed = await this.db.execute<{ id: string }>(sql`
      UPDATE fallback_jobs
         SET state = 'FAILED', claimed_by = NULL, claimed_at = NULL,
             last_error = ${reason.slice(0, 500)}, updated_at = now()
       WHERE id = ${row.id} AND claimed_by = ${this.instanceId}
         AND claim_generation = ${row.claim_generation} AND state = 'CLAIMED'
       RETURNING id
    `);
    if (failed.rows.length === 0) this.logLostLease(row, 'failure');
    return failed.rows.length > 0;
  }

  private logLostLease(row: ClaimedRow, outcome: string): void {
    this.logger.warn({
      msg: 'Discarded a stale fallback job outcome after its lease was lost.',
      jobName: row.job_name,
      jobId: row.id,
      claimGeneration: row.claim_generation,
      outcome,
    });
  }

  /** Abandoned rows aren't swept by a BullMQ-scheduled purge job — that would be circular, since this exists because BullMQ is down. */
  private async cleanupTick(): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM fallback_jobs WHERE state = 'DONE' AND updated_at < now() - (${DONE_RETENTION_MS} * interval '1 millisecond')
    `);
  }
}
