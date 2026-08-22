import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  PERMISSIONS,
  TALLY_REPORTS,
  AgeingSource,
  PaymentAnalysisSource,
  ageingCell,
  paymentAnalysisCell,
  creditCycleCell,
  customerLapseCell,
  customerStatementCell,
  lowStockCell,
  dayBookCell,
  salesAnalysisCell,
  voucherReconciliationCell,
  type CreditCycleSource,
  type CustomerLapseSource,
  type CustomerStatementSource,
  type LowStockSource,
  type ReportCellValue,
  type ReportColumnSpec,
  type ReportDefinition,
  type ReportFilters,
  type ReportKey,
  type SalesAnalysisDimension,
  type DayBookSource,
  type SalesAnalysisSource,
  type VoucherReconciliationSource,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import {
  ReportSourceRegistry,
  type ReportSource,
  type ReportSourcePage,
} from '../export/report-source.registry.js';
import { hasPermission, type Principal } from '../rbac/principal.js';

/**
 * The Tally module's reports under the existing report shell (REQ-Y-06:
 * "none of them is a bespoke screen"). REQ-S-05's reconciliation, and Phase
 * 6d's derived receivables — customer statement (REQ-Y-01), credit cycle
 * (REQ-Y-03), sales analysis (REQ-Y-05) — every one read from the
 * projection alone, every row stamped with the sync it is as of (REQ-Y-07).
 *
 * Ageing (REQ-Y-02) and payment analysis (REQ-Y-04) are absent on purpose:
 * both need bill-wise allocations, which the push-only source does not
 * carry (P6b). A statement can be honest without them; an ageing cannot.
 *
 * Registered like the attendance source: this file puts itself into the
 * registry, and nothing under `platform/export/` learned a new key.
 */

/**
 * How a voucher type moves a customer's balance. Sales and Debit Note debit
 * the customer; Receipt and Credit Note credit them; a Payment to a debtor
 * (a refund) debits. Anything else is shown unclassified and leaves the
 * balance alone — Tally lets a business invent voucher types, and guessing
 * their sign would put a wrong figure in a column that reconciles to the
 * rupee. Purchase-side types are excluded here: this is the receivables view.
 */
const DEBIT_TYPES = ['Sales', 'Debit Note', 'Payment'] as const;
const CREDIT_TYPES = ['Receipt', 'Credit Note'] as const;

const debitCase = sql`CASE WHEN voucher_type = ANY(${sql.raw(`ARRAY['${DEBIT_TYPES.join("','")}']`)}) THEN amount ELSE 0 END`;
const creditCase = sql`CASE WHEN voucher_type = ANY(${sql.raw(`ARRAY['${CREDIT_TYPES.join("','")}']`)}) THEN amount ELSE 0 END`;
const classifiedCase = sql`voucher_type = ANY(${sql.raw(`ARRAY['${[...DEBIT_TYPES, ...CREDIT_TYPES].join("','")}']`)})`;

interface TallyReportPage extends ReportSourcePage {
  readonly key: ReportKey;
  readonly rows: readonly (VoucherReconciliationSource | CustomerStatementSource | CreditCycleSource | AgeingSource | PaymentAnalysisSource | SalesAnalysisSource | LowStockSource | DayBookSource | CustomerLapseSource)[];
}

@Injectable()
export class TallyReportSource implements ReportSource, OnModuleInit {
  readonly keys: readonly ReportKey[] = TALLY_REPORTS.map((report) => report.key);

  constructor(
    private readonly registry: ReportSourceRegistry,
    @InjectDatabase() private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  visibleDefinitions(principal: Principal): readonly ReportDefinition[] {
    return hasPermission(principal, PERMISSIONS.RECEIVABLES_VIEW) ? TALLY_REPORTS : [];
  }

  assertFiltersUsable(key: ReportKey, filters: ReportFilters): ReportFilters {
    if (!this.keys.includes(key)) {
      throw new Error(`TallyReportSource does not serve "${key}".`);
    }
    if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) {
      throw AppError.validation('The period ends before it starts.', {
        fields: [{ path: 'to', message: 'must not precede from' }],
      });
    }
    if (key === 'customer-statement' && filters.partyId === undefined) {
      throw AppError.validation('A customer statement is for one party. Choose a party.', {
        fields: [{ path: 'partyId', message: 'is required' }],
      });
    }
    // Only what each report understands survives; the shell hides the rest,
    // and a hand-written URL carrying an attendance filter is simply ignored.
    return {
      ...(filters.from === undefined ? {} : { from: filters.from }),
      ...(filters.to === undefined ? {} : { to: filters.to }),
      ...(filters.partyId === undefined ? {} : { partyId: filters.partyId }),
      ...(key === 'sales-analysis' ? { groupBy: filters.groupBy ?? 'party' } : {}),
      ...(key === 'day-book' && filters.voucherType !== undefined ? { voucherType: filters.voucherType } : {}),
    };
  }

  async count(principal: Principal, key: ReportKey, filters: ReportFilters): Promise<number> {
    this.requireHolder(principal);
    const usable = this.assertFiltersUsable(key, filters);
    switch (key) {
      case 'voucher-reconciliation':
        return this.scalar(sql`
          SELECT count(*)::int AS value FROM (
            SELECT 1 FROM vouchers
             WHERE org_id = ${principal.orgId} ${this.periodClause(usable, 'voucher_date')}
             GROUP BY to_char(voucher_date, 'YYYY-MM'), voucher_type
          ) grouped
        `);
      case 'customer-statement':
        // The opening row is one more than the vouchers in the period.
        return (
          (await this.scalar(sql`
            SELECT count(*)::int AS value FROM vouchers
             WHERE org_id = ${principal.orgId} AND party_id = ${usable.partyId ?? ''} AND NOT is_cancelled
             ${this.periodClause(usable, 'voucher_date')}
          `)) + 1
        );
      case 'credit-cycle':
        return this.scalar(sql`
          SELECT count(*)::int AS value FROM parties
           WHERE org_id = ${principal.orgId} AND lower(parent_group) = 'sundry debtors'
           ${usable.partyId === undefined ? sql`` : sql`AND id = ${usable.partyId}`}
        `);
      case 'sales-analysis':
        return this.scalar(sql`
          SELECT count(*)::int AS value FROM (
            SELECT 1 ${this.salesLinesFrom()}
             WHERE ${this.salesLinesWhere(principal.orgId, usable)}
             GROUP BY ${this.dimensionKey(usable.groupBy ?? 'party')}
          ) grouped
        `);
      case 'ageing':
        return this.scalar(sql`SELECT count(*)::int AS value FROM (${this.openBills(principal.orgId, usable)}) t`);
      case 'payment-analysis':
        return this.scalar(sql`SELECT count(*)::int AS value FROM (${this.paymentBehaviour(principal.orgId, usable)}) t`);
      case 'low-stock':
        return this.scalar(sql`SELECT count(*)::int AS value FROM (${this.lowStockQuery(principal.orgId)}) t`);
      case 'day-book':
        return this.scalar(sql`SELECT count(*)::int AS value FROM vouchers WHERE ${this.dayBookWhere(principal.orgId, usable)}`);
      case 'customer-lapse':
        return this.scalar(sql`SELECT count(*)::int AS value FROM (${this.customerLapseQuery(principal.orgId)}) t`);
      default:
        throw new Error(`TallyReportSource does not serve "${key}".`);
    }
  }

  async page(
    principal: Principal,
    key: ReportKey,
    filters: ReportFilters & { sort?: string | undefined },
    limit: number,
    offset: number,
  ): Promise<ReportSourcePage> {
    this.requireHolder(principal);
    const usable = this.assertFiltersUsable(key, filters);
    const total = await this.count(principal, key, usable);
    const asOf = await this.asOf(principal.orgId);
    switch (key) {
      case 'voucher-reconciliation':
        return this.wrap(key, total, await this.reconciliationRows(principal.orgId, usable, filters.sort, limit, offset));
      case 'customer-statement':
        return this.wrap(key, total, await this.statementRows(principal.orgId, usable, filters.sort, limit, offset, asOf));
      case 'credit-cycle':
        return this.wrap(key, total, await this.creditRows(principal.orgId, usable, filters.sort, limit, offset, asOf), await this.creditTotals(principal.orgId, usable));
      case 'sales-analysis':
        return this.wrap(key, total, await this.salesRows(principal.orgId, usable, filters.sort, limit, offset, asOf));
      case 'ageing':
        return this.wrap(key, total, await this.ageingRows(principal.orgId, usable, filters.sort, limit, offset, asOf));
      case 'payment-analysis':
        return this.wrap(key, total, await this.paymentRows(principal.orgId, usable, filters.sort, limit, offset, asOf));
      case 'low-stock':
        return this.wrap(key, total, await this.lowStockRows(principal.orgId, filters.sort, limit, offset));
      case 'day-book':
        return this.wrap(key, total, await this.dayBookRows(principal.orgId, usable, filters.sort, limit, offset, asOf));
      case 'customer-lapse':
        return this.wrap(key, total, await this.customerLapseRows(principal.orgId, filters.sort, limit, offset, asOf), await this.lapseTotals(principal.orgId));
      default:
        throw new Error(`TallyReportSource does not serve "${key}".`);
    }
  }

  private wrap(key: ReportKey, total: number, rows: TallyReportPage['rows'], totals?: Readonly<Record<string, string>>): ReportSourcePage {
    const page: TallyReportPage = { key, total, rows };
    return totals === undefined ? page : { ...page, totals };
  }

  cells(page: ReportSourcePage, index: number, columns: readonly ReportColumnSpec[]): ReportCellValue[] {
    const typed = page as TallyReportPage;
    const row = typed.rows[index];
    if (row === undefined) throw new Error(`No row ${String(index)} on this page.`);
    return columns.map((column): ReportCellValue => {
      switch (typed.key) {
        case 'voucher-reconciliation':
          return voucherReconciliationCell(row as VoucherReconciliationSource, column.key);
        case 'customer-statement':
          return customerStatementCell(row as CustomerStatementSource, column.key);
        case 'credit-cycle':
          return creditCycleCell(row as CreditCycleSource, column.key);
        case 'ageing':
          return ageingCell(row as AgeingSource, column.key);
        case 'payment-analysis':
          return paymentAnalysisCell(row as PaymentAnalysisSource, column.key);
        case 'sales-analysis':
          return salesAnalysisCell(row as SalesAnalysisSource, column.key);
        case 'low-stock':
          return lowStockCell(row as LowStockSource, column.key);
        case 'day-book':
          return dayBookCell(row as DayBookSource, column.key);
        case 'customer-lapse':
          return customerLapseCell(row as CustomerLapseSource, column.key);
        default:
          return null;
      }
    });
  }

  // ------------------------------------------------------- reconciliation

  private async reconciliationRows(orgId: string, filters: ReportFilters, sort: string | undefined, limit: number, offset: number): Promise<VoucherReconciliationSource[]> {
    const orderBy = sort === 'voucherType' ? sql`voucher_type ASC, month ASC` : sql`month ASC, voucher_type ASC`;
    const rows = await this.db.execute<{ month: string; voucher_type: string; count: number; cancelled: number; total: string; last_pulled_at: Date }>(sql`
      SELECT to_char(voucher_date, 'YYYY-MM') AS month,
             voucher_type,
             count(*)::int AS count,
             count(*) FILTER (WHERE is_cancelled)::int AS cancelled,
             -- Cancelled vouchers do not count towards value: Tally's Day
             -- Book excludes them, and the point is to match it.
             COALESCE(sum(amount) FILTER (WHERE NOT is_cancelled), 0)::text AS total,
             max(last_pulled_at) AS last_pulled_at
        FROM vouchers
       WHERE org_id = ${orgId} ${this.periodClause(filters, 'voucher_date')}
       GROUP BY to_char(voucher_date, 'YYYY-MM'), voucher_type
       ORDER BY ${orderBy}
       LIMIT ${limit} OFFSET ${offset}
    `);
    return rows.rows.map((row) => ({
      month: row.month,
      voucherType: row.voucher_type,
      count: Number(row.count),
      cancelled: Number(row.cancelled),
      total: row.total,
      lastPulledAt: new Date(row.last_pulled_at).toISOString(),
    }));
  }

  // ------------------------------------------------------------ statement

  /**
   * One row per voucher in the period, running balance included, with an
   * opening row first that carries everything before the period. The
   * balance is a window sum over the whole party history ordered by date
   * then id, so paging never restarts it — page two continues where page one
   * left off. Cancelled vouchers are shown nowhere: they never moved money.
   */
  private async statementRows(orgId: string, filters: ReportFilters, sort: string | undefined, limit: number, offset: number, asOf: string | null): Promise<CustomerStatementSource[]> {
    const partyId = filters.partyId ?? '';
    const from = filters.from;
    const desc = sort === '-date';
    const openingRow: CustomerStatementSource | null =
      offset === 0 && !desc
        ? {
            id: `opening-${partyId}`,
            date: from ?? '',
            voucherType: 'Opening balance',
            voucherNumber: '',
            narration: from === undefined ? 'Before the first voucher held' : `Before ${from}`,
            debit: null,
            credit: null,
            unclassified: null,
            balance: await this.openingBalance(orgId, partyId, from),
            asOf,
          }
        : null;
    // The opening row takes slot zero of page one; vouchers shift by one.
    const voucherOffset = desc ? offset : Math.max(0, offset - 1);
    const voucherLimit = openingRow === null ? limit : limit - 1;
    if (voucherLimit <= 0) return openingRow === null ? [] : [openingRow];

    const rows = await this.db.execute<{
      id: string;
      voucher_date: string;
      voucher_type: string;
      voucher_number: string;
      narration: string | null;
      debit: string;
      credit: string;
      classified: boolean;
      amount: string;
      balance: string;
    }>(sql`
      SELECT id, voucher_date, voucher_type, voucher_number, narration,
             round(${debitCase}, 2)::text AS debit,
             round(${creditCase}, 2)::text AS credit,
             (${classifiedCase}) AS classified,
             round(amount, 2)::text AS amount,
             round(sum(${debitCase} - ${creditCase}) OVER (ORDER BY voucher_date, id ROWS UNBOUNDED PRECEDING), 2)::text AS balance
        FROM vouchers
       WHERE org_id = ${orgId} AND party_id = ${partyId} AND NOT is_cancelled
       ORDER BY voucher_date ${desc ? sql`DESC` : sql`ASC`}, id ${desc ? sql`DESC` : sql`ASC`}
    `);
    // The window runs over the whole history so the balance is right; the
    // period and the page are cut afterwards. A party's vouchers number in
    // the thousands at most, which the projection's shape already assumes.
    const inPeriod = rows.rows.filter((row) => (from === undefined || row.voucher_date >= from) && (filters.to === undefined || row.voucher_date <= filters.to));
    const paged = inPeriod.slice(voucherOffset, voucherOffset + voucherLimit).map((row): CustomerStatementSource => ({
      id: row.id,
      date: row.voucher_date,
      voucherType: row.voucher_type,
      voucherNumber: row.voucher_number,
      narration: row.narration,
      debit: row.classified && Number(row.debit) !== 0 ? row.debit : null,
      credit: row.classified && Number(row.credit) !== 0 ? row.credit : null,
      unclassified: row.classified ? null : row.amount,
      balance: row.balance,
      asOf,
    }));
    return openingRow === null ? paged : [openingRow, ...paged];
  }

  private async openingBalance(orgId: string, partyId: string, from: string | undefined): Promise<string> {
    const rows = await this.db.execute<{ value: string }>(sql`
      SELECT round(COALESCE(sum(${debitCase} - ${creditCase}), 0), 2)::text AS value
        FROM vouchers
       WHERE org_id = ${orgId} AND party_id = ${partyId} AND NOT is_cancelled
         ${from === undefined ? sql`AND false` : sql`AND voucher_date < ${from}`}
    `);
    return rows.rows[0]?.value ?? '0';
  }

  // --------------------------------------------------------- credit cycle

  /**
   * Every bill with something still on it.
   *
   * A bill is its allocation rows summed: the `new` row raises it and each
   * `against` row settles part of it, all signed against the party. What is
   * left is the outstanding, and a bill nets to zero when it is paid -- so
   * "open" is `sum <> 0` and there is no paid flag to drift.
   *
   * `advance` and `on_account` are excluded. They are money with no bill
   * attached, which is a real thing a customer does but not something that can
   * age -- there is no date to age from. They belong on the statement, and the
   * statement has them.
   *
   * Rounded to two places before the comparison, because a hundredth of a
   * rupee left by a part payment is not an open bill and would otherwise sit
   * in 90+ forever.
   */
  private openBills(orgId: string, filters: ReportFilters): SQL {
    return sql`
      SELECT b.party_id,
             max(b.party_name) AS party_name,
             b.bill_name,
             min(b.bill_date) AS bill_date,
             max(b.due_date) AS due_date,
             round(sum(b.amount), 2) AS outstanding
        FROM bill_allocations b
       WHERE b.org_id = ${orgId}
         AND b.ref_type IN ('new', 'against')
         ${filters.partyId === undefined ? sql`` : sql`AND b.party_id = ${filters.partyId}`}
       GROUP BY b.party_id, b.bill_name
      HAVING round(sum(b.amount), 2) <> 0
    `;
  }

  private async ageingRows(orgId: string, filters: ReportFilters, sort: string | undefined, limit: number, offset: number, asOf: string | null): Promise<AgeingSource[]> {
    const orderBy =
      sort === 'partyName' ? sql`party_name ASC, bill_date ASC`
      : sort === '-partyName' ? sql`party_name DESC, bill_date ASC`
      : sort === 'ageDays' ? sql`age_days ASC, party_name ASC`
      : sort === 'outstanding' ? sql`outstanding ASC, party_name ASC`
      : sort === '-outstanding' ? sql`outstanding DESC, party_name ASC`
      : sql`age_days DESC, party_name ASC`;

    const rows = await this.db.execute<{
      party_id: string | null;
      party_name: string;
      bill_name: string;
      bill_date: string | null;
      due_date: string | null;
      age_days: number;
      bucket: string;
      outstanding: string;
      overdue: boolean;
    }>(sql`
      SELECT party_id, party_name, bill_name, bill_date, due_date,
             age_days, bucket, outstanding::text AS outstanding,
             overdue
        FROM (
          SELECT o.*,
                 /* Age from the bill's own date. REQ-Y-02's buckets are
                    0-30 / 31-60 / 61-90 / over 90, and a bill sits in exactly
                    one of them. A bill with no date -- which Tally allows --
                    ages 0 rather than being dropped, because dropping it would
                    quietly understate what is owed. */
                 COALESCE((CURRENT_DATE - o.bill_date), 0) AS age_days,
                 CASE
                   WHEN o.bill_date IS NULL THEN 'UNDATED'
                   WHEN CURRENT_DATE - o.bill_date <= 30 THEN '0-30'
                   WHEN CURRENT_DATE - o.bill_date <= 60 THEN '31-60'
                   WHEN CURRENT_DATE - o.bill_date <= 90 THEN '61-90'
                   ELSE '90+'
                 END AS bucket,
                 /* Overdue is against the bill's own due date when Tally
                    carried one, and against the party's credit days when it
                    did not. This is the half D-40 was missing: the limit was
                    enforced, the terms were not. */
                 CASE
                   WHEN o.due_date IS NOT NULL THEN CURRENT_DATE > o.due_date
                   WHEN o.bill_date IS NOT NULL AND p.credit_days IS NOT NULL
                     THEN CURRENT_DATE > o.bill_date + p.credit_days
                   ELSE false
                 END AS overdue
            FROM (${this.openBills(orgId, filters)}) o
            LEFT JOIN parties p ON p.id = o.party_id
        ) aged
       ORDER BY ${orderBy}
       LIMIT ${limit} OFFSET ${offset}
    `);

    return rows.rows.map((row) => ({
      partyId: row.party_id,
      partyName: row.party_name,
      billName: row.bill_name,
      billDate: row.bill_date,
      dueDate: row.due_date,
      ageDays: Number(row.age_days),
      bucket: row.bucket,
      outstanding: row.outstanding,
      overdue: row.overdue,
      asOf,
    }));
  }

  /**
   * How long each party actually takes, against what they agreed to.
   *
   * A bill is settled when its rows net to zero; the day that happened is the
   * date of its last `against` row. Days-to-pay is that minus the bill date --
   * observed, because the settlement names the bill. Before `bill_allocations`
   * the best available was the order receipts arrived in, which says nothing
   * about which invoice a payment was for.
   */
  private paymentBehaviour(orgId: string, filters: ReportFilters): SQL {
    return sql`
      SELECT p.id AS party_id,
             p.name AS party_name,
             p.credit_days,
             round(avg(s.days_to_pay) FILTER (WHERE s.settled))::int AS avg_days_to_pay,
             count(*) FILTER (WHERE s.settled)::int AS bills_paid,
             count(*) FILTER (WHERE NOT s.settled)::int AS bills_open,
             max(CURRENT_DATE - s.bill_date) FILTER (WHERE NOT s.settled)::int AS oldest_open_days
        FROM parties p
        JOIN (
          SELECT b.party_id,
                 b.bill_name,
                 min(b.bill_date) AS bill_date,
                 round(sum(b.amount), 2) = 0 AS settled,
                 max(v.voucher_date) FILTER (WHERE b.ref_type = 'against') - min(b.bill_date) AS days_to_pay
            FROM bill_allocations b
            JOIN vouchers v ON v.id = b.voucher_id
           WHERE b.org_id = ${orgId}
             AND b.ref_type IN ('new', 'against')
             AND b.bill_date IS NOT NULL
           GROUP BY b.party_id, b.bill_name
        ) s ON s.party_id = p.id
       WHERE p.org_id = ${orgId}
         ${filters.partyId === undefined ? sql`` : sql`AND p.id = ${filters.partyId}`}
       GROUP BY p.id, p.name, p.credit_days
    `;
  }

  private async paymentRows(orgId: string, filters: ReportFilters, sort: string | undefined, limit: number, offset: number, asOf: string | null): Promise<PaymentAnalysisSource[]> {
    const orderBy =
      sort === 'partyName' ? sql`party_name ASC`
      : sort === '-partyName' ? sql`party_name DESC`
      : sort === 'avgDaysToPay' ? sql`avg_days_to_pay ASC NULLS LAST, party_name ASC`
      : sort === '-avgDaysToPay' ? sql`avg_days_to_pay DESC NULLS LAST, party_name ASC`
      : sort === 'slippage' ? sql`slippage ASC NULLS LAST, party_name ASC`
      : sql`slippage DESC NULLS LAST, party_name ASC`;

    const rows = await this.db.execute<{
      party_id: string;
      party_name: string;
      credit_days: number | null;
      avg_days_to_pay: number | null;
      slippage: number | null;
      bills_paid: number;
      bills_open: number;
      oldest_open_days: number | null;
    }>(sql`
      SELECT party_id, party_name, credit_days, avg_days_to_pay,
             avg_days_to_pay - credit_days AS slippage,
             bills_paid, bills_open, oldest_open_days
        FROM (${this.paymentBehaviour(orgId, filters)}) b
       ORDER BY ${orderBy}
       LIMIT ${limit} OFFSET ${offset}
    `);

    return rows.rows.map((row) => ({
      partyId: row.party_id,
      partyName: row.party_name,
      creditDays: row.credit_days,
      avgDaysToPay: row.avg_days_to_pay,
      slippage: row.slippage,
      billsPaid: Number(row.bills_paid),
      billsOpen: Number(row.bills_open),
      oldestOpenDays: row.oldest_open_days,
      asOf,
    }));
  }

  /**
   * One FROM for the rows and for the total. The dashboard's "Receivables
   * exposure" tile added up whatever the first page held -- two hundred rows
   * -- beneath a caption that named every debtor, so any organisation with
   * more debtors than that was shown a headline belonging to nobody. The
   * total is now the report's, and it cannot drift from the rows because it
   * reads the same set.
   */
  private creditFrom(orgId: string, filters: ReportFilters): SQL {
    return sql`FROM parties p
        LEFT JOIN (
          SELECT party_id,
                 sum(${debitCase} - ${creditCase}) AS exposure,
                 max(voucher_date) FILTER (WHERE voucher_type = 'Sales') AS last_invoice,
                 max(voucher_date) FILTER (WHERE voucher_type = 'Receipt') AS last_receipt
            FROM vouchers
           WHERE org_id = ${orgId} AND NOT is_cancelled AND party_id IS NOT NULL
             ${filters.to === undefined ? sql`` : sql`AND voucher_date <= ${filters.to}`}
           GROUP BY party_id
        ) b ON b.party_id = p.id
       WHERE p.org_id = ${orgId} AND lower(p.parent_group) = 'sundry debtors'
         ${filters.partyId === undefined ? sql`` : sql`AND p.id = ${filters.partyId}`}`;
  }

  private async creditTotals(orgId: string, filters: ReportFilters): Promise<Record<string, string>> {
    const row = await this.db.execute<{ value: string }>(sql`
      SELECT round(COALESCE(sum(COALESCE(b.exposure, 0)), 0), 2)::text AS value ${this.creditFrom(orgId, filters)}
    `);
    return { exposure: row.rows[0]?.value ?? '0' };
  }

  /**
   * Only the customers who have actually gone quiet. The tile that reads this
   * is captioned "from lapsed and at-risk customers", and summing every row
   * put the revenue of customers buying exactly on rhythm into it.
   */
  private async lapseTotals(orgId: string): Promise<Record<string, string>> {
    const row = await this.db.execute<{ value: string }>(sql`
      SELECT round(COALESCE(sum(revenue_12m::numeric), 0), 2)::text AS value
        FROM (${this.customerLapseQuery(orgId)}) t
       WHERE state IN ('LAPSED', 'AT_RISK')
    `);
    return { revenue12m: row.rows[0]?.value ?? '0' };
  }

  private async creditRows(orgId: string, filters: ReportFilters, sort: string | undefined, limit: number, offset: number, asOf: string | null): Promise<CreditCycleSource[]> {
    const orderBy =
      sort === 'partyName' ? sql`p.name ASC` : sort === '-partyName' ? sql`p.name DESC` : sort === 'exposure' ? sql`exposure ASC, p.name ASC` : sql`exposure DESC, p.name ASC`;
    const rows = await this.db.execute<{
      id: string;
      name: string;
      credit_limit: string | null;
      credit_days: number | null;
      exposure: string;
      last_invoice: string | null;
      last_receipt: string | null;
    }>(sql`
      SELECT p.id, p.name, p.credit_limit::text AS credit_limit, p.credit_days,
             round(COALESCE(b.exposure, 0), 2)::text AS exposure,
             b.last_invoice, b.last_receipt
        ${this.creditFrom(orgId, filters)}
       ORDER BY ${orderBy}
       LIMIT ${limit} OFFSET ${offset}
    `);
    return rows.rows.map((row) => {
      const limitNumber = row.credit_limit === null ? null : Number(row.credit_limit);
      const exposureNumber = Number(row.exposure);
      const headroom = limitNumber === null || !Number.isFinite(limitNumber) ? null : (limitNumber - exposureNumber).toFixed(2);
      return {
        partyId: row.id,
        partyName: row.name,
        creditLimit: row.credit_limit,
        creditDays: row.credit_days,
        exposure: row.exposure,
        headroom,
        overLimit: limitNumber !== null && limitNumber > 0 && exposureNumber > limitNumber,
        lastInvoiceDate: row.last_invoice,
        lastReceiptDate: row.last_receipt,
        asOf,
      };
    });
  }

  // ------------------------------------------------------- sales analysis

  /**
   * The count and the rows have to read the same tables. Grouping by item
   * group reaches into `stock_items`, and the count query had never joined
   * it: choosing "By item group" -- an option that shipped in the dropdown --
   * failed with `missing FROM-clause entry for table "s"` before a single row
   * was fetched. One FROM, so the two cannot drift again. `stock_items.id` is
   * the primary key, so the LEFT JOIN cannot multiply a line.
   */
  private salesLinesFrom(): SQL {
    return sql`FROM voucher_lines l
        JOIN vouchers v ON v.id = l.voucher_id
        LEFT JOIN stock_items s ON s.id = l.stock_item_id`;
  }

  private salesLinesWhere(orgId: string, filters: ReportFilters): SQL {
    return sql`l.org_id = ${orgId} AND l.kind = 'inventory' AND v.voucher_type = 'Sales' AND NOT v.is_cancelled
      ${this.periodClause(filters, 'v.voucher_date')}
      ${filters.partyId === undefined ? sql`` : sql`AND v.party_id = ${filters.partyId}`}`;
  }

  private dimensionKey(dimension: SalesAnalysisDimension): SQL {
    switch (dimension) {
      case 'party':
        return sql`COALESCE(v.party_id::text, ''), v.party_name`;
      case 'item':
        return sql`COALESCE(l.stock_item_id::text, ''), l.stock_item_name`;
      case 'itemGroup':
        return sql`COALESCE(s.parent_group, '')`;
      case 'month':
        return sql`to_char(v.voucher_date, 'YYYY-MM')`;
      default:
        return sql`v.party_name`;
    }
  }

  private dimensionLabel(dimension: SalesAnalysisDimension): SQL {
    switch (dimension) {
      case 'party':
        return sql`COALESCE(NULLIF(v.party_name, ''), '(no party)')`;
      case 'item':
        return sql`COALESCE(NULLIF(l.stock_item_name, ''), '(no item)')`;
      case 'itemGroup':
        // Postgres accepts a grouping expression verbatim in the select list
        // and nothing else built from an ungrouped column, so this repeats
        // COALESCE(s.parent_group, '') rather than reaching for the bare
        // column: with NULLIF(s.parent_group, ...) the query was rejected
        // even once the join was in place. Blank and NULL are one group, so
        // "(ungrouped)" appears once rather than twice.
        return sql`CASE WHEN COALESCE(s.parent_group, '') = '' THEN '(ungrouped)' ELSE COALESCE(s.parent_group, '') END`;
      case 'month':
        return sql`to_char(v.voucher_date, 'YYYY-MM')`;
      default:
        return sql`v.party_name`;
    }
  }

  private async salesRows(orgId: string, filters: ReportFilters, sort: string | undefined, limit: number, offset: number, asOf: string | null): Promise<SalesAnalysisSource[]> {
    const dimension = filters.groupBy ?? 'party';
    const orderBy = sort === 'label' ? sql`label ASC` : sort === '-label' ? sql`label DESC` : sort === 'value' ? sql`value ASC, label ASC` : sql`value DESC, label ASC`;
    const grand = await this.db.execute<{ value: string }>(sql`
      SELECT round(COALESCE(sum(l.amount), 0), 2)::text AS value
        FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
       WHERE ${this.salesLinesWhere(orgId, filters)}
    `);
    const grandTotal = Number(grand.rows[0]?.value ?? '0');
    const rows = await this.db.execute<{ key: string; label: string; vouchers: number; quantity: string | null; value: string }>(sql`
      SELECT (${this.dimensionKey(dimension)})::text AS key,
             ${this.dimensionLabel(dimension)} AS label,
             count(DISTINCT v.id)::int AS vouchers,
             -- Only when every line agrees on a unit does a quantity mean anything.
             CASE WHEN count(DISTINCT s.unit) = 1
                  THEN sum(COALESCE(NULLIF(substring(l.billed_qty from '^[0-9]+(?:\\.[0-9]+)?'), ''), '0')::numeric)::text || ' ' || max(s.unit)
                  ELSE NULL END AS quantity,
             round(COALESCE(sum(l.amount), 0), 2)::text AS value
        ${this.salesLinesFrom()}
       WHERE ${this.salesLinesWhere(orgId, filters)}
       GROUP BY ${this.dimensionKey(dimension)}
       ORDER BY ${orderBy}
       LIMIT ${limit} OFFSET ${offset}
    `);
    return rows.rows.map((row) => ({
      key: row.key,
      label: row.label,
      vouchers: Number(row.vouchers),
      quantity: row.quantity,
      value: row.value,
      share: grandTotal === 0 ? '0.0' : ((Number(row.value) / grandTotal) * 100).toFixed(1),
      asOf,
    }));
  }

  // -------------------------------------------------------------- low stock

  /** REQ-AC-06: available = closing − committed, against the Vyuha-held reorder level (D-28). */
  private lowStockQuery(orgId: string): SQL {
    return sql`
      SELECT s.id, s.name,
             s.closing_qty,
             COALESCE((SELECT sum(l.quantity - l.dispatched_qty) FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
                        WHERE l.stock_item_id = s.id AND l.deleted_at IS NULL AND d.doc_type = 'SALES_ORDER' AND d.status = 'CONFIRMED' AND d.short_closed_at IS NULL AND d.deleted_at IS NULL), 0) AS committed,
             COALESCE((SELECT sum(pl.quantity - pl.received_qty - pl.rejected_qty) FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.purchase_order_id
                        WHERE pl.stock_item_id = s.id AND pl.deleted_at IS NULL AND po.status = 'CONFIRMED' AND po.short_closed_at IS NULL AND po.deleted_at IS NULL), 0) AS open_po,
             i.reorder_level, s.last_pulled_at
        FROM stock_items s JOIN item_settings i ON i.stock_item_id = s.id AND i.deleted_at IS NULL AND i.reorder_level IS NOT NULL
       WHERE s.org_id = ${orgId}
         AND (COALESCE(s.closing_qty, 0) - COALESCE((SELECT sum(l.quantity - l.dispatched_qty) FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
                        WHERE l.stock_item_id = s.id AND l.deleted_at IS NULL AND d.doc_type = 'SALES_ORDER' AND d.status = 'CONFIRMED' AND d.short_closed_at IS NULL AND d.deleted_at IS NULL), 0)) <= i.reorder_level`;
  }

  private async lowStockRows(orgId: string, sort: string | undefined, limit: number, offset: number): Promise<LowStockSource[]> {
    const orderBy = sort === 'item' ? sql`name ASC` : sort === 'available' ? sql`available ASC` : sql`shortfall DESC, name ASC`;
    const rows = await this.db.execute<{ id: string; name: string; closing_qty: string | null; committed: string; open_po: string; reorder_level: string; last_pulled_at: Date | null; available: string; shortfall: string }>(sql`
      SELECT t.*, (COALESCE(t.closing_qty, 0) - t.committed)::text AS available,
             GREATEST(t.reorder_level - (COALESCE(t.closing_qty, 0) - t.committed + t.open_po), 0)::text AS shortfall
        FROM (${this.lowStockQuery(orgId)}) t
       ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}
    `);
    return rows.rows.map((r) => ({
      stockItemId: r.id,
      item: r.name,
      closing: r.closing_qty === null ? null : Number(r.closing_qty).toFixed(3),
      committed: Number(r.committed).toFixed(3),
      available: Number(r.available).toFixed(3),
      reorderLevel: Number(r.reorder_level).toFixed(3),
      openPo: Number(r.open_po).toFixed(3),
      shortfall: Number(r.shortfall).toFixed(3),
      asOf: r.last_pulled_at === null ? null : new Date(r.last_pulled_at).toISOString(),
    }));
  }

  // ---------------------------------------------------------------- shared

  private dayBookWhere(orgId: string, filters: ReportFilters): SQL {
    return sql`org_id = ${orgId}
      ${this.periodClause(filters, 'voucher_date')}
      ${filters.partyId === undefined ? sql`` : sql`AND party_id = ${filters.partyId}`}
      ${filters.voucherType === undefined ? sql`` : sql`AND voucher_type ILIKE ${filters.voucherType}`}`;
  }

  private async dayBookRows(orgId: string, filters: ReportFilters, sort: string | undefined, limit: number, offset: number, asOf: string | null): Promise<DayBookSource[]> {
    const order =
      sort === 'date' ? sql`voucher_date ASC, created_at ASC`
      : sort === 'voucherType' ? sql`voucher_type ASC, voucher_date DESC`
      : sort === '-voucherType' ? sql`voucher_type DESC, voucher_date DESC`
      : sort === 'partyName' ? sql`party_name ASC NULLS LAST, voucher_date DESC`
      : sort === '-partyName' ? sql`party_name DESC NULLS LAST, voucher_date DESC`
      : sort === 'amount' ? sql`amount ASC`
      : sort === '-amount' ? sql`amount DESC`
      : sql`voucher_date DESC, created_at DESC`;
    const rows = await this.db.execute<{ id: string; voucher_date: string; voucher_type: string; voucher_number: string; party_name: string | null; amount: string; narration: string | null; is_cancelled: boolean }>(sql`
      SELECT id, voucher_date, voucher_type, voucher_number, party_name, amount::text AS amount, narration, is_cancelled
        FROM vouchers
       WHERE ${this.dayBookWhere(orgId, filters)}
       ORDER BY ${order}
       LIMIT ${limit} OFFSET ${offset}
    `);
    return rows.rows.map((r) => ({
      voucherId: r.id,
      date: r.voucher_date,
      voucherType: r.voucher_type,
      voucherNumber: r.voucher_number,
      partyName: r.party_name,
      amount: r.amount,
      narration: r.narration,
      cancelled: r.is_cancelled,
      asOf,
    }));
  }

  /**
   * 14 REQ-AG-02 / its D-36 default: a customer's expected gap is their own
   * median gap between Sales vouchers; lapsed past twice that, at risk past
   * once. Three sales minimum — two gaps — or a "median" is one interval
   * dressed up as a rhythm. Revenue over the last 365 days ranks the rows:
   * what the silence is costing, not merely how long it has lasted.
   */
  private customerLapseQuery(orgId: string): SQL {
    return sql`
      WITH sales AS (
        SELECT party_id, party_name, voucher_date, amount
          FROM vouchers
         WHERE org_id = ${orgId} AND voucher_type = 'Sales' AND NOT is_cancelled AND party_id IS NOT NULL
      ),
      gaps AS (
        SELECT party_id, voucher_date - lag(voucher_date) OVER (PARTITION BY party_id ORDER BY voucher_date) AS gap
          FROM sales
      ),
      rhythm AS (
        SELECT party_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::int AS median_gap, count(*)::int AS gap_count
          FROM gaps WHERE gap IS NOT NULL GROUP BY party_id HAVING count(*) >= 2
      ),
      latest AS (
        SELECT party_id, max(party_name) AS party_name, max(voucher_date) AS last_sale,
               count(*) FILTER (WHERE voucher_date >= CURRENT_DATE - 365)::int AS sales_12m,
               COALESCE(sum(amount) FILTER (WHERE voucher_date >= CURRENT_DATE - 365), 0) AS revenue_12m
          FROM sales GROUP BY party_id
      )
      SELECT l.party_id, l.party_name, l.last_sale, r.median_gap,
             (CURRENT_DATE - l.last_sale)::int AS days_since,
             (l.last_sale + r.median_gap)::date AS expected_by,
             l.sales_12m, l.revenue_12m::text AS revenue_12m,
             CASE WHEN CURRENT_DATE - l.last_sale > 2 * r.median_gap THEN 'LAPSED'
                  WHEN CURRENT_DATE - l.last_sale > r.median_gap THEN 'AT_RISK'
                  ELSE 'ON_RHYTHM' END AS state
        FROM latest l JOIN rhythm r ON r.party_id = l.party_id
    `;
  }

  private async customerLapseRows(orgId: string, sort: string | undefined, limit: number, offset: number, asOf: string | null): Promise<CustomerLapseSource[]> {
    const order =
      sort === 'partyName' ? sql`party_name ASC`
      : sort === '-partyName' ? sql`party_name DESC`
      : sort === 'lastSaleDate' ? sql`last_sale ASC`
      : sort === '-lastSaleDate' ? sql`last_sale DESC`
      : sort === 'daysSince' ? sql`days_since ASC`
      : sort === '-daysSince' ? sql`days_since DESC`
      : sort === 'revenue12m' ? sql`revenue_12m::numeric ASC`
      : sql`CASE state WHEN 'LAPSED' THEN 0 WHEN 'AT_RISK' THEN 1 ELSE 2 END ASC, revenue_12m::numeric DESC`;
    const rows = await this.db.execute<{ party_id: string; party_name: string; last_sale: string; median_gap: number; days_since: number; expected_by: string; sales_12m: number; revenue_12m: string; state: CustomerLapseSource['state'] }>(sql`
      SELECT * FROM (${this.customerLapseQuery(orgId)}) t ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}
    `);
    return rows.rows.map((r) => ({
      partyId: r.party_id,
      partyName: r.party_name,
      state: r.state,
      lastSaleDate: r.last_sale,
      daysSince: Number(r.days_since),
      medianGapDays: Number(r.median_gap),
      expectedBy: r.expected_by,
      sales12m: Number(r.sales_12m),
      revenue12m: r.revenue_12m,
      asOf,
    }));
  }

  private periodClause(filters: ReportFilters, column: string): SQL {
    const col = sql.raw(column);
    return sql`${filters.from === undefined ? sql`` : sql`AND ${col} >= ${filters.from}`} ${filters.to === undefined ? sql`` : sql`AND ${col} <= ${filters.to}`}`;
  }

  /** REQ-Y-07: the newest pull the figures rest on. */
  private async asOf(orgId: string): Promise<string | null> {
    const rows = await this.db.execute<{ at: Date | null }>(sql`SELECT max(last_pulled_at) AS at FROM vouchers WHERE org_id = ${orgId}`);
    const at = rows.rows[0]?.at ?? null;
    return at === null ? null : new Date(at).toISOString();
  }

  private async scalar(query: SQL): Promise<number> {
    const rows = await this.db.execute<{ value: number }>(query);
    return Number(rows.rows[0]?.value ?? 0);
  }

  private requireHolder(principal: Principal): void {
    if (!hasPermission(principal, PERMISSIONS.RECEIVABLES_VIEW)) {
      throw AppError.forbidden('This report needs receivables.view.');
    }
  }
}
