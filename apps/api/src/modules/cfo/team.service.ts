import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { AppError } from '../../platform/common/errors.js';
import { PERMISSIONS } from '@vyuha/shared';

import { AuditService } from '../../platform/audit/audit.service.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { hasPermission, type Principal } from '../../platform/rbac/principal.js';
import { sameDayLastYear } from './period/period-resolver.js';
import { readDelta, type DeltaReading } from './robustness.js';
import { CreditControlService } from './credit-control.service.js';
import { type GrowthBridge } from './growth-bridge.js';

/**
 * The league table and targets (brief G4, G5, Phase 3).
 *
 * A person's book is the union the whole module uses: the parties they are
 * relationship manager on, plus the CFO owner map's current assignments.
 * Sales resolve as of voucher date through the same voucher reading every
 * other screen uses, so the league's total ties to the company's — B3's
 * rule, and the reconciliation check's business.
 *
 * A target covering part of the window counts by day fraction: a March
 * target of 31,000 contributes 1,000 a day to a window touching ten of its
 * days. Elapsed-day honesty (B2), applied to the yardstick as well as the
 * figure.
 */

export interface TargetRow {
  readonly ownerRef: string;
  readonly month: string;
  readonly netTarget: string;
}

export interface LeagueRow {
  readonly ownerRef: string;
  readonly ownerEmail: string | null;
  readonly bookSize: number;
  readonly sales: string;
  readonly salesDelta: DeltaReading;
  readonly collections: string;
  readonly overdue: string;
  readonly target: string | null;
  readonly achievementPct: number | null;
  /** Rupees only for cfo.margin.view holders (K3); the basis note is M07's. */
  readonly margin: string | null;
  /** Percent on the caller's own row for everyone; every row for margin.view. */
  readonly marginPct: number | null;
}

export interface RadarAxis {
  readonly axis: string;
  /** 0-100, where 100 is the team's best on that axis; null where the figure is not knowable yet. */
  readonly mine: number | null;
  readonly team: number | null;
  readonly note?: string;
}

export interface Scorecard {
  readonly ownerRef: string;
  readonly ownerEmail: string | null;
  readonly row: LeagueRow;
  readonly teamSize: number;
  readonly radar: readonly RadarAxis[];
  readonly bridge: GrowthBridge;
  readonly movement: Awaited<ReturnType<CreditControlService['movement']>>;
  readonly ageing: Record<string, string>;
  readonly promises: { readonly kept: number; readonly broken: number; readonly open: number };
  readonly activity: { readonly assigned: number; readonly closed: number };
}

const BUCKETS = ['current', '0-30', '31-60', '61-90', '91-180', '180+'] as const;
const MATERIALITY_FLOOR = 25_000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;

function monthDays(month: string): number {
  const [y = 0, m = 1] = month.split('-').map(Number);
  return new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 0)).getUTCDate();
}

/** Days of `month` that fall inside [from, to], inclusive. */
function overlapDays(month: string, from: string, to: string): number {
  const start = `${month}-01`;
  const end = `${month}-${String(monthDays(month)).padStart(2, '0')}`;
  const lo = start > from ? start : from;
  const hi = end < to ? end : to;
  if (lo > hi) return 0;
  return Math.round((Date.parse(hi) - Date.parse(lo)) / 86_400_000) + 1;
}

@Injectable()
export class TeamService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly credit: CreditControlService,
  ) {}

  async listTargets(principal: Principal, month: string): Promise<TargetRow[]> {
    if (!MONTH.test(month)) throw AppError.validation('A target month is YYYY-MM.');
    const rows = await this.db.execute<{ ownerRef: string; month: string; netTarget: string }>(sql`
      SELECT owner_ref AS "ownerRef", month, net_target::text AS "netTarget"
      FROM cfo_targets WHERE org_id = ${principal.orgId} AND month = ${month}
      ORDER BY owner_ref
    `);
    return rows.rows;
  }

  async setTarget(principal: Principal, ownerRef: string, month: string, netTarget: string): Promise<void> {
    if (!MONTH.test(month)) throw AppError.validation('A target month is YYYY-MM.');
    if (!/^(user:[0-9a-f-]{36}|HOUSE|brand:.{1,120})$/u.test(ownerRef)) {
      throw AppError.validation('A target belongs to user:<id>, HOUSE, or brand:<name>.');
    }
    if (!/^\d{1,14}(\.\d{1,2})?$/u.test(netTarget)) {
      throw AppError.validation('A target is a non-negative amount with at most two decimals.');
    }
    const before = await this.db.execute<{ netTarget: string }>(sql`
      SELECT net_target::text AS "netTarget" FROM cfo_targets
      WHERE org_id = ${principal.orgId} AND owner_ref = ${ownerRef} AND month = ${month}
    `);
    await this.db.execute(sql`
      INSERT INTO cfo_targets (org_id, owner_ref, month, net_target)
      VALUES (${principal.orgId}, ${ownerRef}, ${month}, ${netTarget}::numeric)
      ON CONFLICT (org_id, owner_ref, month)
      DO UPDATE SET net_target = ${netTarget}::numeric, updated_at = now()
    `);
    await this.audit.write({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'cfo.target.set',
      entityType: 'cfo_target',
      entityId: `${ownerRef}:${month}`,
      before: before.rows[0] ?? null,
      after: { ownerRef, month, netTarget },
    });
  }

  /** The period's target for one owner: month targets by day overlap. */
  async targetForRange(principal: Principal, ownerRef: string, from: string, to: string): Promise<string | null> {
    const rows = await this.db.execute<{ month: string; netTarget: string }>(sql`
      SELECT month, net_target::text AS "netTarget" FROM cfo_targets
      WHERE org_id = ${principal.orgId} AND owner_ref = ${ownerRef}
        AND month BETWEEN ${from.slice(0, 7)} AND ${to.slice(0, 7)}
    `);
    if (rows.rows.length === 0) return null;
    let total = 0;
    for (const row of rows.rows) {
      const fraction = overlapDays(row.month, from, to) / monthDays(row.month);
      total += Number(row.netTarget) * fraction;
    }
    return total.toFixed(2);
  }

  /**
   * Every book: RM assignments plus the owner map's current rows, one
   * owner per party per source; the union dedupes.
   */
  private async books(principal: Principal): Promise<Map<string, string[]>> {
    const books = await this.db.execute<{ ownerRef: string; partyId: string }>(sql`
      SELECT DISTINCT owner_ref AS "ownerRef", party_id AS "partyId" FROM (
        SELECT 'user:' || u.id AS owner_ref, pm.party_id
        FROM party_managers pm
        JOIN users u ON u.employee_id = pm.manager_id
        WHERE pm.org_id = ${principal.orgId} AND pm.deleted_at IS NULL
        UNION ALL
        SELECT owner_ref, party_id FROM customer_owner_map
        WHERE org_id = ${principal.orgId}
          AND effective_from <= now()::date AND (effective_to IS NULL OR effective_to >= now()::date)
      ) sources
    `);
    const byOwner = new Map<string, string[]>();
    for (const row of books.rows) {
      const list = byOwner.get(row.ownerRef) ?? [];
      list.push(row.partyId);
      byOwner.set(row.ownerRef, list);
    }
    return byOwner;
  }

  async league(principal: Principal, from: string, to: string): Promise<LeagueRow[]> {
    const byOwner = await this.books(principal);
    if (byOwner.size === 0) return [];

    const lyFrom = sameDayLastYear(from);
    const lyTo = sameDayLastYear(to);
    const rows: LeagueRow[] = [];
    for (const [ownerRef, parties] of byOwner) {
      const totals = await this.db.execute<{ kind: string; value: string | null }>(sql`
        SELECT kind, sum(value)::numeric(16,2)::text AS value FROM (
          SELECT CASE WHEN voucher_date BETWEEN ${from} AND ${to} THEN 'sales' ELSE 'salesLy' END AS kind,
                 CASE WHEN voucher_type = 'Sales' THEN abs(amount) ELSE -abs(amount) END AS value
          FROM vouchers
          WHERE org_id = ${principal.orgId} AND is_cancelled = false AND party_id IN ${parties}
            AND voucher_type IN ('Sales', 'Credit Note')
            AND (voucher_date BETWEEN ${from} AND ${to} OR voucher_date BETWEEN ${lyFrom} AND ${lyTo})
          UNION ALL
          SELECT 'collections', abs(amount) FROM vouchers
          WHERE org_id = ${principal.orgId} AND is_cancelled = false AND party_id IN ${parties}
            AND voucher_type = 'Receipt' AND voucher_date BETWEEN ${from} AND ${to}
        ) parts GROUP BY 1
      `);
      const of = (kind: string): number => Number(totals.rows.find((r) => r.kind === kind)?.value ?? 0);

      const overdue = await this.db.execute<{ value: string | null }>(sql`
        WITH latest AS (
          SELECT max(snapshot_date) AS d FROM fact_receivable_snapshot WHERE org_id = ${principal.orgId}
        )
        SELECT sum(CASE WHEN bucket <> 'current' THEN outstanding ELSE 0 END)::numeric(16,2)::text AS value
        FROM fact_receivable_snapshot, latest
        WHERE org_id = ${principal.orgId} AND snapshot_date = latest.d AND party_id IN ${parties}
      `);

      const owner = ownerRef.startsWith('user:')
        ? await this.db.execute<{ email: string }>(sql`
            SELECT email FROM users WHERE id = ${ownerRef.slice(5)} LIMIT 1
          `)
        : { rows: [] as { email: string }[] };

      const sales = of('sales');
      const target = await this.targetForRange(principal, ownerRef, from, to);
      const marginRow = await this.db.execute<{ margin: string | null; net: string | null }>(sql`
        SELECT sum(pocket_margin)::numeric(16,2)::text AS margin,
               sum(net) FILTER (WHERE pocket_margin IS NOT NULL)::numeric(16,2)::text AS net
        FROM fact_sales_daily
        WHERE org_id = ${principal.orgId} AND salesperson_ref = ${ownerRef} AND date BETWEEN ${from} AND ${to}
      `);
      const marginValue = marginRow.rows[0]?.margin ?? null;
      const marginNet = Number(marginRow.rows[0]?.net ?? 0);
      const canRupees = hasPermission(principal, PERMISSIONS.CFO_MARGIN_VIEW);
      const isOwnRow = ownerRef === `user:${principal.userId}`;
      rows.push({
        ownerRef,
        ownerEmail: owner.rows[0]?.email ?? null,
        bookSize: parties.length,
        sales: sales.toFixed(2),
        salesDelta: readDelta(sales, of('salesLy'), MATERIALITY_FLOOR),
        collections: of('collections').toFixed(2),
        overdue: overdue.rows[0]?.value ?? '0.00',
        target,
        achievementPct: target === null || Number(target) === 0 ? null : Math.round((sales / Number(target)) * 100),
        // K3's two deliberate choices, enforced where the row is built.
        margin: canRupees ? marginValue : null,
        marginPct:
          marginValue === null || marginNet === 0 || !(canRupees || isOwnRow)
            ? null
            : Math.round((Number(marginValue) / marginNet) * 1000) / 10,
      });
    }
    return rows.sort((a, b) => Number(b.sales) - Number(a.sales));
  }

  /**
   * G4: one person's full performance. K3: another person's scorecard needs
   * team.view; your own needs only the module key. Every figure is the
   * league's own engine scoped to the book (B3, "same screen, different
   * scope"), so the scorecard never disagrees with the row above it.
   */
  async scorecard(principal: Principal, ownerRef: string, from: string, to: string): Promise<Scorecard> {
    const isSelf = ownerRef === `user:${principal.userId}`;
    if (!isSelf && !hasPermission(principal, PERMISSIONS.CFO_TEAM_VIEW)) {
      throw AppError.forbidden('Another person\u2019s scorecard needs cfo.team.view.');
    }
    const league = await this.league(principal, from, to);
    const row = league.find((r) => r.ownerRef === ownerRef);
    if (row === undefined) throw AppError.notFound('scorecard', ownerRef);
    const book = (await this.books(principal)).get(ownerRef) ?? [];

    const [bridge, movement] = await Promise.all([
      this.credit.bridge(principal, from, to, book),
      this.credit.movement(principal, from, to, book),
    ]);

    // New customers per owner, for the radar: the movement engine again,
    // once per book -- the team is small and the answer is honest.
    const newByOwner = new Map<string, number>();
    for (const [ref, parties] of await this.books(principal)) {
      const cells = ref === ownerRef ? movement : await this.credit.movement(principal, from, to, parties);
      newByOwner.set(ref, cells.cells.filter((c) => c.state === 'new').reduce((n, c) => n + c.count, 0));
    }

    // Activity: tasks assigned to each owner's employee in the window, and
    // how many of those closed.
    const activity = await this.db.execute<{ ownerRef: string; assigned: number; closed: number }>(sql`
      SELECT 'user:' || u.id AS "ownerRef",
             count(*)::int AS assigned,
             count(*) FILTER (WHERE t.closed_at IS NOT NULL)::int AS closed
      FROM tasks t JOIN users u ON u.employee_id = t.assignee_id
      WHERE t.org_id = ${principal.orgId} AND t.deleted_at IS NULL
        AND t.created_at::date BETWEEN ${from} AND ${to}
      GROUP BY 1
    `);
    const activityOf = (ref: string): { assigned: number; closed: number } =>
      activity.rows.find((a) => a.ownerRef === ref) ?? { assigned: 0, closed: 0 };

    const ageingRows = await this.db.execute<{ bucket: string; value: string }>(sql`
      WITH latest AS (
        SELECT max(snapshot_date) AS d FROM fact_receivable_snapshot WHERE org_id = ${principal.orgId}
      )
      SELECT bucket, sum(outstanding)::numeric(16,2)::text AS value
      FROM fact_receivable_snapshot, latest
      WHERE org_id = ${principal.orgId} AND snapshot_date = latest.d AND party_id IN ${book}
      GROUP BY 1
    `);
    const ageing: Record<string, string> = {};
    for (const bucket of BUCKETS) ageing[bucket] = ageingRows.rows.find((r) => r.bucket === bucket)?.value ?? '0.00';

    const promises = await this.db.execute<{ state: string; n: number }>(sql`
      SELECT state, count(*)::int AS n FROM promises_to_pay
      WHERE org_id = ${principal.orgId} AND deleted_at IS NULL AND party_id IN ${book}
        AND promised_date BETWEEN ${from} AND ${to}
      GROUP BY 1
    `);
    const promiseOf = (state: string): number => promises.rows.find((p) => p.state === state)?.n ?? 0;

    // Radar: each axis as a share of the team's best, so a glance separates
    // the discounting volume seller from the disciplined one (G4). Margin
    // waits for the valuation decision and says so.
    const growthOf = (r: LeagueRow): number => (r.salesDelta.kind === 'pct' ? Math.max(r.salesDelta.deltaPct, 0) : 0);
    const closedRatio = (ref: string): number => {
      const a = activityOf(ref);
      return a.assigned === 0 ? 0 : a.closed / a.assigned;
    };
    const axis = (name: string, value: (r: LeagueRow) => number, note?: string): RadarAxis => {
      const values = league.map(value);
      const best = Math.max(...values, 0);
      const mean = values.reduce((sum, v) => sum + v, 0) / Math.max(values.length, 1);
      const pct = (v: number): number => (best === 0 ? 0 : Math.round((v / best) * 100));
      return { axis: name, mine: pct(value(row)), team: pct(mean), ...(note === undefined ? {} : { note }) };
    };
    const radar: RadarAxis[] = [
      axis('Sales', (r) => Number(r.sales)),
      axis('Growth', growthOf),
      axis('Collections', (r) => Number(r.collections)),
      hasPermission(principal, PERMISSIONS.CFO_MARGIN_VIEW) || isSelf
        ? axis('Margin %', (r) => r.marginPct ?? 0, 'On the Tally item-cost basis (M07)')
        : { axis: 'Margin', mine: null, team: null, note: 'Needs cfo.margin.view' },
      axis('New customers', (r) => newByOwner.get(r.ownerRef) ?? 0),
      axis('Activity', (r) => closedRatio(r.ownerRef)),
    ];

    return {
      ownerRef,
      ownerEmail: row.ownerEmail,
      row,
      teamSize: league.length,
      radar,
      bridge,
      movement,
      ageing,
      promises: { kept: promiseOf('kept') + promiseOf('partially_kept'), broken: promiseOf('broken'), open: promiseOf('open') },
      activity: activityOf(ownerRef),
    };
  }
}
