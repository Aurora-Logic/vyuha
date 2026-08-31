import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { type Principal } from '../../platform/rbac/principal.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { CATEGORIES, CATEGORY_CASE_SQL } from './category.js';

/**
 * The penetration grid (brief Q2.10): customer x category, the whitespace
 * map. A filled cell is what they buy from us; an empty one is what they
 * buy from someone else. For a five-category distributor this is the most
 * actionable grid in the module, and it needs no modelling -- only a join.
 * Every cell carries count and rupees (Q2's rendering rule); row and
 * column totals tie to the grid.
 */

export interface PenetrationCell {
  readonly partyId: string;
  readonly category: string;
  /** Distinct items bought in the window. */
  readonly count: number;
  readonly amount: string;
}

export interface Penetration {
  readonly from: string;
  readonly to: string;
  readonly categories: readonly string[];
  readonly customers: readonly { partyId: string; party: string; total: string; filled: number }[];
  readonly cells: readonly PenetrationCell[];
  readonly columnTotals: Record<string, { count: number; amount: string }>;
}

const TOP_CUSTOMERS = 50;

@Injectable()
export class PenetrationService {
  constructor(@InjectDatabase() private readonly db: Database) {}

  async read(principal: Principal, from?: string, to?: string): Promise<Penetration> {
    const end = to ?? istDateOf(new Date().toISOString());
    const start = from ?? new Date(Date.parse(end) - 365 * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.db.execute<{ partyId: string; party: string; category: string; count: number; amount: string }>(sql`
      SELECT v.party_id AS "partyId", max(v.party_name) AS party,
             (${sql.raw(CATEGORY_CASE_SQL.replace(/item_name/gu, 'l.stock_item_name'))}) AS category,
             count(DISTINCT coalesce(l.stock_item_id::text, l.stock_item_name))::int AS count,
             sum(abs(l.amount))::numeric(16,2)::text AS amount
      FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
      WHERE v.org_id = ${principal.orgId} AND v.is_cancelled = false AND v.voucher_type = 'Sales'
        AND v.party_id IS NOT NULL AND l.kind = 'inventory' AND v.voucher_date BETWEEN ${start} AND ${end}
      GROUP BY 1, 3
    `);
    const byParty = new Map<string, { party: string; total: number; filled: number }>();
    for (const r of rows.rows) {
      const entry = byParty.get(r.partyId) ?? { party: r.party, total: 0, filled: 0 };
      entry.total += Number(r.amount);
      entry.filled += 1;
      byParty.set(r.partyId, entry);
    }
    const customers = [...byParty.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, TOP_CUSTOMERS)
      .map(([partyId, e]) => ({ partyId, party: e.party, total: e.total.toFixed(2), filled: e.filled }));
    const kept = new Set(customers.map((c) => c.partyId));
    const cells = rows.rows
      .filter((r) => kept.has(r.partyId))
      .map((r) => ({ partyId: r.partyId, category: r.category, count: r.count, amount: r.amount }));
    const columnTotals: Record<string, { count: number; amount: string }> = {};
    for (const category of CATEGORIES) {
      const inColumn = cells.filter((c) => c.category === category);
      columnTotals[category] = {
        count: inColumn.length,
        amount: inColumn.reduce((sum, c) => sum + Number(c.amount), 0).toFixed(2),
      };
    }
    return { from: start, to: end, categories: [...CATEGORIES], customers, cells, columnTotals };
  }
}
