import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { type Principal } from '../../platform/rbac/principal.js';
import { CATEGORY_CASE_SQL } from './category.js';
import { type SalesScope } from './sales-analysis.service.js';

/**
 * The pocket-price waterfall and the margin slices (brief C2). Landed
 * cost is the Tally item master's cost price -- the owner confirmed it
 * as the authoritative basis on 28 Aug 2026, closing open decision M1 --
 * and every figure travels with its coverage: the share of net that
 * sits on costed grains. A margin without its coverage is how a
 * dashboard lies politely.
 */

export interface MarginRead {
  readonly coveragePct: number;
  readonly waterfall: readonly { key: string; label: string; amount: string }[];
  readonly slices: readonly { level: string; label: string; rows: readonly { key: string; label: string; net: string; margin: string | null; marginPct: number | null }[] }[];
  readonly negativeGrains: readonly { day: string; party: string; item: string; net: string; margin: string }[];
}

@Injectable()
export class MarginService {
  constructor(@InjectDatabase() private readonly db: Database) {}

  private where(principal: Principal, scope: SalesScope, from: string, to: string) {
    const parts = [sql`f.org_id = ${principal.orgId} AND f.date BETWEEN ${from} AND ${to}`];
    if (scope.brand !== undefined) parts.push(sql`f.brand = ${scope.brand}`);
    if (scope.person !== undefined) parts.push(sql`f.salesperson_ref = ${scope.person}`);
    if (scope.party !== undefined) parts.push(sql`f.party_id = ${scope.party}`);
    if (scope.item !== undefined) parts.push(sql`f.item_id = ${scope.item}`);
    return sql.join(parts, sql` AND `);
  }

  async read(principal: Principal, from: string, to: string, scope: SalesScope): Promise<MarginRead> {
    const where = this.where(principal, scope, from, to);
    const totals = await this.db.execute<{
      gross: string | null; discount: string | null; returns: string | null; net: string | null;
      landed: string | null; margin: string | null; costedNet: string | null; list: string | null;
    }>(sql`
      SELECT sum(f.gross)::numeric(16,2)::text AS gross, sum(f.discount)::numeric(16,2)::text AS discount,
             sum(f.returns)::numeric(16,2)::text AS returns, sum(f.net)::numeric(16,2)::text AS net,
             sum(f.landed_cost)::numeric(16,2)::text AS landed, sum(f.pocket_margin)::numeric(16,2)::text AS margin,
             sum(f.net) FILTER (WHERE f.pocket_margin IS NOT NULL)::numeric(16,2)::text AS "costedNet",
             sum(f.qty * s.sale_price) FILTER (WHERE s.sale_price IS NOT NULL)::numeric(16,2)::text AS list
      FROM fact_sales_daily f LEFT JOIN stock_items s ON s.id = f.item_id
      WHERE ${where}
    `);
    const t = totals.rows[0];
    const net = Number(t?.net ?? 0);
    const coveragePct = net === 0 ? 0 : Math.round((Number(t?.costedNet ?? 0) / net) * 1000) / 10;
    const waterfall = [
      { key: 'list', label: 'List price (master rate)', amount: Number(t?.list ?? 0).toFixed(2) },
      { key: 'invoice', label: 'Invoiced (gross)', amount: Number(t?.gross ?? 0).toFixed(2) },
      { key: 'discount', label: 'Trade discount', amount: (-Number(t?.discount ?? 0)).toFixed(2) },
      { key: 'returns', label: 'Returns and rate difference', amount: (-Number(t?.returns ?? 0)).toFixed(2) },
      { key: 'pocket', label: 'Pocket price (net)', amount: net.toFixed(2) },
      // The wedge that keeps the waterfall honest below full coverage:
      // margin exists only on costed grains, so the uncosted net leaves
      // the walk here instead of masquerading as margin.
      { key: 'uncosted', label: 'Net on uncosted grains (no margin read)', amount: (-(net - Number(t?.costedNet ?? 0))).toFixed(2) },
      { key: 'landed', label: 'Landed cost', amount: (-Number(t?.landed ?? 0)).toFixed(2) },
      { key: 'margin', label: 'Pocket margin', amount: Number(t?.margin ?? 0).toFixed(2) },
    ];

    const slices: { level: string; label: string; rows: { key: string; label: string; net: string; margin: string | null; marginPct: number | null }[] }[] = [];
    for (const level of [
      { level: 'brand', label: 'Brand', column: sql.raw('f.brand'), labelColumn: sql.raw('f.brand') },
      { level: 'category', label: 'Category', column: sql.raw(`(${CATEGORY_CASE_SQL.replace(/item_name/gu, 'f.item_name')})`), labelColumn: sql.raw(`(${CATEGORY_CASE_SQL.replace(/item_name/gu, 'f.item_name')})`) },
      { level: 'person', label: 'Person', column: sql.raw('f.salesperson_ref'), labelColumn: sql.raw('f.salesperson_ref') },
      { level: 'party', label: 'Customer', column: sql.raw('coalesce(f.party_id::text, f.party_name)'), labelColumn: sql.raw('f.party_name') },
    ]) {
      if (level.level in scope && scope[level.level as keyof SalesScope] !== undefined) continue;
      const rows = await this.db.execute<{ key: string | null; label: string | null; net: string; margin: string | null }>(sql`
        SELECT ${level.column}::text AS key, max(${level.labelColumn}::text) AS label,
               sum(f.net)::numeric(16,2)::text AS net, sum(f.pocket_margin)::numeric(16,2)::text AS margin
        FROM fact_sales_daily f WHERE ${where}
        GROUP BY 1 ORDER BY sum(net) DESC LIMIT 25
      `);
      slices.push({
        level: level.level,
        label: level.label,
        rows: rows.rows.map((r) => ({
          key: r.key ?? 'none',
          label: r.label ?? (r.key ?? 'None'),
          net: r.net,
          margin: r.margin,
          marginPct: r.margin === null || Number(r.net) === 0 ? null : Math.round((Number(r.margin) / Number(r.net)) * 1000) / 10,
        })),
      });
    }

    // M13: zero tolerance, so the offending grains are named, not summed.
    const negatives = await this.db.execute<{ day: string; party: string; item: string; net: string; margin: string }>(sql`
      SELECT f.date::text AS day, f.party_name AS party, f.item_name AS item, f.net::text AS net, f.pocket_margin::text AS margin
      FROM fact_sales_daily f WHERE ${where} AND f.pocket_margin < 0 AND f.voucher_type = 'Sales'
      ORDER BY f.pocket_margin ASC LIMIT 50
    `);
    return { coveragePct, waterfall, slices, negativeGrains: negatives.rows };
  }
}
