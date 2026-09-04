import { Injectable } from '@nestjs/common';
import {
  PERMISSIONS,
  type AbsentKpi,
  type DateRangeView,
  type HeatCell,
  type ItemAnalytics,
  type ItemCustomerRow,
  type ItemMonthPoint,
  type ItemVendorRow,
  type Kpi,
  type LifecycleAnalyticsQuery,
  type PartyAnalytics,
  type PartyItemRow,
  type PartyMonthPoint,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { live } from './live-document.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import type { Principal } from '../rbac/principal.js';
import { MastersService } from './masters.service.js';

/**
 * The period half of a lifecycle (owner, 22 Aug 2026): the figures a
 * range says about one item or one party, the same figures for the
 * comparison range when one is asked for, the months in between, who is
 * behind them, and the item × month (or customer × month) grid. Raw SQL
 * with the organisation in every WHERE, like the lifecycle and the report
 * sources, because this is a read across every module.
 *
 * Honesty rules from the data-analyst skill: a figure the tables cannot
 * support is absent, named with what it needs, never approximated; the
 * comparison is the range the client computed with the screen's own
 * FY-aware arithmetic, so the two cannot disagree; what a person sees
 * follows the keys they hold (sales, purchase, receivables, margin).
 */

const ROW_CAP = 8;

type Range = DateRangeView;

function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nullable(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? round((part / whole) * 100, 1) : 0;
}

function kpi(value: number, previous: number | null): Kpi {
  return { value: round(value), previous: previous === null ? null : round(previous) };
}

/** Whole months a range spans, at least one, for "per month" figures. */
function monthsIn(range: Range): number {
  const [fy = 0, fm = 1] = range.from.split('-').map(Number);
  const [ty = 0, tm = 1] = range.to.split('-').map(Number);
  return Math.max(1, (ty - fy) * 12 + (tm - fm) + 1);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2, 1);
}

const RECEIVABLES_ABSENT: readonly AbsentKpi[] = [
  { label: 'Receivables ageing', needs: 'bill-wise allocations from Tally' },
  { label: 'Credit cycle (DSO)', needs: 'bill-wise allocations from Tally' },
  { label: 'Payment delay', needs: 'bill-wise allocations from Tally' },
];

@Injectable()
export class LifecycleAnalyticsService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly masters: MastersService,
  ) {}

  // ------------------------------------------------------------------ item

  async item(principal: Principal, itemId: string, query: LifecycleAnalyticsQuery): Promise<ItemAnalytics> {
    const item = await this.masters.findStockItem(principal, itemId);
    const orgId = principal.orgId;
    const sales = this.salesScope(principal);
    const purchase = principal.permissions.has(PERMISSIONS.PURCHASE_DOCUMENT_VIEW);
    const vouchers = principal.permissions.has(PERMISSIONS.RECEIVABLES_VIEW);
    const margin = principal.permissions.has(PERMISSIONS.REPORTS_MARGIN_VIEW);
    const period: Range = { from: query.from, to: query.to };
    const comparison: Range | null = query.compareFrom !== undefined && query.compareTo !== undefined ? { from: query.compareFrom, to: query.compareTo } : null;

    const [current, previous, now, monthly, monthlyComparison, customers, vendors, heat] = await Promise.all([
      this.itemRange(orgId, itemId, period, sales, purchase, vouchers),
      comparison === null ? Promise.resolve(null) : this.itemRange(orgId, itemId, comparison, sales, purchase, vouchers),
      this.itemNow(orgId, itemId, sales, purchase),
      this.itemMonthly(orgId, itemId, period, sales, purchase, vouchers),
      comparison === null ? Promise.resolve(null) : this.itemMonthly(orgId, itemId, comparison, sales, purchase, vouchers),
      sales === null ? Promise.resolve([]) : this.itemCustomers(orgId, itemId, period, sales),
      !purchase ? Promise.resolve([]) : this.itemVendors(orgId, itemId, period),
      sales === null ? Promise.resolve([]) : this.itemHeat(orgId, itemId, period, sales),
    ]);

    const prev = (read: (r: ItemRangeFigures) => number): number | null => (previous === null ? null : read(previous));
    const realised = current.billedQty > 0 ? current.revenue / current.billedQty : 0;
    const perMonthDispatched = current.dispatched / monthsIn(period);
    const closingQty = nullable(item.closingQty);
    const absent: AbsentKpi[] = [];
    if (!vouchers) absent.push({ label: 'Revenue, realised rate', needs: 'the receivables key (Tally vouchers)' });
    if (!purchase) absent.push({ label: 'Purchases, vendors', needs: 'the purchase view key' });
    if (sales === null) absent.push({ label: 'Orders, customers', needs: 'a sales view key' });

    return {
      period,
      comparison,
      kpis: {
        ordered: kpi(current.ordered, prev((r) => r.ordered)),
        dispatched: kpi(current.dispatched, prev((r) => r.dispatched)),
        fulfilmentPct: kpi(pct(current.dispatched, current.ordered), prev((r) => pct(r.dispatched, r.ordered))),
        orders: kpi(current.orders, prev((r) => r.orders)),
        customers: kpi(current.customers, prev((r) => r.customers)),
        repeatBuyers: kpi(current.repeatBuyers, prev((r) => r.repeatBuyers)),
        topCustomerSharePct: kpi(pct(current.topCustomerQty, current.ordered), prev((r) => pct(r.topCustomerQty, r.ordered))),
        revenue: kpi(current.revenue, prev((r) => r.revenue)),
        billedQty: kpi(current.billedQty, prev((r) => r.billedQty)),
        realisedRate: kpi(realised, prev((r) => (r.billedQty > 0 ? r.revenue / r.billedQty : 0))),
        purchased: kpi(current.purchased, prev((r) => r.purchased)),
        received: kpi(current.received, prev((r) => r.received)),
        purchaseRate: kpi(current.purchased > 0 ? current.purchaseValue / current.purchased : 0, prev((r) => (r.purchased > 0 ? r.purchaseValue / r.purchased : 0))),
        shortages: kpi(current.shortages, prev((r) => r.shortages)),
        openOrders: now.openOrders,
        closingQty,
        monthsOfCover: closingQty !== null && perMonthDispatched > 0 ? round(closingQty / perMonthDispatched, 1) : null,
        lastSoldAt: now.lastSoldAt,
        lastSoldRate: now.lastSoldRate,
        lastPurchasedAt: now.lastPurchasedAt,
        lastPurchaseRate: now.lastPurchaseRate,
        marginProxyPct: margin && realised > 0 && item.costPrice !== null && num(item.costPrice) > 0 ? round(((realised - num(item.costPrice)) / realised) * 100, 1) : null,
      },
      monthly,
      monthlyComparison,
      customers,
      vendors,
      heat,
      absent,
    };
  }

  private async itemRange(orgId: string, itemId: string, range: Range, sales: SQL | null, purchase: boolean, vouchers: boolean): Promise<ItemRangeFigures> {
    const [s, v, p, shortages] = await Promise.all([
      sales === null
        ? Promise.resolve(null)
        : this.db
            .execute<{ ordered: string; dispatched: string; orders: number; customers: number; repeat_buyers: number; top_customer_qty: string }>(sql`
              WITH lines AS (
                SELECT l.quantity, l.dispatched_qty, d.id AS doc_id, coalesce(d.party_id::text, d.customer_name) AS customer
                  FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
                 WHERE d.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')}
                   AND d.deleted_at IS NULL AND d.date BETWEEN ${range.from} AND ${range.to} AND ${sales}
              ), by_customer AS (
                SELECT customer, sum(quantity) AS qty, count(DISTINCT doc_id) AS orders FROM lines GROUP BY customer
              )
              SELECT coalesce((SELECT sum(quantity) FROM lines), 0)::text AS ordered,
                     coalesce((SELECT sum(dispatched_qty) FROM lines), 0)::text AS dispatched,
                     (SELECT count(DISTINCT doc_id) FROM lines)::int AS orders,
                     (SELECT count(*) FROM by_customer)::int AS customers,
                     (SELECT count(*) FROM by_customer WHERE orders >= 2)::int AS repeat_buyers,
                     coalesce((SELECT max(qty) FROM by_customer), 0)::text AS top_customer_qty
            `)
            .then((r) => r.rows[0] ?? null),
      !vouchers
        ? Promise.resolve(null)
        : this.db
            .execute<{ revenue: string; billed_qty: string }>(sql`
              SELECT coalesce(sum(CASE WHEN v.voucher_type = 'Credit Note' THEN -abs(vl.amount) ELSE abs(vl.amount) END), 0)::text AS revenue,
                     coalesce(sum(CASE WHEN v.voucher_type = 'Credit Note' THEN -abs(coalesce(substring(vl.billed_qty FROM '^\\s*-?[0-9]+\\.?[0-9]*')::numeric, 0)) ELSE abs(coalesce(substring(vl.billed_qty FROM '^\\s*-?[0-9]+\\.?[0-9]*')::numeric, 0)) END), 0)::text AS billed_qty
                -- billed_qty is Tally's text ("2 BOX"); its numeric head is the quantity.
                FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
               WHERE v.org_id = ${orgId} AND vl.stock_item_id = ${itemId} AND v.is_cancelled = false
                 AND v.voucher_type IN ('Sales', 'Credit Note') AND v.voucher_date BETWEEN ${range.from} AND ${range.to}
            `)
            .then((r) => r.rows[0] ?? null),
      !purchase
        ? Promise.resolve(null)
        : this.db
            .execute<{ purchased: string; received: string; value: string }>(sql`
              SELECT coalesce(sum(l.quantity), 0)::text AS purchased, coalesce(sum(l.received_qty), 0)::text AS received, coalesce(sum(l.amount), 0)::text AS value
                FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.purchase_order_id
               WHERE p.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND ${live('p')} AND p.deleted_at IS NULL
                 AND p.date BETWEEN ${range.from} AND ${range.to}
            `)
            .then((r) => r.rows[0] ?? null),
      this.db
        .execute<{ shortages: number }>(sql`
          SELECT count(*)::int AS shortages FROM procurement_requirements
           WHERE org_id = ${orgId} AND stock_item_id = ${itemId} AND source = 'shortage' AND deleted_at IS NULL
             AND created_at::date BETWEEN ${range.from} AND ${range.to}
        `)
        .then((r) => r.rows[0]?.shortages ?? 0),
    ]);
    return {
      ordered: num(s?.ordered),
      dispatched: num(s?.dispatched),
      orders: s?.orders ?? 0,
      customers: s?.customers ?? 0,
      repeatBuyers: s?.repeat_buyers ?? 0,
      topCustomerQty: num(s?.top_customer_qty),
      revenue: num(v?.revenue),
      billedQty: num(v?.billed_qty),
      purchased: num(p?.purchased),
      received: num(p?.received),
      purchaseValue: num(p?.value),
      shortages,
    };
  }

  private async itemNow(orgId: string, itemId: string, sales: SQL | null, purchase: boolean) {
    const [s, p] = await Promise.all([
      sales === null
        ? Promise.resolve(null)
        : this.db
            .execute<{ open_orders: number; last_sold_at: string | null; last_rate: string | null }>(sql`
              SELECT count(DISTINCT d.id) FILTER (WHERE l.dispatched_qty < l.quantity AND d.short_closed_at IS NULL)::int AS open_orders,
                     max(d.date)::text AS last_sold_at,
                     (array_agg(l.rate ORDER BY d.date DESC, d.created_at DESC))[1]::text AS last_rate
                FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
               WHERE d.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')} AND d.deleted_at IS NULL AND ${sales}
            `)
            .then((r) => r.rows[0] ?? null),
      !purchase
        ? Promise.resolve(null)
        : this.db
            .execute<{ last_at: string | null; last_rate: string | null }>(sql`
              SELECT max(p.date)::text AS last_at, (array_agg(l.rate ORDER BY p.date DESC, p.created_at DESC))[1]::text AS last_rate
                FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.purchase_order_id
               WHERE p.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND ${live('p')} AND p.deleted_at IS NULL
            `)
            .then((r) => r.rows[0] ?? null),
    ]);
    return {
      openOrders: s?.open_orders ?? 0,
      lastSoldAt: s?.last_sold_at ?? null,
      lastSoldRate: nullable(s?.last_rate),
      lastPurchasedAt: p?.last_at ?? null,
      lastPurchaseRate: nullable(p?.last_rate),
    };
  }

  private async itemMonthly(orgId: string, itemId: string, range: Range, sales: SQL | null, purchase: boolean, vouchers: boolean): Promise<ItemMonthPoint[]> {
    const months = new Map<string, { ordered: number; dispatched: number; revenue: number; purchased: number; received: number }>();
    const at = (month: string) => {
      const entry = months.get(month) ?? { ordered: 0, dispatched: 0, revenue: 0, purchased: 0, received: 0 };
      months.set(month, entry);
      return entry;
    };
    const [s, v, p] = await Promise.all([
      sales === null
        ? Promise.resolve([])
        : this.db
            .execute<{ month: string; ordered: string; dispatched: string }>(sql`
              SELECT to_char(date_trunc('month', d.date), 'YYYY-MM') AS month, sum(l.quantity)::text AS ordered, sum(l.dispatched_qty)::text AS dispatched
                FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
               WHERE d.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')}
                 AND d.deleted_at IS NULL AND d.date BETWEEN ${range.from} AND ${range.to} AND ${sales}
               GROUP BY 1
            `)
            .then((r) => r.rows),
      !vouchers
        ? Promise.resolve([])
        : this.db
            .execute<{ month: string; revenue: string }>(sql`
              SELECT to_char(date_trunc('month', v.voucher_date), 'YYYY-MM') AS month,
                     sum(CASE WHEN v.voucher_type = 'Credit Note' THEN -abs(vl.amount) ELSE abs(vl.amount) END)::text AS revenue
                FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
               WHERE v.org_id = ${orgId} AND vl.stock_item_id = ${itemId} AND v.is_cancelled = false
                 AND v.voucher_type IN ('Sales', 'Credit Note') AND v.voucher_date BETWEEN ${range.from} AND ${range.to}
               GROUP BY 1
            `)
            .then((r) => r.rows),
      !purchase
        ? Promise.resolve([])
        : this.db
            .execute<{ month: string; purchased: string; received: string }>(sql`
              SELECT to_char(date_trunc('month', p.date), 'YYYY-MM') AS month, sum(l.quantity)::text AS purchased, sum(l.received_qty)::text AS received
                FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.purchase_order_id
               WHERE p.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND ${live('p')} AND p.deleted_at IS NULL
                 AND p.date BETWEEN ${range.from} AND ${range.to}
               GROUP BY 1
            `)
            .then((r) => r.rows),
    ]);
    for (const row of s) {
      const e = at(row.month);
      e.ordered = num(row.ordered);
      e.dispatched = num(row.dispatched);
    }
    for (const row of v) at(row.month).revenue = num(row.revenue);
    for (const row of p) {
      const e = at(row.month);
      e.purchased = num(row.purchased);
      e.received = num(row.received);
    }
    return fillMonths(range, [...months.keys()]).map((month) => {
      const e = months.get(month) ?? { ordered: 0, dispatched: 0, revenue: 0, purchased: 0, received: 0 };
      return { month, ordered: round(e.ordered, 3), dispatched: round(e.dispatched, 3), revenue: round(e.revenue), purchased: round(e.purchased, 3), received: round(e.received, 3) };
    });
  }

  private async itemCustomers(orgId: string, itemId: string, range: Range, sales: SQL): Promise<ItemCustomerRow[]> {
    const rows = await this.db
      .execute<{ id: string | null; name: string; quantity: string; value: string; orders: number; last_at: string; last_rate: string | null }>(sql`
        SELECT d.party_id AS id, d.customer_name AS name, sum(l.quantity)::text AS quantity, sum(l.amount)::text AS value,
               count(DISTINCT d.id)::int AS orders, max(d.date)::text AS last_at, (array_agg(l.rate ORDER BY d.date DESC))[1]::text AS last_rate
          FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
         WHERE d.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')}
           AND d.deleted_at IS NULL AND d.date BETWEEN ${range.from} AND ${range.to} AND ${sales}
         GROUP BY d.party_id, d.customer_name ORDER BY sum(l.quantity) DESC LIMIT ${ROW_CAP}
      `)
      .then((r) => r.rows);
    return rows.map((r) => ({ id: r.id, name: r.name, quantity: round(num(r.quantity), 3), value: round(num(r.value)), orders: r.orders, lastAt: r.last_at, lastRate: nullable(r.last_rate) }));
  }

  private async itemVendors(orgId: string, itemId: string, range: Range): Promise<ItemVendorRow[]> {
    const rows = await this.db
      .execute<{
        id: string | null;
        name: string;
        quantity: string;
        value: string;
        purchase_orders: number;
        last_at: string;
        last_rate: string | null;
        lead_time_days: string | null;
        promised_days: number | null;
        rejected_pct: string | null;
      }>(sql`
        SELECT p.party_id AS id, p.vendor_name AS name, sum(l.quantity)::text AS quantity, sum(l.amount)::text AS value,
               count(DISTINCT p.id)::int AS purchase_orders, max(p.date)::text AS last_at,
               (array_agg(l.rate ORDER BY p.date DESC))[1]::text AS last_rate,
               (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (g.first_receipt - q.date::timestamptz)) / 86400)
                  FROM purchase_orders q
                  JOIN LATERAL (SELECT min(gr.received_at) AS first_receipt FROM grns gr WHERE gr.purchase_order_id = q.id AND gr.deleted_at IS NULL) g ON TRUE
                 WHERE q.org_id = ${orgId} AND q.party_id = p.party_id AND q.deleted_at IS NULL AND g.first_receipt IS NOT NULL
                   AND EXISTS (SELECT 1 FROM purchase_order_lines ql WHERE ql.purchase_order_id = q.id AND ql.stock_item_id = ${itemId}))::text AS lead_time_days,
               (SELECT iv.lead_time_days FROM item_vendors iv WHERE iv.org_id = ${orgId} AND iv.stock_item_id = ${itemId} AND iv.party_id = p.party_id AND iv.deleted_at IS NULL LIMIT 1) AS promised_days,
               CASE WHEN sum(l.received_qty + l.rejected_qty) > 0 THEN (sum(l.rejected_qty) * 100 / sum(l.received_qty + l.rejected_qty))::text ELSE NULL END AS rejected_pct
          FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.purchase_order_id
         WHERE p.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND ${live('p')} AND p.deleted_at IS NULL
           AND p.date BETWEEN ${range.from} AND ${range.to}
         GROUP BY p.party_id, p.vendor_name ORDER BY sum(l.quantity) DESC LIMIT ${ROW_CAP}
      `)
      .then((r) => r.rows);
    const rates = rows.map((r) => nullable(r.last_rate)).filter((r): r is number => r !== null && r > 0);
    const best = rates.length > 1 ? Math.min(...rates) : null;
    return rows.map((r) => {
      const lastRate = nullable(r.last_rate);
      return {
        id: r.id,
        name: r.name,
        quantity: round(num(r.quantity), 3),
        value: round(num(r.value)),
        purchaseOrders: r.purchase_orders,
        lastAt: r.last_at,
        lastRate,
        variancePct: best !== null && lastRate !== null ? round(((lastRate - best) / best) * 100, 1) : null,
        leadTimeDays: r.lead_time_days === null ? null : round(num(r.lead_time_days), 1),
        promisedDays: r.promised_days,
        rejectedPct: r.rejected_pct === null ? null : round(num(r.rejected_pct), 1),
      };
    });
  }

  private async itemHeat(orgId: string, itemId: string, range: Range, sales: SQL): Promise<HeatCell[]> {
    const rows = await this.db
      .execute<{ row_id: string | null; row: string; month: string; value: string }>(sql`
        WITH top AS (
          SELECT coalesce(d.party_id::text, d.customer_name) AS key
            FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
           WHERE d.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')}
             AND d.deleted_at IS NULL AND d.date BETWEEN ${range.from} AND ${range.to} AND ${sales}
           GROUP BY 1 ORDER BY sum(l.quantity) DESC LIMIT ${ROW_CAP}
        )
        SELECT d.party_id AS row_id, d.customer_name AS row, to_char(date_trunc('month', d.date), 'YYYY-MM') AS month, sum(l.quantity)::text AS value
          FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
         WHERE d.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')}
           AND d.deleted_at IS NULL AND d.date BETWEEN ${range.from} AND ${range.to} AND ${sales}
           AND coalesce(d.party_id::text, d.customer_name) IN (SELECT key FROM top)
         GROUP BY 1, 2, 3
      `)
      .then((r) => r.rows);
    return rows.map((r) => ({ row: r.row, rowId: r.row_id, month: r.month, value: round(num(r.value), 3) }));
  }

  // ----------------------------------------------------------------- party

  async party(principal: Principal, partyId: string, query: LifecycleAnalyticsQuery): Promise<PartyAnalytics> {
    await this.masters.findParty(principal, partyId);
    const orgId = principal.orgId;
    const sales = this.salesScope(principal);
    const purchase = principal.permissions.has(PERMISSIONS.PURCHASE_DOCUMENT_VIEW);
    const vouchers = principal.permissions.has(PERMISSIONS.RECEIVABLES_VIEW);
    const period: Range = { from: query.from, to: query.to };
    const comparison: Range | null = query.compareFrom !== undefined && query.compareTo !== undefined ? { from: query.compareFrom, to: query.compareTo } : null;

    const [current, previous, now, monthly, monthlyComparison, itemsBought, itemsSupplied, heatBought, heatSupplied] = await Promise.all([
      this.partyRange(orgId, partyId, period, sales, purchase, vouchers),
      comparison === null ? Promise.resolve(null) : this.partyRange(orgId, partyId, comparison, sales, purchase, vouchers),
      this.partyNow(orgId, partyId, sales, purchase),
      this.partyMonthly(orgId, partyId, period, sales, purchase, vouchers),
      comparison === null ? Promise.resolve(null) : this.partyMonthly(orgId, partyId, comparison, sales, purchase, vouchers),
      sales === null ? Promise.resolve([]) : this.partyItemsBought(orgId, partyId, period, sales),
      !purchase ? Promise.resolve([]) : this.partyItemsSupplied(orgId, partyId, period),
      sales === null ? Promise.resolve([]) : this.partyHeat(orgId, partyId, period, 'customer', sales),
      !purchase ? Promise.resolve([]) : this.partyHeat(orgId, partyId, period, 'vendor', sales),
    ]);

    const prev = (read: (r: PartyRangeFigures) => number): number | null => (previous === null ? null : read(previous));
    const absent: AbsentKpi[] = [...RECEIVABLES_ABSENT];
    if (!vouchers) absent.push({ label: 'Revenue, invoices, collected', needs: 'the receivables key (Tally vouchers)' });
    if (!purchase) absent.push({ label: 'Purchases', needs: 'the purchase view key' });
    if (sales === null) absent.push({ label: 'Orders, dispatches', needs: 'a sales view key' });

    const customer: PartyAnalytics['customer'] =
      sales === null && !vouchers
        ? null
        : {
            revenue: kpi(current.revenue, prev((r) => r.revenue)),
            invoices: kpi(current.invoices, prev((r) => r.invoices)),
            averageInvoice: kpi(current.invoices > 0 ? current.revenue / current.invoices : 0, prev((r) => (r.invoices > 0 ? r.revenue / r.invoices : 0))),
            collected: kpi(current.collected, prev((r) => r.collected)),
            orders: kpi(current.orders, prev((r) => r.orders)),
            orderedValue: kpi(current.orderedValue, prev((r) => r.orderedValue)),
            orderedQty: kpi(current.orderedQty, prev((r) => r.orderedQty)),
            dispatchedQty: kpi(current.dispatchedQty, prev((r) => r.dispatchedQty)),
            fulfilmentPct: kpi(pct(current.dispatchedQty, current.orderedQty), prev((r) => pct(r.dispatchedQty, r.orderedQty))),
            partialShipmentPct: kpi(pct(current.partialOrders, current.dispatchedOrders), prev((r) => pct(r.partialOrders, r.dispatchedOrders))),
            leadTimeMedianDays: kpi(current.leadMedian ?? 0, prev((r) => r.leadMedian ?? 0)),
            leadTimeP90Days: kpi(current.leadP90 ?? 0, prev((r) => r.leadP90 ?? 0)),
            revenueSharePct: kpi(pct(current.revenue, current.orgRevenue), prev((r) => pct(r.revenue, r.orgRevenue))),
            openOrders: now.openOrders,
            lastOrderAt: now.lastOrderAt,
            daysSinceLastOrder: now.lastOrderAt === null ? null : daysBetween(now.lastOrderAt, query.to),
            medianOrderGapDays: now.medianGap,
            dormant: now.medianGap !== null && now.lastOrderAt !== null && daysBetween(now.lastOrderAt, query.to) > 2 * now.medianGap,
          };

    const vendor: PartyAnalytics['vendor'] = !purchase
      ? null
      : {
          purchaseOrders: kpi(current.purchaseOrders, prev((r) => r.purchaseOrders)),
          purchasedValue: kpi(current.purchasedValue, prev((r) => r.purchasedValue)),
          orderedQty: kpi(current.purchasedQty, prev((r) => r.purchasedQty)),
          receivedQty: kpi(current.receivedQty, prev((r) => r.receivedQty)),
          receipts: kpi(current.receipts, prev((r) => r.receipts)),
          rejectedPct: kpi(pct(current.rejectedQty, current.receivedQty + current.rejectedQty), prev((r) => pct(r.rejectedQty, r.receivedQty + r.rejectedQty))),
          leadTimeMedianDays: kpi(current.vendorLeadMedian ?? 0, prev((r) => r.vendorLeadMedian ?? 0)),
          leadTimeP90Days: kpi(current.vendorLeadP90 ?? 0, prev((r) => r.vendorLeadP90 ?? 0)),
          promisedDays: now.promisedDays,
          openPurchaseOrders: now.openPurchaseOrders,
          lastPurchaseAt: now.lastPurchaseAt,
        };

    return {
      period,
      comparison,
      customer,
      vendor,
      monthly,
      monthlyComparison,
      itemsBought,
      itemsSupplied,
      heat: heatBought.length > 0 ? heatBought : heatSupplied,
      absent,
    };
  }

  private async partyRange(orgId: string, partyId: string, range: Range, sales: SQL | null, purchase: boolean, vouchers: boolean): Promise<PartyRangeFigures> {
    const [s, v, p] = await Promise.all([
      sales === null
        ? Promise.resolve(null)
        : this.db
            .execute<{
              orders: number;
              ordered_value: string;
              ordered_qty: string;
              dispatched_qty: string;
              dispatched_orders: number;
              partial_orders: number;
              lead_median: string | null;
              lead_p90: string | null;
            }>(sql`
              WITH orders AS (
                SELECT d.id, d.date, d.grand_total, d.short_closed_at,
                       (SELECT count(*) FROM dispatches x WHERE x.document_id = d.id AND x.deleted_at IS NULL) AS dispatches,
                       (SELECT min(x.dispatched_at) FROM dispatches x WHERE x.document_id = d.id AND x.deleted_at IS NULL) AS first_dispatch
                  FROM sales_documents d
                 WHERE d.org_id = ${orgId} AND d.party_id = ${partyId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')}
                   AND d.deleted_at IS NULL AND d.date BETWEEN ${range.from} AND ${range.to} AND ${sales}
              )
              SELECT (SELECT count(*) FROM orders)::int AS orders,
                     coalesce((SELECT sum(grand_total) FROM orders), 0)::text AS ordered_value,
                     coalesce((SELECT sum(l.quantity) FROM sales_document_lines l WHERE l.document_id IN (SELECT id FROM orders)), 0)::text AS ordered_qty,
                     coalesce((SELECT sum(l.dispatched_qty) FROM sales_document_lines l WHERE l.document_id IN (SELECT id FROM orders)), 0)::text AS dispatched_qty,
                     (SELECT count(*) FROM orders WHERE dispatches > 0)::int AS dispatched_orders,
                     (SELECT count(*) FROM orders WHERE dispatches >= 2 OR (dispatches > 0 AND short_closed_at IS NOT NULL))::int AS partial_orders,
                     (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_dispatch - date::timestamptz)) / 86400) FROM orders WHERE first_dispatch IS NOT NULL)::text AS lead_median,
                     (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (first_dispatch - date::timestamptz)) / 86400) FROM orders WHERE first_dispatch IS NOT NULL)::text AS lead_p90
            `)
            .then((r) => r.rows[0] ?? null),
      !vouchers
        ? Promise.resolve(null)
        : this.db
            .execute<{ revenue: string; invoices: number; collected: string; org_revenue: string }>(sql`
              SELECT coalesce(sum(CASE WHEN v.voucher_type = 'Sales' THEN abs(v.amount) WHEN v.voucher_type = 'Credit Note' THEN -abs(v.amount) ELSE 0 END) FILTER (WHERE v.party_id = ${partyId}), 0)::text AS revenue,
                     count(*) FILTER (WHERE v.party_id = ${partyId} AND v.voucher_type = 'Sales')::int AS invoices,
                     coalesce(sum(abs(v.amount)) FILTER (WHERE v.party_id = ${partyId} AND v.voucher_type = 'Receipt'), 0)::text AS collected,
                     coalesce(sum(CASE WHEN v.voucher_type = 'Sales' THEN abs(v.amount) WHEN v.voucher_type = 'Credit Note' THEN -abs(v.amount) ELSE 0 END), 0)::text AS org_revenue
                FROM vouchers v
               WHERE v.org_id = ${orgId} AND v.is_cancelled = false AND v.voucher_date BETWEEN ${range.from} AND ${range.to}
            `)
            .then((r) => r.rows[0] ?? null),
      !purchase
        ? Promise.resolve(null)
        : this.db
            .execute<{ purchase_orders: number; purchased_value: string; purchased_qty: string; received_qty: string; rejected_qty: string; receipts: number; lead_median: string | null; lead_p90: string | null }>(sql`
              WITH pos AS (
                SELECT p.id, p.date, p.grand_total,
                       (SELECT min(g.received_at) FROM grns g WHERE g.purchase_order_id = p.id AND g.deleted_at IS NULL) AS first_receipt
                  FROM purchase_orders p
                 WHERE p.org_id = ${orgId} AND p.party_id = ${partyId} AND ${live('p')} AND p.deleted_at IS NULL
                   AND p.date BETWEEN ${range.from} AND ${range.to}
              ), tally_vch AS (
                SELECT v.id, v.voucher_date,
                       CASE WHEN v.voucher_type IN ('Purchase', 'GST PURCHASE') THEN abs(v.amount)
                            WHEN v.voucher_type = 'Debit Note' THEN -abs(v.amount)
                            ELSE 0 END AS amount
                  FROM vouchers v
                 WHERE v.org_id = ${orgId} AND v.party_id = ${partyId} AND v.is_cancelled = false
                   AND v.voucher_type IN ('Purchase', 'GST PURCHASE', 'Debit Note')
                   AND v.voucher_date BETWEEN ${range.from} AND ${range.to}
              ), tally_lines AS (
                SELECT vl.voucher_id,
                       coalesce(substring(vl.billed_qty FROM '^\s*-?[0-9]+\.?[0-9]*')::numeric, 0) AS qty
                  FROM voucher_lines vl
                  JOIN vouchers v ON v.id = vl.voucher_id
                 WHERE v.org_id = ${orgId} AND v.party_id = ${partyId} AND v.is_cancelled = false
                   AND v.voucher_type IN ('Purchase', 'GST PURCHASE')
                   AND vl.kind = 'inventory'
                   AND v.voucher_date BETWEEN ${range.from} AND ${range.to}
              )
              SELECT ((SELECT count(*) FROM pos) + (SELECT count(*) FROM tally_vch WHERE amount > 0))::int AS purchase_orders,
                     (coalesce((SELECT sum(grand_total) FROM pos), 0) + coalesce((SELECT sum(amount) FROM tally_vch), 0))::text AS purchased_value,
                     (coalesce((SELECT sum(l.quantity) FROM purchase_order_lines l WHERE l.purchase_order_id IN (SELECT id FROM pos)), 0) + coalesce((SELECT sum(qty) FROM tally_lines), 0))::text AS purchased_qty,
                     (coalesce((SELECT sum(l.received_qty) FROM purchase_order_lines l WHERE l.purchase_order_id IN (SELECT id FROM pos)), 0) + coalesce((SELECT sum(qty) FROM tally_lines), 0))::text AS received_qty,
                     coalesce((SELECT sum(l.rejected_qty) FROM purchase_order_lines l WHERE l.purchase_order_id IN (SELECT id FROM pos)), 0)::text AS rejected_qty,
                     ((SELECT count(*) FROM grns g JOIN purchase_orders q ON q.id = g.purchase_order_id
                        WHERE q.org_id = ${orgId} AND q.party_id = ${partyId} AND g.deleted_at IS NULL AND g.received_at::date BETWEEN ${range.from} AND ${range.to}) + (SELECT count(*) FROM tally_vch WHERE amount > 0))::int AS receipts,
                     (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_receipt - date::timestamptz)) / 86400) FROM pos WHERE first_receipt IS NOT NULL)::text AS lead_median,
                     (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (first_receipt - date::timestamptz)) / 86400) FROM pos WHERE first_receipt IS NOT NULL)::text AS lead_p90
            `)
            .then((r) => r.rows[0] ?? null),
    ]);
    return {
      orders: s?.orders ?? 0,
      orderedValue: num(s?.ordered_value),
      orderedQty: num(s?.ordered_qty),
      dispatchedQty: num(s?.dispatched_qty),
      dispatchedOrders: s?.dispatched_orders ?? 0,
      partialOrders: s?.partial_orders ?? 0,
      leadMedian: s?.lead_median === null || s?.lead_median === undefined ? null : round(num(s.lead_median), 1),
      leadP90: s?.lead_p90 === null || s?.lead_p90 === undefined ? null : round(num(s.lead_p90), 1),
      revenue: num(v?.revenue),
      invoices: v?.invoices ?? 0,
      collected: num(v?.collected),
      orgRevenue: num(v?.org_revenue),
      purchaseOrders: p?.purchase_orders ?? 0,
      purchasedValue: num(p?.purchased_value),
      purchasedQty: num(p?.purchased_qty),
      receivedQty: num(p?.received_qty),
      rejectedQty: num(p?.rejected_qty),
      receipts: p?.receipts ?? 0,
      vendorLeadMedian: p?.lead_median === null || p?.lead_median === undefined ? null : round(num(p.lead_median), 1),
      vendorLeadP90: p?.lead_p90 === null || p?.lead_p90 === undefined ? null : round(num(p.lead_p90), 1),
    };
  }

  private async partyNow(orgId: string, partyId: string, sales: SQL | null, purchase: boolean) {
    const [s, dates, p] = await Promise.all([
      sales === null
        ? Promise.resolve(null)
        : this.db
            .execute<{ open_orders: number; last_order_at: string | null }>(sql`
              SELECT count(*) FILTER (WHERE d.short_closed_at IS NULL
                       AND EXISTS (SELECT 1 FROM sales_document_lines l WHERE l.document_id = d.id AND l.dispatched_qty < l.quantity))::int AS open_orders,
                     max(d.date)::text AS last_order_at
                FROM sales_documents d
               WHERE d.org_id = ${orgId} AND d.party_id = ${partyId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')} AND d.deleted_at IS NULL AND ${sales}
            `)
            .then((r) => r.rows[0] ?? null),
      sales === null
        ? Promise.resolve([])
        : this.db
            .execute<{ date: string }>(sql`
              SELECT DISTINCT d.date::text AS date FROM sales_documents d
               WHERE d.org_id = ${orgId} AND d.party_id = ${partyId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')} AND d.deleted_at IS NULL AND ${sales}
               ORDER BY 1
            `)
            .then((r) => r.rows.map((row) => row.date)),      !purchase
        ? Promise.resolve(null)
        : this.db
            .execute<{ open_pos: number; last_at: string | null; promised_days: string | null }>(sql`
              SELECT count(*) FILTER (WHERE p.short_closed_at IS NULL
                       AND EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.purchase_order_id = p.id AND l.received_qty < l.quantity))::int AS open_pos,
                     (SELECT max(d)::text FROM (
                        SELECT p2.date::text AS d FROM purchase_orders p2 WHERE p2.org_id = ${orgId} AND p2.party_id = ${partyId} AND ${live('p2')} AND p2.deleted_at IS NULL
                        UNION ALL
                        SELECT v2.voucher_date::text AS d FROM vouchers v2 WHERE v2.org_id = ${orgId} AND v2.party_id = ${partyId} AND v2.is_cancelled = false AND v2.voucher_type IN ('Purchase', 'GST PURCHASE')
                     ) sub) AS last_at,
                     (SELECT avg(iv.lead_time_days) FROM item_vendors iv WHERE iv.org_id = ${orgId} AND iv.party_id = ${partyId} AND iv.deleted_at IS NULL AND iv.lead_time_days IS NOT NULL)::text AS promised_days
                FROM purchase_orders p
               WHERE p.org_id = ${orgId} AND p.party_id = ${partyId} AND ${live('p')} AND p.deleted_at IS NULL
            `)
            .then((r) => r.rows[0] ?? null),
    ]);
    // D-46: a party's own rhythm, not a flat cutoff. Under three orders there is no rhythm to read.
    const gaps = dates.slice(1).map((date, index) => daysBetween(dates[index] ?? date, date));
    return {
      openOrders: s?.open_orders ?? 0,
      lastOrderAt: s?.last_order_at ?? null,
      medianGap: dates.length >= 3 ? median(gaps) : null,
      openPurchaseOrders: p?.open_pos ?? 0,
      lastPurchaseAt: p?.last_at ?? null,
      promisedDays: p?.promised_days === null || p?.promised_days === undefined ? null : round(num(p.promised_days), 1),
    };
  }

  private async partyMonthly(orgId: string, partyId: string, range: Range, sales: SQL | null, purchase: boolean, vouchers: boolean): Promise<PartyMonthPoint[]> {
    const months = new Map<string, { orders: number; orderedValue: number; revenue: number; collected: number; purchasedValue: number; received: number }>();
    const at = (month: string) => {
      const entry = months.get(month) ?? { orders: 0, orderedValue: 0, revenue: 0, collected: 0, purchasedValue: 0, received: 0 };
      months.set(month, entry);
      return entry;
    };
    const [s, v, p] = await Promise.all([
      sales === null
        ? Promise.resolve([])
        : this.db
            .execute<{ month: string; orders: number; value: string }>(sql`
              SELECT to_char(date_trunc('month', d.date), 'YYYY-MM') AS month, count(*)::int AS orders, sum(d.grand_total)::text AS value
                FROM sales_documents d
               WHERE d.org_id = ${orgId} AND d.party_id = ${partyId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')}
                 AND d.deleted_at IS NULL AND d.date BETWEEN ${range.from} AND ${range.to} AND ${sales}
               GROUP BY 1
            `)
            .then((r) => r.rows),
      !vouchers
        ? Promise.resolve([])
        : this.db
            .execute<{ month: string; revenue: string; collected: string }>(sql`
              SELECT to_char(date_trunc('month', v.voucher_date), 'YYYY-MM') AS month,
                     sum(CASE WHEN v.voucher_type = 'Sales' THEN abs(v.amount) WHEN v.voucher_type = 'Credit Note' THEN -abs(v.amount) ELSE 0 END)::text AS revenue,
                     sum(CASE WHEN v.voucher_type = 'Receipt' THEN abs(v.amount) ELSE 0 END)::text AS collected
                FROM vouchers v
               WHERE v.org_id = ${orgId} AND v.party_id = ${partyId} AND v.is_cancelled = false AND v.voucher_date BETWEEN ${range.from} AND ${range.to}
               GROUP BY 1
            `)
            .then((r) => r.rows),
      !purchase
        ? Promise.resolve([])
        : this.db
            .execute<{ month: string; value: string; received: string }>(sql`
              SELECT to_char(date_trunc('month', d), 'YYYY-MM') AS month, sum(val)::text AS value, sum(rec)::text AS received
                FROM (
                  SELECT p.date AS d, p.grand_total AS val,
                         coalesce((SELECT sum(l.received_qty) FROM purchase_order_lines l WHERE l.purchase_order_id = p.id), 0) AS rec
                    FROM purchase_orders p
                   WHERE p.org_id = ${orgId} AND p.party_id = ${partyId} AND ${live('p')} AND p.deleted_at IS NULL
                     AND p.date BETWEEN ${range.from} AND ${range.to}
                  UNION ALL
                  SELECT v.voucher_date AS d,
                         CASE WHEN v.voucher_type IN ('Purchase', 'GST PURCHASE') THEN abs(v.amount) WHEN v.voucher_type = 'Debit Note' THEN -abs(v.amount) ELSE 0 END AS val,
                         coalesce((SELECT sum(coalesce(substring(vl.billed_qty FROM '^\s*-?[0-9]+\.?[0-9]*')::numeric, 0)) FROM voucher_lines vl WHERE vl.voucher_id = v.id AND vl.kind = 'inventory'), 0) AS rec
                    FROM vouchers v
                   WHERE v.org_id = ${orgId} AND v.party_id = ${partyId} AND v.is_cancelled = false
                     AND v.voucher_type IN ('Purchase', 'GST PURCHASE', 'Debit Note')
                     AND v.voucher_date BETWEEN ${range.from} AND ${range.to}
                ) sub
               GROUP BY 1
            `)            .then((r) => r.rows),
    ]);
    for (const row of s) {
      const e = at(row.month);
      e.orders = row.orders;
      e.orderedValue = num(row.value);
    }
    for (const row of v) {
      const e = at(row.month);
      e.revenue = num(row.revenue);
      e.collected = num(row.collected);
    }
    for (const row of p) {
      const e = at(row.month);
      e.purchasedValue = num(row.value);
      e.received = num(row.received);
    }
    return fillMonths(range, [...months.keys()]).map((month) => {
      const e = months.get(month) ?? { orders: 0, orderedValue: 0, revenue: 0, collected: 0, purchasedValue: 0, received: 0 };
      return { month, orders: e.orders, orderedValue: round(e.orderedValue), revenue: round(e.revenue), collected: round(e.collected), purchasedValue: round(e.purchasedValue), received: round(e.received, 3) };
    });
  }

  private async partyItemsBought(orgId: string, partyId: string, range: Range, sales: SQL): Promise<PartyItemRow[]> {
    const rows = await this.db
      .execute<{ id: string | null; name: string; unit: string | null; quantity: string; value: string; documents: number; last_at: string; last_rate: string | null }>(sql`
        SELECT l.stock_item_id AS id, l.description AS name, l.unit, sum(l.quantity)::text AS quantity, sum(l.amount)::text AS value,
               count(DISTINCT d.id)::int AS documents, max(d.date)::text AS last_at, (array_agg(l.rate ORDER BY d.date DESC))[1]::text AS last_rate
          FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
         WHERE d.org_id = ${orgId} AND d.party_id = ${partyId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')}
           AND d.deleted_at IS NULL AND d.date BETWEEN ${range.from} AND ${range.to} AND ${sales}
         GROUP BY l.stock_item_id, l.description, l.unit ORDER BY sum(l.amount) DESC LIMIT ${ROW_CAP}
      `)
      .then((r) => r.rows);
    return rows.map((r) => ({ id: r.id, name: r.name, unit: r.unit, quantity: round(num(r.quantity), 3), value: round(num(r.value)), documents: r.documents, lastAt: r.last_at, lastRate: nullable(r.last_rate), variancePct: null }));
  }

  private async partyItemsSupplied(orgId: string, partyId: string, range: Range): Promise<PartyItemRow[]> {
    const rows = await this.db
      .execute<{ id: string | null; name: string; unit: string | null; quantity: string; value: string; documents: number; last_at: string; last_rate: string | null; best_rate: string | null }>(sql`
        WITH supplied AS (
          SELECT l.stock_item_id AS id, l.description AS name, l.unit, l.quantity, l.amount,
                 p.id AS doc_id, p.date, l.rate
            FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.purchase_order_id
           WHERE p.org_id = ${orgId} AND p.party_id = ${partyId} AND ${live('p')} AND p.deleted_at IS NULL
             AND p.date BETWEEN ${range.from} AND ${range.to}
          UNION ALL
          SELECT vl.stock_item_id AS id, coalesce(si.name, vl.stock_item_name, 'Unknown') AS name, si.unit,
                 coalesce(substring(vl.billed_qty FROM '^\s*-?[0-9]+\.?[0-9]*')::numeric, 0) AS quantity,
                 abs(vl.amount) AS amount,
                 v.id AS doc_id, v.voucher_date AS date, vl.rate
            FROM voucher_lines vl
            JOIN vouchers v ON v.id = vl.voucher_id
            LEFT JOIN stock_items si ON si.id = vl.stock_item_id
           WHERE v.org_id = ${orgId} AND v.party_id = ${partyId} AND v.is_cancelled = false
             AND v.voucher_type IN ('Purchase', 'GST PURCHASE')
             AND vl.kind = 'inventory'
             AND v.voucher_date BETWEEN ${range.from} AND ${range.to}
        )
        SELECT s.id, s.name, s.unit, sum(s.quantity)::text AS quantity, sum(s.amount)::text AS value,
               count(DISTINCT s.doc_id)::int AS documents, max(s.date)::text AS last_at, (array_agg(s.rate ORDER BY s.date DESC))[1]::text AS last_rate,
               -- The best last rate any vendor gave for the item, all time: the price this vendor is measured against.
               (SELECT min(r.last_rate) FROM (
                  SELECT DISTINCT ON (rates.party_id) rates.rate AS last_rate
                    FROM (
                      SELECT q.party_id, l2.rate, q.date FROM purchase_order_lines l2 JOIN purchase_orders q ON q.id = l2.purchase_order_id
                       WHERE q.org_id = ${orgId} AND l2.stock_item_id = s.id AND ${live('q')} AND q.deleted_at IS NULL AND l2.rate > 0
                      UNION ALL
                      SELECT v2.party_id, vl2.rate, v2.voucher_date AS date FROM voucher_lines vl2 JOIN vouchers v2 ON v2.id = vl2.voucher_id
                       WHERE v2.org_id = ${orgId} AND vl2.stock_item_id = s.id AND v2.is_cancelled = false
                         AND v2.voucher_type IN ('Purchase', 'GST PURCHASE') AND vl2.kind = 'inventory' AND vl2.rate > 0
                    ) rates
                   ORDER BY rates.party_id, rates.date DESC) r)::text AS best_rate
          FROM supplied s
         GROUP BY s.id, s.name, s.unit ORDER BY sum(s.amount) DESC LIMIT ${ROW_CAP}
      `)
      .then((r) => r.rows);
    return rows.map((r) => {
      const lastRate = nullable(r.last_rate);
      const best = nullable(r.best_rate);
      return {
        id: r.id,
        name: r.name,
        unit: r.unit,
        quantity: round(num(r.quantity), 3),
        value: round(num(r.value)),
        documents: r.documents,
        lastAt: r.last_at,
        lastRate,
        variancePct: lastRate !== null && best !== null && best > 0 && r.id !== null ? round(((lastRate - best) / best) * 100, 1) : null,
      };
    });
  }

  private async partyHeat(orgId: string, partyId: string, range: Range, side: 'customer' | 'vendor', sales: SQL | null): Promise<HeatCell[]> {
    const rows =
      side === 'customer'
        ? await this.db
            .execute<{ row_id: string | null; row: string; month: string; value: string }>(sql`
              WITH top AS (
                SELECT l.description AS key FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
                 WHERE d.org_id = ${orgId} AND d.party_id = ${partyId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')}
                   AND d.deleted_at IS NULL AND d.date BETWEEN ${range.from} AND ${range.to} AND ${sales ?? sql`TRUE`}
                 GROUP BY 1 ORDER BY sum(l.amount) DESC LIMIT ${ROW_CAP}
              )
              SELECT l.stock_item_id AS row_id, l.description AS row, to_char(date_trunc('month', d.date), 'YYYY-MM') AS month, sum(l.quantity)::text AS value
                FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
               WHERE d.org_id = ${orgId} AND d.party_id = ${partyId} AND d.doc_type = 'SALES_ORDER' AND ${live('d')}
                 AND d.deleted_at IS NULL AND d.date BETWEEN ${range.from} AND ${range.to} AND ${sales ?? sql`TRUE`}
                 AND l.description IN (SELECT key FROM top)
               GROUP BY 1, 2, 3
            `)
            .then((r) => r.rows)
        : await this.db
            .execute<{ row_id: string | null; row: string; month: string; value: string }>(sql`
              WITH top AS (
                SELECT coalesce(description, 'Unknown') AS key
                  FROM (
                    SELECT l.description, l.amount FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.purchase_order_id
                     WHERE p.org_id = ${orgId} AND p.party_id = ${partyId} AND ${live('p')} AND p.deleted_at IS NULL
                       AND p.date BETWEEN ${range.from} AND ${range.to}
                    UNION ALL
                    SELECT coalesce(si.name, vl.stock_item_name) AS description, abs(vl.amount) AS amount
                      FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id LEFT JOIN stock_items si ON si.id = vl.stock_item_id
                     WHERE v.org_id = ${orgId} AND v.party_id = ${partyId} AND v.is_cancelled = false
                       AND v.voucher_type IN ('Purchase', 'GST PURCHASE') AND vl.kind = 'inventory'
                       AND v.voucher_date BETWEEN ${range.from} AND ${range.to}
                  ) all_lines
                 GROUP BY 1 ORDER BY sum(amount) DESC LIMIT ${ROW_CAP}
              ), combined AS (
                SELECT l.stock_item_id AS row_id, l.description AS row, to_char(date_trunc('month', p.date), 'YYYY-MM') AS month, l.quantity AS value
                  FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.purchase_order_id
                 WHERE p.org_id = ${orgId} AND p.party_id = ${partyId} AND ${live('p')} AND p.deleted_at IS NULL
                   AND p.date BETWEEN ${range.from} AND ${range.to}
                UNION ALL
                SELECT vl.stock_item_id AS row_id, coalesce(si.name, vl.stock_item_name, 'Unknown') AS row, to_char(date_trunc('month', v.voucher_date), 'YYYY-MM') AS month,
                       coalesce(substring(vl.billed_qty FROM '^\s*-?[0-9]+\.?[0-9]*')::numeric, 0) AS value
                  FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id LEFT JOIN stock_items si ON si.id = vl.stock_item_id
                 WHERE v.org_id = ${orgId} AND v.party_id = ${partyId} AND v.is_cancelled = false
                   AND v.voucher_type IN ('Purchase', 'GST PURCHASE') AND vl.kind = 'inventory'
                   AND v.voucher_date BETWEEN ${range.from} AND ${range.to}
              )
              SELECT row_id, row, month, sum(value)::text AS value
                FROM combined
               WHERE row IN (SELECT key FROM top)
               GROUP BY 1, 2, 3
            `)
            .then((r) => r.rows);
    return rows.map((r) => ({ row: r.row, rowId: r.row_id, month: r.month, value: round(num(r.value), 3) }));
  }

  // ----------------------------------------------------------------- scope

  /** The sales documents this person may read, as a predicate on alias `d`; null when none. */
  private salesScope(principal: Principal): SQL | null {
    if (principal.permissions.has(PERMISSIONS.SALES_DOCUMENT_VIEW_ALL)) return sql`TRUE`;
    if (principal.permissions.has(PERMISSIONS.SALES_DOCUMENT_VIEW_SELF)) return sql`d.owner_id = ${principal.userId}`;
    return null;
  }
}

interface ItemRangeFigures {
  ordered: number;
  dispatched: number;
  orders: number;
  customers: number;
  repeatBuyers: number;
  topCustomerQty: number;
  revenue: number;
  billedQty: number;
  purchased: number;
  received: number;
  purchaseValue: number;
  shortages: number;
}

interface PartyRangeFigures {
  orders: number;
  orderedValue: number;
  orderedQty: number;
  dispatchedQty: number;
  dispatchedOrders: number;
  partialOrders: number;
  leadMedian: number | null;
  leadP90: number | null;
  revenue: number;
  invoices: number;
  collected: number;
  orgRevenue: number;
  purchaseOrders: number;
  purchasedValue: number;
  purchasedQty: number;
  receivedQty: number;
  rejectedQty: number;
  receipts: number;
  vendorLeadMedian: number | null;
  vendorLeadP90: number | null;
}

/** Every month of the range, in order, so a chart draws the quiet months as zero rather than skipping them. */
function fillMonths(range: Range, present: readonly string[]): string[] {
  const [fy = 0, fm = 1] = range.from.split('-').map(Number);
  const [ty = 0, tm = 1] = range.to.split('-').map(Number);
  const months: string[] = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m += 1) {
    if (m > 12) {
      m = 1;
      y += 1;
    }
    months.push(`${String(y)}-${String(m).padStart(2, '0')}`);
  }
  // A comparison range shifted by days can hold a month the loop missed; keep what the data holds.
  for (const month of present) if (!months.includes(month)) months.push(month);
  return months.sort();
}
