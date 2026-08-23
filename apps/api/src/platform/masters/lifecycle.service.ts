import { Injectable } from '@nestjs/common';
import { PERMISSIONS, type ItemLifecycle, type LifecycleEvent, type PartyLifecycle, type PartyRole } from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../db/db.provider.js';
import type { Principal } from '../rbac/principal.js';
import { live } from './live-document.js';
import { MastersService } from './masters.service.js';

/**
 * The life of a stock item or a party (owner, 22 Aug 2026), read from every
 * table that ever touched it. Raw SQL with the organisation in every WHERE,
 * the way the report sources read across modules: platform does not import
 * a module's schema (technical design §1), and a lifecycle is by definition
 * a read across all of them.
 *
 * What a person sees follows what they may see: sales documents by the
 * sales view keys (all, or their own), purchase documents by the purchase
 * view key, Tally vouchers by the receivables key. A lifecycle never shows
 * a row the list screens would have refused.
 */

const EVENT_CAP = 200;
const COUNTERPARTY_CAP = 5;

type EventRow = {
  kind: LifecycleEvent['kind'];
  id: string;
  doc_id: string | null;
  at: Date | string;
  title: string;
  detail: string | null;
  quantity: string | null;
  amount: string | null;
  state: string | null;
};

function hrefFor(kind: LifecycleEvent['kind'], id: string, docId: string | null): string {
  switch (kind) {
    case 'estimate':
      return `/sales/estimates/${id}`;
    case 'order':
      return `/sales/orders/${id}`;
    case 'invoice':
      return `/sales/invoices/${id}`;
    case 'pick':
      return `/sales/orders/${docId ?? id}`;
    case 'pack':
      return `/sales/packs/${id}`;
    case 'dispatch':
    case 'delivery':
      return `/sales/dispatches/${id}`;
    case 'purchase_order':
      return `/purchase/orders/${id}`;
    case 'grn':
      return `/purchase/grns/${id}`;
    case 'voucher':
      return `/masters/vouchers/${id}`;
  }
}

@Injectable()
export class LifecycleService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly masters: MastersService,
  ) {}

  async item(principal: Principal, itemId: string): Promise<ItemLifecycle> {
    const item = await this.masters.findStockItem(principal, itemId);
    const orgId = principal.orgId;
    const sales = this.salesScope(principal);
    const purchase = principal.permissions.has(PERMISSIONS.PURCHASE_DOCUMENT_VIEW);
    const vouchers = principal.permissions.has(PERMISSIONS.RECEIVABLES_VIEW);

    const [salesFigures, purchaseFigures, customers, vendors, events] = await Promise.all([
      sales === null
        ? Promise.resolve({ ordered: '0', picked: '0', packed: '0', dispatched: '0', open_orders: 0, last_sold_at: null })
        : this.db
            .execute<{ ordered: string; picked: string; packed: string; dispatched: string; open_orders: number; last_sold_at: string | null }>(sql`
              SELECT coalesce(sum(l.quantity), 0)::text AS ordered,
                     coalesce(sum(l.picked_qty), 0)::text AS picked,
                     coalesce(sum(l.packed_qty), 0)::text AS packed,
                     coalesce(sum(l.dispatched_qty), 0)::text AS dispatched,
                     count(DISTINCT d.id) FILTER (WHERE l.dispatched_qty < l.quantity AND d.short_closed_at IS NULL)::int AS open_orders,
                     max(d.date)::text AS last_sold_at
                FROM sales_document_lines l
                JOIN sales_documents d ON d.id = l.document_id
               WHERE d.org_id = ${orgId} AND l.stock_item_id = ${itemId}
                 AND d.doc_type = 'SALES_ORDER' AND ${live('d')} AND d.deleted_at IS NULL AND ${sales}
            `)
            .then((r) => r.rows[0] ?? { ordered: '0', picked: '0', packed: '0', dispatched: '0', open_orders: 0, last_sold_at: null }),
      !purchase
        ? Promise.resolve({ purchased: '0', received: '0', last_received_at: null })
        : this.db
            .execute<{ purchased: string; received: string; last_received_at: string | null }>(sql`
              SELECT coalesce(sum(l.quantity), 0)::text AS purchased,
                     coalesce(sum(l.received_qty), 0)::text AS received,
                     max(g.received_at)::text AS last_received_at
                FROM purchase_order_lines l
                JOIN purchase_orders p ON p.id = l.purchase_order_id
                LEFT JOIN grn_lines gl ON gl.purchase_order_line_id = l.id
                LEFT JOIN grns g ON g.id = gl.grn_id
               WHERE p.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND ${live('p')} AND p.deleted_at IS NULL
            `)
            .then((r) => r.rows[0] ?? { purchased: '0', received: '0', last_received_at: null }),
      sales === null
        ? Promise.resolve([])
        : this.db
            .execute<{ id: string | null; name: string; quantity: string; last_rate: string | null; last_at: string }>(sql`
              SELECT d.party_id AS id, d.customer_name AS name, sum(l.quantity)::text AS quantity,
                     (array_agg(l.rate ORDER BY d.date DESC))[1]::text AS last_rate, max(d.date)::text AS last_at
                FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
               WHERE d.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND d.doc_type = 'SALES_ORDER'
                 AND ${live('d')} AND d.deleted_at IS NULL AND ${sales}
               GROUP BY d.party_id, d.customer_name ORDER BY sum(l.quantity) DESC LIMIT ${COUNTERPARTY_CAP}
            `)
            .then((r) => r.rows),
      !purchase
        ? Promise.resolve([])
        : this.db
            .execute<{ id: string | null; name: string; quantity: string; last_rate: string | null; last_at: string }>(sql`
              SELECT p.party_id AS id, p.vendor_name AS name, sum(l.quantity)::text AS quantity,
                     (array_agg(l.rate ORDER BY p.date DESC))[1]::text AS last_rate, max(p.date)::text AS last_at
                FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.purchase_order_id
               WHERE p.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND ${live('p')} AND p.deleted_at IS NULL
               GROUP BY p.party_id, p.vendor_name ORDER BY sum(l.quantity) DESC LIMIT ${COUNTERPARTY_CAP}
            `)
            .then((r) => r.rows),
      this.itemEvents(orgId, itemId, item.unit, sales, purchase, vouchers),
    ]);

    return {
      item,
      figures: {
        ordered: salesFigures.ordered,
        picked: salesFigures.picked,
        packed: salesFigures.packed,
        dispatched: salesFigures.dispatched,
        purchased: purchaseFigures.purchased,
        received: purchaseFigures.received,
        openOrders: Number(salesFigures.open_orders),
        lastSoldAt: salesFigures.last_sold_at,
        lastReceivedAt: purchaseFigures.last_received_at,
      },
      customers: customers.map((row) => ({ id: row.id, name: row.name, quantity: row.quantity, lastRate: row.last_rate, lastAt: row.last_at })),
      vendors: vendors.map((row) => ({ id: row.id, name: row.name, quantity: row.quantity, lastRate: row.last_rate, lastAt: row.last_at })),
      events,
    };
  }

  async party(principal: Principal, partyId: string): Promise<PartyLifecycle> {
    const party = await this.masters.findParty(principal, partyId);
    const orgId = principal.orgId;
    const sales = this.salesScope(principal);
    const purchase = principal.permissions.has(PERMISSIONS.PURCHASE_DOCUMENT_VIEW);
    const vouchers = principal.permissions.has(PERMISSIONS.RECEIVABLES_VIEW);

    const [salesFigures, purchaseFigures, events] = await Promise.all([
      sales === null
        ? Promise.resolve(null)
        : this.db
            .execute<{ estimates: number; orders: number; open_orders: number; dispatches: number; delivered: number; invoices: number; ordered_value: string; invoiced_value: string; last_order_at: string | null }>(sql`
              SELECT count(*) FILTER (WHERE d.doc_type = 'ESTIMATE' AND ${live('d')})::int AS estimates,
                     count(*) FILTER (WHERE d.doc_type = 'SALES_ORDER' AND ${live('d')})::int AS orders,
                     count(*) FILTER (WHERE d.doc_type = 'SALES_ORDER' AND ${live('d')} AND d.short_closed_at IS NULL
                                        AND EXISTS (SELECT 1 FROM sales_document_lines l WHERE l.document_id = d.id AND l.dispatched_qty < l.quantity))::int AS open_orders,
                     (SELECT count(*)::int FROM dispatches x JOIN sales_documents o ON o.id = x.document_id WHERE o.org_id = ${orgId} AND o.party_id = ${partyId} AND x.deleted_at IS NULL) AS dispatches,
                     (SELECT count(*)::int FROM dispatches x JOIN sales_documents o ON o.id = x.document_id WHERE o.org_id = ${orgId} AND o.party_id = ${partyId} AND x.deleted_at IS NULL AND x.delivered_at IS NOT NULL) AS delivered,
                     count(*) FILTER (WHERE d.doc_type = 'INVOICE' AND ${live('d')})::int AS invoices,
                     coalesce(sum(d.grand_total) FILTER (WHERE d.doc_type = 'SALES_ORDER' AND ${live('d')}), 0)::text AS ordered_value,
                     coalesce(sum(d.grand_total) FILTER (WHERE d.doc_type = 'INVOICE' AND ${live('d')}), 0)::text AS invoiced_value,
                     max(d.date) FILTER (WHERE d.doc_type = 'SALES_ORDER' AND ${live('d')})::text AS last_order_at
                FROM sales_documents d
               WHERE d.org_id = ${orgId} AND d.party_id = ${partyId} AND d.deleted_at IS NULL AND ${sales}
            `)
            .then((r) => r.rows[0] ?? null),
      !purchase
        ? Promise.resolve(null)
        : this.db
            .execute<{ purchase_orders: number; receipts: number; purchased_value: string; last_purchase_at: string | null }>(sql`
              SELECT count(*)::int AS purchase_orders,
                     (SELECT count(*)::int FROM grns g JOIN purchase_orders q ON q.id = g.purchase_order_id WHERE q.org_id = ${orgId} AND q.party_id = ${partyId} AND g.deleted_at IS NULL) AS receipts,
                     coalesce(sum(p.grand_total), 0)::text AS purchased_value,
                     max(p.date)::text AS last_purchase_at
                FROM purchase_orders p
               WHERE p.org_id = ${orgId} AND p.party_id = ${partyId} AND ${live('p')} AND p.deleted_at IS NULL
            `)
            .then((r) => r.rows[0] ?? null),
      this.partyEvents(orgId, partyId, sales, purchase, vouchers),
    ]);

    const sells = (salesFigures?.orders ?? 0) + (salesFigures?.estimates ?? 0) + (salesFigures?.invoices ?? 0) > 0;
    const buys = (purchaseFigures?.purchase_orders ?? 0) > 0;
    const byGroup: PartyRole = /creditor/iu.test(party.parentGroup) ? 'vendor' : /debtor/iu.test(party.parentGroup) ? 'customer' : 'none';
    const role: PartyRole = sells && buys ? 'both' : sells ? 'customer' : buys ? 'vendor' : byGroup;

    return {
      party,
      role,
      figures: {
        estimates: salesFigures?.estimates ?? 0,
        orders: salesFigures?.orders ?? 0,
        openOrders: salesFigures?.open_orders ?? 0,
        dispatches: salesFigures?.dispatches ?? 0,
        delivered: salesFigures?.delivered ?? 0,
        invoices: salesFigures?.invoices ?? 0,
        orderedValue: salesFigures?.ordered_value ?? '0',
        invoicedValue: salesFigures?.invoiced_value ?? '0',
        purchaseOrders: purchaseFigures?.purchase_orders ?? 0,
        receipts: purchaseFigures?.receipts ?? 0,
        purchasedValue: purchaseFigures?.purchased_value ?? '0',
        lastOrderAt: salesFigures?.last_order_at ?? null,
        lastPurchaseAt: purchaseFigures?.last_purchase_at ?? null,
      },
      events,
    };
  }

  // ---------------------------------------------------------------- scope

  /** The sales documents this person may read, as a predicate on alias `d`; null when none. */
  private salesScope(principal: Principal): SQL | null {
    if (principal.permissions.has(PERMISSIONS.SALES_DOCUMENT_VIEW_ALL)) return sql`TRUE`;
    if (principal.permissions.has(PERMISSIONS.SALES_DOCUMENT_VIEW_SELF)) return sql`d.owner_id = ${principal.userId}`;
    return null;
  }

  // --------------------------------------------------------------- events

  private async itemEvents(orgId: string, itemId: string, unit: string, sales: SQL | null, purchase: boolean, vouchers: boolean): Promise<LifecycleEvent[]> {
    const parts: SQL[] = [];
    if (sales !== null) {
      parts.push(sql`
        SELECT CASE d.doc_type WHEN 'ESTIMATE' THEN 'estimate' WHEN 'INVOICE' THEN 'invoice' ELSE 'order' END AS kind,
               d.id, d.id AS doc_id, d.date::timestamptz AS at, d.number AS title, d.customer_name AS detail,
               l.quantity::text AS quantity, l.amount::text AS amount, d.status::text AS state
          FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
         WHERE d.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND d.deleted_at IS NULL AND ${sales}`);
      parts.push(sql`
        SELECT 'pick' AS kind, k.id, d.id AS doc_id, k.picked_at AS at, d.number AS title, d.customer_name AS detail,
               kl.quantity::text AS quantity, NULL AS amount, NULL AS state
          FROM pick_record_lines kl JOIN pick_records k ON k.id = kl.pick_record_id
          JOIN sales_document_lines l ON l.id = kl.line_id JOIN sales_documents d ON d.id = k.document_id
         WHERE k.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND k.deleted_at IS NULL AND ${sales}`);
      parts.push(sql`
        SELECT 'pack' AS kind, p.id, d.id AS doc_id, p.packed_at AS at, d.number AS title,
               d.customer_name || ' · ' || p.box_count::text || CASE WHEN p.box_count = 1 THEN ' box' ELSE ' boxes' END AS detail,
               pl.quantity::text AS quantity, NULL AS amount, NULL AS state
          FROM pack_record_lines pl JOIN pack_records p ON p.id = pl.pack_record_id
          JOIN sales_document_lines l ON l.id = pl.line_id JOIN sales_documents d ON d.id = p.document_id
         WHERE p.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND p.deleted_at IS NULL AND ${sales}`);
      parts.push(sql`
        SELECT 'dispatch' AS kind, x.id, d.id AS doc_id, x.dispatched_at AS at, x.number AS title, d.customer_name AS detail,
               xl.quantity::text AS quantity, NULL AS amount, x.mode::text AS state
          FROM dispatch_lines xl JOIN dispatches x ON x.id = xl.dispatch_id
          JOIN sales_document_lines l ON l.id = xl.line_id JOIN sales_documents d ON d.id = x.document_id
         WHERE x.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND x.deleted_at IS NULL AND ${sales}`);
      parts.push(sql`
        SELECT 'delivery' AS kind, x.id, d.id AS doc_id, x.delivered_at AS at, x.number AS title,
               d.customer_name || coalesce(' · received by ' || x.received_by, '') AS detail,
               xl.quantity::text AS quantity, NULL AS amount, NULL AS state
          FROM dispatch_lines xl JOIN dispatches x ON x.id = xl.dispatch_id
          JOIN sales_document_lines l ON l.id = xl.line_id JOIN sales_documents d ON d.id = x.document_id
         WHERE x.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND x.delivered_at IS NOT NULL AND x.deleted_at IS NULL AND ${sales}`);
    }
    if (purchase) {
      parts.push(sql`
        SELECT 'purchase_order' AS kind, p.id, p.id AS doc_id, p.date::timestamptz AS at, p.number AS title, p.vendor_name AS detail,
               l.quantity::text AS quantity, l.amount::text AS amount, p.status::text AS state
          FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.purchase_order_id
         WHERE p.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND p.deleted_at IS NULL`);
      parts.push(sql`
        SELECT 'grn' AS kind, g.id, p.id AS doc_id, g.received_at AS at, g.number AS title,
               p.vendor_name || CASE WHEN gl.rejected_qty > 0 THEN ' · ' || gl.rejected_qty::text || ' rejected' ELSE '' END AS detail,
               gl.received_qty::text AS quantity, NULL AS amount, NULL AS state
          FROM grn_lines gl JOIN grns g ON g.id = gl.grn_id
          JOIN purchase_order_lines l ON l.id = gl.purchase_order_line_id JOIN purchase_orders p ON p.id = g.purchase_order_id
         WHERE g.org_id = ${orgId} AND l.stock_item_id = ${itemId} AND g.deleted_at IS NULL`);
    }
    if (vouchers) {
      parts.push(sql`
        SELECT 'voucher' AS kind, v.id, v.id AS doc_id, v.voucher_date::timestamptz AS at,
               v.voucher_type || ' ' || coalesce(v.voucher_number, '') AS title, v.party_name AS detail,
               vl.actual_qty AS quantity, vl.amount::text AS amount, CASE WHEN v.is_cancelled THEN 'Cancelled' ELSE NULL END AS state
          FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
         WHERE v.org_id = ${orgId} AND vl.stock_item_id = ${itemId}`);
    }
    return this.runEvents(parts, unit);
  }

  private async partyEvents(orgId: string, partyId: string, sales: SQL | null, purchase: boolean, vouchers: boolean): Promise<LifecycleEvent[]> {
    const parts: SQL[] = [];
    if (sales !== null) {
      parts.push(sql`
        SELECT CASE d.doc_type WHEN 'ESTIMATE' THEN 'estimate' WHEN 'INVOICE' THEN 'invoice' ELSE 'order' END AS kind,
               d.id, d.id AS doc_id, d.date::timestamptz AS at, d.number AS title,
               (SELECT count(*)::text || ' lines' FROM sales_document_lines l WHERE l.document_id = d.id) AS detail,
               NULL AS quantity, d.grand_total::text AS amount, d.status::text AS state
          FROM sales_documents d WHERE d.org_id = ${orgId} AND d.party_id = ${partyId} AND d.deleted_at IS NULL AND ${sales}`);
      parts.push(sql`
        SELECT 'pack' AS kind, p.id, d.id AS doc_id, p.packed_at AS at, d.number AS title,
               p.box_count::text || CASE WHEN p.box_count = 1 THEN ' box' ELSE ' boxes' END AS detail, NULL AS quantity, NULL AS amount, NULL AS state
          FROM pack_records p JOIN sales_documents d ON d.id = p.document_id
         WHERE p.org_id = ${orgId} AND d.party_id = ${partyId} AND p.deleted_at IS NULL AND ${sales}`);
      parts.push(sql`
        SELECT 'dispatch' AS kind, x.id, d.id AS doc_id, x.dispatched_at AS at, x.number AS title, 'Against ' || d.number AS detail,
               NULL AS quantity, NULL AS amount, x.mode::text AS state
          FROM dispatches x JOIN sales_documents d ON d.id = x.document_id
         WHERE x.org_id = ${orgId} AND d.party_id = ${partyId} AND x.deleted_at IS NULL AND ${sales}`);
      parts.push(sql`
        SELECT 'delivery' AS kind, x.id, d.id AS doc_id, x.delivered_at AS at, x.number AS title,
               'Against ' || d.number || coalesce(' · received by ' || x.received_by, '') AS detail, NULL AS quantity, NULL AS amount, NULL AS state
          FROM dispatches x JOIN sales_documents d ON d.id = x.document_id
         WHERE x.org_id = ${orgId} AND d.party_id = ${partyId} AND x.delivered_at IS NOT NULL AND x.deleted_at IS NULL AND ${sales}`);
    }
    if (purchase) {
      parts.push(sql`
        SELECT 'purchase_order' AS kind, p.id, p.id AS doc_id, p.date::timestamptz AS at, p.number AS title,
               (SELECT count(*)::text || ' lines' FROM purchase_order_lines l WHERE l.purchase_order_id = p.id) AS detail,
               NULL AS quantity, p.grand_total::text AS amount, p.status::text AS state
          FROM purchase_orders p WHERE p.org_id = ${orgId} AND p.party_id = ${partyId} AND p.deleted_at IS NULL`);
      parts.push(sql`
        SELECT 'grn' AS kind, g.id, p.id AS doc_id, g.received_at AS at, g.number AS title, 'Against ' || p.number AS detail,
               NULL AS quantity, NULL AS amount, NULL AS state
          FROM grns g JOIN purchase_orders p ON p.id = g.purchase_order_id
         WHERE g.org_id = ${orgId} AND p.party_id = ${partyId} AND g.deleted_at IS NULL`);
    }
    if (vouchers) {
      parts.push(sql`
        SELECT 'voucher' AS kind, v.id, v.id AS doc_id, v.voucher_date::timestamptz AS at,
               v.voucher_type || ' ' || coalesce(v.voucher_number, '') AS title, v.narration AS detail,
               NULL AS quantity, v.amount::text AS amount, CASE WHEN v.is_cancelled THEN 'Cancelled' ELSE NULL END AS state
          FROM vouchers v WHERE v.org_id = ${orgId} AND v.party_id = ${partyId}`);
    }
    return this.runEvents(parts, null);
  }

  private async runEvents(parts: SQL[], unit: string | null): Promise<LifecycleEvent[]> {
    if (parts.length === 0) return [];
    const union = sql.join(parts, sql` UNION ALL `);
    const rows = await this.db.execute<EventRow>(sql`
      SELECT * FROM (${union}) AS e ORDER BY e.at DESC NULLS LAST LIMIT ${EVENT_CAP}
    `);
    return rows.rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      at: row.at instanceof Date ? row.at.toISOString() : new Date(row.at).toISOString(),
      title: row.title,
      detail: row.detail,
      quantity: row.quantity,
      unit: row.quantity === null ? null : unit,
      amount: row.amount,
      state: row.state,
      href: hrefFor(row.kind, row.id, row.doc_id),
    }));
  }
}
