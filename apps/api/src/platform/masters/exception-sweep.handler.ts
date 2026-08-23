import { Injectable, type OnModuleInit } from '@nestjs/common';
import { NOTIFICATION_EVENTS, PERMISSIONS, REPORT_DEFINITIONS } from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../db/db.provider.js';
import { JobRegistry, type JobContext, type JobHandler, type JobResult } from '../jobs/job-handler.js';
import type { JobPayloads } from '../jobs/queue.registry.js';
import { NotificationDispatcher } from '../notifications/notification.dispatcher.js';
import { AnalyticsReportSource, EXCEPTION_REPORT_KEYS } from './analytics-report.source.js';

/**
 * D-46: each morning, every org's four exception reports are counted, and
 * whoever holds `reports.exceptions.notify` (seeded: Admin and Accounts)
 * hears about the ones that are not empty. An empty sweep says nothing —
 * a daily "all clear" trains people to ignore the day it is not.
 *
 * The same pass prunes `report_usage` past twelve months (D14-6), because
 * this is the one job that already runs daily for the reports platform.
 */
@Injectable()
export class ExceptionSweepHandler implements JobHandler<'sweep-exception-reports'>, OnModuleInit {
  readonly jobName = 'sweep-exception-reports' as const;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly registry: JobRegistry,
    private readonly analytics: AnalyticsReportSource,
    private readonly notifications: NotificationDispatcher,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(payload: JobPayloads['sweep-exception-reports'], _context: JobContext): Promise<JobResult> {
    const today = (payload.now ?? new Date().toISOString()).slice(0, 10);
    const orgs = await this.db.execute<{ id: string }>(sql`SELECT id FROM organizations WHERE deleted_at IS NULL`);
    let notified = 0;
    for (const org of orgs.rows) {
      const counts = await this.analytics.exceptionCounts(org.id);
      const nonEmpty = EXCEPTION_REPORT_KEYS.filter((key) => counts[key] > 0);
      if (nonEmpty.length === 0) continue;
      const parts = nonEmpty.map((key) => `${REPORT_DEFINITIONS[key].label.toLowerCase()} ${String(counts[key])}`);
      await this.notifications.emit({
        orgId: org.id,
        type: NOTIFICATION_EVENTS.REPORTS_EXCEPTIONS_DAILY,
        audience: { kind: 'permission', key: PERMISSIONS.REPORTS_EXCEPTIONS_NOTIFY },
        payload: { date: today, summary: parts.join(', '), detail: parts.join(', '), ...counts },
        idempotencyKey: `exception-sweep-${org.id}-${today}`,
      });
      notified += 1;
    }
    const pruned = await this.db.execute(
      sql`DELETE FROM report_usage WHERE opened_at < now() - interval '12 months'`,
    );
    // Notification idempotency keys, kept far longer than any window in which
    // a second notice would still read as a repeat. They are claimed durably
    // (notification.schema.ts) rather than left to the job queue's completed
    // set, which evicts by count.
    await this.db.execute(
      sql`DELETE FROM notification_idempotency WHERE created_at < now() - interval '12 months'`,
    );
    return { organisations: orgs.rows.length, notified, usageRowsPruned: pruned.rowCount ?? 0 };
  }
}
