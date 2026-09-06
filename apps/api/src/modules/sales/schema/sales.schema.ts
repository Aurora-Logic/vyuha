import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { DocumentDetails, ShipTo } from '@vyuha/shared';

import { ALIVE, primaryId, standardColumns } from '../../../platform/db/columns.js';
import { employees, files, organizations, parties, stockItems, vouchers } from '../../../platform/db/schema/index.js';

/**
 * Sales documents (08 Area W). One table with a type discriminator, as
 * Tally models vouchers and 09 §4.3 models the projection: an estimate, a
 * sales order and a challan are the same header-and-lines shape at
 * different points in a life, and one line editor serves them all.
 *
 * The customer is one of three: a Tally party (`party_id`), a CRM company
 * that is not yet a party (`company_id`, no FK — the sales module may not
 * import the CRM schema, technical design §1), or a name typed in.
 * `customer_name` is what prints, snapshotted so a rename later does not
 * rewrite what was sent. `deal_id` is likewise an unreferenced uuid: the
 * link REQ-U-06 wants is read from this side by deal id.
 */

export const salesDocumentTypeEnum = pgEnum('sales_document_type', ['ESTIMATE', 'SALES_ORDER', 'INVOICE']);
/** One status enum for every document type; which values a type may hold is the service's table. */
export const estimateStatusEnum = pgEnum('estimate_status', ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONFIRMED', 'CANCELLED', 'PENDING_APPROVAL']);
/** REQ-W-06: what the agent reported, never inferred. */
export const documentSyncStateEnum = pgEnum('document_sync_state', ['NOT_PUSHED', 'QUEUED', 'PUSHED', 'FAILED']);

export const salesDocuments = pgTable(
  'sales_documents',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    docType: salesDocumentTypeEnum('doc_type').notNull(),
    /** `EST-0001`, per organisation per type, from `sales_document_sequences`. */
    number: text('number').notNull(),
    status: estimateStatusEnum('status').notNull().default('DRAFT'),
    date: date('date', { mode: 'string' }).notNull(),
    validUntil: date('valid_until', { mode: 'string' }),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }),
    companyId: uuid('company_id'),
    dealId: uuid('deal_id'),
    customerName: text('customer_name').notNull(),
    ownerId: uuid('owner_id').references(() => employees.id, { onDelete: 'restrict' }),
    notes: text('notes'),
    terms: text('terms'),
    subtotal: numeric('subtotal', { precision: 16, scale: 2 }).notNull().default('0'),
    discountTotal: numeric('discount_total', { precision: 16, scale: 2 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 16, scale: 2 }).notNull().default('0'),
    grandTotal: numeric('grand_total', { precision: 16, scale: 2 }).notNull().default('0'),
    /** REQ-W-03: the estimate this order was converted from. Same table, no FK cascade wanted. */
    sourceDocumentId: uuid('source_document_id'),
    /** 15 REQ-AK-08: the return this order replaces. No FK — sales_returns is declared below it. */
    returnId: uuid('return_id'),
    /**
     * REQ-W-06 / REQ-W-07. `remote_guid` is the voucher Tally created; an
     * alter pushes against it and never creates a second (09 §3.3). The
     * idempotency key rides in the voucher's narration and is what the agent
     * queries for before any retry; it also lives in `external_refs`, which
     * is the sync engine's own record of the same link.
     */
    syncState: documentSyncStateEnum('sync_state').notNull().default('NOT_PUSHED'),
    remoteGuid: text('remote_guid'),
    remoteVoucherNumber: text('remote_voucher_number'),
    pushJobId: uuid('push_job_id'),
    lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** REQ-AA-15: when accounts was told this order has waited too long; once per order. */
    invoiceReminderSentAt: timestamp('invoice_reminder_sent_at', { withTimezone: true }),
    /** REQ-W-08: the approval request an over-threshold discount waits on, decided in the inbox. */
    approvalRequestId: uuid('approval_request_id'),
    /** REQ-AA-05: the balance written off, by whom, why. Never silent. */
    shortClosedAt: timestamp('short_closed_at', { withTimezone: true }),
    shortCloseReason: text('short_close_reason'),
    /** REQ-AA-28: from the party master where present, overridable per order. */
    customerEmail: text('customer_email'),
    customerWhatsapp: text('customer_whatsapp'),
    /** The GST header (documents.ts): buyer's state code, consignee, the Tally details grid. */
    placeOfSupply: text('place_of_supply'),
    shipTo: jsonb('ship_to').$type<ShipTo>(),
    details: jsonb('details').$type<DocumentDetails>(),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('sales_documents_org_type_number_uq').on(t.orgId, t.docType, t.number),
    index('sales_documents_org_sync_idx').on(t.orgId, t.docType, t.syncState).where(ALIVE),
    index('sales_documents_org_type_date_idx').on(t.orgId, t.docType, t.date).where(ALIVE),
    index('sales_documents_org_party_idx').on(t.orgId, t.partyId).where(ALIVE),
    index('sales_documents_org_company_idx').on(t.orgId, t.companyId).where(ALIVE),
    index('sales_documents_org_deal_idx').on(t.orgId, t.dealId).where(ALIVE),
    index('sales_documents_org_owner_idx').on(t.orgId, t.ownerId).where(ALIVE),
    // One replacement order per return, decided by the database rather than
    // by a read that two callers can both pass (H-08).
    uniqueIndex('sales_documents_one_replacement_per_return_uq').on(t.returnId).where(sql`return_id IS NOT NULL AND deleted_at IS NULL`),
  ],
);

export const salesDocumentLines = pgTable(
  'sales_document_lines',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => salesDocuments.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    stockItemId: uuid('stock_item_id').references(() => stockItems.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 16, scale: 3 }).notNull(),
    unit: text('unit'),
    rate: numeric('rate', { precision: 16, scale: 2 }).notNull(),
    discountPct: numeric('discount_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    taxPct: numeric('tax_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull(),
    taxAmount: numeric('tax_amount', { precision: 16, scale: 2 }).notNull().default('0'),
    hsnCode: text('hsn_code'),
    /**
     * REQ-AA-01/AA-04: quantities are the state, and the chain is a database
     * constraint, not code. `quantity` is the ordered quantity.
     */
    // D-48: the chain is ordered → picked → packed → invoiced → dispatched.
    pickedQty: numeric('picked_qty', { precision: 16, scale: 3 }).notNull().default('0'),
    packedQty: numeric('packed_qty', { precision: 16, scale: 3 }).notNull().default('0'),
    invoicedQty: numeric('invoiced_qty', { precision: 16, scale: 3 }).notNull().default('0'),
    dispatchedQty: numeric('dispatched_qty', { precision: 16, scale: 3 }).notNull().default('0'),
    // 15 REQ-AN-15: what the price lists resolved when the line was written, as values; and why a rate went below it.
    priceListId: uuid('price_list_id'),
    priceListVersion: integer('price_list_version'),
    resolvedRate: numeric('resolved_rate', { precision: 16, scale: 2 }),
    appliedDiscountPct: numeric('applied_discount_pct', { precision: 5, scale: 2 }),
    rateOverrideReason: text('rate_override_reason'),
    /**
     * 15 REQ-AK-09 / D-51: a free replacement line. REQ-AA-14 holds goods
     * until the invoice exists, which is right when there will be one; a
     * replacement the company decided to give away has no invoice to wait
     * for, and without this mark it would wait for ever. The mark is per
     * line because a replacement may be part free and part sold.
     */
    freeOfCharge: boolean('free_of_charge').notNull().default(false),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('sales_document_lines_doc_line_uq').on(t.documentId, t.lineNo),
    check('sales_document_lines_picked_le_ordered', sql`picked_qty >= 0 AND picked_qty <= quantity`),
    check('sales_document_lines_packed_le_picked', sql`packed_qty >= 0 AND packed_qty <= picked_qty`),
    check('sales_document_lines_invoiced_le_packed', sql`invoiced_qty >= 0 AND invoiced_qty <= packed_qty`),
    // A free replacement waits for no invoice, so what releases it is what was
    // packed -- but `free_of_charge OR ...` short-circuits to true and left the
    // line with no ceiling in the database at all. The service's own check was
    // then the only thing between a request and a dispatched quantity larger
    // than anything ever picked.
    check('sales_document_lines_dispatched_le_invoiced', sql`dispatched_qty >= 0 AND dispatched_qty <= (CASE WHEN free_of_charge THEN packed_qty ELSE invoiced_qty END)`),
    // REQ-W-02: what was quoted for this item, by document.
    index('sales_document_lines_org_item_idx').on(t.orgId, t.stockItemId).where(ALIVE),
  ],
);

/**
 * One row per organisation per document type: the last number issued.
 * Bumped with `UPDATE … RETURNING` inside the insert's transaction, so two
 * estimates raised together cannot share a number and a rolled-back one
 * leaves a gap rather than a duplicate — a gap is a fact, a duplicate is a
 * dispute.
 */
export const salesDocumentSequences = pgTable(
  'sales_document_sequences',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    docType: salesDocumentTypeEnum('doc_type').notNull(),
    lastNumber: integer('last_number').notNull().default(0),
  },
  (t) => [uniqueIndex('sales_document_sequences_uq').on(t.orgId, t.docType)],
);


/** REQ-AA-09: one packing session on one order; several across days are normal. */
export const packRecords = pgTable(
  'pack_records',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => salesDocuments.id, { onDelete: 'cascade' }),
    boxCount: integer('box_count').notNull().default(1),
    packedBy: uuid('packed_by').references(() => employees.id, { onDelete: 'restrict' }),
    packedAt: timestamp('packed_at', { withTimezone: true }).notNull().defaultNow(),
    comment: text('comment'),
    ...standardColumns(),
  },
  (t) => [index('pack_records_org_document_idx').on(t.orgId, t.documentId)],
);

export const packRecordLines = pgTable(
  'pack_record_lines',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    packRecordId: uuid('pack_record_id')
      .notNull()
      .references(() => packRecords.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id')
      .notNull()
      .references(() => salesDocumentLines.id, { onDelete: 'cascade' }),
    quantity: numeric('quantity', { precision: 16, scale: 3 }).notNull(),
    comment: text('comment'),
    ...standardColumns(),
  },
  (t) => [index('pack_record_lines_line_idx').on(t.lineId), check('pack_record_lines_qty_positive', sql`quantity > 0`)],
);

/**
 * REQ-AA-12/AA-13: the invoice Tally raised, linked to the order — by the
 * order number in the narration (D-21) or by a person. One voucher links to
 * one order; the unlinked ones are a screen, never a guess.
 */
export const salesOrderInvoices = pgTable(
  'sales_order_invoices',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => salesDocuments.id, { onDelete: 'cascade' }),
    /** Null until a Vyuha-raised invoice's own voucher pulls back (D-38). */
    voucherId: uuid('voucher_id').references(() => vouchers.id, { onDelete: 'cascade' }),
    /** The Vyuha invoice document, when it was raised here (D-38). */
    invoiceDocumentId: uuid('invoice_document_id'),
    method: text('method').notNull(),
    linkedBy: uuid('linked_by'),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sales_order_invoices_voucher_uq').on(t.voucherId), uniqueIndex('sales_order_invoices_invoice_uq').on(t.invoiceDocumentId), index('sales_order_invoices_document_idx').on(t.documentId)],
);

/** D-48: a picking session — who took how much off the shelf, before it is packed. Mirrors pack_records. */
export const pickRecords = pgTable(
  'pick_records',
  {
    id: primaryId(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    documentId: uuid('document_id').notNull().references(() => salesDocuments.id, { onDelete: 'restrict' }),
    pickedBy: uuid('picked_by').references(() => employees.id, { onDelete: 'restrict' }),
    pickedAt: timestamp('picked_at', { withTimezone: true }).notNull().defaultNow(),
    comment: text('comment'),
    ...standardColumns(),
  },
  (t) => [index('pick_records_org_document_idx').on(t.orgId, t.documentId)],
);

export const pickRecordLines = pgTable(
  'pick_record_lines',
  {
    id: primaryId(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    pickRecordId: uuid('pick_record_id').notNull().references(() => pickRecords.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id').notNull().references(() => salesDocumentLines.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 16, scale: 3 }).notNull(),
    comment: text('comment'),
    ...standardColumns(),
  },
  (t) => [index('pick_record_lines_pick_idx').on(t.pickRecordId), check('pick_record_lines_qty_positive', sql`quantity > 0`)],
);

export const dispatchModeEnum = pgEnum('dispatch_mode', ['local_auto', 'local_own_vehicle', 'outstation', 'customer_collects']);

/** REQ-AA-16: a dispatch is its own record; one order may have many. Pushes as a Delivery Note (REQ-AA-22). */
export const dispatches = pgTable(
  'dispatches',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => salesDocuments.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    mode: dispatchModeEnum('mode').notNull(),
    dispatchedBy: uuid('dispatched_by').references(() => employees.id, { onDelete: 'restrict' }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }).notNull().defaultNow(),
    lrNumber: text('lr_number'),
    transporterName: text('transporter_name'),
    transporterContact: text('transporter_contact'),
    vehicleNumber: text('vehicle_number'),
    driverName: text('driver_name'),
    expectedDeliveryDate: date('expected_delivery_date', { mode: 'string' }),
    notes: text('notes'),
    // D-47: the door step. Null until somebody marks it delivered; the
    // receiver's name and the photograph are the proof (attachment kind 'delivery').
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliveredBy: uuid('delivered_by'),
    receivedBy: text('received_by'),
    deliveryNote: text('delivery_note'),
    syncState: documentSyncStateEnum('sync_state').notNull().default('NOT_PUSHED'),
    remoteGuid: text('remote_guid'),
    remoteVoucherNumber: text('remote_voucher_number'),
    pushJobId: uuid('push_job_id'),
    lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('dispatches_org_number_uq').on(t.orgId, t.number),
    index('dispatches_org_document_idx').on(t.orgId, t.documentId),
    index('dispatches_org_sync_idx').on(t.orgId, t.syncState).where(ALIVE),
  ],
);

export const dispatchLines = pgTable(
  'dispatch_lines',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    dispatchId: uuid('dispatch_id')
      .notNull()
      .references(() => dispatches.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id')
      .notNull()
      .references(() => salesDocumentLines.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 16, scale: 3 }).notNull(),
    ...standardColumns(),
  },
  (t) => [index('dispatch_lines_dispatch_idx').on(t.dispatchId), check('dispatch_lines_qty_positive', sql`quantity > 0`)],
);

/** REQ-AA-20: through the existing files pipeline; `kind` says which photograph. */
export const dispatchAttachments = pgTable(
  'dispatch_attachments',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    dispatchId: uuid('dispatch_id')
      .notNull()
      .references(() => dispatches.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    ...standardColumns(),
  },
  (t) => [index('dispatch_attachments_dispatch_idx').on(t.dispatchId)],
);

/** REQ-AA-26/AA-27: every notification attempt, `manual` first, recorded from day one. */
export const dispatchNotifications = pgTable(
  'dispatch_notifications',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    dispatchId: uuid('dispatch_id')
      .notNull()
      .references(() => dispatches.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    /** D-47: which moment the message is about — 'dispatched' or 'delivered'. */
    event: text('event').notNull().default('dispatched'),
    recipient: text('recipient'),
    status: text('status').notNull(),
    composedText: text('composed_text').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentBy: uuid('sent_by'),
    error: text('error'),
    ...standardColumns(),
  },
  (t) => [index('dispatch_notifications_dispatch_idx').on(t.dispatchId)],
);

/**
 * 15 Area AK — sales returns. The GRN inverted: goods come back, quantity
 * and condition are recorded with the goods in hand, and the accounting
 * document is Tally's (REQ-AK-05). No stock moves here (REQ-AK-07): a
 * restocked line rises in Tally as a consequence of the credit note and
 * arrives on the following pull.
 */
export const returnStateEnum = pgEnum('return_state', ['awaiting_credit_note', 'credited', 'cancelled']);
export const returnConditionEnum = pgEnum('return_condition', ['sealed', 'opened', 'damaged']);
export const returnDispositionEnum = pgEnum('return_disposition', ['restock', 'scrap']);
export const replacementChargeEnum = pgEnum('replacement_charge', ['chargeable', 'free']);

export const salesReturns = pgTable(
  'sales_returns',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** `RET-0001`, from `document_sequences` under kind SALES_RETURN. */
    number: text('number').notNull(),
    state: returnStateEnum('state').notNull().default('awaiting_credit_note'),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }),
    customerName: text('customer_name').notNull(),
    /** REQ-AK-01: the invoice or sales order it relates to, and the dispatch when one is known. */
    sourceDocumentId: uuid('source_document_id').references(() => salesDocuments.id, { onDelete: 'set null' }),
    dispatchId: uuid('dispatch_id').references(() => dispatches.id, { onDelete: 'set null' }),
    receivedOn: date('received_on', { mode: 'string' }).notNull(),
    receivedBy: uuid('received_by').references(() => employees.id, { onDelete: 'restrict' }),
    notes: text('notes'),
    /** REQ-AK-09 / D-51: chargeable or free, decided per return. Null until somebody decides. */
    replacementCharge: replacementChargeEnum('replacement_charge'),
    cancelledReason: text('cancelled_reason'),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('sales_returns_org_number_uq').on(t.orgId, t.number),
    index('sales_returns_org_state_idx').on(t.orgId, t.state).where(ALIVE),
    index('sales_returns_org_party_idx').on(t.orgId, t.partyId).where(ALIVE),
    index('sales_returns_org_received_idx').on(t.orgId, t.receivedOn).where(ALIVE),
  ],
);

export const salesReturnLines = pgTable(
  'sales_return_lines',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    returnId: uuid('return_id')
      .notNull()
      .references(() => salesReturns.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    /** The invoice or order line it came off, when the return is against a Vyuha document. */
    sourceLineId: uuid('source_line_id').references(() => salesDocumentLines.id, { onDelete: 'set null' }),
    stockItemId: uuid('stock_item_id').references(() => stockItems.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    unit: text('unit'),
    quantity: numeric('quantity', { precision: 16, scale: 3 }).notNull(),
    /** REQ-AK-02: the words, not a code — the list is the organisation's to edit. */
    reason: text('reason').notNull(),
    reasonNote: text('reason_note'),
    condition: returnConditionEnum('condition').notNull(),
    disposition: returnDispositionEnum('disposition').notNull(),
    /** REQ-AK-08: how much of this line has gone back out on a replacement order. */
    replacedQty: numeric('replaced_qty', { precision: 16, scale: 3 }).notNull().default('0'),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('sales_return_lines_return_line_uq').on(t.returnId, t.lineNo),
    index('sales_return_lines_org_item_idx').on(t.orgId, t.stockItemId).where(ALIVE),
    check('sales_return_lines_qty_positive', sql`quantity > 0`),
    check('sales_return_lines_replaced_le_returned', sql`replaced_qty >= 0 AND replaced_qty <= quantity`),
  ],
);

/** REQ-AK-04: through the files pipeline, exactly as a dispatch photograph goes. */
export const salesReturnAttachments = pgTable(
  'sales_return_attachments',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    returnId: uuid('return_id')
      .notNull()
      .references(() => salesReturns.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    ...standardColumns(),
  },
  (t) => [index('sales_return_attachments_return_idx').on(t.returnId)],
);

/**
 * REQ-AK-05/AK-06: the credit note is Tally's, and this is the link — by the
 * return number in its narration or by a person. Never guessed at by party
 * and date; the unlinkable ones are a screen, exactly as the Sales vouchers
 * with no order behind them are.
 */
export const salesReturnCreditNotes = pgTable(
  'sales_return_credit_notes',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    returnId: uuid('return_id')
      .notNull()
      .references(() => salesReturns.id, { onDelete: 'cascade' }),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vouchers.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    linkedBy: uuid('linked_by'),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sales_return_credit_notes_voucher_uq').on(t.voucherId), uniqueIndex('sales_return_credit_notes_return_uq').on(t.returnId)],
);
