import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { JobRegistry, type JobContext, type JobHandler, type JobResult } from '../../platform/jobs/job-handler.js';
import type { JobPayloads } from '../../platform/jobs/queue.registry.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { InterestBuildService } from './interest-build.service.js';

/**
 * D-22: the nightly walk of the daily closing series, and the vehicle the
 * recompute endpoint rides. The payload's date, when present, comes from
 * the occurrence, never from the deployment — the runner rewrites a
 * scheduled job's `requestedAt`, and this handler reads its own clock only
 * when the payload carries neither (see scheduled-clock.test.ts for the
 * failure that rule exists to prevent). "Today" is the IST calendar date of
 * that instant — the same `istDateOf` the receivable snapshot (D-23) keys
 * by, so the two nightly photographs of the same books can never file one
 * night under two dates.
 */
@Injectable()
export class InterestSnapshotHandler implements JobHandler<'build-interest-snapshots'>, OnModuleInit {
  readonly jobName = 'build-interest-snapshots' as const;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly registry: JobRegistry,
    private readonly builder: InterestBuildService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(payload: JobPayloads['build-interest-snapshots'], _context: JobContext): Promise<JobResult> {
    const today = istDateOf(payload.now ?? payload.requestedAt ?? new Date().toISOString());
    const scope = {
      today,
      ...(payload.from === undefined ? {} : { from: payload.from }),
      ...(payload.partyId === undefined ? {} : { partyId: payload.partyId }),
      ...(payload.stockItemId === undefined ? {} : { stockItemId: payload.stockItemId }),
    };

    const orgIds =
      payload.orgId !== undefined
        ? [payload.orgId]
        : (await this.db.execute<{ id: string }>(sql`SELECT id FROM organizations WHERE deleted_at IS NULL`)).rows.map((row) => row.id);

    let organisations = 0;
    let partyRows = 0;
    let stockRows = 0;
    for (const orgId of orgIds) {
      const outcome = await this.builder.buildOrg(orgId, scope);
      if (outcome === null) continue;
      organisations += 1;
      partyRows += outcome.partyRows;
      stockRows += outcome.stockRows;
    }
    return { organisations, partyRows, stockRows };
  }
}
