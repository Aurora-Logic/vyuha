import { Injectable, type OnModuleInit } from '@nestjs/common';

import {
  JobRegistry,
  type JobContext,
  type JobHandler,
  type JobResult,
} from '../jobs/job-handler.js';
import type { JobPayloads } from '../jobs/queue.registry.js';
import { SyncSchedulerService } from './sync-scheduler.service.js';

/**
 * D-20's timer. The statement it runs is the one UPDATE the journal's guard
 * trigger permits; everything interesting lives in the service and the
 * trigger, so this stays a registration.
 */
@Injectable()
export class SyncJournalSweepHandler
  implements JobHandler<'sweep-sync-journal-bodies'>, OnModuleInit
{
  readonly jobName = 'sweep-sync-journal-bodies' as const;

  constructor(
    private readonly scheduler: SyncSchedulerService,
    private readonly registry: JobRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(
    _payload: JobPayloads['sweep-sync-journal-bodies'],
    _context: JobContext,
  ): Promise<JobResult> {
    const outcome = await this.scheduler.sweepJournalBodies();
    return { cleared: outcome.cleared, pruned: outcome.pruned };
  }
}
