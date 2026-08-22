import { PERMISSIONS, SYSTEM_ROLES } from '@vyuha/shared';
import type { Job } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { env } from '../common/env.js';
import { files } from '../db/schema/index.js';
import { FileService } from '../files/file.service.js';
import { ObjectStore } from '../storage/object-store.js';
import { JobRegistry } from './job-handler.js';
import { JobMonitorService, type JobMonitorSummary } from './job-monitor.service.js';
import { JobRunner } from './job-runner.service.js';
import { DEFAULT_JOB_OPTIONS, QUEUES } from './queue.registry.js';

/**
 * Real Redis, real BullMQ, real MinIO, real Postgres.
 *
 * The workers are started here with `JobRunner.startWorkers()` -- the same
 * method the bootstrap hook calls -- rather than by building a `Worker` in the
 * test. A hand-built worker would test a processor this file wrote, not the
 * one the application runs.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000f2';

let harness: ApiHarness;
let runner: JobRunner;
let fileService: FileService;
let objects: ObjectStore;
let uploaderId: string;
const createdFileIds: string[] = [];

/** Waits for a specific job to leave the queue, either way. */
async function settle(job: Job, timeoutMs = 30_000): Promise<'completed' | 'failed'> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await job.getState();
    if (state === 'completed') return 'completed';
    if (state === 'failed') return 'failed';
    if (Date.now() >= deadline) throw new Error(`Job ${job.id ?? '?'} stuck in state "${state}".`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function storeExpiredPhoto(): Promise<{ id: string; storageKey: string }> {
  const bytes = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 5, g: 5, b: 5 } },
  })
    .jpeg()
    .toBuffer();

  const stored = await fileService.storeImage({
    orgId: ORG_ID,
    uploadedBy: uploaderId,
    purpose: 'PUNCH_PHOTO',
    bytes,
    expiresAt: new Date(Date.now() - 60_000),
  });
  createdFileIds.push(stored.id);
  return { id: stored.id, storageKey: stored.storageKey };
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Vyuha Jobs Test');
  runner = harness.resolve(JobRunner);
  fileService = harness.resolve(FileService);
  objects = harness.resolve(ObjectStore);

  const uploader = await harness.createUser({ email: scopedEmail('jobs.uploader') });
  uploaderId = uploader.id;

  runner.startWorkers();
}, 60_000);

afterAll(async () => {
  if (createdFileIds.length > 0) {
    await harness.db.delete(files).where(inArray(files.id, createdFileIds));
  }
  await harness.close();
});

describe('the registry', () => {
  it('has a handler for every job it schedules', () => {
    const registry = harness.resolve(JobRegistry);
    expect(registry.registeredJobNames()).toContain('purge-expired-files');
  });

  it('refuses a second handler for the same job name', () => {
    const registry = harness.resolve(JobRegistry);
    expect(() =>
      registry.register({
        jobName: 'purge-expired-files',
        run: () => Promise.resolve({}),
      }),
    ).toThrow(/already has a handler/u);
  });

  it('fails a job whose name nothing understands, rather than dropping it', async () => {
    const queue = runner.queueFor(QUEUES.MAINTENANCE);
    const job = await queue.add(
      'a-job-from-a-future-release',
      {},
      { attempts: 1, removeOnFail: false },
    );

    expect(await settle(job)).toBe('failed');
    const reloaded = await queue.getJob(job.id ?? '');
    expect(reloaded?.failedReason).toContain('No handler is registered');
    await reloaded?.remove();
  }, 40_000);
});

describe('purge-expired-files', () => {
  it('applies the retry-with-backoff defaults from the registry', async () => {
    const jobId = await runner.enqueue('purge-expired-files', {
      requestedAt: new Date().toISOString(),
    });
    const job = await runner.queueFor(QUEUES.MAINTENANCE).getJob(jobId);

    expect(job?.opts.attempts).toBe(DEFAULT_JOB_OPTIONS.attempts);
    expect(job?.opts.backoff).toEqual(DEFAULT_JOB_OPTIONS.backoff);
    await settle(job as Job);
  }, 40_000);

  it('removes the object and closes the row, and a second run is a no-op', async () => {
    const target = await storeExpiredPhoto();
    expect(await objects.exists('photos', target.storageKey)).toBe(true);

    // ---- first run
    const firstId = await runner.enqueue('purge-expired-files', {
      requestedAt: new Date().toISOString(),
    });
    const first = await runner.queueFor(QUEUES.MAINTENANCE).getJob(firstId);
    expect(await settle(first as Job)).toBe('completed');

    const firstResult = (await runner.queueFor(QUEUES.MAINTENANCE).getJob(firstId))?.returnvalue as
      | { scanned: number; purged: number }
      | undefined;
    expect(firstResult?.purged).toBeGreaterThanOrEqual(1);

    // The object is actually gone from the bucket, not merely flagged.
    expect(await objects.exists('photos', target.storageKey)).toBe(false);

    const afterFirst = (
      await harness.db.select().from(files).where(eq(files.id, target.id))
    )[0];
    expect(afterFirst?.purgedAt).not.toBeNull();

    // ---- second run
    const secondId = await runner.enqueue('purge-expired-files', {
      requestedAt: new Date().toISOString(),
    });
    const second = await runner.queueFor(QUEUES.MAINTENANCE).getJob(secondId);
    expect(await settle(second as Job)).toBe('completed');

    const secondResult = (await runner.queueFor(QUEUES.MAINTENANCE).getJob(secondId))
      ?.returnvalue as { scanned: number; purged: number } | undefined;

    // Both halves matter. `purged: 0` alone could mean the job errored into
    // returning nothing; `scanned: 0` says the selection genuinely found no
    // work, which is what idempotent means here.
    expect(secondResult?.scanned).toBe(0);
    expect(secondResult?.purged).toBe(0);

    // ...and the row was not touched a second time.
    const afterSecond = (
      await harness.db.select().from(files).where(eq(files.id, target.id))
    )[0];
    expect(afterSecond?.purgedAt?.getTime()).toBe(afterFirst?.purgedAt?.getTime());
  }, 60_000);

  it('leaves a file alone until its retention date has passed', async () => {
    const bytes = await sharp({
      create: { width: 120, height: 120, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .jpeg()
      .toBuffer();

    const future = await fileService.storeImage({
      orgId: ORG_ID,
      uploadedBy: uploaderId,
      purpose: 'PUNCH_PHOTO',
      bytes,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    createdFileIds.push(future.id);

    const jobId = await runner.enqueue('purge-expired-files', {
      requestedAt: new Date().toISOString(),
    });
    await settle((await runner.queueFor(QUEUES.MAINTENANCE).getJob(jobId)) as Job);

    const row = (await harness.db.select().from(files).where(eq(files.id, future.id)))[0];
    expect(row?.purgedAt).toBeNull();
    expect(await objects.exists('photos', future.storageKey)).toBe(true);
  }, 40_000);
});

describe('the failure path', () => {
  it('retries, then lands in the failed set where the monitor can see it', async () => {
    // The real handler holds this exact instance, so the job fails inside the
    // real dispatch rather than through a substituted handler.
    const spy = vi
      .spyOn(fileService, 'purgeExpiredFiles')
      .mockRejectedValue(new Error('object store is unreachable'));

    try {
      // Short attempts and a fixed 50 ms backoff so the retry is observable in
      // a test. The production defaults are asserted separately above.
      const jobId = await runner.enqueue(
        'purge-expired-files',
        { requestedAt: new Date().toISOString() },
        { attempts: 3, backoff: { type: 'fixed', delay: 50 } },
      );

      const job = await runner.queueFor(QUEUES.MAINTENANCE).getJob(jobId);
      expect(await settle(job as Job)).toBe('failed');

      const failed = await runner.queueFor(QUEUES.MAINTENANCE).getJob(jobId);
      // It was retried, not abandoned on the first error.
      expect(failed?.attemptsMade).toBe(3);
      expect(failed?.failedReason).toContain('object store is unreachable');
      expect(spy).toHaveBeenCalledTimes(3);

      const summary = await harness.resolve(JobMonitorService).summary(ORG_ID);
      const surfaced = summary.recentFailures.find((failure) => failure.jobId === jobId);
      expect(surfaced).toBeDefined();
      expect(surfaced?.queue).toBe(QUEUES.MAINTENANCE);
      expect(surfaced?.failedReason).toContain('object store is unreachable');

      await failed?.remove();
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});

describe('the admin job monitor endpoint', () => {
  it('is refused to an Operations user and served to an Admin', async () => {
    await harness.ensurePermissionCatalogue();
    const opsRole = await harness.createSystemRole(SYSTEM_ROLES.OPERATIONS);
    const adminRole = await harness.createSystemRole(SYSTEM_ROLES.ADMIN);

    const ops = await harness.createUser({
      email: scopedEmail('jobs.ops'),
      roleIds: [opsRole],
    });
    const admin = await harness.createUser({
      email: scopedEmail('jobs.admin'),
      roleIds: [adminRole],
    });

    const opsSession = await harness.login(ops.email, ops.password);
    const denied = await harness.get('/jobs', { token: opsSession.token });
    expect(denied.status).toBe(403);
    expect((denied.body as { error: { details: { requiredAnyOf: string[] } } }).error.details
      .requiredAnyOf).toContain(PERMISSIONS.SETTINGS_MANAGE);

    const adminSession = await harness.login(admin.email, admin.password);
    const allowed = await harness.get<JobMonitorSummary>('/jobs', { token: adminSession.token });
    expect(allowed.status).toBe(200);
    expect(allowed.body.registeredJobs).toContain('purge-expired-files');
    expect(allowed.body.queues.map((queue) => queue.name)).toContain(QUEUES.MAINTENANCE);
    // The suite runs with the consumer half switched off (see vitest.config),
    // and the monitor reports that rather than implying work is being done.
    expect(allowed.body.workerEnabled).toBe(env.JOBS_WORKER_ENABLED);
  }, 60_000);

  it('is refused entirely without a token', async () => {
    const anonymous = await harness.get('/jobs');
    expect(anonymous.status).toBe(401);
  });
});
