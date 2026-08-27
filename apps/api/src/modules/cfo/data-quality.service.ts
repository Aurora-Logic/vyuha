import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { type Principal } from '../../platform/rbac/principal.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { CATEGORY_CASE_SQL } from './category.js';

/**
 * The Data Quality screen (brief Q3): the screen that admits what is
 * broken, which is what makes the rest defensible. Each check carries its
 * current value, its target, the fix, and where the offending records
 * live. The headline is one number, "Data health", the mean of every
 * check's distance from its target. A check the module cannot run yet
 * says so with a null rather than a flattering zero.
 */

export interface QualityCheck {
  readonly key: string;
  readonly label: string;
  /** Current value; null when the check has nothing to measure yet. */
  readonly value: number | null;
  readonly unit: 'pct' | 'count';
  readonly target: number;
  /** Fraction of the goal met, 0-1; null when not measurable. */
  readonly health: number | null;
  readonly fix: string;
  /** Where to go to fix it, inside the app. */
  readonly drill: string | null;
  readonly note?: string;
}

export interface DataQuality {
  readonly asOf: string;
  readonly headline: number | null;
  readonly checks: readonly QualityCheck[];
}

const healthOf = (value: number | null, target: number, unit: 'pct' | 'count'): number | null => {
  if (value === null) return null;
  if (value <= target) return 1;
  // Percent checks decay linearly to zero at 100%; counts decay against
  // ten times the target, so a handful over is a dent, a hundred is a hole.
  const span = unit === 'pct' ? 100 - target : Math.max(10, target * 10);
  return Math.max(0, 1 - (value - target) / span);
};

const GSTIN = String.raw`^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`;

@Injectable()
export class DataQualityService {
  constructor(@InjectDatabase() private readonly db: Database) {}

  async read(principal: Principal): Promise<DataQuality> {
    const today = istDateOf(new Date().toISOString());
    const since = new Date(Date.parse(today) - 90 * 86_400_000).toISOString().slice(0, 10);
    const org = principal.orgId;

    const sales = await this.db.execute<{ net: string | null; unassigned: string | null }>(sql`
      SELECT sum(net)::text AS net, sum(net) FILTER (WHERE salesperson_ref = 'UNASSIGNED')::text AS unassigned
      FROM fact_sales_daily WHERE org_id = ${org} AND date BETWEEN ${since} AND ${today}
    `);
    const duplicates = await this.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM duplicate_clusters WHERE org_id = ${org} AND state = 'open'
    `);
    const items = await this.db.execute<{ total: number; noCost: number; noBrand: number; noUnit: number; noCategory: number }>(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE cost_price IS NULL)::int AS "noCost",
             count(*) FILTER (WHERE parent_group IS NULL OR parent_group = '')::int AS "noBrand",
             count(*) FILTER (WHERE unit IS NULL OR unit = '')::int AS "noUnit",
             count(*) FILTER (WHERE (${sql.raw(CATEGORY_CASE_SQL.replace(/item_name/gu, 'name'))}) = 'Other')::int AS "noCategory"
      FROM stock_items WHERE org_id = ${org} AND absent_in_tally = false
    `);
    const bills = await this.db.execute<{ total: number; noDue: number }>(sql`
      WITH latest AS (SELECT max(snapshot_date) AS d FROM fact_receivable_snapshot WHERE org_id = ${org})
      SELECT count(*)::int AS total, count(*) FILTER (WHERE due_date IS NULL)::int AS "noDue"
      FROM fact_receivable_snapshot, latest WHERE org_id = ${org} AND snapshot_date = latest.d
    `);
    const parties = await this.db.execute<{ total: number; noTerms: number; badGstin: number; noPhone: number }>(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE credit_days IS NULL AND credit_limit IS NULL)::int AS "noTerms",
             count(*) FILTER (WHERE gstin IS NULL OR gstin = '' OR gstin !~ ${GSTIN})::int AS "badGstin",
             count(*) FILTER (WHERE phone IS NULL OR phone = '')::int AS "noPhone"
      FROM parties WHERE org_id = ${org} AND absent_in_tally = false AND parent_group ILIKE '%debtor%'
    `);

    const s = sales.rows[0];
    const i = items.rows[0] ?? { total: 0, noCost: 0, noBrand: 0, noUnit: 0, noCategory: 0 };
    const b = bills.rows[0] ?? { total: 0, noDue: 0 };
    const p = parties.rows[0] ?? { total: 0, noTerms: 0, badGstin: 0, noPhone: 0 };
    const pct = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);
    const netSales = Number(s?.net ?? 0);

    const check = (
      key: string,
      label: string,
      value: number | null,
      unit: 'pct' | 'count',
      target: number,
      fix: string,
      drill: string | null,
      note?: string,
    ): QualityCheck => ({ key, label, value, unit, target, health: healthOf(value, target, unit), fix, drill, ...(note === undefined ? {} : { note }) });

    const checks: QualityCheck[] = [
      check('unassigned-sales', 'Unassigned sales', netSales === 0 ? null : pct(Number(s?.unassigned ?? 0), netSales), 'pct', 2, 'Assign an owner in the CFO owner map', '/reports/sales-analysis', 'Share of the last 90 days’ net sales with no salesperson'),
      check('duplicate-parties', 'Duplicate parties', duplicates.rows[0]?.n ?? 0, 'count', 0, 'Review and merge', '/masters/duplicates'),
      check('missing-cost', 'Items without cost', pct(i.noCost, i.total), 'pct', 10, 'Map a cost price in Tally', '/masters/items', 'Margin cannot be read on these lines'),
      check('missing-due-date', 'Bills without a due date', pct(b.noDue, b.total), 'pct', 5, 'Set credit days in Tally', '/masters/parties'),
      check('items-no-brand', 'Items without brand', i.noBrand, 'count', 0, 'Map to C&S / BCH / Other in the item group', '/masters/items'),
      check('items-no-category', 'Items without category', i.noCategory, 'count', 0, 'Name the item so its category reads (MCB / MCCB / ACB / RCCB / PQ)', '/masters/items', 'Category is read off the item name until a category master lands'),
      check('items-no-uom', 'Items without a unit', i.noUnit, 'count', 0, 'Add the unit in Tally', '/masters/items'),
      check('parties-no-class', 'Parties without class', null, 'count', 0, 'Assign a customer class', null, 'Customer classes arrive with Part P'),
      check('parties-no-terms', 'Parties without credit terms', p.noTerms, 'count', 0, 'Set credit days or a limit', '/masters/parties'),
      check('parties-bad-gstin', 'Invalid or missing GSTIN', p.badGstin, 'count', 0, 'Correct the master in Tally', '/masters/parties'),
      check('negative-margin', 'Negative margin from bad cost', null, 'count', 0, 'Investigate the cost', null, 'Awaits the valuation decision (M1)'),
      check('parties-no-phone', 'Customers without a phone number', p.noPhone, 'count', 0, 'Add a number — a call list without numbers is useless', '/masters/parties'),
    ];
    const measured = checks.map((c) => c.health).filter((h): h is number => h !== null);
    const headline = measured.length === 0 ? null : Math.round((measured.reduce((a, b) => a + b, 0) / measured.length) * 100);
    return { asOf: today, headline, checks };
  }
}
