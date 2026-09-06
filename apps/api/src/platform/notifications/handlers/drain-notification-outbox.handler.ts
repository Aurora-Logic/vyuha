import { Injectable, type OnModuleInit } from '@nestjs/common';

import { JobRegistry, type JobContext, type JobHandler, type JobResult } from '../../jobs/job-handler.js';
import type { JobPayloads } from '../../jobs/queue.registry.js';
import { NotificationDispatcher } from '../notification.dispatcher.js';

/** Retries durable envelopes that a queue outage left pending. */
@Injectable()
export class DrainNotificationOutboxHandler
  implements JobHandler<'drain-notification-outbox'>, OnModuleInit
{
  readonly jobName = 'drain-notification-outbox' as const;

  constructor(
    private readonly dispatcher: NotificationDispatcher,
    private readonly registry: JobRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  run(
    _payload: JobPayloads['drain-notification-outbox'],
    _context: JobContext,
  ): Promise<JobResult> {
    return this.dispatcher.drainOutbox();
  }
}
