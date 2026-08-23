import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { DocumentDetails, ShipTo } from '@vyuha/shared';

import { ALIVE, primaryId, standardColumns } from '../../../platform/db/columns.js';
import { employees, organizations, parties, procurementRequirements, stockItems } from '../../../platform/db/schema/index.js';

/**
 * Purchase orders and GRNs (08 Area X, 13 §4). The sales module's shape —
 * header, lines, quantities as the state, the same sync-state columns —
 * under its own tables, because the two modules may not import each other
 * (D-36). `item_vendors` is the one Vyuha-owned master in the design (D-27).
 */

export const purchaseOrderStatusEnum = pgEnum('purchase_order_status', ['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'CANCELLED']);
export const purchaseSyncStateEnum = pgEnum('purchase_sync_state', ['NOT_PUSHED', 'QUEUED', 'PUSHED', 'FAILED']);

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    status: purchaseOrderStatusEnum('status').notNull().default('DRAFT'),
    date: date('date', { mode: 'string' }).notNull(),
    /** The vendor: a Tally party under Sundry Creditors. */
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    vendorName: text('vendor_name').notNull(),
    /** REQ-X-02: raised against a sales order, or standalone for stock. */
    salesOrderId: uuid('sales_order_id'),
    expectedDate: date('expected_date', { mode: 'string' }),
    ownerId: uuid('owner_id').references(() => employees.id, { onDelete: 'restrict' }),
    notes: text('notes'),
    subtotal: numeric('subtotal', { precision: 16, scale: 2 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 16, scale: 2 }).notNull().default('0'),
    grandTotal: numeric('grand_total', { precision: 16, scale: 2 }).notNull().default('0'),
    /** REQ-X-16: the approval request, when the value crossed the threshold. */
    approvalRequestId: uuid('approval_request_id'),
    syncState: purchaseSyncStateEnum('sync_state').notNull().default('NOT_PUSHED'),
    remoteGuid: text('remote_guid'),
    remoteVoucherNumber: text('remote_voucher_number'),
    pushJobId: uuid('push_job_id'),
    lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
    lastError: text('last_error'),
    shortClosedAt: timestamp('short_closed_at', { withTimezone: true }),
    shortCloseReason: text('short_close_reason'),
    /** REQ-X-18: the vendor's contact for this PO's notification. */
    vendorEmail: text('vendor_email'),
    vendorWhatsapp: text('vendor_whatsapp'),
    /** D-38: what the printed order carries beyond its lines — terms, the details grid, where to deliver. */
    terms: text('terms'),
    details: jsonb('details').$type<DocumentDetails>(),
    shipTo: jsonb('ship_to').$type<ShipTo>(),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('purchase_orders_org_number_uq').on(t.orgId, t.number),
    index('purchase_orders_org_status_idx').on(t.orgId, t.status).where(ALIVE),
    index('purchase_orders_org_party_idx').on(t.orgId, t.partyId).where(ALIVE),
    index('purchase_orders_sales_order_idx').on(t.salesOrderId),
  ],
);

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    stockItemId: uuid('stock_item_id').references(() => stockItems.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 16, scale: 3 }).notNull(),
    unit: text('unit'),
    rate: numeric('rate', { precision: 16, scale: 2 }).notNull(),
    discountPct: numeric('discount_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    taxPct: numeric('tax_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    hsnCode: text('hsn_code'),
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull(),
    taxAmount: numeric('tax_amount', { precision: 16, scale: 2 }).notNull().default('0'),
    /** REQ-X-19/X-21: received and rejected never exceed ordered — a constraint, not code. */
    receivedQty: numeric('received_qty', { precision: 16, scale: 3 }).notNull().default('0'),
    rejectedQty: numeric('rejected_qty', { precision: 16, scale: 3 }).notNull().default('0'),
    // 15 REQ-AN-15: carried for symmetry with sales lines; purchase rates resolve from nothing yet.
    priceListId: uuid('price_list_id'),
    priceListVersion: integer('price_list_version'),
    resolvedRate: numeric('resolved_rate', { precision: 16, scale: 2 }),
    appliedDiscountPct: numeric('applied_discount_pct', { precision: 5, scale: 2 }),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('purchase_order_lines_po_line_uq').on(t.purchaseOrderId, t.lineNo),
    index('purchase_order_lines_org_item_idx').on(t.orgId, t.stockItemId).where(ALIVE),
    check('purchase_order_lines_received_le_ordered', sql`received_qty >= 0 AND rejected_qty >= 0 AND received_qty + rejected_qty <= quantity`),
  ],
);

/** REQ-X-10: many-to-many between PO lines and requirements, with the quantity each took. */
export const poLineRequirements = pgTable(
  'po_line_requirements',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    purchaseOrderLineId: uuid('purchase_order_line_id')
      .notNull()
      .references(() => purchaseOrderLines.id, { onDelete: 'cascade' }),
    requirementId: uuid('requirement_id')
      .notNull()
      .references(() => procurementRequirements.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 16, scale: 3 }).notNull(),
    /** REQ-X-27 / D-30: how much of a receipt was allocated to this requirement, by an explicit decision. */
    allocatedQty: numeric('allocated_qty', { precision: 16, scale: 3 }).notNull().default('0'),
  },
  (t) => [uniqueIndex('po_line_requirements_uq').on(t.purchaseOrderLineId, t.requirementId), index('po_line_requirements_req_idx').on(t.requirementId)],
);

/** REQ-X-18: the message to the vendor, per channel — the dispatch notification's shape, in the purchase module. */
export const purchaseOrderNotifications = pgTable(
  'purchase_order_notifications',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    recipient: text('recipient'),
    status: text('status').notNull(),
    composedText: text('composed_text').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentBy: uuid('sent_by'),
    error: text('error'),
    ...standardColumns(),
  },
  (t) => [index('purchase_order_notifications_po_idx').on(t.purchaseOrderId)],
);

export const grns = pgTable(
  'grns',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    receivedBy: uuid('received_by').references(() => employees.id, { onDelete: 'restrict' }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    vendorInvoiceRef: text('vendor_invoice_ref'),
    notes: text('notes'),
    syncState: purchaseSyncStateEnum('sync_state').notNull().default('NOT_PUSHED'),
    remoteGuid: text('remote_guid'),
    remoteVoucherNumber: text('remote_voucher_number'),
    pushJobId: uuid('push_job_id'),
    lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...standardColumns(),
  },
  (t) => [uniqueIndex('grns_org_number_uq').on(t.orgId, t.number), index('grns_org_po_idx').on(t.orgId, t.purchaseOrderId)],
);

export const grnLines = pgTable(
  'grn_lines',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    grnId: uuid('grn_id')
      .notNull()
      .references(() => grns.id, { onDelete: 'cascade' }),
    purchaseOrderLineId: uuid('purchase_order_line_id')
      .notNull()
      .references(() => purchaseOrderLines.id, { onDelete: 'restrict' }),
    receivedQty: numeric('received_qty', { precision: 16, scale: 3 }).notNull().default('0'),
    rejectedQty: numeric('rejected_qty', { precision: 16, scale: 3 }).notNull().default('0'),
    rejectionReason: text('rejection_reason'),
    ...standardColumns(),
  },
  (t) => [
    index('grn_lines_grn_idx').on(t.grnId),
    check('grn_lines_something_received', sql`received_qty + rejected_qty > 0`),
    check('grn_lines_rejection_reasoned', sql`rejected_qty = 0 OR rejection_reason IS NOT NULL`),
  ],
);

/** D-27: the one Vyuha-owned master. Preferred vendor per item, with lead time (D-33). */
export const itemVendors = pgTable(
  'item_vendors',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    stockItemId: uuid('stock_item_id')
      .notNull()
      .references(() => stockItems.id, { onDelete: 'cascade' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    isPreferred: boolean('is_preferred').notNull().default(false),
    leadTimeDays: integer('lead_time_days'),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('item_vendors_item_party_uq').on(t.stockItemId, t.partyId).where(ALIVE),
    uniqueIndex('item_vendors_item_preferred_uq').on(t.stockItemId).where(sql`is_preferred AND deleted_at IS NULL`),
  ],
);
