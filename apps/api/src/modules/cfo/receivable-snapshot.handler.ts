import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { JobRegistry, type JobContext, type JobHandler, type JobResult } from '../../platform/jobs/job-handler.js';
import type { JobPayloads } from '../../platform/jobs/queue.registry.js';
import { istDateOf } from './cfo-math.js';
import { ReceivableSnapshotService } from './receivable-snapshot.service.js';

/**
 * D-23: the nightly photograph of every organisation's open receivable
 * book. `now`, when present, comes from a test or a repair, never from the
 * deployment — the scheduled payload carries no clock, and this handler
 * reads its own when the payload has none (see scheduled-clock.test.ts for
 * the failure that rule exists to prevent). The snapshot day is the IST
 * calendar date of that instant: the book's day boundary is IST midnight,
 * not UTC's, because that is the day the business closes.
 */
@Injectable()
export class ReceivableSnapshotHandler implements JobHandler<'snapshot-receivables'>, OnModuleInit {
  readonly jobName = 'snapshot-receivables' as const;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly registry: JobRegistry,
    private readonly builder: ReceivableSnapshotService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(payload: JobPayloads['snapshot-receivables'], _context: JobContext): Promise<JobResult> {
    const snapshotDate = istDateOf(payload.now ?? new Date().toISOString());
    const orgIds =
      payload.orgId !== undefined
        ? [payload.orgId]
        : (await this.db.execute<{ id: string }>(sql`SELECT id FROM organizations WHERE deleted_at IS NULL`)).rows.map((row) => row.id);

    let organisations = 0;
    let rows = 0;
    for (const orgId of orgIds) {
      rows += await this.builder.buildOrgDay(orgId, snapshotDate);
      organisations += 1;
    }
    return { organisations, rows, snapshotDate };
  }
}
