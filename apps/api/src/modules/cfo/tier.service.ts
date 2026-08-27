import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { AppError } from '../../platform/common/errors.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { type Principal } from '../../platform/rbac/principal.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { creditGrade, type CreditGrade, type GradeReading } from './credit-grade.js';

/**
 * Customer classes (brief Part P) and the payment grade (D18) -- two
 * gradings that must never collide. The class answers "how important are
 * they to us?" and only changes when someone decides, with a reason and
 * an effective date; the grade answers "will they pay?" and the system
 * reads it from behaviour. Both are shown side by side wherever a
 * customer is named; a Class A+ with payment grade D is exactly what a
 * director needs to see at a glance.
 *
 * The class is resolved as of a date, never "current", for the same
 * reason attribution is (B4): otherwise last year's report shifts each
 * time someone re-grades.
 */

export interface TierRow {
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly colourToken: string;
  readonly creditDays: number | null;
  readonly creditLimit: string | null;
  readonly maxDiscountPct: string | null;
  readonly contactEveryDays: number | null;
  readonly servicePriority: string;
  readonly reviewEvery: string;
  readonly sortOrder: number;
  readonly assigned: number;
}

export interface TierAssignment {
  readonly tierCode: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly assignedBy: string;
  readonly reason: string;
}

export interface PartyClass {
  readonly partyId: string;
  readonly current: TierAssignment | null;
  readonly history: readonly TierAssignment[];
  readonly grade: GradeReading | null;
}

/** P3's example rows, seeded on first read so the master is never empty. */
const DEFAULT_TIERS: readonly Omit<TierRow, 'assigned'>[] = [
  { code: 'A+', label: 'Key account', description: 'Director relationship, quarterly visit', colourToken: 'fresh-1', creditDays: 45, creditLimit: '1500000.00', maxDiscountPct: '12.00', contactEveryDays: 30, servicePriority: 'Highest — dispatch same day', reviewEvery: 'Quarterly', sortOrder: 1 },
  { code: 'A', label: 'Major', description: 'Sales head relationship', colourToken: 'fresh-4', creditDays: 45, creditLimit: '800000.00', maxDiscountPct: '10.00', contactEveryDays: 45, servicePriority: 'High', reviewEvery: 'Quarterly', sortOrder: 2 },
  { code: 'B', label: 'Regular', description: 'Salesperson relationship', colourToken: 'fresh-3', creditDays: 30, creditLimit: '300000.00', maxDiscountPct: '8.00', contactEveryDays: 60, servicePriority: 'Normal', reviewEvery: 'Half-yearly', sortOrder: 3 },
  { code: 'C', label: 'Occasional', description: 'Order-driven', colourToken: 'fresh-2', creditDays: 15, creditLimit: '100000.00', maxDiscountPct: '5.00', contactEveryDays: 90, servicePriority: 'Normal', reviewEvery: 'Annually', sortOrder: 4 },
  { code: 'D', label: 'Cash', description: 'Cash and carry, no credit', colourToken: 'fresh-5', creditDays: 0, creditLimit: '0.00', maxDiscountPct: '2.00', contactEveryDays: null, servicePriority: 'Standard', reviewEvery: 'Annually', sortOrder: 5 },
];

const CODE = /^[A-E]\+?$|^[A-Z][A-Z0-9+]{0,3}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

@Injectable()
export class TierService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private async seedIfEmpty(orgId: string): Promise<void> {
    const count = await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM customer_tiers WHERE org_id = ${orgId}`);
    if ((count.rows[0]?.n ?? 0) > 0) return;
    for (const t of DEFAULT_TIERS) {
      await this.db.execute(sql`
        INSERT INTO customer_tiers (org_id, code, label, description, colour_token, credit_days, credit_limit, max_discount_pct, contact_every_days, service_priority, review_every, sort_order)
        VALUES (${orgId}, ${t.code}, ${t.label}, ${t.description}, ${t.colourToken}, ${t.creditDays}, ${t.creditLimit}::numeric, ${t.maxDiscountPct}::numeric, ${t.contactEveryDays}, ${t.servicePriority}, ${t.reviewEvery}, ${t.sortOrder})
        ON CONFLICT (org_id, code) DO NOTHING
      `);
    }
  }

  async listTiers(principal: Principal): Promise<TierRow[]> {
    await this.seedIfEmpty(principal.orgId);
    const rows = await this.db.execute<{
      code: string; label: string; description: string; colourToken: string; creditDays: number | null; creditLimit: string | null;
      maxDiscountPct: string | null; contactEveryDays: number | null; servicePriority: string; reviewEvery: string; sortOrder: number; assigned: number;
    }>(sql`
      SELECT t.code, t.label, t.description, t.colour_token AS "colourToken", t.credit_days AS "creditDays",
             t.credit_limit::text AS "creditLimit", t.max_discount_pct::text AS "maxDiscountPct",
             t.contact_every_days AS "contactEveryDays", t.service_priority AS "servicePriority", t.review_every AS "reviewEvery",
             t.sort_order AS "sortOrder",
             (SELECT count(*)::int FROM customer_tier_assignments a
               WHERE a.org_id = t.org_id AND a.tier_code = t.code AND a.effective_to IS NULL) AS assigned
      FROM customer_tiers t WHERE t.org_id = ${principal.orgId} ORDER BY t.sort_order, t.code
    `);
    return rows.rows;
  }

  async saveTier(principal: Principal, row: Omit<TierRow, 'assigned'>): Promise<void> {
    if (!CODE.test(row.code)) throw AppError.validation('A class code is a short upper-case mark like A+ or B.');
    const before = await this.db.execute<{ label: string }>(sql`SELECT label FROM customer_tiers WHERE org_id = ${principal.orgId} AND code = ${row.code}`);
    await this.db.execute(sql`
      INSERT INTO customer_tiers (org_id, code, label, description, colour_token, credit_days, credit_limit, max_discount_pct, contact_every_days, service_priority, review_every, sort_order)
      VALUES (${principal.orgId}, ${row.code}, ${row.label}, ${row.description}, ${row.colourToken}, ${row.creditDays}, ${row.creditLimit}::numeric, ${row.maxDiscountPct}::numeric, ${row.contactEveryDays}, ${row.servicePriority}, ${row.reviewEvery}, ${row.sortOrder})
      ON CONFLICT (org_id, code) DO UPDATE SET
        label = EXCLUDED.label, description = EXCLUDED.description, colour_token = EXCLUDED.colour_token,
        credit_days = EXCLUDED.credit_days, credit_limit = EXCLUDED.credit_limit, max_discount_pct = EXCLUDED.max_discount_pct,
        contact_every_days = EXCLUDED.contact_every_days, service_priority = EXCLUDED.service_priority,
        review_every = EXCLUDED.review_every, sort_order = EXCLUDED.sort_order, updated_at = now()
    `);
    await this.audit.write({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: before.rows[0] === undefined ? 'cfo.tier.created' : 'cfo.tier.updated',
      entityType: 'customer_tier',
      entityId: row.code,
      before: before.rows[0] ?? null,
      after: { code: row.code, label: row.label },
    });
  }

  /** P3: never deleted while customers are assigned -- reassign first. */
  async deleteTier(principal: Principal, code: string): Promise<void> {
    const assigned = await this.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM customer_tier_assignments WHERE org_id = ${principal.orgId} AND tier_code = ${code} AND effective_to IS NULL
    `);
    if ((assigned.rows[0]?.n ?? 0) > 0) {
      throw AppError.conflict(`${String(assigned.rows[0]?.n)} customers are class ${code}; reassign them first.`);
    }
    const gone = await this.db.execute<{ code: string }>(sql`
      DELETE FROM customer_tiers WHERE org_id = ${principal.orgId} AND code = ${code} RETURNING code
    `);
    if (gone.rows[0] === undefined) throw AppError.notFound('customer class', code);
    await this.audit.write({ orgId: principal.orgId, actorUserId: principal.userId, action: 'cfo.tier.deleted', entityType: 'customer_tier', entityId: code, before: { code }, after: null });
  }

  /** P4: a class change is a new dated row; history is never rewritten. */
  async assign(principal: Principal, partyId: string, tierCode: string, reason: string, effectiveFrom: string): Promise<void> {
    if (reason.trim() === '') throw AppError.validation('A class change needs a reason.');
    if (!DATE.test(effectiveFrom)) throw AppError.validation('The effective date is YYYY-MM-DD.');
    const tier = await this.db.execute<{ code: string }>(sql`SELECT code FROM customer_tiers WHERE org_id = ${principal.orgId} AND code = ${tierCode}`);
    if (tier.rows[0] === undefined) throw AppError.notFound('customer class', tierCode);
    const party = await this.db.execute<{ id: string }>(sql`SELECT id FROM parties WHERE org_id = ${principal.orgId} AND id = ${partyId}`);
    if (party.rows[0] === undefined) throw AppError.notFound('party', partyId);
    const current = await this.db.execute<{ tierCode: string; effectiveFrom: string }>(sql`
      SELECT tier_code AS "tierCode", effective_from AS "effectiveFrom" FROM customer_tier_assignments
      WHERE org_id = ${principal.orgId} AND party_id = ${partyId} AND effective_to IS NULL
      ORDER BY effective_from DESC LIMIT 1
    `);
    const open = current.rows[0];
    if (open !== undefined && effectiveFrom <= open.effectiveFrom) {
      throw AppError.validation(`The current class started ${open.effectiveFrom}; a change takes effect after it -- history is never rewritten.`);
    }
    if (open?.tierCode === tierCode) throw AppError.conflict(`Already class ${tierCode}.`);
    const dayBefore = new Date(Date.parse(effectiveFrom) - 86_400_000).toISOString().slice(0, 10);
    await this.db.execute(sql`
      UPDATE customer_tier_assignments SET effective_to = ${dayBefore}
      WHERE org_id = ${principal.orgId} AND party_id = ${partyId} AND effective_to IS NULL
    `);
    await this.db.execute(sql`
      INSERT INTO customer_tier_assignments (org_id, party_id, tier_code, effective_from, assigned_by, reason)
      VALUES (${principal.orgId}, ${partyId}, ${tierCode}, ${effectiveFrom}, ${principal.userId}, ${reason.trim()})
    `);
    await this.audit.write({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'cfo.tier.assigned',
      entityType: 'party',
      entityId: partyId,
      before: open === undefined ? null : { tierCode: open.tierCode },
      after: { tierCode, effectiveFrom, reason: reason.trim() },
    });
  }

  /** The class as of a date, for every party asked about; absent means unclassed. */
  async classAsOf(orgId: string, partyIds: readonly string[], asOf: string): Promise<Map<string, string>> {
    if (partyIds.length === 0) return new Map();
    const rows = await this.db.execute<{ partyId: string; tierCode: string }>(sql`
      SELECT party_id AS "partyId", tier_code AS "tierCode" FROM customer_tier_assignments
      WHERE org_id = ${orgId} AND party_id IN ${[...partyIds]} AND effective_from <= ${asOf}
        AND (effective_to IS NULL OR effective_to >= ${asOf})
    `);
    return new Map(rows.rows.map((r) => [r.partyId, r.tierCode]));
  }

  async partyClass(principal: Principal, partyId: string): Promise<PartyClass> {
    const history = await this.db.execute<{ tierCode: string; effectiveFrom: string; effectiveTo: string | null; assignedBy: string; reason: string }>(sql`
      SELECT a.tier_code AS "tierCode", a.effective_from AS "effectiveFrom", a.effective_to AS "effectiveTo",
             coalesce(split_part(u.email, '@', 1), 'Former user') AS "assignedBy", a.reason
      FROM customer_tier_assignments a LEFT JOIN users u ON u.id = a.assigned_by
      WHERE a.org_id = ${principal.orgId} AND a.party_id = ${partyId}
      ORDER BY a.effective_from DESC
    `);
    const grades = await this.gradesOf(principal.orgId, [partyId]);
    return {
      partyId,
      current: history.rows.find((h) => h.effectiveTo === null) ?? null,
      history: history.rows,
      grade: grades.get(partyId) ?? null,
    };
  }

  /** D18 for a set of parties, from the latest book, the promise log and the order rhythm. */
  async gradesOf(orgId: string, partyIds: readonly string[]): Promise<Map<string, GradeReading>> {
    if (partyIds.length === 0) return new Map();
    const today = istDateOf(new Date().toISOString());
    const ids = [...partyIds];
    const book = await this.db.execute<{ partyId: string; outstanding: string; overdue: string; lateDays: string | null; creditLimit: string | null }>(sql`
      WITH latest AS (SELECT max(snapshot_date) AS d FROM fact_receivable_snapshot WHERE org_id = ${orgId})
      SELECT f.party_id AS "partyId", sum(f.outstanding)::text AS outstanding,
             sum(CASE WHEN f.bucket <> 'current' THEN f.outstanding ELSE 0 END)::text AS overdue,
             (sum(f.days_overdue * f.outstanding) FILTER (WHERE f.bucket <> 'current') / nullif(sum(f.outstanding) FILTER (WHERE f.bucket <> 'current'), 0))::text AS "lateDays",
             max(p.credit_limit)::text AS "creditLimit"
      FROM fact_receivable_snapshot f LEFT JOIN parties p ON p.id = f.party_id, latest
      WHERE f.org_id = ${orgId} AND f.snapshot_date = latest.d AND f.party_id IN ${ids}
      GROUP BY 1
    `);
    const promises = await this.db.execute<{ partyId: string; made: number; broken: number }>(sql`
      SELECT party_id AS "partyId", count(*)::int AS made, count(*) FILTER (WHERE state = 'broken')::int AS broken
      FROM promises_to_pay WHERE org_id = ${orgId} AND deleted_at IS NULL AND party_id IN ${ids} GROUP BY 1
    `);
    const disputes = await this.db.execute<{ partyId: string; n: number }>(sql`
      SELECT party_id AS "partyId", count(*)::int AS n FROM cfo_desk_outcomes
      WHERE org_id = ${orgId} AND outcome = 'DISPUTE_RAISED' AND party_id IN ${ids} AND logged_on::date > (${today}::date - 365)
      GROUP BY 1
    `);
    const orders = await this.db.execute<{ partyId: string; days: string[] }>(sql`
      SELECT party_id AS "partyId", array_agg(voucher_date::text ORDER BY voucher_date) AS days
      FROM vouchers WHERE org_id = ${orgId} AND voucher_type = 'Sales' AND is_cancelled = false
        AND party_id IN ${ids} AND voucher_date > (${today}::date - 365)
      GROUP BY 1
    `);
    const bookOf = new Map(book.rows.map((r) => [r.partyId, r]));
    const promiseOf = new Map(promises.rows.map((r) => [r.partyId, r]));
    const disputeOf = new Map(disputes.rows.map((r) => [r.partyId, r.n]));
    const gapRatioOf = new Map<string, number>();
    const gap = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    for (const row of orders.rows) {
      const d = row.days;
      if (d.length < 5) continue;
      const gaps = d.slice(1).map((x, i) => gap(d[i] ?? x, x));
      const sorted = [...gaps].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const recent = gaps.slice(-3);
      const recentAvg = recent.reduce((a, b) => a + b, 0) / Math.max(recent.length, 1);
      if (median > 0) gapRatioOf.set(row.partyId, recentAvg / median);
    }
    const out = new Map<string, GradeReading>();
    for (const id of ids) {
      const b = bookOf.get(id);
      const p = promiseOf.get(id);
      const outstanding = Number(b?.outstanding ?? 0);
      const limit = Number(b?.creditLimit ?? 0);
      out.set(id, creditGrade({
        avgDaysLate: Number(b?.lateDays ?? 0),
        brokenPromiseRate: p === undefined || p.made === 0 ? 0 : p.broken / p.made,
        overdueShare: outstanding === 0 ? 0 : Number(b?.overdue ?? 0) / outstanding,
        utilisationPct: limit > 0 ? (outstanding / limit) * 100 : 0,
        gapRatio: gapRatioOf.get(id) ?? 1,
        disputes: disputeOf.get(id) ?? 0,
      }));
    }
    return out;
  }

  /** Q2.2: class x payment grade -- the A+ / D cell is the concentrated risk in one number. */
  async classGradeGrid(principal: Principal): Promise<{
    classes: readonly string[];
    grades: readonly CreditGrade[];
    unclassed: { count: number; amount: string };
    cells: readonly { tierCode: string; grade: CreditGrade; count: number; amount: string; parties: readonly { partyId: string; party: string; outstanding: string }[] }[];
  }> {
    const today = istDateOf(new Date().toISOString());
    const tiers = await this.listTiers(principal);
    const book = await this.db.execute<{ partyId: string; party: string; outstanding: string }>(sql`
      WITH latest AS (SELECT max(snapshot_date) AS d FROM fact_receivable_snapshot WHERE org_id = ${principal.orgId})
      SELECT f.party_id AS "partyId", coalesce(p.name, 'Unknown party') AS party, sum(f.outstanding)::numeric(16,2)::text AS outstanding
      FROM fact_receivable_snapshot f LEFT JOIN parties p ON p.id = f.party_id, latest
      WHERE f.org_id = ${principal.orgId} AND f.snapshot_date = latest.d AND f.party_id IS NOT NULL
      GROUP BY 1, 2
    `);
    const ids = book.rows.map((r) => r.partyId);
    const [classes, grades] = await Promise.all([this.classAsOf(principal.orgId, ids, today), this.gradesOf(principal.orgId, ids)]);
    const GRADES: CreditGrade[] = ['A', 'B', 'C', 'D', 'E'];
    const cells = tiers.flatMap((t) =>
      GRADES.map((g) => {
        const members = book.rows.filter((r) => classes.get(r.partyId) === t.code && grades.get(r.partyId)?.grade === g);
        return {
          tierCode: t.code,
          grade: g,
          count: members.length,
          amount: members.reduce((sum, m) => sum + Number(m.outstanding), 0).toFixed(2),
          parties: members.sort((a, b) => Number(b.outstanding) - Number(a.outstanding)).slice(0, 50),
        };
      }),
    );
    const unclassed = book.rows.filter((r) => !classes.has(r.partyId));
    return {
      classes: tiers.map((t) => t.code),
      grades: GRADES,
      unclassed: { count: unclassed.length, amount: unclassed.reduce((sum, m) => sum + Number(m.outstanding), 0).toFixed(2) },
      cells,
    };
  }
}
