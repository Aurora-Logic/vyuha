import { Injectable, type OnModuleInit } from '@nestjs/common';
import { NOTIFICATION_EVENTS, PERMISSIONS } from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../db/db.provider.js';
import { JobRegistry, type JobContext, type JobHandler, type JobResult } from '../jobs/job-handler.js';
import type { JobPayloads } from '../jobs/queue.registry.js';
import { NotificationDispatcher } from '../notifications/notification.dispatcher.js';
import { CollectionsService } from './collections.service.js';

/**
 * REQ-AJ-09 / D-38: each morning every promise still open is re-read
 * against the receipts Tally has sent since it was taken, and the ones
 * that came due with nothing -- or not enough -- against them are named
 * to whoever holds a collections view key.
 *
 * The evaluation is the point, not the notice: it is what makes the
 * dashboard, the reports and the credit flag agree without any of them
 * recomputing. An organisation with nothing broken hears nothing, for the
 * same reason the exception sweep is silent on a clean morning.
 */
@Injectable()
export class BrokenPromiseSweepHandler implements JobHandler<'sweep-broken-promises'>, OnModuleInit {
  readonly jobName = 'sweep-broken-promises' as const;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly registry: JobRegistry,
    private readonly collections: CollectionsService,
    private readonly notifications: NotificationDispatcher,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(payload: JobPayloads['sweep-broken-promises'], _context: JobContext): Promise<JobResult> {
    const today = (payload.now ?? new Date().toISOString()).slice(0, 10);
    const orgs = await this.db.execute<{ id: string }>(sql`SELECT id FROM organizations WHERE deleted_at IS NULL`);
    let evaluated = 0;
    let notified = 0;
    for (const org of orgs.rows) {
      const outcome = await this.collections.evaluateAll(org.id);
      evaluated += outcome.evaluated;
      if (outcome.broken === 0) continue;
      const worst = await this.db.execute<{ party_name: string; shortfall: string; total: string; parties: number }>(sql`
        SELECT max(pa.name) AS party_name,
               max(round(p.amount - p.received_amount, 2))::text AS shortfall,
               sum(round(p.amount - p.received_amount, 2))::text AS total,
               count(DISTINCT p.party_id)::int AS parties
          FROM promises_to_pay p JOIN parties pa ON pa.id = p.party_id
         WHERE p.org_id = ${org.id} AND p.deleted_at IS NULL AND p.state IN ('broken', 'partially_kept') AND p.promised_date < ${today}::date
      `);
      const row = worst.rows[0];
      const shortfall = Number(row?.total ?? 0).toFixed(2);
      const parties = row?.parties ?? 0;
      await this.notifications.emit({
        orgId: org.id,
        type: NOTIFICATION_EVENTS.COLLECTIONS_PROMISES_BROKEN,
        audience: { kind: 'permission', key: PERMISSIONS.COLLECTIONS_VIEW_ALL },
        payload: {
          date: today,
          summary: `${String(outcome.broken)} promise${outcome.broken === 1 ? '' : 's'}`,
          detail: `${String(outcome.broken)} promise${outcome.broken === 1 ? '' : 's'} from ${String(parties)} customer${parties === 1 ? '' : 's'} came due with ${shortfall} still to arrive`,
          broken: outcome.broken,
          shortfall,
        },
        idempotencyKey: `broken-promises-${org.id}-${today}`,
      });
      notified += 1;
    }
    return { organisations: orgs.rows.length, promisesEvaluated: evaluated, organisationsNotified: notified };
  }
}
