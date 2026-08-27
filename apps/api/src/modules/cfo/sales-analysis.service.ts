import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { PERMISSIONS } from '@vyuha/shared';

import { AppError } from '../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { hasPermission, type Principal } from '../../platform/rbac/principal.js';
import { sameDayLastYear } from './period/period-resolver.js';
import { readDelta, type DeltaReading } from './robustness.js';

/**
 * Sales Analysis, level-aware (brief B3, Phase 3 item 14): one metric
 * engine, every scope. The scope is a set of filters -- brand, person,
 * customer, product -- that carry down a drill and show as a breadcrumb;
 * Company is the empty set. Every figure comes from fact_sales_daily, the
 * ex-GST fact that reconciles to the paisa, so a person's total here is
 * the same number the league prints.
 *
 * Unattributed sales are never dropped: their size travels with every
 * answer as the footer KPI B3 asks for.
 */

export interface SalesScope {
  readonly brand?: string;
  readonly person?: string;
  readonly party?: string;
  readonly item?: string;
}

export interface BreakdownRow {
  readonly key: string;
  readonly label: string;
  readonly net: string;
  readonly lastYear: string;
  readonly qty: string;
  readonly vouchers: number;
}

export interface SalesAnalysis {
  readonly scope: readonly { level: string; key: string; label: string }[];
  readonly summary: {
    readonly net: string;
    readonly lastYear: string;
    readonly delta: DeltaReading;
    readonly qty: string;
    readonly customers: number;
    readonly vouchers: number;
    readonly unassignedNet: string;
    /** Unassigned as a share of the company's net for the window, in percent. */
    readonly unassignedPct: number;
  };
  readonly trend: readonly { t: string; net: number; lastYear: number }[];
  readonly breakdowns: readonly { level: string; label: string; rows: readonly BreakdownRow[] }[];
}

const MATERIALITY_FLOOR = 25_000;

const LEVELS: readonly { level: keyof SalesScope; label: string; column: string; labelColumn: string }[] = [
  { level: 'brand', label: 'Brand', column: 'brand', labelColumn: 'brand' },
  { level: 'person', label: 'Person', column: 'salesperson_ref', labelColumn: 'salesperson_ref' },
  { level: 'party', label: 'Customer', column: 'party_id', labelColumn: 'party_name' },
  { level: 'item', label: 'Product', column: 'item_id', labelColumn: 'item_name' },
];

@Injectable()
export class SalesAnalysisService {
  constructor(@InjectDatabase() private readonly db: Database) {}

  private where(principal: Principal, scope: SalesScope, from: string, to: string): SQL {
    const parts: SQL[] = [sql`org_id = ${principal.orgId} AND date BETWEEN ${from} AND ${to}`];
    if (scope.brand !== undefined) parts.push(sql`brand = ${scope.brand}`);
    if (scope.person !== undefined) parts.push(sql`salesperson_ref = ${scope.person}`);
    if (scope.party !== undefined) parts.push(sql`party_id = ${scope.party}`);
    if (scope.item !== undefined) parts.push(sql`item_id = ${scope.item}`);
    return sql.join(parts, sql` AND `);
  }

  async analyse(principal: Principal, from: string, to: string, scope: SalesScope): Promise<SalesAnalysis> {
    // K3: a person's detail beyond your own needs team.view.
    if (scope.person !== undefined && scope.person !== `user:${principal.userId}` && !hasPermission(principal, PERMISSIONS.CFO_TEAM_VIEW)) {
      throw AppError.forbidden('Another person’s sales need cfo.team.view.');
    }
    const lyFrom = sameDayLastYear(from);
    const lyTo = sameDayLastYear(to);
    const ty = this.where(principal, scope, from, to);
    const ly = this.where(principal, scope, lyFrom, lyTo);

    const totals = await this.db.execute<{ net: string | null; qty: string | null; customers: number; vouchers: number }>(sql`
      SELECT sum(net)::numeric(16,2)::text AS net, sum(qty)::numeric(16,3)::text AS qty,
             count(DISTINCT party_id)::int AS customers, coalesce(sum(voucher_count), 0)::int AS vouchers
      FROM fact_sales_daily WHERE ${ty}
    `);
    const lastYear = await this.db.execute<{ net: string | null }>(sql`
      SELECT sum(net)::numeric(16,2)::text AS net FROM fact_sales_daily WHERE ${ly}
    `);
    const company = await this.db.execute<{ net: string | null; unassigned: string | null }>(sql`
      SELECT sum(net)::numeric(16,2)::text AS net,
             sum(net) FILTER (WHERE salesperson_ref = 'UNASSIGNED')::numeric(16,2)::text AS unassigned
      FROM fact_sales_daily WHERE org_id = ${principal.orgId} AND date BETWEEN ${from} AND ${to}
    `);

    const trendRows = await this.db.execute<{ t: string; net: string; lastYear: string }>(sql`
      SELECT t::text, sum(net)::numeric(16,2)::text AS net, sum(ly)::numeric(16,2)::text AS "lastYear" FROM (
        SELECT date AS t, net, 0 AS ly FROM fact_sales_daily WHERE ${ty}
        UNION ALL
        SELECT (date + interval '1 year')::date AS t, 0 AS net, net AS ly FROM fact_sales_daily WHERE ${ly}
      ) days GROUP BY 1 ORDER BY 1
    `);

    const breakdowns: { level: string; label: string; rows: BreakdownRow[] }[] = [];
    for (const level of LEVELS) {
      if (scope[level.level] !== undefined) continue;
      const col = sql.raw(level.column);
      const labelCol = sql.raw(level.labelColumn);
      const rows = await this.db.execute<{ key: string | null; label: string | null; net: string; lastYear: string; qty: string; vouchers: number }>(sql`
        SELECT key, max(label) AS label, sum(net)::numeric(16,2)::text AS net, sum(ly)::numeric(16,2)::text AS "lastYear",
               sum(qty)::numeric(16,3)::text AS qty, sum(vouchers)::int AS vouchers FROM (
          SELECT ${col}::text AS key, ${labelCol}::text AS label, net, 0 AS ly, qty, voucher_count AS vouchers
          FROM fact_sales_daily WHERE ${ty}
          UNION ALL
          SELECT ${col}::text, ${labelCol}::text, 0, net, 0, 0 FROM fact_sales_daily WHERE ${ly}
        ) grains GROUP BY 1 ORDER BY sum(net) DESC
      `);
      breakdowns.push({
        level: level.level,
        label: level.label,
        rows: rows.rows.map((r) => ({
          key: r.key ?? '',
          label: r.label ?? (r.key ?? 'Unknown'),
          net: r.net,
          lastYear: r.lastYear,
          qty: r.qty,
          vouchers: r.vouchers,
        })),
      });
    }
    // People are stored as refs; the screen wants names.
    const people = breakdowns.find((b) => b.level === 'person');
    if (people !== undefined) {
      const ids = people.rows.map((r) => r.key).filter((k) => k.startsWith('user:')).map((k) => k.slice(5));
      const emails = ids.length === 0
        ? { rows: [] as { id: string; email: string }[] }
        : await this.db.execute<{ id: string; email: string }>(sql`SELECT id, email FROM users WHERE id IN ${ids}`);
      const emailOf = new Map(emails.rows.map((r) => [r.id, r.email]));
      people.rows = people.rows.map((r) => ({
        ...r,
        label: r.key === 'UNASSIGNED' ? 'Unassigned' : r.key === 'HOUSE' ? 'House' : (emailOf.get(r.key.slice(5))?.split('@')[0] ?? r.label),
      }));
    }

    const scopeCrumbs = await this.describeScope(principal, scope);
    const net = Number(totals.rows[0]?.net ?? 0);
    const companyNet = Number(company.rows[0]?.net ?? 0);
    const unassigned = Number(company.rows[0]?.unassigned ?? 0);
    return {
      scope: scopeCrumbs,
      summary: {
        net: net.toFixed(2),
        lastYear: Number(lastYear.rows[0]?.net ?? 0).toFixed(2),
        delta: readDelta(net, Number(lastYear.rows[0]?.net ?? 0), MATERIALITY_FLOOR),
        qty: totals.rows[0]?.qty ?? '0.000',
        customers: totals.rows[0]?.customers ?? 0,
        vouchers: totals.rows[0]?.vouchers ?? 0,
        unassignedNet: unassigned.toFixed(2),
        unassignedPct: companyNet === 0 ? 0 : Math.round((unassigned / companyNet) * 1000) / 10,
      },
      trend: trendRows.rows.map((r) => ({ t: r.t, net: Number(r.net), lastYear: Number(r.lastYear) })),
      breakdowns,
    };
  }

  /** The breadcrumb's words for each fixed level, looked up once. */
  private async describeScope(principal: Principal, scope: SalesScope): Promise<{ level: string; key: string; label: string }[]> {
    const crumbs: { level: string; key: string; label: string }[] = [];
    if (scope.brand !== undefined) crumbs.push({ level: 'brand', key: scope.brand, label: scope.brand });
    if (scope.person !== undefined) {
      const email = scope.person.startsWith('user:')
        ? await this.db.execute<{ email: string }>(sql`SELECT email FROM users WHERE id = ${scope.person.slice(5)} LIMIT 1`)
        : { rows: [] as { email: string }[] };
      const label = scope.person === 'UNASSIGNED' ? 'Unassigned' : scope.person === 'HOUSE' ? 'House' : (email.rows[0]?.email.split('@')[0] ?? scope.person);
      crumbs.push({ level: 'person', key: scope.person, label });
    }
    if (scope.party !== undefined) {
      const party = await this.db.execute<{ name: string }>(sql`SELECT name FROM parties WHERE org_id = ${principal.orgId} AND id = ${scope.party} LIMIT 1`);
      crumbs.push({ level: 'party', key: scope.party, label: party.rows[0]?.name ?? 'Customer' });
    }
    if (scope.item !== undefined) {
      const item = await this.db.execute<{ name: string }>(sql`SELECT name FROM stock_items WHERE org_id = ${principal.orgId} AND id = ${scope.item} LIMIT 1`);
      crumbs.push({ level: 'item', key: scope.item, label: item.rows[0]?.name ?? 'Product' });
    }
    return crumbs;
  }
}
