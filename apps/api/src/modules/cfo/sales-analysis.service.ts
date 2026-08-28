import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { PERMISSIONS, type PivotSpec } from '@vyuha/shared';

import { AppError } from '../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { hasPermission, type Principal } from '../../platform/rbac/principal.js';
import { sameDayLastYear } from './period/period-resolver.js';
import { CATEGORY_CASE_SQL } from './category.js';
import { ExprError, evaluate, measuresOf, parseExpression, unitOf, type ExprNode } from './pivot-expression.js';
import { readDelta, type DeltaReading } from './robustness.js';
import { TierService } from './tier.service.js';

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

export interface PivotResult {
  readonly rows: readonly { key: string; label: string; total: number }[];
  readonly columns: readonly { key: string; label: string; total: number }[];
  readonly cells: readonly { row: string; column: string; value: number }[];
  readonly grandTotal: number;
  readonly metric: string;
  readonly unit: 'money' | 'count' | 'ratio';
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
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly tiers: TierService,
  ) {}

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

  /**
   * S1.1: rows x columns x one metric, at the same scope the analysis
   * uses. Dimensions map to the fact's columns; category is read off the
   * item name and class resolved as of the window's end. Rows beyond
   * `top` fold into "Other" so a 900-customer pivot stays a screen.
   */
  async pivot(principal: Principal, from: string, to: string, scope: SalesScope, spec: PivotSpec & { expr?: string }): Promise<PivotResult> {
    if (scope.person !== undefined && scope.person !== `user:${principal.userId}` && !hasPermission(principal, PERMISSIONS.CFO_TEAM_VIEW)) {
      throw AppError.forbidden('Another person’s sales need cfo.team.view.');
    }
    // K3: rupee margin is a separate sight. The proxy note lives in the registry (M07).
    // S1.2: a calculated field is an expression over registered measures,
    // parsed and unit-checked before any SQL is written.
    let expr: ExprNode | null = null;
    if (spec.expr !== undefined) {
      try {
        expr = parseExpression(spec.expr);
      } catch (error) {
        if (error instanceof ExprError) throw AppError.validation(error.message);
        throw error;
      }
    }
    const usedMeasures = expr === null ? [spec.metric] : measuresOf(expr);
    if (usedMeasures.length === 0) throw AppError.validation('The formula must use at least one measure.');
    if (usedMeasures.some((m) => m === 'margin' || m === 'landed') && !hasPermission(principal, PERMISSIONS.CFO_MARGIN_VIEW)) {
      throw AppError.forbidden('Margin in rupees needs cfo.margin.view.');
    }
    const metricSql: Record<PivotSpec['metric'], string> = {
      net: 'sum(net)', gross: 'sum(gross)', discount: 'sum(discount)', returns: 'sum(returns)', qty: 'sum(qty)', vouchers: 'sum(voucher_count)',
      landed: 'sum(landed_cost)', margin: 'sum(pocket_margin)',
    };
    const dimSql = (d: string, alias: string): string => {
      switch (d) {
        case 'party': return `coalesce(party_id::text, party_name) AS ${alias}_key, party_name AS ${alias}_label`;
        case 'brand': return `brand AS ${alias}_key, brand AS ${alias}_label`;
        case 'item': return `coalesce(item_id::text, item_name) AS ${alias}_key, item_name AS ${alias}_label`;
        case 'category': return `(${CATEGORY_CASE_SQL}) AS ${alias}_key, (${CATEGORY_CASE_SQL}) AS ${alias}_label`;
        case 'salesperson': return `salesperson_ref AS ${alias}_key, salesperson_ref AS ${alias}_label`;
        case 'class': return `party_id::text AS ${alias}_key, party_id::text AS ${alias}_label`;
        case 'month': return `to_char(date, 'YYYY-MM') AS ${alias}_key, to_char(date, 'YYYY-MM') AS ${alias}_label`;
        case 'business_line': return `business_line AS ${alias}_key, business_line AS ${alias}_label`;
        default: return `'all' AS ${alias}_key, 'All' AS ${alias}_label`;
      }
    };
    const compare = spec.columns === 'compare';
    const colDim = compare || spec.columns === null ? null : spec.columns;
    const lyFrom = sameDayLastYear(from);
    const lyTo = sameDayLastYear(to);

    const valueSelect = usedMeasures.map((m, i) => `${metricSql[m]}::numeric(18,3)::text AS v${String(i)}`).join(', ');
    const query = async (f: string, t: string, colKey: string) =>
      this.db.execute<{ rKey: string | null; rLabel: string | null; cKey: string | null; cLabel: string | null } & Record<string, string | null>>(sql`
        SELECT r_key AS "rKey", max(r_label) AS "rLabel", c_key AS "cKey", max(c_label) AS "cLabel", ${sql.raw(valueSelect)} FROM (
          SELECT ${sql.raw(dimSql(spec.rows, 'r'))},
                 ${sql.raw(colDim === null ? `'${colKey}' AS c_key, '${colKey}' AS c_label` : dimSql(colDim, 'c'))},
                 net, gross, discount, returns, qty, voucher_count
          FROM fact_sales_daily WHERE ${this.where(principal, scope, f, t)}
        ) g GROUP BY 1, 3
      `);
    const results = compare
      ? [...(await query(from, to, 'ty')).rows, ...(await query(lyFrom, lyTo, 'ly')).rows]
      : (await query(from, to, 'all')).rows;

    // Labels that live outside the fact: people, classes.
    const labelOf = new Map<string, string>();
    const needsPeople = spec.rows === 'salesperson' || colDim === 'salesperson';
    const needsClass = spec.rows === 'class' || colDim === 'class';
    if (needsPeople) {
      const ids = [...new Set(results.flatMap((r) => [r.rKey, r.cKey]).filter((k): k is string => k !== null && k.startsWith('user:')))].map((k) => k.slice(5));
      const users = ids.length === 0 ? { rows: [] as { id: string; email: string }[] } : await this.db.execute<{ id: string; email: string }>(sql`SELECT id, email FROM users WHERE id IN ${ids}`);
      for (const u of users.rows) labelOf.set(`user:${u.id}`, u.email.split('@')[0] ?? u.email);
      labelOf.set('UNASSIGNED', 'Unassigned');
      labelOf.set('HOUSE', 'House');
    }
    const classOf = needsClass
      ? await this.tiers.classAsOf(principal.orgId, [...new Set(results.flatMap((r) => [r.rKey, r.cKey]).filter((k): k is string => k !== null))], to)
      : new Map<string, string>();
    const resolve = (dim: string | null, key: string | null, label: string | null): { key: string; label: string } => {
      if (key === null) return { key: 'none', label: 'None' };
      if (dim === 'class') { const c = classOf.get(key) ?? 'Unclassed'; return { key: c, label: c }; }
      if (dim === 'salesperson') return { key, label: labelOf.get(key) ?? label ?? key };
      if (compare && dim === null) return { key, label: key === 'ty' ? 'This period' : 'Same days last year' };
      return { key, label: label ?? key };
    };

    const sums = new Map<string, (number | null)[]>();
    const rowLabels = new Map<string, string>();
    const colLabels = new Map<string, string>();
    for (const r of results) {
      const row = resolve(spec.rows, r.rKey, r.rLabel);
      const col = resolve(colDim, r.cKey, r.cLabel);
      rowLabels.set(row.key, row.label);
      colLabels.set(col.key, col.label);
      const k = `${row.key}\u0000${col.key}`;
      const acc = sums.get(k) ?? usedMeasures.map(() => null as number | null);
      usedMeasures.forEach((_, i) => {
        const v = (r as Record<string, string | null>)[`v${String(i)}`];
        if (v !== null && v !== undefined) acc[i] = (acc[i] ?? 0) + Number(v);
      });
      sums.set(k, acc);
    }
    const cellMap = new Map<string, number>();
    for (const [k, acc] of sums) {
      let value: number | null;
      if (expr === null) value = acc[0] ?? null;
      else {
        const named: Partial<Record<PivotSpec['metric'], number | null>> = {};
        usedMeasures.forEach((m, i) => { named[m] = acc[i]; });
        value = evaluate(expr, named);
      }
      if (value !== null) cellMap.set(k, value);
    }
    const rowTotal = new Map<string, number>();
    const colTotal = new Map<string, number>();
    for (const [k, v] of cellMap) {
      const [rk, ck] = k.split('\u0000');
      rowTotal.set(rk ?? '', (rowTotal.get(rk ?? '') ?? 0) + v);
      colTotal.set(ck ?? '', (colTotal.get(ck ?? '') ?? 0) + v);
    }
    // Top rows by total; the rest fold into Other, which still ties.
    const ranked = [...rowTotal.entries()].sort((a, b) => b[1] - a[1]);
    const kept = ranked.slice(0, spec.top).map(([k]) => k);
    const folded = ranked.slice(spec.top).map(([k]) => k);
    const rowKeyOf = (k: string): string => (folded.includes(k) ? 'other' : k);
    const cells = new Map<string, number>();
    for (const [k, v] of cellMap) {
      const [rk, ck] = k.split('\u0000');
      const key = `${rowKeyOf(rk ?? '')}\u0000${ck ?? ''}`;
      cells.set(key, (cells.get(key) ?? 0) + v);
    }
    const rows = [...kept.map((k) => ({ key: k, label: rowLabels.get(k) ?? k, total: round3(rowTotal.get(k) ?? 0) })),
      ...(folded.length > 0 ? [{ key: 'other', label: `Other (${String(folded.length)})`, total: round3(folded.reduce((s, k) => s + (rowTotal.get(k) ?? 0), 0)) }] : [])];
    const columns = [...colLabels.entries()]
      .map(([k, label]) => ({ key: k, label, total: round3(colTotal.get(k) ?? 0) }))
      .sort((a, b) => (colDim === 'month' || compare ? a.key.localeCompare(b.key) : b.total - a.total));
    return {
      rows,
      columns,
      cells: [...cells.entries()].map(([k, v]) => { const [row, column] = k.split('\u0000'); return { row: row ?? '', column: column ?? '', value: round3(v) }; }),
      grandTotal: round3([...rowTotal.values()].reduce((s, v) => s + v, 0)),
      metric: spec.expr ?? spec.metric,
      unit: expr !== null
        ? (() => { const u = unitOf(expr); return u === 'money' ? 'money' : u === 'count' ? 'count' : 'ratio'; })()
        : spec.metric === 'qty' || spec.metric === 'vouchers' ? 'count' : 'money',
    };
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
