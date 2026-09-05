import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { auditColumns, primaryId } from '../columns.js';

/**
 * The Postgres fallback for BullMQ (`FallbackJobRunner`), active only when
 * `JobRunner` could not reach Redis at boot. Mirrors `sync_jobs`'s claim
 * shape (`FOR UPDATE SKIP LOCKED`, stale-claim requeue) rather than
 * inventing a new one.
 *
 * `job_name` is free text, not a Postgres enum — matching how `sync_jobs`'s
 * own `entity_type` handles an evolving string-literal union (`JobName`)
 * with no DB enum, since BullMQ job names have never had one either.
 *
 * `DONE` rows are kept (not deleted) for `external_job_id` dedup parity with
 * BullMQ's own "ignore an add whose id already exists" behaviour, and swept
 * on the same cleanup timer as expired rate-limit attempts.
 */
export const fallbackJobs = pgTable(
  'fallback_jobs',
  {
    id: primaryId(),
    jobName: text('job_name').notNull(),
    payload: jsonb('payload').notNull(),
    state: text('state').notNull().default('QUEUED'), // QUEUED | CLAIMED | DONE | FAILED
    attempts: integer('attempts').notNull().default(0),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    /** BullMQ's `EnqueueOptions.jobId` equivalent, for dedup parity. */
    externalJobId: text('external_job_id'),
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /**
     * Monotonic fencing token. Every successful claim increments it and every
     * lease renewal/state transition must present the generation it received.
     * `claimed_by` alone is not enough: the same process can lose a stale
     * lease and later reclaim the row, leaving an older invocation with the
     * same owner id able to overwrite the newer one.
     */
    claimGeneration: integer('claim_generation').notNull().default(0),
    lastError: text('last_error'),
    ...auditColumns(),
  },
  (t) => [
    index('fallback_jobs_state_run_after_idx').on(t.state, t.runAfter),
    uniqueIndex('fallback_jobs_external_id_uq')
      .on(t.jobName, t.externalJobId)
      .where(sql`external_job_id IS NOT NULL`),
  ],
);

/**
 * One row per `SCHEDULED_JOBS` entry, upserted by `schedulerId` at
 * activation — the Postgres analog of BullMQ's `upsertJobScheduler`.
 */
export const fallbackJobSchedules = pgTable('fallback_job_schedules', {
  schedulerId: text('scheduler_id').primaryKey(),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
});
