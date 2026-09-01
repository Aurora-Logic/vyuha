import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { type Principal } from '../../platform/rbac/principal.js';
import { readDelta, type DeltaReading } from './robustness.js';
import { TeamService } from './team.service.js';

/**
 * My CFO (brief G3): what one person sees about their own book — the screen
 * that makes the sales team open the module voluntarily. Everything scopes
 * to "my customers": the parties I am relationship manager on, plus any the
 * CFO owner map currently assigns me. History still resolves as of voucher
 * date everywhere else; this screen is about NOW, so the book is today's.
 *
 * What it deliberately does not show yet, and says so rather than faking:
 * real profit, blocked on the valuation method (M1). Target progress
 * arrived with Phase 3's targets -- null until someone sets one. Q1.1 applies to the deltas — a customer below the
 * materiality floor gets a rupee change, never a percentage.
 */

const MATERIALITY_FLOOR = 25_000;

export interface MyCustomerRow {
  readonly partyId: string;
  readonly party: string;
  readonly thisPeriod: string;
  readonly lastYear: string;
  readonly change: DeltaReading;
  readonly overdue: string;
  readonly daysOverdue: number;
  readonly daysSinceLastOrder: number | null;
}

export interface MyCfo {
  readonly bookSize: number;
  readonly mySales: string;
  readonly salesDelta: DeltaReading;
  readonly myCollections: string;
  readonly myOverdue: string;
  readonly overdueParties: number;
  readonly delayCostPerYear: string;
  readonly target: string | null;
  readonly achievementPct: number | null;
  /** Percent on the own book (K3); null while the book's grains carry no cost. */
  readonly marginPct: number | null;
  readonly pacing: readonly { t: string; cumulative: number; lastYear: number }[];
  readonly customers: readonly MyCustomerRow[];
}

@Injectable()
export class MyCfoService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly team: TeamService,
  ) {}

  /** The party ids this principal answers for, RM assignment first. */
  private async bookOf(principal: Principal): Promise<string[]> {
    const viaRm =
      principal.employeeId === null
        ? { rows: [] as { partyId: string }[] }
        : await this.db.execute<{ partyId: string }>(sql`
            SELECT party_id AS "partyId" FROM party_managers
            WHERE org_id = ${principal.orgId} AND manager_id = ${principal.employeeId} AND deleted_at IS NULL
          `);
    const viaMap = await this.db.execute<{ partyId: string }>(sql`
      SELECT party_id AS "partyId" FROM customer_owner_map
      WHERE org_id = ${principal.orgId} AND owner_ref = ${'user:' + principal.userId}
        AND effective_from <= now()::date AND (effective_to IS NULL OR effective_to >= now()::date)
    `);
    return [...new Set([...viaRm.rows.map((r) => r.partyId), ...viaMap.rows.map((r) => r.partyId)])];
  }

  async read(principal: Principal, from: string, to: string): Promise<MyCfo> {
    const book = await this.bookOf(principal);
    if (book.length === 0) {
      return {
        bookSize: 0,
        mySales: '0.00',
        salesDelta: { kind: 'none', reason: 'no-data' },
        myCollections: '0.00',
        myOverdue: '0.00',
        overdueParties: 0,
        delayCostPerYear: '0.00',
        target: null,
        achievementPct: null,
        marginPct: null,
        pacing: [],
        customers: [],
      };
    }

    const today = istDateOf(new Date().toISOString());
    const rate = (await this.settings.read(principal)).interest.annualRatePct;

    // Net sales and collections over the period, and the same elapsed window
    // a year back for the honest comparison (B2).
    const totals = await this.db.execute<{ kind: string; value: string }>(sql`
      SELECT kind, sum(value)::numeric(16,2)::text AS value FROM (
        SELECT 'sales' AS kind,
               CASE WHEN voucher_type = 'Sales' THEN abs(amount) ELSE -abs(amount) END AS value
        FROM vouchers
        WHERE org_id = ${principal.orgId} AND is_cancelled = false AND party_id IN ${book}
          AND voucher_type IN ('Sales', 'Credit Note') AND voucher_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'salesLy' AS kind,
               CASE WHEN voucher_type = 'Sales' THEN abs(amount) ELSE -abs(amount) END AS value
        FROM vouchers
        WHERE org_id = ${principal.orgId} AND is_cancelled = false AND party_id IN ${book}
          AND voucher_type IN ('Sales', 'Credit Note')
          AND voucher_date BETWEEN (${from}::date - interval '1 year') AND (${to}::date - interval '1 year')
        UNION ALL
        SELECT 'collections' AS kind, abs(amount) AS value
        FROM vouchers
        WHERE org_id = ${principal.orgId} AND is_cancelled = false AND party_id IN ${book}
          AND voucher_type = 'Receipt' AND voucher_date BETWEEN ${from} AND ${to}
      ) parts GROUP BY 1
    `);
    const totalOf = (kind: string): number => Number(totals.rows.find((r) => r.kind === kind)?.value ?? 0);
    const mySales = totalOf('sales');
    const salesLy = totalOf('salesLy');

    // The overdue book from the latest photograph, mine only.
    const overdue = await this.db.execute<{ overdue: string | null; parties: number }>(sql`
      WITH latest AS (
        SELECT max(snapshot_date) AS d FROM fact_receivable_snapshot WHERE org_id = ${principal.orgId}
      )
      SELECT sum(CASE WHEN bucket <> 'current' THEN outstanding ELSE 0 END)::numeric(16,2)::text AS overdue,
             count(DISTINCT party_id) FILTER (WHERE bucket <> 'current')::int AS parties
      FROM fact_receivable_snapshot, latest
      WHERE org_id = ${principal.orgId} AND snapshot_date = latest.d AND party_id IN ${book}
    `);
    const myOverdue = Number(overdue.rows[0]?.overdue ?? 0);

    // Month pacing: my cumulative net this period against the same days LY.
    const daily = await this.db.execute<{ day: string; ty: string; ly: string }>(sql`
      SELECT day::text, sum(ty)::numeric(16,2)::text AS ty, sum(ly)::numeric(16,2)::text AS ly FROM (
        SELECT voucher_date AS day,
               CASE WHEN voucher_type = 'Sales' THEN abs(amount) ELSE -abs(amount) END AS ty,
               0 AS ly
        FROM vouchers
        WHERE org_id = ${principal.orgId} AND is_cancelled = false AND party_id IN ${book}
          AND voucher_type IN ('Sales', 'Credit Note') AND voucher_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT (voucher_date + interval '1 year')::date AS day,
               0 AS ty,
               CASE WHEN voucher_type = 'Sales' THEN abs(amount) ELSE -abs(amount) END AS ly
        FROM vouchers
        WHERE org_id = ${principal.orgId} AND is_cancelled = false AND party_id IN ${book}
          AND voucher_type IN ('Sales', 'Credit Note')
          AND voucher_date BETWEEN (${from}::date - interval '1 year') AND (${to}::date - interval '1 year')
      ) days GROUP BY 1 ORDER BY 1
    `);
    let runTy = 0;
    let runLy = 0;
    const pacing = daily.rows.map((row) => {
      runTy += Number(row.ty);
      runLy += Number(row.ly);
      return { t: row.day, cumulative: Math.round(runTy * 100) / 100, lastYear: Math.round(runLy * 100) / 100 };
    });

    // Row three: the customers themselves.
    const perParty = await this.db.execute<{
      partyId: string;
      party: string;
      ty: string;
      ly: string;
      lastOrder: string | null;
    }>(sql`
      SELECT v.party_id AS "partyId", max(v.party_name) AS party,
             sum(CASE WHEN v.voucher_date BETWEEN ${from} AND ${to}
                      THEN (CASE WHEN v.voucher_type = 'Sales' THEN abs(v.amount) ELSE -abs(v.amount) END) ELSE 0 END)::numeric(16,2)::text AS ty,
             sum(CASE WHEN v.voucher_date BETWEEN (${from}::date - interval '1 year') AND (${to}::date - interval '1 year')
                      THEN (CASE WHEN v.voucher_type = 'Sales' THEN abs(v.amount) ELSE -abs(v.amount) END) ELSE 0 END)::numeric(16,2)::text AS ly,
             max(v.voucher_date) FILTER (WHERE v.voucher_type = 'Sales')::text AS "lastOrder"
      FROM vouchers v
      WHERE v.org_id = ${principal.orgId} AND v.is_cancelled = false AND v.party_id IN ${book}
        AND v.voucher_type IN ('Sales', 'Credit Note')
      GROUP BY 1
    `);
    const partyOverdue = await this.db.execute<{ partyId: string; overdue: string; days: number }>(sql`
      WITH latest AS (
        SELECT max(snapshot_date) AS d FROM fact_receivable_snapshot WHERE org_id = ${principal.orgId}
      )
      SELECT party_id AS "partyId",
             sum(CASE WHEN bucket <> 'current' THEN outstanding ELSE 0 END)::numeric(16,2)::text AS overdue,
             max(days_overdue)::int AS days
      FROM fact_receivable_snapshot, latest
      WHERE org_id = ${principal.orgId} AND snapshot_date = latest.d AND party_id IN ${book}
      GROUP BY 1
    `);
    const overdueByParty = new Map(partyOverdue.rows.map((r) => [r.partyId, r]));

    const dayGap = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    const customers: MyCustomerRow[] = perParty.rows
      .map((row) => {
        const od = overdueByParty.get(row.partyId);
        return {
          partyId: row.partyId,
          party: row.party,
          thisPeriod: row.ty,
          lastYear: row.ly,
          change: readDelta(Number(row.ty), Number(row.ly), MATERIALITY_FLOOR),
          overdue: od?.overdue ?? '0.00',
          daysOverdue: od?.days ?? 0,
          daysSinceLastOrder: row.lastOrder === null ? null : dayGap(row.lastOrder, today),
        };
      })
      .sort((a, b) => Number(b.thisPeriod) - Number(a.thisPeriod));

    const target = await this.team.targetForRange(principal, 'user:' + principal.userId, from, to);
    const marginRow = await this.db.execute<{ margin: string | null; net: string | null }>(sql`
      SELECT sum(pocket_margin)::numeric(16,2)::text AS margin,
             sum(net) FILTER (WHERE pocket_margin IS NOT NULL)::numeric(16,2)::text AS net
      FROM fact_sales_daily
      WHERE org_id = ${principal.orgId} AND salesperson_ref = ${'user:' + principal.userId} AND date BETWEEN ${from} AND ${to}
    `);
    const marginPct =
      marginRow.rows[0]?.margin == null || Number(marginRow.rows[0].net ?? 0) === 0
        ? null
        : Math.round((Number(marginRow.rows[0].margin) / Number(marginRow.rows[0].net)) * 1000) / 10;

    return {
      bookSize: book.length,
      mySales: mySales.toFixed(2),
      salesDelta: readDelta(mySales, salesLy, MATERIALITY_FLOOR),
      myCollections: totalOf('collections').toFixed(2),
      myOverdue: myOverdue.toFixed(2),
      overdueParties: overdue.rows[0]?.parties ?? 0,
      delayCostPerYear: ((myOverdue * rate) / 100).toFixed(2),
      target,
      achievementPct: target === null || Number(target) === 0 ? null : Math.round((mySales / Number(target)) * 100),
      marginPct,
      pacing,
      customers,
    };
  }
}
