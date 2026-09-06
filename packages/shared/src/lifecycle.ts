import { z } from 'zod';

import type { PartyView, StockItemView } from './masters.js';

/**
 * The life of one thing, read from everything that ever touched it
 * (owner, 22 Aug 2026): a stock item across estimates, orders, picks,
 * packs, dispatches, invoices, purchase orders and receipts; a party as
 * the customer it is, the vendor it is, or both. Every event has a date
 * and a door, so a row in the timeline is a link and never a dead end.
 */
export const LIFECYCLE_EVENT_KINDS = ['estimate', 'order', 'pick', 'pack', 'dispatch', 'delivery', 'invoice', 'purchase_order', 'grn', 'voucher'] as const;
export type LifecycleEventKind = (typeof LIFECYCLE_EVENT_KINDS)[number];

export const LIFECYCLE_EVENT_LABELS: Record<LifecycleEventKind, string> = {
  estimate: 'Estimate',
  order: 'Sales order',
  pick: 'Picked',
  pack: 'Packed',
  dispatch: 'Dispatched',
  delivery: 'Delivered',
  invoice: 'Invoice',
  purchase_order: 'Purchase order',
  grn: 'Received',
  voucher: 'Tally voucher',
};

export interface LifecycleEvent {
  readonly kind: LifecycleEventKind;
  readonly id: string;
  /** ISO date-time. */
  readonly at: string;
  /** The document's number, or the name of the thing. */
  readonly title: string;
  /** Who it was for or from, what it carried. */
  readonly detail: string | null;
  /** Exact decimal text; null where the event carries no quantity. */
  readonly quantity: string | null;
  readonly unit: string | null;
  /** Exact decimal text; null where the event carries no amount. */
  readonly amount: string | null;
  /** The document's own state word, when it has one. */
  readonly state: string | null;
  /** Where the event is read in full. */
  readonly href: string;
}

export interface ItemLifecycleFigures {
  readonly ordered: string;
  readonly picked: string;
  readonly packed: string;
  readonly dispatched: string;
  readonly purchased: string;
  readonly received: string;
  readonly openOrders: number;
  readonly lastSoldAt: string | null;
  readonly lastReceivedAt: string | null;
}

export interface ItemCounterparty {
  readonly id: string | null;
  readonly name: string;
  readonly quantity: string;
  readonly lastRate: string | null;
  readonly lastAt: string;
}

export interface ItemLifecycle {
  readonly item: StockItemView;
  readonly figures: ItemLifecycleFigures;
  readonly customers: readonly ItemCounterparty[];
  readonly vendors: readonly ItemCounterparty[];
  readonly events: readonly LifecycleEvent[];
}

export type PartyRole = 'customer' | 'vendor' | 'both' | 'none';

export interface PartyLifecycleFigures {
  readonly estimates: number;
  readonly orders: number;
  readonly openOrders: number;
  readonly dispatches: number;
  readonly delivered: number;
  readonly invoices: number;
  readonly orderedValue: string;
  readonly invoicedValue: string;
  readonly purchaseOrders: number;
  readonly receipts: number;
  readonly purchasedValue: string;
  readonly lastOrderAt: string | null;
  readonly lastPurchaseAt: string | null;
}

export interface PartyLifecycle {
  readonly party: PartyView;
  readonly role: PartyRole;
  readonly figures: PartyLifecycleFigures;
  readonly events: readonly LifecycleEvent[];
}

// ---------------------------------------------------------------- analytics

/**
 * The period half of a lifecycle (owner, 22 Aug 2026: "charts, KPIs, last
 * order, comparison, custom calendar"). Everything above is the identity
 * and the trail; this is what the period says, with a comparison range
 * beside it when asked (data-analyst skill §3: FY April–March, partial
 * periods compare to date, the client computes the comparison range with
 * the same arithmetic the screen shows).
 */
export const LIFECYCLE_COMPARE_MODES = ['off', 'previous', 'lastYear'] as const;
export type LifecycleCompareMode = (typeof LIFECYCLE_COMPARE_MODES)[number];

export const lifecycleAnalyticsQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  /** The comparison range, already computed by the client; absent when comparison is off. */
  compareFrom: z.iso.date().optional(),
  compareTo: z.iso.date().optional(),
});
export type LifecycleAnalyticsQuery = z.infer<typeof lifecycleAnalyticsQuerySchema>;

export interface DateRangeView {
  readonly from: string;
  readonly to: string;
}

/** A figure for the period and, when a comparison was asked for, the same figure for the comparison range. */
export interface Kpi {
  readonly value: number;
  readonly previous: number | null;
}

/** A figure the system cannot compute honestly (data-analyst skill: absent, not zero). */
export interface AbsentKpi {
  readonly label: string;
  readonly needs: string;
}

export interface HeatCell {
  readonly row: string;
  readonly rowId: string | null;
  /** YYYY-MM. */
  readonly month: string;
  readonly value: number;
}

export interface ItemMonthPoint {
  readonly month: string;
  readonly ordered: number;
  readonly dispatched: number;
  readonly revenue: number;
  readonly purchased: number;
  readonly received: number;
}

export interface ItemCustomerRow {
  readonly id: string | null;
  readonly name: string;
  readonly quantity: number;
  readonly value: number;
  readonly orders: number;
  readonly lastAt: string;
  readonly lastRate: number | null;
}

export interface ItemVendorRow {
  readonly id: string | null;
  readonly name: string;
  readonly quantity: number;
  readonly value: number;
  readonly purchaseOrders: number;
  readonly lastAt: string;
  readonly lastRate: number | null;
  /** (lastRate − best last rate among vendors) ÷ best, in %. Null with one vendor or no rates. */
  readonly variancePct: number | null;
  /** PO date → first receipt, median days. Null with no receipt. */
  readonly leadTimeDays: number | null;
  /** item_vendors.lead_time_days, the promise. */
  readonly promisedDays: number | null;
  readonly rejectedPct: number | null;
}

export interface ItemAnalytics {
  readonly period: DateRangeView;
  readonly comparison: DateRangeView | null;
  readonly kpis: {
    readonly ordered: Kpi;
    readonly dispatched: Kpi;
    readonly fulfilmentPct: Kpi;
    readonly orders: Kpi;
    readonly customers: Kpi;
    readonly repeatBuyers: Kpi;
    readonly topCustomerSharePct: Kpi;
    readonly revenue: Kpi;
    readonly billedQty: Kpi;
    readonly realisedRate: Kpi;
    readonly purchased: Kpi;
    readonly received: Kpi;
    readonly purchaseRate: Kpi;
    readonly shortages: Kpi;
    /** Now, not the period: open orders and the shelf. */
    readonly openOrders: number;
    readonly closingQty: number | null;
    /** closingQty ÷ average monthly dispatched in the period; null when nothing was dispatched. */
    readonly monthsOfCover: number | null;
    readonly lastSoldAt: string | null;
    readonly lastSoldRate: number | null;
    readonly lastPurchasedAt: string | null;
    readonly lastPurchaseRate: number | null;
    /** Gross margin proxy (D-46), only for reports.margin.view; otherwise null. */
    readonly marginProxyPct: number | null;
  };
  readonly monthly: readonly ItemMonthPoint[];
  readonly monthlyComparison: readonly ItemMonthPoint[] | null;
  readonly customers: readonly ItemCustomerRow[];
  readonly vendors: readonly ItemVendorRow[];
  /** Customer × month, ordered quantity. */
  readonly heat: readonly HeatCell[];
  readonly absent: readonly AbsentKpi[];
}

export interface PartyMonthPoint {
  readonly month: string;
  readonly orders: number;
  readonly orderedValue: number;
  readonly revenue: number;
  readonly collected: number;
  readonly purchasedValue: number;
  readonly received: number;
}

export interface PartyItemRow {
  readonly id: string | null;
  readonly name: string;
  readonly unit: string | null;
  readonly quantity: number;
  readonly value: number;
  readonly documents: number;
  readonly lastAt: string;
  readonly lastRate: number | null;
  /** Vendor side: this vendor's last rate against the best last rate any vendor gave for the item, in %. */
  readonly variancePct: number | null;
}

export interface PartyAnalytics {
  readonly period: DateRangeView;
  readonly comparison: DateRangeView | null;
  readonly openingBalance?: number | null;
  readonly closingBalance?: number | null;
  readonly customer: {
    readonly revenue: Kpi;
    readonly invoices: Kpi;
    readonly averageInvoice: Kpi;
    readonly collected: Kpi;
    readonly orders: Kpi;
    readonly orderedValue: Kpi;
    readonly orderedQty: Kpi;
    readonly dispatchedQty: Kpi;
    readonly fulfilmentPct: Kpi;
    readonly partialShipmentPct: Kpi;
    readonly leadTimeMedianDays: Kpi;
    readonly leadTimeP90Days: Kpi;
    readonly revenueSharePct: Kpi;
    readonly openOrders: number;
    readonly lastOrderAt: string | null;
    readonly daysSinceLastOrder: number | null;
    /** Median days between this party's orders, all time; null under three orders. */
    readonly medianOrderGapDays: number | null;
    /** D-46: the gap since the last order exceeds twice the party's own median gap. */
    readonly dormant: boolean;
  } | null;
  readonly vendor: {
    readonly purchaseOrders: Kpi;
    readonly purchasedValue: Kpi;
    readonly orderedQty: Kpi;
    readonly receivedQty: Kpi;
    readonly receipts: Kpi;
    readonly rejectedPct: Kpi;
    readonly leadTimeMedianDays: Kpi;
    readonly leadTimeP90Days: Kpi;
    readonly promisedDays: number | null;
    readonly openPurchaseOrders: number;
    readonly lastPurchaseAt: string | null;
  } | null;
  readonly monthly: readonly PartyMonthPoint[];
  readonly monthlyComparison: readonly PartyMonthPoint[] | null;
  /** What the customer buys, by value. */
  readonly itemsBought: readonly PartyItemRow[];
  /** What the vendor supplies, by value. */
  readonly itemsSupplied: readonly PartyItemRow[];
  /** Item × month, quantity: ordered for a customer, purchased for a vendor. */
  readonly heat: readonly HeatCell[];
  readonly absent: readonly AbsentKpi[];
}
