import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { JobRegistry, type JobContext, type JobHandler, type JobResult } from '../../platform/jobs/job-handler.js';
import type { JobPayloads } from '../../platform/jobs/queue.registry.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { CfoNightlyService } from './cfo-nightly.service.js';
import { ReceivableSnapshotService } from './receivable-snapshot.service.js';

/**
 * D-23: the nightly photograph of every organisation's open receivable
 * book. `now`, when present, comes from a test or a repair, never from the
 * deployment; the scheduled occurrence carries `requestedAt`, its own
 * creation time, which the runner keeps honest (see scheduled-clock.test.ts
 * for the failure that rule exists to prevent). The occurrence's clock
 * beats this process's, deliberately: a retry that limps past IST midnight
 * must still photograph the day its occurrence woke for, or that day is
 * silently never written — and this is the table that cannot be rebuilt.
 * The snapshot day is the IST calendar date of that instant: the book's day
 * boundary is IST midnight, not UTC's, because that is the day the business
 * closes — and it is the same `istDateOf` the interest build keys by, so
 * the two nightly photographs can never file one night under two dates.
 */
@Injectable()
export class ReceivableSnapshotHandler implements JobHandler<'snapshot-receivables'>, OnModuleInit {
  readonly jobName = 'snapshot-receivables' as const;
  private readonly logger = new Logger(ReceivableSnapshotHandler.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly registry: JobRegistry,
    private readonly builder: ReceivableSnapshotService,
    private readonly nightly: CfoNightlyService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(payload: JobPayloads['snapshot-receivables'], _context: JobContext): Promise<JobResult> {
    const snapshotDate = istDateOf(payload.now ?? payload.requestedAt ?? new Date().toISOString());
    const orgIds =
      payload.orgId !== undefined
        ? [payload.orgId]
        : (await this.db.execute<{ id: string }>(sql`SELECT id FROM organizations WHERE deleted_at IS NULL`)).rows.map((row) => row.id);

    // One poisoned organisation must not cost every other its page of
    // irreplaceable history: finish the sweep, then fail the job so the
    // retry repairs the losers — a rebuilt day replaces, never doubles.
    let rows = 0;
    const failed: string[] = [];
    for (const orgId of orgIds) {
      try {
        rows += await this.builder.buildOrgDay(orgId, snapshotDate);
        // The CFO nightly rides the same occurrence: facts, grades, alert
        // evaluations, quality history and due schedules for this org-day.
        const cfo = await this.nightly.run(orgId, snapshotDate);
        this.logger.log({ msg: 'CFO nightly done', orgId, snapshotDate, ...cfo });
      } catch (error) {
        this.logger.error({ msg: 'Receivable snapshot failed for organisation', orgId, snapshotDate, error });
        failed.push(orgId);
      }
    }
    if (failed.length > 0) {
      throw new Error(
        `Receivable snapshot for ${snapshotDate} failed for ${String(failed.length)} of ${String(orgIds.length)} organisations: ${failed.join(', ')}`,
      );
    }
    return { organisations: orgIds.length, rows, snapshotDate };
  }
}
