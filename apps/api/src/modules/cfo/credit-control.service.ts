import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { type Principal } from '../../platform/rbac/principal.js';
import { growthBridge, type BridgeRow, type GrowthBridge } from './growth-bridge.js';
import { sameDayLastYear } from './period/period-resolver.js';
import {
  averageDaysDelinquent,
  collectionEffectivenessIndex,
  dsoCountback,
  type MonthSales,
} from './receivable-metrics.js';
import { orderGapAllowed, readDelta, median } from './robustness.js';

/**
 * Phase 2's credit control (brief C4, E1, E3): the receivable book read as
 * measures and as named work lists. Everything computes from the snapshot
 * table, the voucher projection and the party masters -- and every list row
 * ends in a name, an amount and a reason, because a report that ends in a
 * percentage is an observation, not a control (A1).
 *
 * D17 prices a delay at the interest module's configured annual rate (M5,
 * decided 26 Aug): the overdue balance times the rate is what a year of
 * this customer's lateness costs, the most persuasive number in a
 * collection call.
 */

const BUCKETS = ['current', '0-30', '31-60', '61-90', '91-180', '180+'] as const;
const MATERIALITY_FLOOR = 25_000;

export interface AgeingPoint {
  readonly t: string;
  readonly [bucket: string]: string | number;
}

export interface CreditOverview {
  readonly asOf: string | null;
  readonly outstanding: string;
  readonly overdue: string;
  readonly buckets: Record<string, string>;
  readonly dsoCountback: number | null;
  readonly bestPossibleDso: number | null;
  readonly addDays: number | null;
  readonly cei: number | null;
  readonly ageingTrend: AgeingPoint[];
  readonly topOverdue: readonly {
    partyId: string | null;
    party: string;
    outstanding: string;
    overdue: string;
    oldestBill: string | null;
    daysOverdue: number;
    lastPayment: string | null;
    costPerYear: string;
  }[];
}

export interface WorkListRow {
  readonly partyId: string | null;
  readonly party: string;
  readonly amount: string;
  readonly reason: string;
  readonly daysOverdue?: number;
  readonly oldestBill?: string | null;
  readonly lastPayment?: string | null;
  readonly utilisationPct?: number;
  readonly medianGapDays?: number;
  readonly daysSinceLastOrder?: number;
  readonly declinePct?: number | null;
}

export interface WorkLists {
  readonly asOf: string;
  readonly lists: readonly { key: string; label: string; hint: string; rows: readonly WorkListRow[] }[];
}

function money(value: string | null | undefined): string {
  return value ?? '0.00';
}

@Injectable()
export class CreditControlService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly settings: SettingsService,
  ) {}

  async receivables(principal: Principal, from: string, to: string): Promise<CreditOverview> {
    const trend = await this.db.execute<{ day: string; key: string; value: string }>(sql`
      SELECT snapshot_date::text AS day, bucket AS key, sum(outstanding)::numeric(16,2)::text AS value
      FROM fact_receivable_snapshot
      WHERE org_id = ${principal.orgId} AND snapshot_date BETWEEN ${from} AND ${to}
      GROUP BY 1, 2 ORDER BY 1
    `);
    const days = [...new Set(trend.rows.map((r) => r.day))].sort();
    const byDay = new Map<string, Map<string, string>>();
    for (const row of trend.rows) {
      const bucket = byDay.get(row.day) ?? new Map<string, string>();
      bucket.set(row.key, row.value);
      byDay.set(row.day, bucket);
    }
    const ageingTrend: AgeingPoint[] = days.map((day) => {
      const point: Record<string, string | number> = { t: day };
      for (const bucket of BUCKETS) point[bucket] = byDay.get(day)?.get(bucket) ?? 0;
      return point as AgeingPoint;
    });

    const asOf = days.at(-1) ?? null;
    const latest = asOf === null ? new Map<string, string>() : (byDay.get(asOf) ?? new Map<string, string>());
    const bucketTotals: Record<string, string> = {};
    let outstanding = 0;
    let current = 0;
    for (const bucket of BUCKETS) {
      const value = Number(latest.get(bucket) ?? 0);
      bucketTotals[bucket] = money(latest.get(bucket) ?? '0.00');
      outstanding += value;
      if (bucket === 'current') current = value;
    }

    // Monthly net credit sales for the countback: the six months ending at
    // the period's end, from the voucher projection (ex-cancelled).
    const months = await this.db.execute<{ month: string; sales: string; days: number }>(sql`
      SELECT to_char(voucher_date, 'YYYY-MM') AS month,
             sum(CASE WHEN voucher_type = 'Sales' THEN abs(amount) ELSE -abs(amount) END)::numeric(16,2)::text AS sales,
             extract(day FROM (date_trunc('month', min(voucher_date)) + interval '1 month' - interval '1 day'))::int AS days
      FROM vouchers
      WHERE org_id = ${principal.orgId} AND is_cancelled = false
        AND voucher_type IN ('Sales', 'Credit Note')
        AND voucher_date > (${to}::date - interval '6 months') AND voucher_date <= ${to}
      GROUP BY 1 ORDER BY 1 DESC
    `);
    const monthSales: MonthSales[] = months.rows.map((row) => ({
      month: row.month,
      creditSales: Math.max(0, Number(row.sales)),
      days: row.days,
    }));

    const dso = dsoCountback(outstanding, monthSales);
    const best = dsoCountback(current, monthSales);
    const add = averageDaysDelinquent(dso, best);

    // CEI over the window: opening book from the earliest day in range.
    const opening = days[0] === undefined ? 0 : [...(byDay.get(days[0]) ?? new Map<string, string>()).values()].reduce((sum, v) => sum + Number(v), 0);
    const creditSales = monthSales
      .filter((m) => m.month >= from.slice(0, 7) && m.month <= to.slice(0, 7))
      .reduce((sum, m) => sum + m.creditSales, 0);
    const cei = collectionEffectivenessIndex(opening, creditSales, outstanding, current);

    const rate = (await this.settings.read(principal)).interest.annualRatePct;
    const topOverdue =
      asOf === null
        ? []
        : (
            await this.db.execute<{
              partyId: string | null;
              party: string;
              outstanding: string;
              overdue: string;
              oldestBill: string | null;
              daysOverdue: number;
            }>(sql`
              SELECT f.party_id AS "partyId",
                     coalesce(p.name, 'Unknown party') AS party,
                     sum(f.outstanding)::numeric(16,2)::text AS outstanding,
                     sum(CASE WHEN f.bucket <> 'current' THEN f.outstanding ELSE 0 END)::numeric(16,2)::text AS overdue,
                     min(f.bill_date)::text AS "oldestBill",
                     max(f.days_overdue)::int AS "daysOverdue"
              FROM fact_receivable_snapshot f
              LEFT JOIN parties p ON p.id = f.party_id
              WHERE f.org_id = ${principal.orgId} AND f.snapshot_date = ${asOf}
              GROUP BY 1, 2
              HAVING sum(CASE WHEN f.bucket <> 'current' THEN f.outstanding ELSE 0 END) > 0
              -- The overdue sum itself, not column 4's ::text of it (CFO-1).
              ORDER BY sum(CASE WHEN f.bucket <> 'current' THEN f.outstanding ELSE 0 END) DESC LIMIT 10
            `)
          ).rows.map((row) => ({
            ...row,
            lastPayment: null as string | null,
            costPerYear: ((Number(row.overdue) * rate) / 100).toFixed(2),
          }));

    // Last payment per listed party, one query for the set.
    if (topOverdue.length > 0) {
      const ids = topOverdue.map((r) => r.partyId).filter((id): id is string => id !== null);
      if (ids.length > 0) {
        const payments = await this.db.execute<{ partyId: string; last: string }>(sql`
          SELECT party_id AS "partyId", max(voucher_date)::text AS last
          FROM vouchers
          WHERE org_id = ${principal.orgId} AND voucher_type = 'Receipt' AND is_cancelled = false
            AND party_id IN ${ids}
          GROUP BY 1
        `);
        const byParty = new Map(payments.rows.map((r) => [r.partyId, r.last]));
        for (const row of topOverdue) {
          if (row.partyId !== null) row.lastPayment = byParty.get(row.partyId) ?? null;
        }
      }
    }

    return {
      asOf,
      outstanding: outstanding.toFixed(2),
      overdue: (outstanding - current).toFixed(2),
      buckets: bucketTotals,
      dsoCountback: dso,
      bestPossibleDso: best,
      addDays: add,
      cei,
      ageingTrend,
      topOverdue,
    };
  }

  /**
   * D1 over the voucher projection: the window against the same elapsed
   * days a year back, at customer x item grain. Credit notes ride as
   * negative party-level rows so a returns-heavy customer's story lands in
   * mix or lost, never silently dropped.
   */
  /** @param partyIds Level 4/5 scope (B3): a person's book, or one account. Company when omitted. */
  async bridge(principal: Principal, from: string, to: string, partyIds?: readonly string[]): Promise<GrowthBridge> {
    const scope = partyIds === undefined ? sql`` : sql` AND v.party_id IN ${[...partyIds]}`;
    const window = async (f: string, t: string): Promise<BridgeRow[]> => {
      const rows = await this.db.execute<{ customerKey: string; itemKey: string; qty: string; net: string }>(sql`
        SELECT customer AS "customerKey", item AS "itemKey", sum(qty)::float AS qty, sum(net)::float AS net FROM (
          SELECT coalesce(v.party_id::text, v.party_name) AS customer,
                 coalesce(l.stock_item_id::text, 'ledger-only') AS item,
                 CASE WHEN l.billed_qty ~ '^\s*-?[0-9]' THEN (regexp_match(l.billed_qty, '-?[0-9]+\.?[0-9]*'))[1]::numeric ELSE 0 END AS qty,
                 abs(l.amount) AS net
          FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
          WHERE v.org_id = ${principal.orgId} AND v.is_cancelled = false AND v.voucher_type = 'Sales'
            AND l.kind = 'inventory' AND v.voucher_date BETWEEN ${f} AND ${t}${scope}
          UNION ALL
          SELECT coalesce(v.party_id::text, v.party_name), 'ledger-only', 0, v.amount
          FROM vouchers v
          WHERE v.org_id = ${principal.orgId} AND v.is_cancelled = false AND v.voucher_type = 'Sales'
            AND v.voucher_date BETWEEN ${f} AND ${t}${scope}
            AND NOT EXISTS (SELECT 1 FROM voucher_lines l WHERE l.voucher_id = v.id AND l.kind = 'inventory')
          UNION ALL
          SELECT coalesce(v.party_id::text, v.party_name), 'credit-note', 0, -v.amount
          FROM vouchers v
          WHERE v.org_id = ${principal.orgId} AND v.is_cancelled = false AND v.voucher_type = 'Credit Note'
            AND v.voucher_date BETWEEN ${f} AND ${t}${scope}
        ) grains GROUP BY 1, 2
      `);
      return rows.rows.map((r) => ({ customerKey: r.customerKey, itemKey: r.itemKey, qty: Number(r.qty), net: Number(r.net) }));
    };
    // The period engine's own year-shift, which already knows 29 February
    // maps to the 28th rather than to an invalid date.
    const [ty, ly] = await Promise.all([window(from, to), window(sameDayLastYear(from), sameDayLastYear(to))]);
    return growthBridge(ty, ly);
  }

  /**
   * D2: the customer movement matrix. Six states x three size bands,
   * every cell a count, a rupee figure and the names behind it --
   * "Declining x A" is the most expensive cell on the screen.
   *
   * States, from the window against the same elapsed days last year:
   * New (nothing in the prior 365 days), Reactivated (returned after 180+
   * days quiet), Growing (+5% and up), Flat (within 5%), Declining (-5%
   * and down), Lost (last year's money, nothing now). Bands are terciles
   * of each customer's larger year, A the heaviest -- configurable
   * thresholds arrive with the settings pass.
   */
  async movement(principal: Principal, from: string, to: string, partyIds?: readonly string[]): Promise<{
    cells: readonly {
      state: string;
      band: string;
      count: number;
      amount: string;
      parties: readonly { partyId: string; party: string; thisYear: string; lastYear: string }[];
    }[];
  }> {
    const lyFrom = sameDayLastYear(from);
    const lyTo = sameDayLastYear(to);
    const scope = partyIds === undefined ? sql`` : sql` AND v.party_id IN ${[...partyIds]}`;
    const rows = await this.db.execute<{
      partyId: string;
      party: string;
      ty: string;
      ly: string;
      lastBefore: string | null;
      firstIn: string | null;
    }>(sql`
      SELECT v.party_id AS "partyId", max(v.party_name) AS party,
             sum(CASE WHEN v.voucher_date BETWEEN ${from} AND ${to}
                      THEN (CASE WHEN v.voucher_type = 'Sales' THEN abs(v.amount) ELSE -abs(v.amount) END) ELSE 0 END)::numeric(16,2)::text AS ty,
             sum(CASE WHEN v.voucher_date BETWEEN ${lyFrom} AND ${lyTo}
                      THEN (CASE WHEN v.voucher_type = 'Sales' THEN abs(v.amount) ELSE -abs(v.amount) END) ELSE 0 END)::numeric(16,2)::text AS ly,
             max(v.voucher_date) FILTER (WHERE v.voucher_type = 'Sales' AND v.voucher_date < ${from})::text AS "lastBefore",
             min(v.voucher_date) FILTER (WHERE v.voucher_type = 'Sales' AND v.voucher_date BETWEEN ${from} AND ${to})::text AS "firstIn"
      FROM vouchers v
      WHERE v.org_id = ${principal.orgId} AND v.is_cancelled = false AND v.party_id IS NOT NULL
        AND v.voucher_type IN ('Sales', 'Credit Note')${scope}
      GROUP BY 1
    `);

    interface Classified {
      partyId: string;
      party: string;
      ty: number;
      ly: number;
      state: string;
      size: number;
    }
    const gapDays = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    const classified: Classified[] = [];
    for (const row of rows.rows) {
      const ty = Number(row.ty);
      const ly = Number(row.ly);
      if (ty <= 0 && ly <= 0) continue;
      let state: string;
      if (ly <= 0 && ty > 0) {
        const quiet = row.lastBefore !== null && row.firstIn !== null ? gapDays(row.lastBefore, row.firstIn) : null;
        state = quiet === null ? 'new' : quiet >= 180 ? 'reactivated' : 'growing';
      } else if (ty <= 0) {
        state = 'lost';
      } else {
        const changePct = ((ty - ly) / Math.abs(ly)) * 100;
        state = changePct > 5 ? 'growing' : changePct < -5 ? 'declining' : 'flat';
      }
      classified.push({ partyId: row.partyId, party: row.party, ty, ly, state, size: Math.max(ty, ly) });
    }

    // Bands: terciles of the classified set by size, A the heaviest.
    const bySize = [...classified].sort((a, b) => b.size - a.size);
    const bandOf = new Map<string, string>();
    bySize.forEach((c, index) => {
      const third = Math.ceil(bySize.length / 3);
      bandOf.set(c.partyId, index < third ? 'A' : index < third * 2 ? 'B' : 'C');
    });

    const STATES = ['new', 'reactivated', 'growing', 'flat', 'declining', 'lost'];
    const BANDS = ['A', 'B', 'C'];
    const cells = STATES.flatMap((state) =>
      BANDS.map((band) => {
        const members = classified.filter((c) => c.state === state && bandOf.get(c.partyId) === band);
        // Lost customers are measured by what last year held; everyone else
        // by the window's own money.
        const amount = members.reduce((sum, c) => sum + (state === 'lost' ? c.ly : c.ty), 0);
        return {
          state,
          band,
          count: members.length,
          amount: amount.toFixed(2),
          parties: members
            .sort((a, b) => (state === 'lost' ? b.ly - a.ly : b.ty - a.ty))
            .slice(0, 50)
            .map((c) => ({ partyId: c.partyId, party: c.party, thisYear: c.ty.toFixed(2), lastYear: c.ly.toFixed(2) })),
        };
      }),
    );
    return { cells };
  }

  async workLists(principal: Principal): Promise<WorkLists> {
    const today = istDateOf(new Date().toISOString());
    const rate = (await this.settings.read(principal)).interest.annualRatePct;

    const latestDay = await this.db.execute<{ d: string | null }>(sql`
      SELECT max(snapshot_date)::text AS d FROM fact_receivable_snapshot WHERE org_id = ${principal.orgId}
    `);
    const asOf = latestDay.rows[0]?.d ?? today;

    // One pass over the latest book, banded per party.
    const book = await this.db.execute<{
      partyId: string | null;
      party: string;
      outstanding: string;
      overdue: string;
      dueSoon: string;
      daysOverdue: number;
      oldestBill: string | null;
      creditLimit: string | null;
    }>(sql`
      SELECT f.party_id AS "partyId",
             coalesce(p.name, 'Unknown party') AS party,
             sum(f.outstanding)::numeric(16,2)::text AS outstanding,
             sum(CASE WHEN f.bucket <> 'current' THEN f.outstanding ELSE 0 END)::numeric(16,2)::text AS overdue,
             sum(CASE WHEN f.bucket = 'current' AND f.due_date IS NOT NULL AND f.due_date <= (${today}::date + 7) THEN f.outstanding ELSE 0 END)::numeric(16,2)::text AS "dueSoon",
             max(f.days_overdue)::int AS "daysOverdue",
             min(f.bill_date)::text AS "oldestBill",
             max(p.credit_limit)::text AS "creditLimit"
      FROM fact_receivable_snapshot f
      LEFT JOIN parties p ON p.id = f.party_id
      WHERE f.org_id = ${principal.orgId} AND f.snapshot_date = ${asOf}
      GROUP BY 1, 2
    `);

    const costOf = (overdue: number): string => ((overdue * rate) / 100).toFixed(2);
    const ladder = (fromDays: number, toDays: number | null): WorkListRow[] =>
      book.rows
        .filter((r) => Number(r.overdue) > 0 && r.daysOverdue >= fromDays && (toDays === null || r.daysOverdue <= toDays))
        .sort((a, b) => Number(b.overdue) - Number(a.overdue))
        .map((r) => ({
          partyId: r.partyId,
          party: r.party,
          amount: r.overdue,
          reason: `${String(r.daysOverdue)} days overdue · delay costs ${costOf(Number(r.overdue))} a year`,
          daysOverdue: r.daysOverdue,
          oldestBill: r.oldestBill,
        }));

    const dueThisWeek: WorkListRow[] = book.rows
      .filter((r) => Number(r.dueSoon) > 0)
      .sort((a, b) => Number(b.dueSoon) - Number(a.dueSoon))
      .map((r) => ({
        partyId: r.partyId,
        party: r.party,
        amount: r.dueSoon,
        reason: 'Due within seven days — a courtesy reminder beats a chase',
      }));

    const breaches: WorkListRow[] = book.rows
      .filter((r) => r.creditLimit !== null && Number(r.creditLimit) > 0 && Number(r.outstanding) > Number(r.creditLimit))
      .map((r) => ({
        partyId: r.partyId,
        party: r.party,
        amount: r.outstanding,
        reason: `Over the limit of ${money(r.creditLimit)}`,
        utilisationPct: Math.round((Number(r.outstanding) / Number(r.creditLimit)) * 100),
      }))
      .sort((a, b) => (b.utilisationPct ?? 0) - (a.utilisationPct ?? 0));

    // Order history per party, trailing 365 days, for L01/L02/L07.
    const orders = await this.db.execute<{ partyId: string; party: string; day: string }>(sql`
      SELECT party_id AS "partyId", party_name AS party, voucher_date::text AS day
      FROM vouchers
      WHERE org_id = ${principal.orgId} AND voucher_type = 'Sales' AND is_cancelled = false
        AND party_id IS NOT NULL AND voucher_date > (${today}::date - 365)
      ORDER BY 1, 3
    `);
    const history = new Map<string, { party: string; days: string[] }>();
    for (const row of orders.rows) {
      const entry = history.get(row.partyId) ?? { party: row.party, days: [] };
      entry.days.push(row.day);
      history.set(row.partyId, entry);
    }
    const annualValue = await this.db.execute<{ partyId: string; net: string }>(sql`
      SELECT party_id AS "partyId",
             sum(CASE WHEN voucher_type = 'Sales' THEN abs(amount) ELSE -abs(amount) END)::numeric(16,2)::text AS net
      FROM vouchers
      WHERE org_id = ${principal.orgId} AND is_cancelled = false AND party_id IS NOT NULL
        AND voucher_type IN ('Sales', 'Credit Note') AND voucher_date > (${today}::date - 365)
      GROUP BY 1
    `);
    const valueOf = new Map(annualValue.rows.map((r) => [r.partyId, Number(r.net)]));

    const dayGap = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    const silent: WorkListRow[] = [];
    const widening: WorkListRow[] = [];
    for (const [partyId, entry] of history) {
      // Q1.1: fewer than five completed orders is "insufficient history",
      // not silent churn -- the rule that keeps false alarms off this list.
      if (!orderGapAllowed(entry.days.length)) continue;
      const gaps = entry.days.slice(1).map((day, index) => dayGap(entry.days[index] ?? day, day));
      const med = median(gaps);
      if (med === null || med <= 0) continue;
      const last = entry.days.at(-1) ?? today;
      const since = dayGap(last, today);
      if (since > med * 1.5) {
        silent.push({
          partyId,
          party: entry.party,
          amount: (valueOf.get(partyId) ?? 0).toFixed(2),
          reason: `No order in ${String(since)} days — their normal gap is ${String(Math.round(med))}`,
          medianGapDays: Math.round(med),
          daysSinceLastOrder: since,
        });
      } else {
        const recent = gaps.slice(-3);
        const recentAvg = recent.reduce((sum, g) => sum + g, 0) / Math.max(1, recent.length);
        if (recent.length === 3 && recentAvg > med * 1.3) {
          widening.push({
            partyId,
            party: entry.party,
            amount: (valueOf.get(partyId) ?? 0).toFixed(2),
            reason: `Order gap widened to ${String(Math.round(recentAvg))} days against a normal ${String(Math.round(med))}`,
            medianGapDays: Math.round(med),
          });
        }
      }
    }
    silent.sort((a, b) => Number(b.amount) - Number(a.amount));
    widening.sort((a, b) => Number(b.amount) - Number(a.amount));

    // L02: this financial YTD against the same elapsed window last year.
    const fyStart = Number(today.slice(5, 7)) >= 4 ? `${today.slice(0, 4)}-04-01` : `${String(Number(today.slice(0, 4)) - 1)}-04-01`;
    const decline = await this.db.execute<{ partyId: string; party: string; ty: string; ly: string }>(sql`
      SELECT party_id AS "partyId", max(party_name) AS party,
             sum(CASE WHEN voucher_date >= ${fyStart} THEN (CASE WHEN voucher_type = 'Sales' THEN abs(amount) ELSE -abs(amount) END) ELSE 0 END)::numeric(16,2)::text AS ty,
             sum(CASE WHEN voucher_date < ${fyStart} THEN (CASE WHEN voucher_type = 'Sales' THEN abs(amount) ELSE -abs(amount) END) ELSE 0 END)::numeric(16,2)::text AS ly
      FROM vouchers
      WHERE org_id = ${principal.orgId} AND is_cancelled = false AND party_id IS NOT NULL
        AND voucher_type IN ('Sales', 'Credit Note')
        AND (
          (voucher_date >= ${fyStart} AND voucher_date <= ${today})
          OR (voucher_date >= (${fyStart}::date - interval '1 year') AND voucher_date <= (${today}::date - interval '1 year'))
        )
      GROUP BY 1
    `);
    const declining: WorkListRow[] = decline.rows
      .map((row) => {
        const reading = readDelta(Number(row.ty), Number(row.ly), MATERIALITY_FLOOR);
        return { row, reading };
      })
      .filter(({ reading }) => reading.kind === 'pct' && reading.deltaPct < -20)
      .map(({ row, reading }) => ({
        partyId: row.partyId,
        party: row.party,
        amount: (reading.kind === 'pct' ? -reading.deltaAbs : 0).toFixed(2),
        reason: `Down ${String(Math.round(reading.kind === 'pct' ? -reading.deltaPct : 0))}% on the same period last year`,
        declinePct: reading.kind === 'pct' ? Math.round(reading.deltaPct) : null,
      }))
      .sort((a, b) => Number(b.amount) - Number(a.amount));

    return {
      asOf,
      lists: [
        { key: 'due-this-week', label: 'Due this week', hint: 'L15: due in the next seven days; a courtesy reminder, not a chase.', rows: dueThisWeek },
        { key: 'overdue-1-30', label: '1–30 overdue', hint: 'L16: statement and a call from accounts.', rows: ladder(1, 30) },
        { key: 'overdue-31-60', label: '31–60 overdue', hint: 'L17: the sales owner calls; new orders flagged.', rows: ladder(31, 60) },
        { key: 'overdue-61-90', label: '61–90 overdue', hint: 'L18: supply hold recommended.', rows: ladder(61, 90) },
        { key: 'overdue-90-plus', label: '90+ overdue', hint: 'L19: written demand and provisioning review.', rows: ladder(91, null) },
        { key: 'limit-breach', label: 'Limit breaches', hint: 'L20: utilisation over 100% — hold order confirmation until released.', rows: breaches },
        { key: 'silent-churn', label: 'Silent churn', hint: 'L01: quiet beyond 1.5× their own median gap; needs five orders of history before it may accuse.', rows: silent },
        { key: 'declining', label: 'Declining accounts', hint: 'L02: down more than 20% on last year, above the materiality floor.', rows: declining },
        { key: 'gap-widening', label: 'Frequency decline', hint: 'L07: recent gaps 30% wider than their own normal.', rows: widening },
      ],
    };
  }
}
