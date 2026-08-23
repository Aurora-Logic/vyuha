import { Injectable } from '@nestjs/common';
import type { OrderWaitingOnView } from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { InjectDatabase, type Database, type Transaction } from '../db/db.provider.js';

/**
 * Procurement requirements (13 §4.1), the record a purchase order is built
 * from. Raised by a short pack (REQ-X-08, D-31), by the nightly reorder
 * check (REQ-X-09), or by hand; taken up by purchase order lines
 * (REQ-X-10); closed with a reason (REQ-X-11). Platform, so the sales
 * module can raise one and the purchase module can consume it without
 * either importing the other (D-35).
 */
export interface RequirementRow {
  readonly id: string;
  readonly stockItemId: string;
  readonly stockItemName: string;
  readonly quantity: string;
  readonly orderedQty: string;
  readonly receivedQty: string;
  readonly source: 'shortage' | 'reorder' | 'manual';
  readonly salesOrderId: string | null;
  readonly salesOrderLineId: string | null;
  readonly salesOrderNumber: string | null;
  readonly customerName: string | null;
  readonly neededBy: string | null;
  readonly state: 'open' | 'ordered' | 'received' | 'closed';
  readonly closedReason: string | null;
  readonly createdAt: string;
}

@Injectable()
export class RequirementsService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly audit: AuditService,
  ) {}

  /**
   * REQ-X-08: the unpacked balance of one order line becomes (or updates)
   * one open requirement. Idempotent per line: a second short pack moves the
   * quantity to the new balance rather than raising a second requirement.
   */
  async raiseShortage(tx: Transaction, orgId: string, actorUserId: string | null, input: { stockItemId: string; salesOrderId: string; salesOrderLineId: string; balanceQty: string; neededBy: string | null }): Promise<string | null> {
    if (Number(input.balanceQty) <= 0) {
      await tx.execute(sql`
        UPDATE procurement_requirements SET state = 'closed', closed_reason = 'Balance packed', closed_at = now(), updated_at = now()
         WHERE org_id = ${orgId} AND sales_order_line_id = ${input.salesOrderLineId} AND state = 'open' AND deleted_at IS NULL
      `);
      return null;
    }
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM procurement_requirements
       WHERE org_id = ${orgId} AND sales_order_line_id = ${input.salesOrderLineId} AND state IN ('open', 'ordered') AND deleted_at IS NULL
       LIMIT 1
    `);
    const found = existing.rows[0];
    if (found !== undefined) {
      await tx.execute(sql`
        UPDATE procurement_requirements SET quantity = ${input.balanceQty}, updated_at = now(), updated_by = ${actorUserId}
         WHERE id = ${found.id}
      `);
      return found.id;
    }
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO procurement_requirements (org_id, stock_item_id, quantity, source, sales_order_id, sales_order_line_id, needed_by, created_by, updated_by)
      VALUES (${orgId}, ${input.stockItemId}, ${input.balanceQty}, 'shortage', ${input.salesOrderId}, ${input.salesOrderLineId}, ${input.neededBy}, ${actorUserId}, ${actorUserId})
      RETURNING id
    `);
    const id = inserted.rows[0]?.id ?? null;
    if (id !== null) {
      this.auditContext.record({
        action: 'procurement.requirement.raised',
        entityType: 'procurement_requirement',
        entityId: id,
        before: null,
        after: { source: 'shortage', stockItemId: input.stockItemId, quantity: input.balanceQty, salesOrderId: input.salesOrderId },
      });
    }
    return id;
  }

  /**
   * Give up on what a sales order was waiting for.
   *
   * Called when the order stops being something to fulfil -- short-closed, or
   * cancelled in Tally, which is the same fact arriving from the other
   * direction. The Tally path did nothing at all, so the shortages that order
   * had raised stayed open for ever: the buyer went on purchasing for an order
   * that no longer existed, and the requirement queue carried work nobody
   * wanted done.
   *
   * Here rather than in the sales module because `procurement_requirements` is
   * the platform's table (D-35) -- the sales module was reaching into it by
   * hand, which is the boundary this repairs along with the bug.
   */
  async closeForSalesOrder(tx: Database, orgId: string, salesOrderId: string, reason: string): Promise<number> {
    const closed = await tx.execute<{ id: string }>(sql`
      UPDATE procurement_requirements
         SET state = 'closed', closed_reason = ${reason}, closed_at = now(), updated_at = now()
       WHERE org_id = ${orgId} AND sales_order_id = ${salesOrderId}
         AND state IN ('open', 'ordered') AND deleted_at IS NULL
      RETURNING id
    `);
    return closed.rows.length;
  }

  /** REQ-X-09: one open requirement per item at or below its reorder level, skipping items an open PO already covers. */
  async raiseReorderBreaches(orgId: string): Promise<number> {
    const rows = await this.db.execute<{ id: string; stock_item_id: string; quantity: string }>(sql`
      INSERT INTO procurement_requirements (org_id, stock_item_id, quantity, source, state)
      SELECT s.org_id, s.id,
             GREATEST(i.reorder_level - (COALESCE(s.closing_qty, 0) - COALESCE(c.committed, 0) + COALESCE(p.open_po, 0)), COALESCE(NULLIF(i.minimum_order_qty, 0), 1)),
             'reorder', 'open'
        FROM stock_items s
        JOIN item_settings i ON i.stock_item_id = s.id AND i.deleted_at IS NULL AND i.reorder_level IS NOT NULL
        LEFT JOIN LATERAL (
          SELECT sum(l.quantity - l.dispatched_qty) AS committed
            FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
           WHERE l.stock_item_id = s.id AND l.deleted_at IS NULL AND d.doc_type = 'SALES_ORDER'
             AND d.status = 'CONFIRMED' AND d.short_closed_at IS NULL AND d.deleted_at IS NULL
        ) c ON true
        LEFT JOIN LATERAL (
          SELECT sum(pl.quantity - pl.received_qty - pl.rejected_qty) AS open_po
            FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.purchase_order_id
           WHERE pl.stock_item_id = s.id AND pl.deleted_at IS NULL AND po.status = 'CONFIRMED'
             AND po.short_closed_at IS NULL AND po.deleted_at IS NULL
        ) p ON true
       WHERE s.org_id = ${orgId}
         AND (COALESCE(s.closing_qty, 0) - COALESCE(c.committed, 0) + COALESCE(p.open_po, 0)) <= i.reorder_level
         -- An item already being dealt with is not raised again. "Already"
         -- includes one whose goods have arrived but whose receipt has not
         -- come back from Tally yet: closing_qty is Tally's figure, so between
         -- the GRN and the next pull the shelf still reads empty and the sweep
         -- raised the same reorder a second time, every night, until Tally
         -- caught up. last_pulled_at is when this item's figure was last true
         -- (NOT NULL, defaulted to now()), so a requirement received after it
         -- is one the closing quantity does not yet know about.
         AND NOT EXISTS (
           SELECT 1 FROM procurement_requirements r
            WHERE r.org_id = s.org_id AND r.stock_item_id = s.id AND r.source = 'reorder'
              AND r.deleted_at IS NULL
              AND (r.state IN ('open', 'ordered')
                   OR (r.state = 'received' AND r.updated_at > s.last_pulled_at))
         )
      RETURNING id, stock_item_id, quantity::text AS quantity
    `);
    // A job has no request to flush an audit context into, so the rows are
    // written directly: a requirement raised overnight is a state change a
    // person should be able to find the next morning (REQ-X-09).
    for (const row of rows.rows) {
      await this.audit.write({ orgId, actorUserId: null, action: 'procurement.requirement.raised', entityType: 'procurement_requirement', entityId: row.id, after: { source: 'reorder', stockItemId: row.stock_item_id, quantity: row.quantity } });
    }
    return rows.rows.length;
  }

  async list(orgId: string, filters: { state?: string | undefined; stockItemId?: string | undefined; salesOrderId?: string | undefined }): Promise<RequirementRow[]> {
    const rows = await this.db.execute<{
      id: string; stock_item_id: string; stock_item_name: string; quantity: string; ordered_qty: string; received_qty: string;
      source: RequirementRow['source']; sales_order_id: string | null; sales_order_line_id: string | null; sales_order_number: string | null;
      customer_name: string | null; needed_by: string | null; state: RequirementRow['state']; closed_reason: string | null; created_at: Date;
    }>(sql`
      SELECT r.id, r.stock_item_id, s.name AS stock_item_name, r.quantity::text AS quantity, r.ordered_qty::text AS ordered_qty, r.received_qty::text AS received_qty,
             r.source, r.sales_order_id, r.sales_order_line_id, d.number AS sales_order_number, d.customer_name,
             r.needed_by, r.state, r.closed_reason, r.created_at
        FROM procurement_requirements r
        JOIN stock_items s ON s.id = r.stock_item_id
        LEFT JOIN sales_documents d ON d.id = r.sales_order_id
       WHERE r.org_id = ${orgId} AND r.deleted_at IS NULL
         ${filters.state === undefined ? sql`` : sql`AND r.state = ${filters.state}`}
         ${filters.stockItemId === undefined ? sql`` : sql`AND r.stock_item_id = ${filters.stockItemId}`}
         ${filters.salesOrderId === undefined ? sql`` : sql`AND r.sales_order_id = ${filters.salesOrderId}`}
       ORDER BY r.needed_by NULLS LAST, r.created_at
       LIMIT 500
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      stockItemId: r.stock_item_id,
      stockItemName: r.stock_item_name,
      quantity: r.quantity,
      orderedQty: r.ordered_qty,
      receivedQty: r.received_qty,
      source: r.source,
      salesOrderId: r.sales_order_id,
      salesOrderLineId: r.sales_order_line_id,
      salesOrderNumber: r.sales_order_number,
      customerName: r.customer_name,
      neededBy: r.needed_by,
      state: r.state,
      closedReason: r.closed_reason,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  /**
   * 13 REQ-X-26: what a sales order waits on — its open and ordered
   * requirements, each with the POs raised against it, the vendor and the
   * expected date — so sales answers "when will the rest come" from the
   * order. Read here, in the platform, because the requirement is the seam
   * (D-35): the sales module never queries a purchase table.
   */
  async waitingOn(orgId: string, salesOrderId: string): Promise<OrderWaitingOnView[]> {
    const rows = await this.db.execute<{
      id: string; sales_order_line_id: string | null; stock_item_name: string; quantity: string; ordered_qty: string; received_qty: string;
      state: OrderWaitingOnView['state']; needed_by: string | null; purchase_orders: OrderWaitingOnView['purchaseOrders'];
    }>(sql`
      SELECT r.id, r.sales_order_line_id, s.name AS stock_item_name, r.quantity::text AS quantity, r.ordered_qty::text AS ordered_qty, r.received_qty::text AS received_qty,
             r.state, r.needed_by,
             COALESCE((
               SELECT json_agg(json_build_object('id', po.id, 'number', po.number, 'vendorName', po.vendor_name, 'status', po.status, 'expectedDate', po.expected_date, 'quantity', plr.quantity::text) ORDER BY po.date)
                 FROM po_line_requirements plr
                 JOIN purchase_order_lines pl ON pl.id = plr.purchase_order_line_id
                 JOIN purchase_orders po ON po.id = pl.purchase_order_id AND po.deleted_at IS NULL AND po.status <> 'CANCELLED'
                WHERE plr.requirement_id = r.id
             ), '[]'::json) AS purchase_orders
        FROM procurement_requirements r JOIN stock_items s ON s.id = r.stock_item_id
       WHERE r.org_id = ${orgId} AND r.sales_order_id = ${salesOrderId} AND r.deleted_at IS NULL AND r.state IN ('open', 'ordered')
       ORDER BY r.created_at
    `);
    return rows.rows.map((r) => ({
      requirementId: r.id,
      lineId: r.sales_order_line_id,
      stockItemName: r.stock_item_name,
      quantity: r.quantity,
      orderedQty: r.ordered_qty,
      receivedQty: r.received_qty,
      state: r.state,
      neededBy: r.needed_by,
      purchaseOrders: r.purchase_orders,
    }));
  }

  async close(orgId: string, actorUserId: string | null, id: string, reason: string): Promise<boolean> {
    const rows = await this.db.execute<{ id: string }>(sql`
      UPDATE procurement_requirements SET state = 'closed', closed_reason = ${reason}, closed_at = now(), updated_at = now(), updated_by = ${actorUserId}
       WHERE org_id = ${orgId} AND id = ${id} AND state IN ('open', 'ordered') AND deleted_at IS NULL
      RETURNING id
    `);
    if (rows.rows.length === 0) return false;
    this.auditContext.record({ action: 'procurement.requirement.closed', entityType: 'procurement_requirement', entityId: id, before: null, after: { reason } });
    return true;
  }
}
