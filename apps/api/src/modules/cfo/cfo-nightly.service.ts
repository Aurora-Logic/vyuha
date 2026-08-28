import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ALL_PERMISSIONS, type PermissionKey } from '@vyuha/shared';

import { env } from '../../platform/common/env.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { Mailer } from '../../platform/mail/mailer.js';
import { type Principal } from '../../platform/rbac/principal.js';
import { AlertsService } from './alerts.service.js';
import { DataQualityService } from './data-quality.service.js';
import { SalesFactService } from './sales-fact.service.js';
import { TierService } from './tier.service.js';

/**
 * The CFO module's share of the nightly run, riding the receivable-snapshot
 * job so no new queue entry is needed. Per organisation, after the book is
 * photographed:
 *
 *   1. fact_sales_daily is rebuilt across the recompute window, so a
 *      backdated voucher is caught rather than trusted to a stale fact;
 *   2. every graded party's payment grade is written to history, which is
 *      what lets "migrated into D" be an event instead of a state;
 *   3. tonight's alert candidates are written as evaluations -- Q5's
 *      two-evaluation confirmation reads yesterday's;
 *   4. every data-quality check's value lands in the daily table, which is
 *      where the screen's ninety-day trend comes from;
 *   5. report schedules that are due go out, as a summary with a link --
 *      the workbook itself needs a signed-in session.
 *
 * The system principal below carries every permission: the nightly run is
 * the system reading its own organisation, not a user reading past their
 * keys, and nothing here writes an audit row under that identity.
 */

const RECOMPUTE_DAYS = 45;

const systemPrincipal = (orgId: string): Principal => ({
  userId: '00000000-0000-0000-0000-000000000000',
  orgId,
  employeeId: null,
  email: 'nightly@vyuha.internal',
  status: 'ACTIVE',
  sessionId: '00000000-0000-0000-0000-000000000000',
  roles: [],
  permissions: new Set<PermissionKey>(ALL_PERMISSIONS),
});

@Injectable()
export class CfoNightlyService {
  private readonly logger = new Logger(CfoNightlyService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly facts: SalesFactService,
    private readonly tiers: TierService,
    private readonly alerts: AlertsService,
    private readonly quality: DataQualityService,
    private readonly mailer: Mailer,
  ) {}

  async run(orgId: string, day: string): Promise<{ factRows: number; grades: number; evaluations: number; qualityRows: number; schedulesSent: number }> {
    const principal = systemPrincipal(orgId);
    const since = new Date(Date.parse(day) - RECOMPUTE_DAYS * 86_400_000).toISOString().slice(0, 10);

    let factRows = 0;
    const days = await this.db.execute<{ d: string }>(sql`
      SELECT DISTINCT voucher_date::text AS d FROM vouchers
      WHERE org_id = ${orgId} AND voucher_type IN ('Sales', 'Credit Note') AND voucher_date BETWEEN ${since} AND ${day}
      ORDER BY 1
    `);
    for (const { d } of days.rows) factRows += await this.facts.buildOrgDay(orgId, d);

    // The latest photograph on or before the day: if tonight's snapshot
    // failed and the retry is repairing it, the grades still come from the
    // freshest book there is rather than from nobody.
    const parties = await this.db.execute<{ partyId: string }>(sql`
      SELECT DISTINCT party_id AS "partyId" FROM fact_receivable_snapshot
      WHERE org_id = ${orgId} AND party_id IS NOT NULL
        AND snapshot_date = (SELECT max(snapshot_date) FROM fact_receivable_snapshot WHERE org_id = ${orgId} AND snapshot_date <= ${day})
    `);
    const grades = await this.tiers.gradesOf(orgId, parties.rows.map((r) => r.partyId));
    for (const [partyId, reading] of grades) {
      await this.db.execute(sql`
        INSERT INTO cfo_grade_history (org_id, day, party_id, grade, risk)
        VALUES (${orgId}, ${day}, ${partyId}, ${reading.grade}, ${reading.risk})
        ON CONFLICT (org_id, day, party_id) DO UPDATE SET grade = ${reading.grade}, risk = ${reading.risk}
      `);
    }

    const evaluations = await this.alerts.writeEvaluations(principal, day);
    const qualityRows = await this.writeQuality(principal, day);
    const schedulesSent = await this.sendSchedules(principal, day);
    return { factRows, grades: grades.size, evaluations, qualityRows, schedulesSent };
  }

  private async writeQuality(principal: Principal, day: string): Promise<number> {
    const report = await this.quality.read(principal);
    let n = 0;
    for (const check of report.checks) {
      await this.db.execute(sql`
        INSERT INTO cfo_data_quality_daily (org_id, day, check_key, value, health)
        VALUES (${principal.orgId}, ${day}, ${check.key}, ${check.value}, ${check.health})
        ON CONFLICT (org_id, day, check_key) DO UPDATE SET value = ${check.value}, health = ${check.health}
      `);
      n += 1;
    }
    return n;
  }

  private async sendSchedules(principal: Principal, day: string): Promise<number> {
    const weekday = new Date(Date.parse(day)).getUTCDay();
    const due = await this.db.execute<{ id: string; report: string; cadence: string; recipients: string }>(sql`
      SELECT id, report, cadence, recipients FROM cfo_report_schedules
      WHERE org_id = ${principal.orgId} AND (last_run_on IS NULL OR last_run_on < ${day})
        AND (cadence = 'daily' OR (cadence = 'weekly' AND ${weekday} = 1) OR (cadence = 'monthly' AND ${day.slice(8)} = '01'))
    `);
    let sent = 0;
    for (const schedule of due.rows) {
      const url = `${env.WEB_BASE_URL}/reports?scheduled=${schedule.report}`;
      for (const to of schedule.recipients.split(',').map((r) => r.trim()).filter(Boolean)) {
        try {
          await this.mailer.send({
            to,
            subject: `Vyuha: ${schedule.report} for ${day}`,
            body: `The scheduled ${schedule.cadence} report "${schedule.report}" is ready as of ${day}. Open Vyuha to view or export it; exports carry the standard header block and are logged.`,
            actionUrl: url,
          });
          sent += 1;
        } catch (error) {
          this.logger.error({ msg: 'Scheduled report mail failed', schedule: schedule.id, to, error });
        }
      }
      await this.db.execute(sql`UPDATE cfo_report_schedules SET last_run_on = ${day} WHERE id = ${schedule.id}`);
    }
    return sent;
  }
}
