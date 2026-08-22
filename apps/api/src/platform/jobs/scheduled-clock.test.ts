import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { JobRegistry, type JobHandler } from './job-handler.js';
import { JobRunner } from './job-runner.service.js';

/**
 * A scheduled job must run against the clock of the occurrence, not the clock
 * of the deployment.
 *
 * BullMQ stores a scheduler's `data` once, when `upsertJobScheduler`
 * registers it, and replays that same object on every iteration. The runner
 * used to put `requestedAt: new Date()` in there, and three of the leave
 * handlers read `payload.requestedAt` as "today" -- so on a process that
 * stays up for a month, monthly accrual ran every night believing it was
 * still the day the process booted, and the daily sweeps re-ran the same day
 * for ever.
 *
 * These drive `JobRunner.process` directly with a job shaped the way BullMQ
 * shapes one, so no Redis is needed to pin the behaviour.
 */

/** A handler that records the payload it was handed. */
function recorder(): { handler: JobHandler<'accrue-leave'>; seen: { requestedAt?: string }[] } {
  const seen: { requestedAt?: string }[] = [];
  return {
    seen,
    handler: {
      jobName: 'accrue-leave',
      run: (payload) => {
        seen.push(payload as { requestedAt?: string });
        return Promise.resolve({ ok: true });
      },
    } as unknown as JobHandler<'accrue-leave'>,
  };
}

function runnerWith(handler: JobHandler<'accrue-leave'>): JobRunner {
  const registry = new JobRegistry();
  registry.register(handler);
  // Only `process` is exercised; the queue and worker plumbing is not touched.
  return new JobRunner(registry) as JobRunner;
}

/** A BullMQ job as the worker receives one. `repeatJobKey` is what marks it scheduled. */
function jobLike(over: Partial<Job>): Job {
  return {
    name: 'accrue-leave',
    id: 'j1',
    attemptsMade: 0,
    timestamp: Date.parse('2026-08-23T02:00:00.000Z'),
    data: {},
    ...over,
  } as unknown as Job;
}

describe('a scheduled job reads the clock of its own occurrence', () => {
  const bootedAt = '2026-07-01T03:00:00.000Z';

  it('replaces the template timestamp with the time the occurrence was created', async () => {
    const { handler, seen } = recorder();
    await runnerWith(handler).process(
      jobLike({
        // What BullMQ replays: the template written when the scheduler was
        // registered, seven weeks ago.
        data: { requestedAt: bootedAt },
        repeatJobKey: 'maintenance:accrue-leave',
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.requestedAt).toBe('2026-08-23T02:00:00.000Z');
    expect(seen[0]?.requestedAt).not.toBe(bootedAt);
  });

  it('leaves a one-off job’s payload exactly as the caller enqueued it', async () => {
    const { handler, seen } = recorder();
    // No repeatJobKey: somebody asked for this run, and the timestamp they
    // put in the payload is the one they meant.
    await runnerWith(handler).process(jobLike({ data: { requestedAt: bootedAt, month: '2026-06' } }));
    expect(seen[0]?.requestedAt).toBe(bootedAt);
    expect((seen[0] as { month?: string }).month).toBe('2026-06');
  });

  it('leaves a scheduled payload that carries no clock alone', async () => {
    const { handler, seen } = recorder();
    await runnerWith(handler).process(jobLike({ data: { orgId: 'o1' }, repeatJobKey: 'maintenance:accrue-leave' }));
    expect(seen[0]).toEqual({ orgId: 'o1' });
  });
});
