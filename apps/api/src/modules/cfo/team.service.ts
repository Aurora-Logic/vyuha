import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { AppError } from '../../platform/common/errors.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { type Principal } from '../../platform/rbac/principal.js';
import { sameDayLastYear } from './period/period-resolver.js';
import { readDelta, type DeltaReading } from './robustness.js';

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
}

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
    if (!/^(user:[0-9a-f-]{36}|HOUSE)$/u.test(ownerRef)) {
      throw AppError.validation('A target belongs to user:<id> or HOUSE.');
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

  async league(principal: Principal, from: string, to: string): Promise<LeagueRow[]> {
    // Every book: RM assignments plus the owner map's current rows, one
    // owner per party per source; the union dedupes.
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
    if (byOwner.size === 0) return [];

    const lyFrom = sameDayLastYear(from);
    const lyTo = sameDayLastYear(to);
    const rows: LeagueRow[] = [];
    for (const [ownerRef, parties] of byOwner) {
      const totals = await this.db.execute<{ kind: string; value: string | null }>(sql`
        SELECT kind, sum(value)::numeric(16,2)::text AS value FROM (
          SELECT CASE WHEN voucher_date BETWEEN ${from} AND ${to} THEN 'sales' ELSE 'salesLy' END AS kind,
                 CASE WHEN voucher_type = 'Sales' THEN amount ELSE -amount END AS value
          FROM vouchers
          WHERE org_id = ${principal.orgId} AND is_cancelled = false AND party_id IN ${parties}
            AND voucher_type IN ('Sales', 'Credit Note')
            AND (voucher_date BETWEEN ${from} AND ${to} OR voucher_date BETWEEN ${lyFrom} AND ${lyTo})
          UNION ALL
          SELECT 'collections', amount FROM vouchers
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
      });
    }
    return rows.sort((a, b) => Number(b.sales) - Number(a.sales));
  }
}
