import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  INTEREST_REPORTS,
  INTEREST_REPORT_KEYS,
  PERMISSIONS,
  cashCycleCell,
  partyInterestCell,
  stockInterestCell,
  type CashCycleSource,
  type PartyInterestSource,
  type ReportCellValue,
  type ReportColumnSpec,
  type ReportDefinition,
  type ReportFilters,
  type ReportKey,
  type StockInterestSource,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AppError } from '../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { orderBy, type SortMap } from '../../platform/export/report-order.js';
import { ReportSourceRegistry, type ReportSource, type ReportSourcePage } from '../../platform/export/report-source.registry.js';
import { hasPermission, type Principal } from '../../platform/rbac/principal.js';
import type { InterestPolicy } from '../../platform/settings/settings.catalogue.js';
import { isNonMoving } from './interest-math.js';
import { readInterestPolicy } from './interest-policy.js';

/**
 * D-22: the three interest surfaces, every figure from the snapshot tables
 * the nightly build wrote — a request never replays vouchers into a series.
 * The one thing read outside the snapshots is plain period turnover (a sum
 * over projected vouchers), which prices the days columns and the
 * loss-as-a-share figure; it is a denominator, not a recomputation.
 *
 * Rate and basis are applied here, at read time, from the org policy and
 * the per-party override — the snapshots hold balances only, so an edited
 * rate re-prices all of history at the next request.
 */

type PartyRow = {
  party_id: string;
  party_name: string;
  effective_rate_pct: number;
  planned_cost: string;
  interest_loss: string;
  avg_days_outstanding: number | null;
  avg_overdue_days: number | null;
  loss_pct_of_turnover: number | null;
  credit_terms: 'TALLY' | 'OVERRIDE' | 'MISSING';
  settlement_rule: string;
  as_of: string | null;
};
type StockRow = {
  stock_item_id: string;
  item: string;
  closing_value: string;
  funded_value: string;
  interest: string;
  days_since_outward: number | null;
  as_of: string | null;
};
type CashRow = {
  month: string;
  inventory_days: number | null;
  receivable_days: number | null;
  payable_days: number | null;
  cash_cycle_days: number | null;
  total_interest: string;
  as_of: string | null;
};

interface InterestPage extends ReportSourcePage {
  readonly reportKey: ReportKey;
  readonly rows: readonly (PartyInterestSource | StockInterestSource | CashCycleSource)[];
}

const SORTABLE = {
  'party-interest-cost': {
    partyName: 'party_name',
    plannedCost: 'planned_cost::numeric',
    interestLoss: 'interest_loss::numeric',
    lossPctOfTurnover: 'loss_pct_of_turnover',
  },
  'stock-interest-cost': {
    item: 'item',
    closingValue: 'closing_value::numeric',
    interest: 'interest::numeric',
    daysSinceOutward: 'days_since_outward',
  },
  'cash-cycle': {
    month: 'month',
    cashCycleDays: 'cash_cycle_days',
    totalInterest: 'total_interest::numeric',
  },
} satisfies Partial<Record<ReportKey, SortMap>>;

const AS_OF = sql`to_char(st.built_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

@Injectable()
export class InterestReportSource implements ReportSource, OnModuleInit {
  readonly keys: readonly ReportKey[] = INTEREST_REPORT_KEYS;

  constructor(
    private readonly registry: ReportSourceRegistry,
    @InjectDatabase() private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  visibleDefinitions(principal: Principal): readonly ReportDefinition[] {
    return hasPermission(principal, PERMISSIONS.INTEREST_VIEW) ? INTEREST_REPORTS : [];
  }

  sortableFields(key: ReportKey): readonly string[] {
    return Object.hasOwn(SORTABLE, key) ? Object.keys(SORTABLE[key as keyof typeof SORTABLE]) : [];
  }

  assertFiltersUsable(key: ReportKey, filters: ReportFilters): ReportFilters {
    if (!this.keys.includes(key)) throw new Error(`InterestReportSource does not serve "${key}".`);
    if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) {
      throw AppError.validation('The period ends before it starts.', { fields: [{ path: 'to', message: 'must not precede from' }] });
    }
    return {
      ...(filters.from === undefined ? {} : { from: filters.from }),
      ...(filters.to === undefined ? {} : { to: filters.to }),
      ...(filters.partyId === undefined ? {} : { partyId: filters.partyId }),
      ...(filters.itemName === undefined ? {} : { itemName: filters.itemName }),
    };
  }

  async count(principal: Principal, key: ReportKey, filters: ReportFilters): Promise<number> {
    this.require(principal);
    const policy = await readInterestPolicy(this.db, principal.orgId);
    const body = this.body(principal.orgId, key, this.assertFiltersUsable(key, filters), policy);
    const rows = await this.db.execute<{ value: number }>(sql`SELECT count(*)::int AS value FROM (${body}) t`);
    return Number(rows.rows[0]?.value ?? 0);
  }

  async page(
    principal: Principal,
    key: ReportKey,
    filters: ReportFilters & { sort?: string | undefined },
    limit: number,
    offset: number,
  ): Promise<ReportSourcePage> {
    this.require(principal);
    const usable = this.assertFiltersUsable(key, filters);
    const total = await this.count(principal, key, usable);
    const policy = await readInterestPolicy(this.db, principal.orgId);
    const body = this.body(principal.orgId, key, usable, policy);

    if (key === 'party-interest-cost') {
      const order = orderBy(filters.sort, SORTABLE[key], 'interest_loss::numeric DESC, party_name ASC', 'party_name ASC');
      const rows = await this.db.execute<PartyRow>(sql`SELECT * FROM (${body}) t ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`);
      const page: InterestPage = {
        total,
        reportKey: key,
        rows: rows.rows.map((row): PartyInterestSource => ({
          partyId: row.party_id,
          partyName: row.party_name,
          effectiveRatePct: Number(row.effective_rate_pct),
          plannedCost: row.planned_cost,
          interestLoss: row.interest_loss,
          avgDaysOutstanding: row.avg_days_outstanding === null ? null : Number(row.avg_days_outstanding),
          avgOverdueDays: row.avg_overdue_days === null ? null : Number(row.avg_overdue_days),
          lossPctOfTurnover: row.loss_pct_of_turnover === null ? null : Number(row.loss_pct_of_turnover),
          creditTerms: row.credit_terms,
          settlementRule: row.settlement_rule,
          asOf: row.as_of,
        })),
      };
      return page;
    }

    if (key === 'stock-interest-cost') {
      const order = orderBy(filters.sort, SORTABLE[key], 'interest::numeric DESC, item ASC', 'item ASC');
      const rows = await this.db.execute<StockRow>(sql`SELECT * FROM (${body}) t ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`);
      const page: InterestPage = {
        total,
        reportKey: key,
        rows: rows.rows.map((row): StockInterestSource => ({
          stockItemId: row.stock_item_id,
          item: row.item,
          closingValue: row.closing_value,
          fundedValue: row.funded_value,
          interest: row.interest,
          daysSinceOutward: row.days_since_outward === null ? null : Number(row.days_since_outward),
          nonMoving: isNonMoving(
            row.days_since_outward === null ? null : Number(row.days_since_outward),
            policy.nonMovingDays,
          ),
          asOf: row.as_of,
        })),
      };
      return page;
    }

    const order = orderBy(filters.sort, SORTABLE['cash-cycle'], 'month ASC', 'month ASC');
    const rows = await this.db.execute<CashRow>(sql`SELECT * FROM (${body}) t ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`);
    const page: InterestPage = {
      total,
      reportKey: key,
      rows: rows.rows.map((row): CashCycleSource => ({
        month: row.month,
        inventoryDays: row.inventory_days === null ? null : Number(row.inventory_days),
        receivableDays: row.receivable_days === null ? null : Number(row.receivable_days),
        payableDays: row.payable_days === null ? null : Number(row.payable_days),
        cashCycleDays: row.cash_cycle_days === null ? null : Number(row.cash_cycle_days),
        totalInterest: row.total_interest,
        asOf: row.as_of,
      })),
    };
    return page;
  }

  cells(page: ReportSourcePage, index: number, columns: readonly ReportColumnSpec[]): ReportCellValue[] {
    const typed = page as InterestPage;
    const row = typed.rows[index];
    if (row === undefined) throw new Error(`No row ${String(index)} on this page.`);
    if (typed.reportKey === 'party-interest-cost') return columns.map((column) => partyInterestCell(row as PartyInterestSource, column.key));
    if (typed.reportKey === 'stock-interest-cost') return columns.map((column) => stockInterestCell(row as StockInterestSource, column.key));
    return columns.map((column) => cashCycleCell(row as CashCycleSource, column.key));
  }

  private body(orgId: string, key: ReportKey, filters: ReportFilters, policy: InterestPolicy): SQL {
    const seriesRange = sql`
      ${filters.from === undefined ? sql`` : sql`AND s.date >= ${filters.from}::date`}
      ${filters.to === undefined ? sql`` : sql`AND s.date <= ${filters.to}::date`}`;
    const voucherRange = sql`
      ${filters.from === undefined ? sql`` : sql`AND v.voucher_date >= ${filters.from}::date`}
      ${filters.to === undefined ? sql`` : sql`AND v.voucher_date <= ${filters.to}::date`}`;
    const basis = sql`${policy.dayBasis}::numeric`;

    if (key === 'party-interest-cost') {
      const rate = sql`coalesce(ips.interest_rate_override::numeric, ${policy.annualRatePct}::numeric)`;
      return sql`
        WITH series AS (
          SELECT s.party_id,
                 sum(s.within_credit) AS within_value_days,
                 sum(s.overdue) AS overdue_value_days,
                 sum(s.closing) AS closing_value_days
            FROM interest_daily_party s
           WHERE s.org_id = ${orgId} ${seriesRange}
           ${filters.partyId === undefined ? sql`` : sql`AND s.party_id = ${filters.partyId}`}
           GROUP BY s.party_id
        ),
        turnover AS (
          SELECT v.party_id, sum(abs(v.amount)) AS sales
            FROM vouchers v
           WHERE v.org_id = ${orgId} AND v.voucher_type = 'Sales' AND NOT v.is_cancelled AND v.party_id IS NOT NULL ${voucherRange}
           GROUP BY v.party_id
        ),
        marks AS (
          SELECT DISTINCT b.party_id FROM bill_allocations b WHERE b.org_id = ${orgId} AND b.ref_type = 'against'
        )
        SELECT p.id AS party_id,
               p.name AS party_name,
               round(${rate}, 2)::float8 AS effective_rate_pct,
               round(se.within_value_days * ${rate} / 100 / ${basis}, 2)::text AS planned_cost,
               round(se.overdue_value_days * ${rate} / 100 / ${basis}, 2)::text AS interest_loss,
               CASE WHEN coalesce(t.sales, 0) > 0 THEN round(se.closing_value_days / t.sales, 1)::float8 END AS avg_days_outstanding,
               CASE WHEN coalesce(t.sales, 0) > 0 THEN round(se.overdue_value_days / t.sales, 1)::float8 END AS avg_overdue_days,
               CASE WHEN coalesce(t.sales, 0) > 0 THEN round(se.overdue_value_days * ${rate} / ${basis} / t.sales, 2)::float8 END AS loss_pct_of_turnover,
               CASE WHEN ips.credit_days_override IS NOT NULL THEN 'OVERRIDE'
                    WHEN p.credit_days IS NOT NULL THEN 'TALLY'
                    ELSE 'MISSING' END AS credit_terms,
               CASE WHEN m.party_id IS NOT NULL THEN 'Bill-wise (Tally)' ELSE 'FIFO oldest-first' END AS settlement_rule,
               ${AS_OF} AS as_of
          FROM series se
          JOIN parties p ON p.id = se.party_id AND p.org_id = ${orgId}
          LEFT JOIN interest_party_settings ips ON ips.org_id = ${orgId} AND ips.party_id = p.id AND ips.deleted_at IS NULL
          LEFT JOIN turnover t ON t.party_id = se.party_id
          LEFT JOIN marks m ON m.party_id = se.party_id
          LEFT JOIN interest_build_state st ON st.org_id = ${orgId}
         WHERE p.parent_group = 'Sundry Debtors'`;
    }

    if (key === 'stock-interest-cost') {
      const toOnly = filters.to === undefined ? sql`` : sql`AND s.date <= ${filters.to}::date`;
      return sql`
        WITH funded AS (
          SELECT s.stock_item_id, sum(s.funded_value) AS funded_value_days
            FROM interest_daily_stock s
           WHERE s.org_id = ${orgId} ${seriesRange}
           GROUP BY s.stock_item_id
        ),
        latest AS (
          SELECT DISTINCT ON (s.stock_item_id) s.stock_item_id, s.date, s.quantity, s.closing_value, s.funded_value
            FROM interest_daily_stock s
           WHERE s.org_id = ${orgId} ${toOnly}
           ORDER BY s.stock_item_id, s.date DESC
        ),
        moved AS (
          SELECT q.stock_item_id, max(q.date) AS moved_on FROM (
            SELECT s.stock_item_id, s.date, s.quantity,
                   lag(s.quantity) OVER (PARTITION BY s.stock_item_id ORDER BY s.date) AS prev
              FROM interest_daily_stock s
             WHERE s.org_id = ${orgId} ${toOnly}
          ) q WHERE q.prev IS NOT NULL AND q.quantity < q.prev GROUP BY q.stock_item_id
        )
        SELECT f.stock_item_id,
               si.name AS item,
               round(coalesce(l.closing_value, 0), 2)::text AS closing_value,
               round(coalesce(l.funded_value, 0), 2)::text AS funded_value,
               round(f.funded_value_days * ${policy.annualRatePct}::numeric / 100 / ${basis}, 2)::text AS interest,
               (l.date - m.moved_on)::int AS days_since_outward,
               ${AS_OF} AS as_of
          FROM funded f
          JOIN stock_items si ON si.id = f.stock_item_id AND si.org_id = ${orgId}
          LEFT JOIN latest l ON l.stock_item_id = f.stock_item_id
          LEFT JOIN moved m ON m.stock_item_id = f.stock_item_id
          LEFT JOIN interest_build_state st ON st.org_id = ${orgId}
         WHERE TRUE ${filters.itemName === undefined ? sql`` : sql`AND si.name ILIKE ${`%${filters.itemName}%`}`}`;
    }

    return sql`
      WITH ar AS (
        SELECT to_char(s.date, 'YYYY-MM') AS month, sum(s.closing) AS closing_days, sum(s.overdue) AS overdue_days
          FROM interest_daily_party s
          JOIN parties p ON p.id = s.party_id AND p.org_id = ${orgId}
         WHERE s.org_id = ${orgId} AND p.parent_group = 'Sundry Debtors' ${seriesRange}
         GROUP BY 1
      ),
      ap AS (
        SELECT to_char(s.date, 'YYYY-MM') AS month, sum(s.closing) AS closing_days
          FROM interest_daily_party s
          JOIN parties p ON p.id = s.party_id AND p.org_id = ${orgId}
         WHERE s.org_id = ${orgId} AND p.parent_group = 'Sundry Creditors' ${seriesRange}
         GROUP BY 1
      ),
      stk AS (
        SELECT to_char(s.date, 'YYYY-MM') AS month, sum(s.closing_value) AS value_days, sum(s.funded_value) AS funded_days
          FROM interest_daily_stock s
         WHERE s.org_id = ${orgId} ${seriesRange}
         GROUP BY 1
      ),
      sales AS (
        SELECT to_char(v.voucher_date, 'YYYY-MM') AS month, sum(abs(v.amount)) AS total
          FROM vouchers v
         WHERE v.org_id = ${orgId} AND v.voucher_type = 'Sales' AND NOT v.is_cancelled ${voucherRange}
         GROUP BY 1
      ),
      purchases AS (
        SELECT to_char(v.voucher_date, 'YYYY-MM') AS month, sum(abs(v.amount)) AS total
          FROM vouchers v
         WHERE v.org_id = ${orgId} AND v.voucher_type = 'Purchase' AND NOT v.is_cancelled ${voucherRange}
         GROUP BY 1
      ),
      months AS (
        SELECT month FROM ar UNION SELECT month FROM ap UNION SELECT month FROM stk
      )
      SELECT m.month,
             CASE WHEN coalesce(pu.total, 0) > 0 THEN round(coalesce(stk.value_days, 0) / pu.total, 1)::float8 END AS inventory_days,
             CASE WHEN coalesce(sa.total, 0) > 0 THEN round(coalesce(ar.closing_days, 0) / sa.total, 1)::float8 END AS receivable_days,
             CASE WHEN coalesce(pu.total, 0) > 0 THEN round(coalesce(ap.closing_days, 0) / pu.total, 1)::float8 END AS payable_days,
             CASE WHEN coalesce(pu.total, 0) > 0 AND coalesce(sa.total, 0) > 0
                  THEN round(coalesce(stk.value_days, 0) / pu.total + coalesce(ar.closing_days, 0) / sa.total - coalesce(ap.closing_days, 0) / pu.total, 1)::float8 END AS cash_cycle_days,
             round((coalesce(ar.overdue_days, 0) + coalesce(stk.funded_days, 0)) * ${policy.annualRatePct}::numeric / 100 / ${basis}, 2)::text AS total_interest,
             ${AS_OF} AS as_of
        FROM months m
        LEFT JOIN ar ON ar.month = m.month
        LEFT JOIN ap ON ap.month = m.month
        LEFT JOIN stk ON stk.month = m.month
        LEFT JOIN sales sa ON sa.month = m.month
        LEFT JOIN purchases pu ON pu.month = m.month
        LEFT JOIN interest_build_state st ON st.org_id = ${orgId}`;
  }

  private require(principal: Principal): void {
    if (!hasPermission(principal, PERMISSIONS.INTEREST_VIEW)) {
      throw AppError.forbidden('Interest reports need interest_cost.view.');
    }
  }
}
