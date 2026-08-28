import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { AppError } from '../../platform/common/errors.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { type Principal } from '../../platform/rbac/principal.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { creditGrade, type CreditGrade, type GradeReading } from './credit-grade.js';
import { normaliseName, parseClassImport } from './tier-import.js';

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

export interface BulkAssignResult {
  readonly applied: number;
  readonly skipped: readonly { partyId: string; party: string; reason: string }[];
}

export interface ImportRow {
  readonly line: number;
  readonly party: string;
  readonly partyId: string | null;
  readonly tierCode: string | null;
  readonly from: string | null;
  readonly status: 'change' | 'unchanged' | 'unknown-party' | 'ambiguous-party' | 'unknown-class' | 'applied' | 'failed';
  readonly note: string;
}

export interface MismatchRow {
  readonly partyId: string;
  readonly party: string;
  readonly current: string | null;
  readonly suggested: string;
  readonly direction: 'under' | 'over';
  readonly netTY: string;
  readonly growthPct: number | null;
  readonly why: string;
}

export interface NeglectedRow {
  readonly partyId: string;
  readonly party: string;
  readonly tierCode: string;
  readonly contactEveryDays: number;
  readonly lastTouch: string | null;
  readonly daysSince: number;
  readonly ownerLabel: string;
  readonly outstanding: string;
}

/**
 * P5's suggestion bands: customers sorted by trailing-year revenue, the
 * ones composing the first half of it suggested into the top class, and
 * so on down. Cumulative share, not head-count deciles, because a
 * distributor's book is skewed -- the top decile by count would promote
 * three times as many customers as actually matter.
 */
const SUGGESTION_BANDS = [0.5, 0.8, 0.95, 0.99] as const;

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
    // Same class first: "already there" is the truthful answer even when the
    // proposed date would also have been refused.
    if (open?.tierCode === tierCode) throw AppError.conflict(`Already class ${tierCode}.`);
    if (open !== undefined && effectiveFrom <= open.effectiveFrom) {
      throw AppError.validation(`The current class started ${open.effectiveFrom}; a change takes effect after it -- history is never rewritten.`);
    }
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

  /** P4 bulk: one decision, one reason, many customers; each row still audited alone. */
  async bulkAssign(principal: Principal, partyIds: readonly string[], tierCode: string, reason: string, effectiveFrom: string): Promise<BulkAssignResult> {
    const unique = [...new Set(partyIds)];
    const names = await this.db.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM parties WHERE org_id = ${principal.orgId} AND id IN ${unique}
    `);
    const nameOf = new Map(names.rows.map((r) => [r.id, r.name]));
    let applied = 0;
    const skipped: { partyId: string; party: string; reason: string }[] = [];
    for (const partyId of unique) {
      try {
        await this.assign(principal, partyId, tierCode, reason, effectiveFrom);
        applied += 1;
      } catch (error) {
        if (error instanceof AppError) {
          skipped.push({ partyId, party: nameOf.get(partyId) ?? partyId, reason: error.message });
        } else {
          throw error;
        }
      }
    }
    return { applied, skipped };
  }

  /** P4 import: the pasted sheet is shown back as what will and will not change before a row is written. */
  async importPreview(principal: Principal, text: string, effectiveFrom: string): Promise<ImportRow[]> {
    const today = istDateOf(new Date().toISOString());
    const tiers = await this.listTiers(principal);
    const lines = parseClassImport(text, tiers.map((t) => t.code));
    const wanted = [...new Set(lines.map((l) => normaliseName(l.party)).filter((n) => n !== ''))];
    const matches = wanted.length === 0 ? { rows: [] as { id: string; name: string; norm: string }[] } : await this.db.execute<{ id: string; name: string; norm: string }>(sql`
      SELECT id, name, lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) AS norm
      FROM parties WHERE org_id = ${principal.orgId}
        AND lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) IN ${wanted}
      UNION
      SELECT id, name, lower(regexp_replace(trim(alias), '\\s+', ' ', 'g')) AS norm
      FROM parties WHERE org_id = ${principal.orgId} AND alias IS NOT NULL
        AND lower(regexp_replace(trim(alias), '\\s+', ' ', 'g')) IN ${wanted}
    `);
    const byNorm = new Map<string, { id: string; name: string }[]>();
    for (const row of matches.rows) {
      const list = byNorm.get(row.norm) ?? [];
      if (!list.some((entry) => entry.id === row.id)) list.push({ id: row.id, name: row.name });
      byNorm.set(row.norm, list);
    }
    const resolved = lines.map((l) => ({ l, found: byNorm.get(normaliseName(l.party)) ?? [] }));
    const classed = await this.classAsOf(principal.orgId, resolved.flatMap((r) => (r.found.length === 1 ? [r.found[0]?.id ?? ''] : [])), today);
    return resolved.map(({ l, found }) => {
      const base = { line: l.line, party: l.party, tierCode: l.tierCode, from: null, partyId: null };
      if (l.tierCode === null) return { ...base, status: 'unknown-class' as const, note: `No class code on this line; the classes are ${tiers.map((t) => t.code).join(', ')}.` };
      if (found.length === 0) return { ...base, status: 'unknown-party' as const, note: 'No customer with exactly this name.' };
      if (found.length > 1) return { ...base, status: 'ambiguous-party' as const, note: `${String(found.length)} customers share this name.` };
      const party = found[0];
      if (party === undefined) return { ...base, status: 'unknown-party' as const, note: 'No customer with exactly this name.' };
      const current = classed.get(party.id) ?? null;
      if (current === l.tierCode) return { ...base, partyId: party.id, party: party.name, from: current, status: 'unchanged' as const, note: `Already class ${current}.` };
      return { ...base, partyId: party.id, party: party.name, from: current, status: 'change' as const, note: current === null ? `Unclassed to ${l.tierCode} on ${effectiveFrom}.` : `${current} to ${l.tierCode} on ${effectiveFrom}.` };
    });
  }

  async importApply(principal: Principal, text: string, effectiveFrom: string): Promise<{ applied: number; rows: ImportRow[] }> {
    const preview = await this.importPreview(principal, text, effectiveFrom);
    let applied = 0;
    const rows: ImportRow[] = [];
    for (const row of preview) {
      if (row.status !== 'change' || row.partyId === null || row.tierCode === null) {
        rows.push(row);
        continue;
      }
      const line = parseClassImport(text, [row.tierCode]).find((l) => l.line === row.line);
      const reason = line === undefined || line.reason === '' ? 'Imported classification' : line.reason;
      try {
        await this.assign(principal, row.partyId, row.tierCode, reason, effectiveFrom);
        applied += 1;
        rows.push({ ...row, status: 'applied', note: `Class ${row.tierCode} from ${effectiveFrom}.` });
      } catch (error) {
        if (error instanceof AppError) rows.push({ ...row, status: 'failed', note: error.message });
        else throw error;
      }
    }
    return { applied, rows };
  }

  /**
   * P5: the system proposes, a person decides -- never auto-assign. A
   * suggestion is the class the trailing year's revenue would put the
   * customer in; the list is only where the suggestion and the decision
   * disagree, in both directions, because under-serving a growing
   * customer and financing a shrunken one are both expensive.
   */
  async mismatches(principal: Principal): Promise<{ rows: MismatchRow[] }> {
    const today = istDateOf(new Date().toISOString());
    const tiers = await this.listTiers(principal);
    const ladder = tiers.map((t) => t.code);
    if (ladder.length === 0) return { rows: [] };
    const sales = await this.db.execute<{ partyId: string; netTY: string; netLY: string }>(sql`
      SELECT party_id AS "partyId",
             sum(net) FILTER (WHERE date > (${today}::date - 365))::text AS "netTY",
             sum(net) FILTER (WHERE date <= (${today}::date - 365))::text AS "netLY"
      FROM fact_sales_daily
      WHERE org_id = ${principal.orgId} AND party_id IS NOT NULL AND date > (${today}::date - 730)
      GROUP BY 1
    `);
    const current = await this.db.execute<{ partyId: string; tierCode: string }>(sql`
      SELECT party_id AS "partyId", tier_code AS "tierCode" FROM customer_tier_assignments
      WHERE org_id = ${principal.orgId} AND effective_from <= ${today} AND (effective_to IS NULL OR effective_to >= ${today})
    `);
    const snoozed = await this.db.execute<{ partyId: string | null }>(sql`
      SELECT party_id AS "partyId" FROM cfo_alert_snoozes
      WHERE org_id = ${principal.orgId} AND alert_key = 'class-mismatch' AND until >= ${today}
    `);
    const snoozedIds = new Set(snoozed.rows.map((r) => r.partyId).filter((id): id is string => id !== null));
    const classOf = new Map(current.rows.map((r) => [r.partyId, r.tierCode]));
    const netOf = new Map(sales.rows.map((r) => [r.partyId, { ty: Number(r.netTY ?? 0), ly: Number(r.netLY ?? 0) }]));
    const candidates = [...new Set([...netOf.keys(), ...classOf.keys()])].filter((id) => !snoozedIds.has(id));
    const ranked = candidates
      .map((id) => ({ id, ty: netOf.get(id)?.ty ?? 0, ly: netOf.get(id)?.ly ?? 0 }))
      .sort((a, b) => b.ty - a.ty);
    const total = ranked.reduce((sum, r) => sum + Math.max(r.ty, 0), 0);
    const orderOf = new Map(ladder.map((code, i) => [code, i]));
    let cumulative = 0;
    const suggestions = new Map<string, { suggested: string; share: number; rank: number }>();
    ranked.forEach((r, index) => {
      cumulative += Math.max(r.ty, 0);
      const share = total > 0 ? cumulative / total : 1;
      // Zero-revenue customers land in the last class regardless of band.
      const band = r.ty <= 0 ? ladder.length - 1 : SUGGESTION_BANDS.findIndex((b) => share <= b);
      const at = band === -1 ? Math.min(SUGGESTION_BANDS.length, ladder.length - 1) : Math.min(band, ladder.length - 1);
      const code = ladder[at];
      if (code !== undefined) suggestions.set(r.id, { suggested: code, share: total > 0 ? Math.max(r.ty, 0) / total : 0, rank: index + 1 });
    });
    const mismatched = ranked.filter((r) => {
      const s = suggestions.get(r.id);
      return s !== undefined && s.suggested !== (classOf.get(r.id) ?? null);
    });
    if (mismatched.length === 0) return { rows: [] };
    const names = await this.db.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM parties WHERE org_id = ${principal.orgId} AND id IN ${mismatched.map((r) => r.id)}
    `);
    const nameOf = new Map(names.rows.map((r) => [r.id, r.name]));
    const rows = mismatched
      .map((r): MismatchRow | null => {
        const s = suggestions.get(r.id);
        if (s === undefined) return null;
        const cur = classOf.get(r.id) ?? null;
        const growthPct = r.ly > 0 ? Math.round(((r.ty - r.ly) / r.ly) * 100) : null;
        const why = r.ty <= 0
          ? 'Nothing bought in the last 12 months.'
          : `Rank ${String(s.rank)} of ${String(ranked.length)} by revenue (${(s.share * 100).toFixed(1)}% of the book)${growthPct === null ? '' : growthPct >= 0 ? `, growing ${String(growthPct)}%` : `, shrinking ${String(Math.abs(growthPct))}%`}.`;
        const direction: 'under' | 'over' = cur === null || (orderOf.get(s.suggested) ?? 99) < (orderOf.get(cur) ?? 99) ? 'under' : 'over';
        return { partyId: r.id, party: nameOf.get(r.id) ?? r.id, current: cur, suggested: s.suggested, direction, netTY: r.ty.toFixed(2), growthPct, why };
      })
      .filter((row): row is MismatchRow => row !== null)
      .sort((a, b) => {
        const step = (row: MismatchRow) => Math.abs((orderOf.get(row.suggested) ?? 99) - (row.current === null ? ladder.length : (orderOf.get(row.current) ?? 99)));
        return step(b) - step(a) || Number(b.netTY) - Number(a.netTY);
      })
      .slice(0, 50);
    return { rows };
  }

  /**
   * O2.1, P6: key accounts past their contact frequency. The last touch
   * is a logged desk outcome or a sales voucher, whichever is later; a
   * customer classed A+ whose only contact is their own orders is
   * exactly who this list exists for.
   */
  async neglected(principal: Principal): Promise<{ rows: NeglectedRow[] }> {
    const today = istDateOf(new Date().toISOString());
    const rows = await this.db.execute<{
      partyId: string; party: string; tierCode: string; contactEveryDays: number; lastTouch: string | null; since: string; outstanding: string | null;
    }>(sql`
      WITH cur AS (
        SELECT a.party_id, a.tier_code, a.effective_from
        FROM customer_tier_assignments a
        WHERE a.org_id = ${principal.orgId} AND a.effective_to IS NULL AND a.effective_from <= ${today}
      ),
      touch AS (
        SELECT party_id, max(d) AS last FROM (
          SELECT party_id, max(voucher_date)::text AS d FROM vouchers
          WHERE org_id = ${principal.orgId} AND voucher_type = 'Sales' AND is_cancelled = false AND party_id IS NOT NULL
          GROUP BY 1
          UNION ALL
          SELECT party_id, max(logged_on::date)::text FROM cfo_desk_outcomes WHERE org_id = ${principal.orgId} GROUP BY 1
        ) t GROUP BY 1
      ),
      book AS (
        SELECT f.party_id, sum(f.outstanding)::numeric(16,2)::text AS outstanding
        FROM fact_receivable_snapshot f
        WHERE f.org_id = ${principal.orgId}
          AND f.snapshot_date = (SELECT max(snapshot_date) FROM fact_receivable_snapshot WHERE org_id = ${principal.orgId})
        GROUP BY 1
      )
      SELECT c.party_id AS "partyId", p.name AS party, c.tier_code AS "tierCode",
             t.contact_every_days AS "contactEveryDays", touch.last AS "lastTouch",
             c.effective_from AS since, book.outstanding
      FROM cur c
      JOIN customer_tiers t ON t.org_id = ${principal.orgId} AND t.code = c.tier_code AND t.contact_every_days IS NOT NULL
      JOIN parties p ON p.id = c.party_id
      LEFT JOIN touch ON touch.party_id = c.party_id
      LEFT JOIN book ON book.party_id = c.party_id
    `);
    const owners = await this.db.execute<{ partyId: string; ref: string; email: string | null }>(sql`
      SELECT party_id AS "partyId", owner_ref AS ref, u.email
      FROM customer_owner_map m LEFT JOIN users u ON u.id::text = substr(m.owner_ref, 6)
      WHERE m.org_id = ${principal.orgId} AND m.effective_from <= ${today}
        AND (m.effective_to IS NULL OR m.effective_to >= ${today})
    `);
    const ownerOf = new Map<string, string>();
    for (const o of owners.rows) {
      if (ownerOf.has(o.partyId)) continue;
      ownerOf.set(o.partyId, o.ref === 'HOUSE' ? 'House' : (o.email?.split('@')[0] ?? 'Former user'));
    }
    const days = (from: string): number => Math.floor((Date.parse(today) - Date.parse(from)) / 86_400_000);
    const out = rows.rows
      .map((r): NeglectedRow => {
        const anchor = r.lastTouch ?? r.since;
        return {
          partyId: r.partyId,
          party: r.party,
          tierCode: r.tierCode,
          contactEveryDays: r.contactEveryDays,
          lastTouch: r.lastTouch,
          daysSince: days(anchor),
          ownerLabel: ownerOf.get(r.partyId) ?? 'Unassigned',
          outstanding: r.outstanding ?? '0.00',
        };
      })
      .filter((r) => r.daysSince > r.contactEveryDays)
      .sort((a, b) => (b.daysSince - b.contactEveryDays) - (a.daysSince - a.contactEveryDays))
      .slice(0, 100);
    return { rows: out };
  }
}
