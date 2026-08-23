import { ERROR_CODES } from '@vyuha/shared';
import { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { AppError } from '../common/errors.js';
import { JobMonitorService, type JobMonitorSummary } from './job-monitor.service.js';
import { JobRunner } from './job-runner.service.js';
import {
  ENQUEUE_TIMEOUT_MS,
  QUEUES,
  SHUTDOWN_BUDGET_MS,
  SHUTDOWN_STAGE_MS,
} from './queue.registry.js';

/**
 * What the API does when Redis stops answering.
 *
 * Every behaviour here was found on the running production build with Redis
 * behind a TCP proxy that was then killed -- absence proven with `lsof`, not
 * with a failed connect. The numbers in each test's comment are from that
 * session; the tests reproduce the *shape* of the failure deterministically,
 * because a suite that killed the shared Redis would take every other agent on
 * this machine down with it.
 *
 * The shape is precise, not approximate: BullMQ requires
 * `maxRetriesPerRequest: null` (`bull-connection.ts`), so a command issued
 * while Redis is unreachable does not fail -- it never settles. A promise that
 * never resolves is exactly that, and it is what `add` returned for 40 seconds
 * while `POST /auth/password-resets` held its connection open.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000b2';

let harness: ApiHarness;
let runner: JobRunner;
let monitor: JobMonitorService;

/** A promise with the one property that matters here: it never settles. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Vyuha Job Resilience');
  runner = harness.resolve(JobRunner);
  monitor = harness.resolve(JobMonitorService);
}, 60_000);

afterAll(async () => {
  await harness.close();
});

describe('enqueueing while Redis does not answer', () => {
  it('gives up inside the deadline instead of waiting for ever', async () => {
    const queue = runner.queueFor(QUEUES.NOTIFICATION);
    const add = vi.spyOn(queue, 'add').mockImplementation(() => neverSettles());

    try {
      const started = Date.now();
      const failure = await runner
        .enqueue('deliver-password-reset', {
          email: 'nobody@vyuha.test',
          ip: null,
          requestedAt: new Date().toISOString(),
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      const elapsed = Date.now() - started;

      expect(add).toHaveBeenCalledTimes(1);
      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).code).toBe(ERROR_CODES.SERVICE_UNAVAILABLE);
      expect((failure as AppError).status).toBe(503);
      // Generous upper bound: the assertion is "bounded", not "fast". Before
      // the deadline existed this line was never reached at all.
      expect(elapsed).toBeLessThan(ENQUEUE_TIMEOUT_MS * 3);
    } finally {
      add.mockRestore();
    }
  }, 30_000);

  /**
   * REQ-B-04. The endpoint documents an unconditional 202 -- an address with an
   * account and one without must be indistinguishable in status, body *and*
   * clock -- and absorbs a failed enqueue to keep it. That absorption was
   * unreachable: measured on the production build, `curl -m 40` got HTTP 000
   * after 40.0s, and the "could not queue" line the catch writes appeared zero
   * times in the log. A contract that cannot fail cannot be kept.
   */
  it('still answers POST /auth/password-resets with 202', async () => {
    const queue = runner.queueFor(QUEUES.NOTIFICATION);
    const add = vi.spyOn(queue, 'add').mockImplementation(() => neverSettles());

    try {
      const started = Date.now();
      const result = await harness.post('/auth/password-resets', {
        body: { email: scopedEmail('reset.while.redis.down') },
      });
      const elapsed = Date.now() - started;

      expect(result.status).toBe(202);
      expect(elapsed).toBeLessThan(ENQUEUE_TIMEOUT_MS * 3);
    } finally {
      add.mockRestore();
    }
  }, 30_000);

  /**
   * The other request paths that await an enqueue -- the export request and
   * every leave decision -- have no catch of their own, so what reaches their
   * client is whatever `enqueue` throws. A retryable 503 with a `Retry-After`
   * is a caller's answer; a request that never returns is not, and neither is
   * a 500. Asserted on the error rather than through those endpoints so this
   * stays a statement about the queue layer.
   */
  it('refuses with a retryable code carrying a retry hint', async () => {
    const queue = runner.queueFor(QUEUES.EXPORT);
    const add = vi.spyOn(queue, 'add').mockImplementation(() => neverSettles());

    try {
      const failure = await runner
        .enqueue('generate-report-export', {
          orgId: ORG_ID,
          exportJobId: '01900000-0000-7000-8000-0000000000f6',
          requestedAt: new Date().toISOString(),
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect((failure as AppError).details).toMatchObject({
        retryAfterSeconds: expect.any(Number),
        jobName: 'generate-report-export',
      });
    } finally {
      add.mockRestore();
    }
  }, 30_000);
});

describe('the job monitor', () => {
  /**
   * The one screen an operator opens to answer "why has no reset mail gone
   * out". `consumedHere` was derived from `JobRegistry.registeredJobNames()`,
   * and handlers register in `onModuleInit` whatever `JOBS_WORKER_ENABLED`
   * says -- so a process booted with the worker off reported
   * `workerEnabled: false` alongside `notification { consumedHere: true }`.
   * Observed live with `waiting: 631` on that same queue.
   */
  it('reports nothing consumed here when this process runs no workers', async () => {
    const summary = await monitor.summary(ORG_ID);

    // The premise: handlers *are* registered, which is why the old derivation
    // looked plausible. Without this the test could pass for the wrong reason.
    expect(summary.registeredJobs).toContain('deliver-password-reset');
    expect(summary.queues.length).toBeGreaterThan(0);

    for (const queue of summary.queues) {
      expect({ queue: queue.name, consumedHere: queue.consumedHere }).toEqual({
        queue: queue.name,
        consumedHere: false,
      });
    }
  }, 30_000);

  it('reports the queues consumed here once workers are running', async () => {
    runner.startWorkers();

    try {
      const summary: JobMonitorSummary = await monitor.summary(ORG_ID);
      const consumed = summary.queues
        .filter((queue) => queue.consumedHere)
        .map((queue) => queue.name);

      expect(consumed).toContain(QUEUES.NOTIFICATION);
      expect(consumed).toContain(QUEUES.MAINTENANCE);
      // `attendance` was the empty one when this was written, and the punch
      // reminder and missing-OUT sweeps (REQ-K-03) gave it its first handlers.
      // The other direction - a queue reporting a consumer this process does
      // not have - is what "reports nothing consumed here when this process
      // runs no workers" above is for, and that is the lie that actually
      // shipped, so the teeth are there rather than here.
      expect(consumed).toContain(QUEUES.ATTENDANCE);
    } finally {
      await runner.onApplicationShutdown();
    }
  }, 60_000);
});

describe('shutdown', () => {
  /**
   * Two API processes that had lived through a Redis outage were still alive
   * 10m36s and 4m45s after SIGTERM, holding no port, while three that never
   * lost Redis exited cleanly on the same signal. Reproduced at 90s with Redis
   * already back and `/ready` answering `redis ok` in 38ms, which is what rules
   * out "it is still waiting for Redis": `Worker.close()` waits on a connection
   * that has no concept of giving up.
   *
   * On the production compose that is a deploy that hangs until Docker sends
   * SIGKILL, so the property under test is not "closes cleanly" but "returns".
   */
  it('finishes even when every worker close never settles', async () => {
    runner.startWorkers();
    expect(runner.consumedQueues().size).toBeGreaterThan(0);

    // Both the polite close and the forced one, for every worker. `disconnect`
    // is deliberately left real: it is the last resort the shutdown falls back
    // to, so letting it run proves the fallback works *and* leaves no worker
    // consuming jobs that belong to the next test file.
    const stalled: Worker[] = [];
    const close = vi
      .spyOn(Worker.prototype, 'close')
      .mockImplementation(function stall(this: Worker): Promise<void> {
        stalled.push(this);
        return neverSettles();
      });

    try {
      const started = Date.now();
      await runner.onApplicationShutdown();
      const elapsed = Date.now() - started;

      expect(stalled.length).toBeGreaterThan(0);
      // The lower bound says the shutdown genuinely waited and then stopped
      // waiting, rather than skipping the close altogether. The upper bound is
      // the whole point, and it is the shared budget rather than a sum of
      // stages: before either existed this call never returned, and the test
      // could only end by timing out.
      expect(elapsed).toBeGreaterThanOrEqual(SHUTDOWN_STAGE_MS);
      expect(elapsed).toBeLessThan(SHUTDOWN_BUDGET_MS * 2);
      expect(runner.consumedQueues().size).toBe(0);
    } finally {
      close.mockRestore();
    }
  }, 120_000);
});

describe('a queue that answers normally', () => {
  /**
   * The control. Every test above proves something about failure, and each of
   * them would also pass against a runner that had simply stopped working.
   */
  it('still enqueues against the real Redis', async () => {
    const jobId = await runner.enqueue('purge-expired-files', {
      requestedAt: new Date().toISOString(),
    });

    expect(jobId).not.toBe('');

    const job = await runner.queueFor(QUEUES.MAINTENANCE).getJob(jobId);
    expect(job?.name).toBe('purge-expired-files');
    await job?.remove();
  }, 30_000);
});
