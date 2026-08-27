import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PERMISSIONS } from '@vyuha/shared';

import { AppError } from '../../platform/common/errors.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { hasPermission, type Principal } from '../../platform/rbac/principal.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { CreditControlService } from './credit-control.service.js';
import { TierService } from './tier.service.js';

/**
 * Alerts (brief Part L defaults, Part Q5 discipline). Robust alerting is
 * mostly about NOT firing: a minimum value floor, one alert per customer
 * per day carrying every reason, a daily cap of ten ranked by rupees with
 * the rest rolled into a digest line, and snoozes with a reason and a
 * date. Every alert states what, how much, since when, why it fired, and
 * one action. Evaluated on read today; the two-evaluation confirmation
 * and the three-day escalation need the nightly job's memory and say so.
 */

export interface AlertReason {
  readonly key: string;
  readonly label: string;
  readonly why: string;
  readonly amount: string;
  /** Fires immediately (limit breach) rather than after confirmation. */
  readonly immediate: boolean;
}

export interface Alert {
  readonly partyId: string | null;
  readonly subject: string;
  readonly exposure: string;
  readonly since: string | null;
  readonly reasons: readonly AlertReason[];
  readonly action: string;
  readonly snoozed: { until: string; reason: string } | null;
}

export interface Alerts {
  readonly asOf: string;
  readonly alerts: readonly Alert[];
  readonly digest: { count: number; exposure: string };
  readonly companyAlerts: readonly AlertReason[];
  readonly cap: number;
}

const DAILY_CAP = 10;
const MATERIALITY = 25_000;
const DSO_UP_DAYS = 5;
const CEI_DOWN_POINTS = 5;
const ADD_UP_DAYS = 3;
const CONCENTRATION_UP_POINTS = 5;

const shiftDays = (day: string, n: number): string => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);

@Injectable()
export class AlertsService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly credit: CreditControlService,
    private readonly tiers: TierService,
  ) {}

  async list(principal: Principal): Promise<Alerts> {
    const today = istDateOf(new Date().toISOString());
    const lists = await this.credit.workLists(principal);
    const listRows = (key: string) => lists.lists.find((l) => l.key === key)?.rows ?? [];

    // Customer-level reasons, gathered per party (Q5: one alert per customer per day).
    const byParty = new Map<string, { subject: string; reasons: AlertReason[]; since: string | null }>();
    const add = (partyId: string | null, subject: string, reason: AlertReason, since: string | null) => {
      if (partyId === null) return;
      const entry = byParty.get(partyId) ?? { subject, reasons: [], since: null };
      entry.reasons.push(reason);
      if (since !== null && (entry.since === null || since < entry.since)) entry.since = since;
      byParty.set(partyId, entry);
    };

    for (const r of listRows('limit-breach')) {
      add(r.partyId, r.party, { key: 'limit-breach', label: 'Credit limit breach', why: r.reason, amount: r.amount, immediate: true }, r.oldestBill ?? null);
    }
    // Top-10 customer down more than 20% on last year: the declining list already
    // applies the 20% and the floor; top-10 is by last year's money.
    const declining = listRows('declining');
    const topTen = [...declining].sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 10);
    for (const r of topTen) {
      add(r.partyId, r.party, { key: 'top-customer-down', label: 'Top customer down', why: r.reason, amount: r.amount, immediate: false }, null);
    }
    for (const r of listRows('silent-churn')) {
      if (Number(r.amount) < MATERIALITY) continue;
      add(r.partyId, r.party, { key: 'silent-churn', label: 'Silent churn', why: r.reason, amount: r.amount, immediate: false }, null);
    }
    // Payment grade at D or E: the state today; migration needs the nightly history.
    const overdueParties = listRows('overdue-31-60').concat(listRows('overdue-61-90'), listRows('overdue-90-plus'));
    const gradeIds = [...new Set(overdueParties.map((r) => r.partyId).filter((id): id is string => id !== null))];
    const grades = await this.tiers.gradesOf(principal.orgId, gradeIds);
    for (const r of overdueParties) {
      const g = r.partyId === null ? undefined : grades.get(r.partyId);
      if (g === undefined || (g.grade !== 'D' && g.grade !== 'E')) continue;
      if (Number(r.amount) < MATERIALITY) continue;
      add(r.partyId, r.party, { key: 'grade-d-e', label: `Payment grade ${g.grade}`, why: `Risk ${String(g.risk)} of 100 with ${r.reason}`, amount: r.amount, immediate: false }, r.oldestBill ?? null);
    }

    // Company-level reasons: DSO, CEI, ADD against ninety days ago; concentration against last year.
    const companyAlerts: AlertReason[] = [];
    if (hasPermission(principal, PERMISSIONS.CFO_RECEIVABLES_VIEW)) {
      const now = await this.credit.receivables(principal, shiftDays(today, -30), today);
      const before = await this.credit.receivables(principal, shiftDays(today, -120), shiftDays(today, -90));
      if (now.dsoCountback !== null && before.dsoCountback !== null && now.dsoCountback - before.dsoCountback > DSO_UP_DAYS) {
        companyAlerts.push({ key: 'dso-up', label: 'DSO up', why: `${String(now.dsoCountback)} days against ${String(before.dsoCountback)} ninety days ago`, amount: now.overdue, immediate: false });
      }
      if (now.cei !== null && before.cei !== null && before.cei - now.cei > CEI_DOWN_POINTS) {
        companyAlerts.push({ key: 'cei-down', label: 'Collection effectiveness down', why: `${String(Math.round(now.cei))} against ${String(Math.round(before.cei))} ninety days ago`, amount: now.overdue, immediate: false });
      }
      if (now.addDays !== null && before.addDays !== null && now.addDays - before.addDays > ADD_UP_DAYS) {
        companyAlerts.push({ key: 'add-up', label: 'Days late up', why: `${String(now.addDays)} days late against ${String(before.addDays)}`, amount: now.overdue, immediate: false });
      }
    }
    const concentration = await this.db.execute<{ share: string | null; shareLy: string | null; top: string | null }>(sql`
      WITH ty AS (
        SELECT party_id, sum(net) AS net FROM fact_sales_daily
        WHERE org_id = ${principal.orgId} AND date BETWEEN ${shiftDays(today, -365)} AND ${today} AND party_id IS NOT NULL GROUP BY 1
      ), ly AS (
        SELECT party_id, sum(net) AS net FROM fact_sales_daily
        WHERE org_id = ${principal.orgId} AND date BETWEEN ${shiftDays(today, -730)} AND ${shiftDays(today, -366)} AND party_id IS NOT NULL GROUP BY 1
      )
      SELECT ((SELECT sum(net) FROM (SELECT net FROM ty ORDER BY net DESC LIMIT 5) t) / nullif((SELECT sum(net) FROM ty), 0) * 100)::numeric(5,1)::text AS share,
             ((SELECT sum(net) FROM (SELECT net FROM ly ORDER BY net DESC LIMIT 5) t) / nullif((SELECT sum(net) FROM ly), 0) * 100)::numeric(5,1)::text AS "shareLy",
             (SELECT sum(net) FROM (SELECT net FROM ty ORDER BY net DESC LIMIT 5) t)::numeric(16,2)::text AS top
    `);
    const c = concentration.rows[0];
    if (c?.share && c.shareLy && Number(c.share) - Number(c.shareLy) > CONCENTRATION_UP_POINTS) {
      companyAlerts.push({ key: 'concentration-up', label: 'Concentration rising', why: `Top five customers are ${c.share}% of sales against ${c.shareLy}% last year`, amount: c.top ?? '0.00', immediate: false });
    }

    // Snoozes, then the cap.
    const snoozes = await this.db.execute<{ alertKey: string; partyId: string | null; until: string; reason: string }>(sql`
      SELECT alert_key AS "alertKey", party_id AS "partyId", until, reason FROM cfo_alert_snoozes
      WHERE org_id = ${principal.orgId} AND until >= ${today}
    `);
    const snoozeOf = (key: string, partyId: string | null) => snoozes.rows.find((s) => s.alertKey === key && s.partyId === partyId) ?? null;

    const alerts: Alert[] = [...byParty.entries()].map(([partyId, entry]) => {
      const exposure = Math.max(...entry.reasons.map((r) => Number(r.amount)), 0);
      const loudest = [...entry.reasons].sort((a, b) => Number(b.amount) - Number(a.amount))[0];
      const snooze = snoozeOf('customer', partyId);
      return {
        partyId,
        subject: entry.subject,
        exposure: exposure.toFixed(2),
        since: entry.since,
        reasons: entry.reasons,
        action: loudest?.key === 'limit-breach' ? 'Hold new confirmations until released' : loudest?.key === 'silent-churn' ? 'Call today; reopen the line' : loudest?.key === 'grade-d-e' ? 'Escalate the collection' : 'Owner calls this week',
        snoozed: snooze === null ? null : { until: snooze.until, reason: snooze.reason },
      };
    });
    const live = alerts.filter((a) => a.snoozed === null).sort((a, b) => Number(b.exposure) - Number(a.exposure));
    const shown = live.slice(0, DAILY_CAP);
    const rest = live.slice(DAILY_CAP);
    return {
      asOf: today,
      alerts: [...shown, ...alerts.filter((a) => a.snoozed !== null)],
      digest: { count: rest.length, exposure: rest.reduce((sum, a) => sum + Number(a.exposure), 0).toFixed(2) },
      companyAlerts: companyAlerts.filter((a) => snoozeOf(a.key, null) === null),
      cap: DAILY_CAP,
    };
  }

  async snooze(principal: Principal, alertKey: string, partyId: string | null, until: string, reason: string): Promise<void> {
    if (reason.trim() === '') throw AppError.validation('A snooze needs a reason.');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(until)) throw AppError.validation('The snooze date is YYYY-MM-DD.');
    await this.db.execute(sql`
      INSERT INTO cfo_alert_snoozes (org_id, alert_key, party_id, until, reason, snoozed_by)
      VALUES (${principal.orgId}, ${alertKey}, ${partyId}, ${until}, ${reason.trim()}, ${principal.userId})
    `);
    await this.audit.write({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'cfo.alert.snoozed',
      entityType: 'cfo_alert',
      entityId: partyId ?? alertKey,
      before: null,
      after: { alertKey, partyId, until, reason: reason.trim() },
    });
  }
}
