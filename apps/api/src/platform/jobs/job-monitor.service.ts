import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';

import { env } from '../common/env.js';
import { FallbackJobRunner } from './fallback-job-runner.service.js';
import { JobRegistry } from './job-handler.js';
import { JobRunner } from './job-runner.service.js';
import { ALL_QUEUES, type QueueName } from './queue.registry.js';

/**
 * Technical design §17: "a job monitor page for BullMQ", and §11: failures
 * "surface in an admin job monitor".
 *
 * The failure list is read back out of Redis rather than kept in a ring buffer
 * in this process. That is the whole point of an admin-visible failure path:
 * an in-memory list is empty after the restart that the failure probably
 * caused, and it shows only the failures this instance happened to observe.
 */

export interface QueueSummary {
  readonly name: QueueName;
  /**
   * Whether *this* process has a worker on the queue. The question an operator
   * opens the page to answer is "why has no reset mail gone out", and the only
   * honest answer to it is whether anything is draining the queue.
   */
  readonly consumedHere: boolean;
  readonly counts: Readonly<Record<string, number>>;
}

export interface JobFailure {
  readonly queue: QueueName;
  readonly jobId: string;
  readonly jobName: string;
  readonly attemptsMade: number;
  readonly failedReason: string;
  readonly failedAt: string | null;
}

export interface JobMonitorSummary {
  readonly mode: 'bullmq' | 'db-fallback';
  readonly workerEnabled: boolean;
  readonly registeredJobs: readonly string[];
  readonly queues: readonly QueueSummary[];
  readonly recentFailures: readonly JobFailure[];
  /**
   * Failures this reader is not entitled to see, counted rather than hidden.
   * A number with no detail tells an administrator the deployment is unwell
   * without telling them whose data broke it.
   */
  readonly withheldFailures: number;
  /** Only set in fallback mode: counts from `fallback_jobs`, grouped by state. */
  readonly fallbackCounts?: Readonly<Record<string, number>>;
}

const FAILURES_PER_QUEUE = 20;

@Injectable()
export class JobMonitorService {
  constructor(
    private readonly runner: JobRunner,
    private readonly registry: JobRegistry,
    private readonly fallback: FallbackJobRunner,
  ) {}

  async summary(orgId: string): Promise<JobMonitorSummary> {
    if (this.fallback.isActive()) {
      // BullMQ's own calls below require `maxRetriesPerRequest: null` and
      // never settle against a dead Redis (queue.registry.ts's own measured
      // 40s+ hang) -- this page must not make the same mistake by appending
      // fallback data to them instead of bypassing them entirely.
      return {
        mode: 'db-fallback',
        workerEnabled: env.JOBS_WORKER_ENABLED,
        registeredJobs: [...this.registry.registeredJobNames()].sort(),
        queues: [],
        recentFailures: [],
        withheldFailures: 0,
        fallbackCounts: await this.fallback.countsByState(),
      };
    }

    // From the runner's workers, not the registry: a handler is registered on
    // every instance so that every instance understands the job names it
    // enqueues, and only a worker consumes. See `JobRunner.consumedQueues`.
    const consumed = this.runner.consumedQueues();

    const queues: QueueSummary[] = [];
    const failures: AttributedFailure[] = [];

    for (const name of ALL_QUEUES) {
      const queue = this.runner.queueFor(name);
      queues.push({
        name,
        consumedHere: consumed.has(name),
        counts: await queue.getJobCounts(),
      });

      for (const job of await queue.getFailed(0, FAILURES_PER_QUEUE - 1)) {
        failures.push(describeFailure(name, job));
      }
    }

    // Newest first across all queues, so the page opens on what just broke.
    failures.sort((a, b) => (b.failedAt ?? '').localeCompare(a.failedAt ?? ''));

    /*
     * One BullMQ deployment holds one set of queues for every organisation on
     * it, and a failure reason is 500 characters of whatever the driver said
     * -- a file key, an address, the value that violated a constraint. Four of
     * the job types carry the organisation they were enqueued for; those are
     * shown only to that organisation. The rest are the deployment's own
     * maintenance, belong to no organisation, and stay visible, because an
     * administrator who cannot see that the sweeps are failing cannot act.
     */
    const mine = failures.filter((f) => f.orgId === null || f.orgId === orgId);
    const withheld = failures.length - mine.length;

    return {
      mode: 'bullmq',
      workerEnabled: env.JOBS_WORKER_ENABLED,
      registeredJobs: [...this.registry.registeredJobNames()].sort(),
      queues,
      recentFailures: mine.slice(0, FAILURES_PER_QUEUE).map(({ orgId: _orgId, ...rest }) => rest),
      withheldFailures: withheld,
    };
  }
}

/** The reply shape plus the organisation used to decide who may see it. */
type AttributedFailure = JobFailure & { readonly orgId: string | null };

function describeFailure(queue: QueueName, job: Job): AttributedFailure {
  const data: unknown = job.data;
  const orgId = typeof data === 'object' && data !== null && typeof (data as { orgId?: unknown }).orgId === 'string' ? (data as { orgId: string }).orgId : null;
  return {
    orgId,
    queue,
    jobId: job.id ?? 'unknown',
    jobName: job.name,
    attemptsMade: job.attemptsMade,
    // Truncated: a stack trace from a driver can be kilobytes, and the monitor
    // is a list, not a log viewer.
    failedReason: (job.failedReason ?? 'unknown').slice(0, 500),
    failedAt: job.finishedOn === undefined ? null : new Date(job.finishedOn).toISOString(),
  };
}
