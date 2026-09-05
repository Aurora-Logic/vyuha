import { Injectable, type OnModuleInit } from '@nestjs/common';

import { JobRegistry, type JobContext, type JobHandler, type JobResult } from '../jobs/job-handler.js';
import type { JobPayloads } from '../jobs/queue.registry.js';
import { ApprovalService } from './approval.service.js';

/** Recovers post-commit approval work from its database outbox. */
@Injectable()
export class SettleApprovalOutboxHandler
  implements JobHandler<'settle-approval-outbox'>, OnModuleInit
{
  readonly jobName = 'settle-approval-outbox' as const;

  constructor(
    private readonly approvals: ApprovalService,
    private readonly registry: JobRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  run(
    _payload: JobPayloads['settle-approval-outbox'],
    _context: JobContext,
  ): Promise<JobResult> {
    return this.approvals.drainSettlementOutbox();
  }
}
