import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  PERMISSIONS,
  RETURNS_REPORTS,
  returnRateCustomerCell,
  returnRateItemCell,
  returnsByReasonCell,
  type ReportCellValue,
  type ReportColumnSpec,
  type ReportDefinition,
  type ReportFilters,
  type ReportKey,
  type ReturnRateCustomerSource,
  type ReturnRateItemSource,
  type ReturnsByReasonSource,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { ReportSourceRegistry, type ReportSource, type ReportSourcePage } from '../../../platform/export/report-source.registry.js';
import { hasPermission, type Principal } from '../../../platform/rbac/principal.js';

/**
 * REQ-AK-10: the return rate, three ways — by item, by customer, by reason.
 *
 * The denominator is what **Tally billed** in the period, not what Vyuha
 * dispatched. An organisation still raising some invoices directly in Tally
 * would otherwise see a rate against a fraction of its sales and read it as
 * three times worse than it is. Where nothing was billed the rate is absent
 * rather than zero or infinite (REQ-AD-07): a return against a sale from
 * last quarter is a real return and a meaningless ratio.
 */

type ItemRow = { id: string; item_name: string; returned_qty: string; sold_qty: string; returns: number; scrapped_qty: string; top_reason: string | null; last_returned_on: string };
type CustomerRow = { id: string; party_id: string | null; party_name: string; returned_qty: string; sold_qty: string; returns: number; awaiting_credit: number; top_reason: string | null; last_returned_on: string };
type ReasonRow = { id: string; reason: string; lines: number; returns: number; quantity: string; scrap_lines: number; damaged_lines: number; top_item: string | null; all_lines: number };

interface ReturnsPage extends ReportSourcePage {
  readonly reportKey: ReportKey;
  readonly rows: readonly (ReturnRateItemSource | ReturnRateCustomerSource | ReturnsByReasonSource)[];
}

function ratePct(returned: string, sold: string): number | null {
  const denominator = Number(sold);
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((Number(returned) / denominator) * 1000) / 10;
}

@Injectable()
export class ReturnsReportSource implements ReportSource, OnModuleInit {
  readonly keys: readonly ReportKey[] = RETURNS_REPORTS.map((r) => r.key);

  constructor(
    private readonly registry: ReportSourceRegistry,
    @InjectDatabase() private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  visibleDefinitions(principal: Principal): readonly ReportDefinition[] {
    return hasPermission(principal, PERMISSIONS.RETURNS_VIEW) ? RETURNS_REPORTS : [];
  }

  assertFiltersUsable(key: ReportKey, filters: ReportFilters): ReportFilters {
    if (!this.keys.includes(key)) throw new Error(`ReturnsReportSource does not serve "${key}".`);
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
    const rows = await this.db.execute<{ value: number }>(sql`SELECT count(*)::int AS value FROM (${this.body(principal, key, this.assertFiltersUsable(key, filters))}) t`);
    return Number(rows.rows[0]?.value ?? 0);
  }

  async page(principal: Principal, key: ReportKey, filters: ReportFilters & { sort?: string | undefined }, limit: number, offset: number): Promise<ReportSourcePage> {
    this.require(principal);
    const usable = this.assertFiltersUsable(key, filters);
    const total = await this.count(principal, key, usable);
    const body = this.body(principal, key, usable);

    if (key === 'returns-by-reason') {
      const order = filters.sort === 'reason' ? sql`reason ASC` : filters.sort === 'quantity' ? sql`quantity::numeric DESC` : filters.sort === 'lines' ? sql`lines ASC` : sql`lines DESC`;
      const rows = await this.db.execute<ReasonRow>(sql`SELECT * FROM (${body}) t ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`);
      const page: ReturnsPage = {
        total,
        reportKey: key,
        rows: rows.rows.map((r): ReturnsByReasonSource => ({
          id: r.id,
          reason: r.reason,
          lines: Number(r.lines),
          returns: Number(r.returns),
          quantity: r.quantity,
          sharePct: Number(r.all_lines) > 0 ? Math.round((Number(r.lines) / Number(r.all_lines)) * 1000) / 10 : 0,
          scrapLines: Number(r.scrap_lines),
          damagedLines: Number(r.damaged_lines),
          topItem: r.top_item ?? '—',
        })),
      };
      return page;
    }

    if (key === 'return-rate-by-item') {
      const order = filters.sort === 'itemName' ? sql`item_name ASC` : filters.sort === 'returnedQty' ? sql`returned_qty::numeric ASC` : sql`returned_qty::numeric DESC`;
      const rows = await this.db.execute<ItemRow>(sql`SELECT * FROM (${body}) t ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`);
      const page: ReturnsPage = {
        total,
        reportKey: key,
        rows: rows.rows.map((r): ReturnRateItemSource => ({
          id: r.id,
          itemName: r.item_name,
          returnedQty: r.returned_qty,
          soldQty: r.sold_qty,
          ratePct: ratePct(r.returned_qty, r.sold_qty),
          returns: Number(r.returns),
          scrappedQty: r.scrapped_qty,
          topReason: r.top_reason ?? '—',
          lastReturnedOn: r.last_returned_on,
        })),
      };
      return page;
    }

    const order = filters.sort === 'partyName' ? sql`party_name ASC` : filters.sort === 'returnedQty' ? sql`returned_qty::numeric ASC` : sql`returned_qty::numeric DESC`;
    const rows = await this.db.execute<CustomerRow>(sql`SELECT * FROM (${body}) t ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`);
    const page: ReturnsPage = {
      total,
      reportKey: key,
      rows: rows.rows.map((r): ReturnRateCustomerSource => ({
        id: r.id,
        partyId: r.party_id,
        partyName: r.party_name,
        returnedQty: r.returned_qty,
        soldQty: r.sold_qty,
        ratePct: ratePct(r.returned_qty, r.sold_qty),
        returns: Number(r.returns),
        awaitingCredit: Number(r.awaiting_credit),
        topReason: r.top_reason ?? '—',
        lastReturnedOn: r.last_returned_on,
      })),
    };
    return page;
  }

  cells(page: ReportSourcePage, index: number, columns: readonly ReportColumnSpec[]): ReportCellValue[] {
    const typed = page as ReturnsPage;
    const row = typed.rows[index];
    if (row === undefined) throw new Error(`No row ${String(index)} on this page.`);
    if (typed.reportKey === 'returns-by-reason') return columns.map((column) => returnsByReasonCell(row as ReturnsByReasonSource, column.key));
    if (typed.reportKey === 'return-rate-by-item') return columns.map((column) => returnRateItemCell(row as ReturnRateItemSource, column.key));
    return columns.map((column) => returnRateCustomerCell(row as ReturnRateCustomerSource, column.key));
  }

  private body(principal: Principal, key: ReportKey, filters: ReportFilters): SQL {
    const orgId = principal.orgId;
    // A cancelled receipt is not a return; it is a receipt written in error.
    const period = sql`
      ${filters.from === undefined ? sql`` : sql`AND r.received_on >= ${filters.from}::date`}
      ${filters.to === undefined ? sql`` : sql`AND r.received_on <= ${filters.to}::date`}
      ${filters.partyId === undefined ? sql`` : sql`AND r.party_id = ${filters.partyId}`}
      ${filters.itemName === undefined ? sql`` : sql`AND l.description ILIKE ${`%${filters.itemName}%`}`}`;
    const billedPeriod = sql`
      ${filters.from === undefined ? sql`` : sql`AND v.voucher_date >= ${filters.from}::date`}
      ${filters.to === undefined ? sql`` : sql`AND v.voucher_date <= ${filters.to}::date`}`;

    if (key === 'returns-by-reason') {
      return sql`
        SELECT l.reason AS id, l.reason,
               count(*)::int AS lines,
               count(DISTINCT r.id)::int AS returns,
               sum(l.quantity)::text AS quantity,
               count(*) FILTER (WHERE l.disposition = 'scrap')::int AS scrap_lines,
               count(*) FILTER (WHERE l.condition = 'damaged')::int AS damaged_lines,
               (SELECT l2.description FROM sales_return_lines l2 JOIN sales_returns r2 ON r2.id = l2.return_id
                 WHERE l2.reason = l.reason AND r2.org_id = ${orgId} AND r2.state <> 'cancelled' AND r2.deleted_at IS NULL AND l2.deleted_at IS NULL
                 GROUP BY l2.description ORDER BY sum(l2.quantity) DESC LIMIT 1) AS top_item,
               sum(count(*)) OVER ()::int AS all_lines
          FROM sales_return_lines l
          JOIN sales_returns r ON r.id = l.return_id
         WHERE r.org_id = ${orgId} AND r.state <> 'cancelled' AND r.deleted_at IS NULL AND l.deleted_at IS NULL ${period}
         GROUP BY l.reason`;
    }

    if (key === 'return-rate-by-item') {
      return sql`
        SELECT coalesce(l.stock_item_id::text, 'text:' || l.description) AS id,
               max(coalesce(si.name, l.description)) AS item_name,
               sum(l.quantity)::text AS returned_qty,
               COALESCE((
                 SELECT sum(abs(coalesce(substring(vl.billed_qty FROM '^\\s*-?[0-9]+\\.?[0-9]*')::numeric, 0)))
                   FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
                  WHERE v.org_id = ${orgId} AND v.voucher_type = 'Sales' AND NOT v.is_cancelled AND vl.kind = 'inventory'
                    AND vl.stock_item_name = max(coalesce(si.name, l.description)) ${billedPeriod}
               ), 0)::text AS sold_qty,
               count(DISTINCT r.id)::int AS returns,
               COALESCE(sum(l.quantity) FILTER (WHERE l.disposition = 'scrap'), 0)::text AS scrapped_qty,
               (SELECT l2.reason FROM sales_return_lines l2 JOIN sales_returns r2 ON r2.id = l2.return_id
                 WHERE r2.org_id = ${orgId} AND r2.state <> 'cancelled' AND r2.deleted_at IS NULL AND l2.deleted_at IS NULL
                   AND coalesce(l2.stock_item_id::text, 'text:' || l2.description) = coalesce(l.stock_item_id::text, 'text:' || l.description)
                 GROUP BY l2.reason ORDER BY sum(l2.quantity) DESC LIMIT 1) AS top_reason,
               max(r.received_on)::text AS last_returned_on
          FROM sales_return_lines l
          JOIN sales_returns r ON r.id = l.return_id
          LEFT JOIN stock_items si ON si.id = l.stock_item_id
         WHERE r.org_id = ${orgId} AND r.state <> 'cancelled' AND r.deleted_at IS NULL AND l.deleted_at IS NULL ${period}
         GROUP BY coalesce(l.stock_item_id::text, 'text:' || l.description), l.stock_item_id, l.description`;
    }

    return sql`
      SELECT coalesce(r.party_id::text, 'name:' || r.customer_name) AS id,
             r.party_id, max(r.customer_name) AS party_name,
             sum(l.quantity)::text AS returned_qty,
             COALESCE((
               SELECT sum(abs(coalesce(substring(vl.billed_qty FROM '^\\s*-?[0-9]+\\.?[0-9]*')::numeric, 0)))
                 FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
                WHERE v.org_id = ${orgId} AND v.voucher_type = 'Sales' AND NOT v.is_cancelled AND vl.kind = 'inventory'
                  AND v.party_id = r.party_id ${billedPeriod}
             ), 0)::text AS sold_qty,
             count(DISTINCT r.id)::int AS returns,
             count(DISTINCT r.id) FILTER (WHERE r.state = 'awaiting_credit_note')::int AS awaiting_credit,
             (SELECT l2.reason FROM sales_return_lines l2 JOIN sales_returns r2 ON r2.id = l2.return_id
               WHERE r2.org_id = ${orgId} AND r2.state <> 'cancelled' AND r2.deleted_at IS NULL AND l2.deleted_at IS NULL
                 AND coalesce(r2.party_id::text, 'name:' || r2.customer_name) = coalesce(r.party_id::text, 'name:' || r.customer_name)
               GROUP BY l2.reason ORDER BY sum(l2.quantity) DESC LIMIT 1) AS top_reason,
             max(r.received_on)::text AS last_returned_on
        FROM sales_returns r
        JOIN sales_return_lines l ON l.return_id = r.id AND l.deleted_at IS NULL
       WHERE r.org_id = ${orgId} AND r.state <> 'cancelled' AND r.deleted_at IS NULL ${period}
       GROUP BY coalesce(r.party_id::text, 'name:' || r.customer_name), r.party_id, r.customer_name`;
  }

  private require(principal: Principal): void {
    if (!hasPermission(principal, PERMISSIONS.RETURNS_VIEW)) throw AppError.forbidden('Return reports need returns.view.');
  }
}
