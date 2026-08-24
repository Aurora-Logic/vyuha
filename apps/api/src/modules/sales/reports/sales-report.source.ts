import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  PERMISSIONS,
  SALES_REPORTS,
  pendingDispatchCell,
  type PendingDispatchSource,
  type ReportCellValue,
  type ReportColumnSpec,
  type ReportDefinition,
  type ReportFilters,
  type ReportKey,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { orderBy as orderByField, type SortMap } from '../../../platform/export/report-order.js';
import { ReportSourceRegistry, type ReportSource, type ReportSourcePage } from '../../../platform/export/report-source.registry.js';
import { hasPermission, type Principal } from '../../../platform/rbac/principal.js';
import { ScopeService } from '../../../platform/rbac/scope.service.js';

const SORTABLE = {
  'pending-dispatch': { orderNumber: 'order_number', customerName: 'customer_name', orderDate: 'order_date', ageDays: 'age_days' },
} satisfies Partial<Record<ReportKey, SortMap>>;

/** The sales module's report (12 REQ-AA-30) under the existing shell, scoped like the orders themselves. */
@Injectable()
export class SalesReportSource implements ReportSource, OnModuleInit {
  readonly keys: readonly ReportKey[] = SALES_REPORTS.map((r) => r.key);

  constructor(
    private readonly registry: ReportSourceRegistry,
    @InjectDatabase() private readonly db: Database,
    private readonly scopes: ScopeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  visibleDefinitions(principal: Principal): readonly ReportDefinition[] {
    return this.holds(principal) ? SALES_REPORTS : [];
  }

  sortableFields(key: ReportKey): readonly string[] {
    return Object.hasOwn(SORTABLE, key) ? Object.keys(SORTABLE[key as keyof typeof SORTABLE]) : [];
  }

  assertFiltersUsable(key: ReportKey, filters: ReportFilters): ReportFilters {
    if (!this.keys.includes(key)) throw new Error(`SalesReportSource does not serve "${key}".`);
    return filters.partyId === undefined ? {} : { partyId: filters.partyId };
  }

  async count(principal: Principal, key: ReportKey, filters: ReportFilters): Promise<number> {
    this.require(principal);
    const usable = this.assertFiltersUsable(key, filters);
    const rows = await this.db.execute<{ value: number }>(sql`SELECT count(*)::int AS value FROM (${this.query(principal, usable)}) t`);
    return Number(rows.rows[0]?.value ?? 0);
  }

  async page(principal: Principal, key: ReportKey, filters: ReportFilters & { sort?: string | undefined }, limit: number, offset: number): Promise<ReportSourcePage> {
    this.require(principal);
    const usable = this.assertFiltersUsable(key, filters);
    const total = await this.count(principal, key, usable);
    const orderBy = orderByField(filters.sort, SORTABLE['pending-dispatch'], 'age_days DESC, order_number ASC', 'order_number ASC');
    const rows = await this.db.execute<{
      id: string; order_id: string; order_number: string; customer_name: string; order_date: string; age_days: number; item: string; ordered: string; packed: string; invoiced: string; dispatched: string; balance: string; fulfilment: string;
    }>(sql`SELECT * FROM (${this.query(principal, usable)}) t ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`);
    const page: ReportSourcePage & { rows: PendingDispatchSource[] } = {
      total,
      rows: rows.rows.map((r) => ({
        id: r.id,
        orderId: r.order_id,
        orderNumber: r.order_number,
        customerName: r.customer_name,
        orderDate: r.order_date,
        ageDays: Number(r.age_days),
        item: r.item,
        ordered: r.ordered,
        packed: r.packed,
        invoiced: r.invoiced,
        dispatched: r.dispatched,
        balance: r.balance,
        fulfilment: r.fulfilment,
      })),
    };
    return page;
  }

  cells(page: ReportSourcePage, index: number, columns: readonly ReportColumnSpec[]): ReportCellValue[] {
    const row = (page as ReportSourcePage & { rows: PendingDispatchSource[] }).rows[index];
    if (row === undefined) throw new Error(`No row ${String(index)} on this page.`);
    return columns.map((column) => pendingDispatchCell(row, column.key));
  }

  private query(principal: Principal, filters: ReportFilters): SQL {
    const scope = this.scopes.resolve(principal, { self: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF, all: PERMISSIONS.SALES_DOCUMENT_VIEW_ALL }, sql`d.owner_id`).where;
    return sql`
      SELECT l.id, d.id AS order_id, d.number AS order_number, d.customer_name, d.date AS order_date,
             (current_date - d.date)::int AS age_days, l.description AS item,
             l.quantity::text AS ordered, l.packed_qty::text AS packed, l.invoiced_qty::text AS invoiced, l.dispatched_qty::text AS dispatched,
             (l.quantity - l.dispatched_qty)::text AS balance,
             CASE WHEN l.invoiced_qty > l.dispatched_qty THEN 'ready_to_dispatch' WHEN l.packed_qty > l.invoiced_qty THEN 'awaiting_invoice' WHEN l.packed_qty > 0 THEN 'picking' ELSE 'open' END AS fulfilment
        FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
       WHERE d.org_id = ${principal.orgId} AND d.doc_type = 'SALES_ORDER' AND d.status = 'CONFIRMED' AND d.short_closed_at IS NULL
         AND d.deleted_at IS NULL AND l.deleted_at IS NULL AND l.quantity > l.dispatched_qty AND ${scope}
         ${filters.partyId === undefined ? sql`` : sql`AND d.party_id = ${filters.partyId}`}`;
  }

  private holds(principal: Principal): boolean {
    return hasPermission(principal, PERMISSIONS.SALES_DOCUMENT_VIEW_SELF) || hasPermission(principal, PERMISSIONS.SALES_DOCUMENT_VIEW_ALL);
  }

  private require(principal: Principal): void {
    if (!this.holds(principal)) throw AppError.forbidden('This report needs sales.document.view.');
  }
}
