import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ERROR_CODES } from '@vyuha/shared';
import { Job, Queue, Worker, type JobsOptions } from 'bullmq';

import { env } from '../common/env.js';
import { AppError, describeError } from '../common/errors.js';
import { StartupError } from '../common/startup-error.js';
import { bullConnectionOptions } from './bull-connection.js';
import { FallbackJobRunner } from './fallback-job-runner.service.js';
import { JobRegistry, type JobResult } from './job-handler.js';
import {
  DEFAULT_JOB_OPTIONS,
  ENQUEUE_TIMEOUT_MS,
  JOB_QUEUE,
  SCHEDULED_JOBS,
  SHUTDOWN_BUDGET_MS,
  SHUTDOWN_STAGE_MS,
  WORKER_SHUTDOWN_BUDGET_MS,
  type JobName,
  type JobPayloads,
  type QueueName,
} from './queue.registry.js';

/**
 * Technical design §11. Producers and consumers in one place, because the
 * thing worth getting right is that they agree about names and payloads.
 *
 * The producer side is always wired: an API instance must be able to enqueue.
 * The consumer side is behind `JOBS_WORKER_ENABLED`, so a deployment can run
 * web and worker processes separately without a second entry point.
 *
 * Queues are created on first use rather than up front. Five idle queues would
 * be five idle Redis connections in every test process and every web instance,
 * for queues whose first job arrives in Phase 3.
 */

/**
 * What a client is told to wait before retrying a refused enqueue. Short: the
 * failure this reports is a cache blip, not a maintenance window, and the
 * offline punch queue drains on its own triggers anyway.
 */
const RETRY_AFTER_SECONDS = 5;

export interface EnqueueOptions {
  /**
   * Deduplicates. BullMQ ignores an `add` whose id already exists, including
   * for a job still retained after completing, so a caller that cannot tell
   * whether it already enqueued something can simply enqueue it again.
   */
  readonly jobId?: string;
  readonly delayMs?: number;
  readonly attempts?: number;
  readonly backoff?: JobsOptions['backoff'];
}

/** Whether this payload carries the field the scheduled handlers read as their clock. */
function hasRequestedAt(payload: unknown): payload is { requestedAt: string } {
  return typeof payload === 'object' && payload !== null && typeof (payload as { requestedAt?: unknown }).requestedAt === 'string';
}

@Injectable()
export class JobRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobRunner.name);
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Map<QueueName, Worker>();

  constructor(
    private readonly registry: JobRegistry,
    private readonly fallback: FallbackJobRunner,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!env.JOBS_WORKER_ENABLED) {
      this.logger.log({
        msg: 'JOBS_WORKER_ENABLED is false; this process enqueues but does not consume or schedule background jobs.',
      });
      return;
    }

    try {
      await this.installSchedules();
    } catch (error: unknown) {
      // JOBS_REQUIRE_REDIS is opt-in, for a deployment that has installed
      // Redis and wants a misconfigured REDIS_URL there to be a loud boot
      // failure rather than a silent switch to the Postgres fallback.
      if (env.JOBS_REQUIRE_REDIS) throw error;

      this.logger.warn({
        msg: 'Could not connect to Redis; background jobs are running from the Postgres fallback until Redis is reachable.',
        reason: describeError(error),
      });
      await this.fallback.activate();
      return; // No live BullMQ to consume from.
    }

    this.startWorkers();
  }

  // -------------------------------------------------------------- producer

  queueFor(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing !== undefined) return existing;

    const queue = new Queue(name, {
      connection: bullConnectionOptions(),
      prefix: env.JOBS_QUEUE_PREFIX,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });

    // Same reason the worker has one: without a listener BullMQ's EventEmitter
    // turns a connection error into an unhandled error event, and a boot with
    // Redis down printed bare `connect ECONNREFUSED` stack traces -- 160 of
    // them in 25 seconds -- with nothing naming the queue they came from.
    queue.on('error', (error: Error) => {
      this.logger.error({
        msg: 'Job queue connection error.',
        queue: name,
        reason: describeError(error),
      });
    });

    this.queues.set(name, queue);
    return queue;
  }

  /**
   * Hands a job to Redis, or gives up.
   *
   * The bound is the point. Every caller of this method is on a request path,
   * and BullMQ's connection retries a command forever by contract
   * (`bull-connection.ts`), so without it a Redis outage does not make an
   * enqueue fail -- it makes the request that asked for it never answer, while
   * holding its connection open. `SERVICE_UNAVAILABLE` rather than a bare
   * `Error` because that is a decision the caller can act on: absorb it and
   * keep an unconditional promise the way `requestPasswordReset` does, or let
   * it reach the client as a retryable 503.
   *
   * The abandoned `add` is not cancellable -- Redis may still accept the job
   * when it comes back -- so the message says the request was not accepted
   * rather than that nothing will happen.
   */
  async enqueue<TName extends JobName>(
    jobName: TName,
    payload: JobPayloads[TName],
    options: EnqueueOptions = {},
  ): Promise<string> {
    // Known-down since boot: go straight to Postgres rather than paying
    // ENQUEUE_TIMEOUT_MS on a BullMQ connection that isn't there at all.
    if (this.fallback.isActive()) return this.fallback.enqueue(jobName, payload, options);

    // No worker-flag short-circuit here, deliberately: JOBS_WORKER_ENABLED
    // means "this process does not consume", never "this process does not
    // enqueue". The API under test enqueues real jobs into a real Redis with
    // the flag off, and every queue assertion in the suite depends on that.
    const job = await this.withinDeadline(
      this.queueFor(JOB_QUEUE[jobName]).add(jobName, payload, {
        ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
        ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
        ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
        ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
      }),
      ENQUEUE_TIMEOUT_MS,
      () =>
        new AppError(
          ERROR_CODES.SERVICE_UNAVAILABLE,
          'Background work could not be queued just now. Try again shortly.',
          {
            details: { retryAfterSeconds: RETRY_AFTER_SECONDS, jobName },
          },
        ),
    );

    // BullMQ types `id` as optional because a job added to a flow may not have
    // one yet. A plain `add` always does.
    return job.id ?? '';
  }

  /**
   * Rejects with `onTimeout()` if `work` has not settled in `timeoutMs`.
   *
   * The timer is cleared either way, and the losing promise's rejection is
   * swallowed rather than left to become an unhandled rejection -- an
   * abandoned BullMQ command does eventually reject, minutes later, long after
   * anybody cared.
   */
  private async withinDeadline<T>(
    work: Promise<T>,
    timeoutMs: number,
    onTimeout: () => Error,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(onTimeout());
      }, timeoutMs);
    });

    work.catch(() => undefined);

    try {
      return await Promise.race([work, expiry]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Registers the recurring work from `SCHEDULED_JOBS`. Upsert by id, so
   * restarting does not stack duplicates and editing the pattern updates the
   * existing scheduler instead of leaving the old one firing too.
   *
   * Bounded for the reason `enqueue` is, and it matters more here: this runs
   * inside `onApplicationBootstrap`, which `app.listen()` awaits. Booting with
   * Redis unreachable used to stop on the first upsert and stay there -- a
   * process alive for ever, holding no port, never reaching `app.listen`, with
   * nothing in its output but repeated connection stack traces. Failing the
   * boot is right (a process that cannot queue must not take traffic); failing
   * it silently and for ever is not.
   */
  private async installSchedules(): Promise<void> {
    for (const scheduled of SCHEDULED_JOBS) {
      if (this.registry.get(scheduled.jobName) === null) {
        // A schedule with no handler would enqueue jobs nothing consumes,
        // which fills the queue and looks like a backlog.
        this.logger.warn({
          msg: `Skipping schedule "${scheduled.schedulerId}": no handler is registered for ${scheduled.jobName}.`,
        });
        continue;
      }

      await this.withinDeadline(
        this.queueFor(JOB_QUEUE[scheduled.jobName]).upsertJobScheduler(
          scheduled.schedulerId,
          { pattern: scheduled.pattern },
          { name: scheduled.jobName, data: { requestedAt: new Date().toISOString() } },
        ),
        ENQUEUE_TIMEOUT_MS,
        () =>
          new StartupError(
            `Redis did not accept the job scheduler "${scheduled.schedulerId}" within ${String(ENQUEUE_TIMEOUT_MS)}ms.`,
            `REDIS_URL points at a server this process cannot reach. The API refuses to serve traffic it cannot queue background work from; fix Redis, or start this process with JOBS_WORKER_ENABLED=false only once Redis is reachable.`,
          ),
      );
    }
  }

  // -------------------------------------------------------------- consumer

  /**
   * Public so a test can start the same workers the bootstrap hook starts,
   * rather than building a parallel set that could drift from this one.
   * Idempotent.
   */
  startWorkers(): void {
    const queuesWithHandlers = new Set(
      this.registry.registeredJobNames().map((jobName) => JOB_QUEUE[jobName]),
    );

    for (const queueName of queuesWithHandlers) {
      if (this.workers.has(queueName)) continue;

      // Same prefix as the producer, necessarily: a worker reading a different
      // namespace is a worker that never sees the job and never says so.
      const worker = new Worker(queueName, (job: Job) => this.process(job), {
        connection: bullConnectionOptions(),
        prefix: env.JOBS_QUEUE_PREFIX,
        concurrency: 2,
      });

      worker.on('failed', (job: Job | undefined, error: Error) => {
        const attempts = job?.opts.attempts ?? DEFAULT_JOB_OPTIONS.attempts ?? 1;
        const made = job?.attemptsMade ?? 0;
        const final = made >= attempts;

        // Two levels on purpose. A retryable failure is noise at error level
        // and would train an operator to ignore the channel; the final one is
        // the job giving up, and that is what the monitor surfaces.
        this.logger[final ? 'error' : 'warn']({
          msg: final
            ? 'Job failed permanently and is now in the failed set.'
            : 'Job attempt failed; it will be retried.',
          queue: queueName,
          jobName: job?.name,
          jobId: job?.id,
          attempt: made,
          of: attempts,
          reason: describeError(error),
        });
      });

      worker.on('error', (error: Error) => {
        // Connection-level trouble, not a job failing. Without a listener
        // BullMQ's EventEmitter would make this an unhandled error.
        this.logger.error({
          msg: 'Job worker error.',
          queue: queueName,
          reason: describeError(error),
        });
      });

      this.workers.set(queueName, worker);
      this.logger.log({ msg: `Job worker started for queue "${queueName}".` });
    }
  }

  /**
   * The queues this process is actually draining.
   *
   * Read from the running workers rather than from the registry, because the
   * two disagree in the deployment that matters. Handlers register during
   * `onModuleInit` whatever `JOBS_WORKER_ENABLED` says -- registration is what
   * makes a job name understood, and a web instance must still understand the
   * names it enqueues. Only `startWorkers` puts a consumer on a queue, and it
   * runs only when the flag is on. Deriving this from the registry made the
   * admin job monitor report `consumedHere: true` for four queues on a process
   * that had created no workers at all.
   */
  consumedQueues(): ReadonlySet<QueueName> {
    return new Set(this.workers.keys());
  }

  /**
   * The dispatch a worker performs. Separated so the failure modes are visible
   * in one place: an unknown job name is a deployment mismatch and must not be
   * retried into oblivion, and a handler's own error is rethrown untouched so
   * BullMQ applies the backoff.
   */
  async process(job: Job): Promise<JobResult> {
    const handler = this.registry.get(job.name);

    if (handler === null) {
      // Reachable when an old instance still holds jobs a new deployment no
      // longer knows about, or the reverse. Failing loudly beats discarding.
      throw new Error(
        `No handler is registered for job "${job.name}". ` +
          'A queued job outlived the code that understood it.',
      );
    }

    const started = Date.now();
    // The payload was validated by the type system at the enqueue site and has
    // round-tripped through JSON since. The handler treats it as its declared
    // shape, which is the same contract every BullMQ consumer has.
    let payload = job.data as JobPayloads[JobName];

    /*
     * A scheduled job's `data` is a template BullMQ stores once, when the
     * scheduler is registered, and replays unchanged on every iteration
     * (`upsertJobScheduler` below writes it into the scheduler hash). So a
     * `requestedAt` put there is the moment this *process booted*, not the
     * moment the job ran -- and three of the leave handlers read it as
     * "today". On a server that stays up a month, monthly accrual would run
     * every night believing it was still deploy day.
     *
     * `job.timestamp` is when this occurrence was actually created, which is
     * what every one of those handlers means. Repeated jobs are the only ones
     * that can carry a stale template, so this only ever corrects them.
     */
    if (typeof job.repeatJobKey === 'string' && job.repeatJobKey !== '' && hasRequestedAt(payload)) {
      payload = { ...payload, requestedAt: new Date(job.timestamp).toISOString() } as JobPayloads[JobName];
    }

    const result = await handler.run(payload, {
      jobId: job.id ?? 'unknown',
      attempt: job.attemptsMade + 1,
    });

    this.logger.log({
      msg: 'Job completed',
      jobName: job.name,
      jobId: job.id,
      elapsedMs: Date.now() - started,
      ...result,
    });

    return result;
  }

  // -------------------------------------------------------------- shutdown

  /**
   * Shutdown that always finishes.
   *
   * `Worker.close()` waits for the current jobs and for its own connections,
   * and a connection configured to retry for ever (BullMQ's requirement) never
   * reports that it has given up. A process that had lived through a Redis
   * outage therefore never completed this hook: measured still alive 90s after
   * SIGTERM, holding no port, with Redis already back and `/ready` answering
   * `redis ok` in 38ms. An instance that never lost Redis exited in 2s.
   *
   * So each stage is bounded and the next one is harsher than the last -- ask
   * politely, then force, then drop the sockets -- and the whole teardown
   * shares one budget, because per-stage bounds multiply into a total that
   * outlasts the orchestrator's patience. Nothing here rethrows: the only
   * outcome that matters is that this method returns, because a shutdown hook
   * that does not is a deploy that does not.
   */
  async onApplicationShutdown(): Promise<void> {
    const started = Date.now();

    // Workers first: a worker closed after its queue would keep trying to read
    // from a connection that is already going away. They get a share of the
    // budget rather than all of it -- see `WORKER_SHUTDOWN_BUDGET_MS`.
    await Promise.all(
      [...this.workers.values()].map((worker) =>
        this.stopWorker(worker, started + WORKER_SHUTDOWN_BUDGET_MS),
      ),
    );
    this.workers.clear();

    const queueDeadline = started + SHUTDOWN_BUDGET_MS;
    await Promise.all(
      [...this.queues.values()].map(async (queue) => {
        if (await this.attempt(queue.close(), 'queue close', queueDeadline)) return;
        await this.attempt(queue.disconnect(), 'queue disconnect', queueDeadline);
      }),
    );
    this.queues.clear();
  }

  private async stopWorker(worker: Worker, deadline: number): Promise<void> {
    // `close()` drains in-flight jobs, which is what we want when it works.
    // `close(true)` abandons them, which is the right answer for a worker held
    // up by one long job -- an abandoned job is picked up again by BullMQ's
    // stalled-job recovery. Neither helps when the connection itself is wedged,
    // which is what `disconnect` is for.
    if (await this.attempt(worker.close(), 'worker close', deadline)) return;
    if (await this.attempt(worker.close(true), 'forced worker close', deadline)) return;
    await this.attempt(worker.disconnect(), 'worker disconnect', deadline);
  }

  /**
   * True when the work finished inside the bound; false on timeout or error.
   *
   * The wait is the shorter of one stage and whatever is left of the shared
   * budget, so a stage that starts late gets less rather than extending the
   * total. Once the budget is spent every remaining stage is skipped outright.
   */
  private async attempt(work: Promise<unknown>, what: string, deadline: number): Promise<boolean> {
    const remaining = Math.min(SHUTDOWN_STAGE_MS, deadline - Date.now());

    if (remaining <= 0) {
      this.logger.warn({ msg: `Shutdown: no budget left for ${what}; skipping it.` });
      return false;
    }

    try {
      await this.withinDeadline(
        work,
        remaining,
        () => new Error(`${what} did not finish within ${String(remaining)}ms.`),
      );
      return true;
    } catch (error: unknown) {
      this.logger.warn({ msg: `Shutdown: ${what} gave up.`, reason: describeError(error) });
      return false;
    }
  }
}
