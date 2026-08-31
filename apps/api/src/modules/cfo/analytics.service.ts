import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { type Principal } from '../../platform/rbac/principal.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { CATEGORY_CASE_SQL } from './category.js';
import { TierService } from './tier.service.js';

/**
 * The Phase 5 analytics that need no valuation decision: price bands and
 * the realisation gap (M10, M11), ABC-XYZ (Q2.9), cohort retention
 * (Q2.21), concentration and HHI (C10, C11), and cross-sell (Q2.10's
 * whitespace priced) -- which is also what finally feeds the desk score's
 * opportunity factor and the call sheet's "should buy".
 */

export interface PriceBand {
  readonly itemId: string;
  readonly item: string;
  readonly qty: string;
  readonly net: string;
  readonly min: string;
  readonly p25: string;
  readonly median: string;
  readonly p75: string;
  readonly max: string;
  /** M11: what selling every below-median line at the median would recover. */
  readonly recoverable: string;
}

export interface AbcXyzCell {
  readonly abc: 'A' | 'B' | 'C';
  readonly xyz: 'X' | 'Y' | 'Z';
  readonly count: number;
  readonly net: string;
  readonly items: readonly { itemId: string; item: string; net: string }[];
}

export interface CohortRow {
  readonly cohort: string;
  readonly size: number;
  /** Share (0-100) of the cohort active in month offset i (index 0 = the cohort month). */
  readonly retention: readonly number[];
}

export interface Concentration {
  readonly top5Pct: number;
  readonly top10Pct: number;
  readonly hhi: number;
  readonly top5PctLy: number | null;
  readonly hhiLy: number | null;
}

export interface CrossSellSuggestion {
  readonly partyId: string;
  readonly party: string;
  readonly category: string;
  /** Share of the customer's class buying this category. */
  readonly adoptionPct: number;
  /** The class's median annual spend on the category. */
  readonly estimate: string;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly tiers: TierService,
  ) {}

  async priceBands(principal: Principal, from: string, to: string): Promise<PriceBand[]> {
    const rows = await this.db.execute<{
      itemId: string; item: string; qty: string; net: string; min: string; p25: string; median: string; p75: string; max: string; recoverable: string;
    }>(sql`
      WITH lines AS (
        SELECT l.stock_item_id AS item_id, l.stock_item_name AS item, l.rate::numeric AS rate,
               CASE WHEN l.billed_qty ~ '^\\s*-?[0-9]' THEN (regexp_match(l.billed_qty, '-?[0-9]+\\.?[0-9]*'))[1]::numeric ELSE 0 END AS qty,
               abs(l.amount) AS amount
        FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
        WHERE v.org_id = ${principal.orgId} AND v.is_cancelled = false AND v.voucher_type = 'Sales'
          AND l.kind = 'inventory' AND l.stock_item_id IS NOT NULL AND l.rate IS NOT NULL
          AND v.voucher_date BETWEEN ${from} AND ${to}
      ), bands AS (
        SELECT item_id, max(item) AS item, count(*) AS n,
               sum(qty) AS qty, sum(amount) AS net,
               min(rate) AS min,
               percentile_cont(0.25) WITHIN GROUP (ORDER BY rate) AS p25,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY rate) AS median,
               percentile_cont(0.75) WITHIN GROUP (ORDER BY rate) AS p75,
               max(rate) AS max
        FROM lines GROUP BY item_id HAVING count(*) >= 3
      )
      SELECT b.item_id AS "itemId", b.item,
             b.qty::numeric(16,3)::text AS qty, b.net::numeric(16,2)::text AS net,
             b.min::numeric(16,2)::text AS min, b.p25::numeric(16,2)::text AS p25,
             b.median::numeric(16,2)::text AS median, b.p75::numeric(16,2)::text AS p75,
             b.max::numeric(16,2)::text AS max,
             coalesce((SELECT sum(GREATEST(0, b.median - l.rate) * l.qty) FROM lines l WHERE l.item_id = b.item_id), 0)::numeric(16,2)::text AS recoverable
      FROM bands b ORDER BY b.net DESC LIMIT 50
    `);
    return rows.rows;
  }

  async abcXyz(principal: Principal, asOf?: string): Promise<{ cells: AbcXyzCell[] }> {
    const day = asOf ?? istDateOf(new Date().toISOString());
    const since = new Date(Date.parse(day) - 365 * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.db.execute<{ itemId: string; item: string; net: string; months: string[]; qtys: string[] }>(sql`
      SELECT item_id AS "itemId", max(item_name) AS item, sum(net)::numeric(16,2)::text AS net,
             array_agg(to_char(date, 'YYYY-MM')) AS months, array_agg(qty::text) AS qtys
      FROM fact_sales_daily
      WHERE org_id = ${principal.orgId} AND item_id IS NOT NULL AND voucher_type = 'Sales'
        AND date BETWEEN ${since} AND ${day}
      GROUP BY 1
    `);
    const items = rows.rows.map((r) => {
      const monthly = new Map<string, number>();
      r.months.forEach((m, i) => monthly.set(m, (monthly.get(m) ?? 0) + Number(r.qtys[i] ?? 0)));
      const values = [...monthly.values()];
      const mean = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(values.length, 1);
      const cv = mean === 0 ? Infinity : Math.sqrt(variance) / mean;
      // Fewer than three months of movement cannot claim steadiness (Q1.1).
      const xyz: 'X' | 'Y' | 'Z' = values.length < 3 ? 'Z' : cv < 0.5 ? 'X' : cv < 1 ? 'Y' : 'Z';
      return { itemId: r.itemId, item: r.item, net: Number(r.net), xyz };
    });
    const total = items.reduce((sum, i) => sum + i.net, 0);
    const sorted = [...items].sort((a, b) => b.net - a.net);
    let running = 0;
    const abcOf = new Map<string, 'A' | 'B' | 'C'>();
    for (const item of sorted) {
      // Classified by the share BEFORE this item joins: the first item is
      // always an A, however small the catalogue.
      const before = running;
      running += item.net;
      abcOf.set(item.itemId, total === 0 ? 'C' : before < total * 0.8 ? 'A' : before < total * 0.95 ? 'B' : 'C');
    }
    const cells: AbcXyzCell[] = [];
    for (const abc of ['A', 'B', 'C'] as const) {
      for (const xyz of ['X', 'Y', 'Z'] as const) {
        const members = sorted.filter((i) => abcOf.get(i.itemId) === abc && i.xyz === xyz);
        cells.push({
          abc,
          xyz,
          count: members.length,
          net: members.reduce((sum, i) => sum + i.net, 0).toFixed(2),
          items: members.slice(0, 25).map((i) => ({ itemId: i.itemId, item: i.item, net: i.net.toFixed(2) })),
        });
      }
    }
    return { cells };
  }

  async cohorts(principal: Principal, asOf?: string): Promise<CohortRow[]> {
    const day = asOf ?? istDateOf(new Date().toISOString());
    const rows = await this.db.execute<{ partyId: string; months: string[] }>(sql`
      SELECT party_id AS "partyId", array_agg(DISTINCT to_char(voucher_date, 'YYYY-MM')) AS months
      FROM vouchers
      WHERE org_id = ${principal.orgId} AND voucher_type = 'Sales' AND is_cancelled = false AND party_id IS NOT NULL
      GROUP BY 1
    `);
    const monthIndex = (m: string): number => Number(m.slice(0, 4)) * 12 + Number(m.slice(5)) - 1;
    const nowIndex = monthIndex(day.slice(0, 7));
    const cohorts = new Map<string, { size: number; active: Map<number, Set<string>> }>();
    for (const r of rows.rows) {
      const months = [...r.months].sort();
      const first = months[0];
      if (first === undefined || nowIndex - monthIndex(first) > 12) continue;
      const cohort = cohorts.get(first) ?? { size: 0, active: new Map<number, Set<string>>() };
      cohort.size += 1;
      for (const m of months) {
        const offset = monthIndex(m) - monthIndex(first);
        const set = cohort.active.get(offset) ?? new Set<string>();
        set.add(r.partyId);
        cohort.active.set(offset, set);
      }
      cohorts.set(first, cohort);
    }
    return [...cohorts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cohort, data]) => {
        const horizon = Math.min(12, nowIndex - monthIndex(cohort));
        const retention: number[] = [];
        for (let offset = 0; offset <= horizon; offset += 1) {
          retention.push(Math.round(((data.active.get(offset)?.size ?? 0) / data.size) * 100));
        }
        return { cohort, size: data.size, retention };
      });
  }

  async concentration(principal: Principal, asOf?: string): Promise<Concentration> {
    const day = asOf ?? istDateOf(new Date().toISOString());
    const window = async (from: string, to: string) => {
      const rows = await this.db.execute<{ net: string }>(sql`
        SELECT sum(net)::numeric(16,2)::text AS net FROM fact_sales_daily
        WHERE org_id = ${principal.orgId} AND party_id IS NOT NULL AND date BETWEEN ${from} AND ${to}
        GROUP BY party_id ORDER BY 1 DESC
      `);
      const values = rows.rows.map((r) => Number(r.net)).filter((n) => n > 0);
      const total = values.reduce((a, b) => a + b, 0);
      if (total === 0) return null;
      const share = (n: number) => Math.round((values.slice(0, n).reduce((a, b) => a + b, 0) / total) * 1000) / 10;
      const hhi = Math.round(values.reduce((a, b) => a + ((b / total) * 100) ** 2, 0));
      return { top5: share(5), top10: share(10), hhi };
    };
    const ty = await window(new Date(Date.parse(day) - 365 * 86_400_000).toISOString().slice(0, 10), day);
    const ly = await window(new Date(Date.parse(day) - 730 * 86_400_000).toISOString().slice(0, 10), new Date(Date.parse(day) - 366 * 86_400_000).toISOString().slice(0, 10));
    return {
      top5Pct: ty?.top5 ?? 0,
      top10Pct: ty?.top10 ?? 0,
      hhi: ty?.hhi ?? 0,
      top5PctLy: ly?.top5 ?? null,
      hhiLy: ly?.hhi ?? null,
    };
  }

  /**
   * Q2.10 priced: for each customer and category they do not buy, how many
   * of their class buy it and what the class's median annual spend on it
   * is. That estimate is the desk's opportunity and the call sheet's
   * "should buy: 71% of similar customers do".
   */
  async crossSell(principal: Principal, asOf?: string): Promise<Map<string, CrossSellSuggestion[]>> {
    const day = asOf ?? istDateOf(new Date().toISOString());
    const since = new Date(Date.parse(day) - 365 * 86_400_000).toISOString().slice(0, 10);
    const spend = await this.db.execute<{ partyId: string; party: string; category: string; net: string }>(sql`
      SELECT party_id AS "partyId", max(party_name) AS party, (${sql.raw(CATEGORY_CASE_SQL)}) AS category,
             sum(net)::numeric(16,2)::text AS net
      FROM fact_sales_daily
      WHERE org_id = ${principal.orgId} AND party_id IS NOT NULL AND voucher_type = 'Sales'
        AND date BETWEEN ${since} AND ${day}
      GROUP BY 1, 3 HAVING sum(net) > 0
    `);
    const partyIds = [...new Set(spend.rows.map((r) => r.partyId))];
    if (partyIds.length === 0) return new Map();
    const classes = await this.tiers.classAsOf(principal.orgId, partyIds, day);
    const classOf = (partyId: string): string => classes.get(partyId) ?? 'Unclassed';

    const byClassCategory = new Map<string, number[]>();
    const buyers = new Map<string, Set<string>>();
    const classSize = new Map<string, Set<string>>();
    const partyName = new Map<string, string>();
    const bought = new Map<string, Set<string>>();
    for (const r of spend.rows) {
      if (r.category === 'Other') continue;
      const cls = classOf(r.partyId);
      const key = `${cls}|${r.category}`;
      byClassCategory.set(key, [...(byClassCategory.get(key) ?? []), Number(r.net)]);
      buyers.set(key, (buyers.get(key) ?? new Set()).add(r.partyId));
      classSize.set(cls, (classSize.get(cls) ?? new Set()).add(r.partyId));
      partyName.set(r.partyId, r.party);
      bought.set(r.partyId, (bought.get(r.partyId) ?? new Set()).add(r.category));
    }
    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const out = new Map<string, CrossSellSuggestion[]>();
    for (const partyId of partyIds) {
      const cls = classOf(partyId);
      const size = classSize.get(cls)?.size ?? 0;
      if (size < 4) continue;
      const mine = bought.get(partyId) ?? new Set();
      const suggestions: CrossSellSuggestion[] = [];
      for (const [key, values] of byClassCategory) {
        const [keyClass, category] = key.split('|');
        if (keyClass !== cls || category === undefined || mine.has(category)) continue;
        const adoptionPct = Math.round(((buyers.get(key)?.size ?? 0) / size) * 100);
        // Q1.1's spirit: a category half the class ignores is not a gap.
        if (adoptionPct < 50) continue;
        suggestions.push({ partyId, party: partyName.get(partyId) ?? '', category, adoptionPct, estimate: median(values).toFixed(2) });
      }
      if (suggestions.length > 0) out.set(partyId, suggestions.sort((a, b) => Number(b.estimate) - Number(a.estimate)));
    }
    return out;
  }
}
