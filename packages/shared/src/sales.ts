import { z } from 'zod';

import { pageQuerySchema } from './pagination.js';

/**
 * Sales documents (08 Area W). Phase 8a opens with the estimate (REQ-W-01):
 * Vyuha-owned, never pushed to Tally (D-04). Later document types share the
 * table and this contract; the type discriminator is what Tally itself does
 * with vouchers (09 §4.3), and one line editor serves them all.
 *
 * Money is exact decimal text end to end. Line arithmetic — quantity × rate,
 * less a discount, plus tax shown for information — is done once, in SQL, on
 * save; the client shows what the server computed and never re-derives it.
 */

export const SALES_DOCUMENT_TYPES = ['ESTIMATE', 'SALES_ORDER', 'INVOICE'] as const;
export type SalesDocumentType = (typeof SALES_DOCUMENT_TYPES)[number];

export const SALES_DOCUMENT_TYPE_LABELS: Record<SalesDocumentType, string> = { ESTIMATE: 'Estimate', SALES_ORDER: 'Sales order', INVOICE: 'Invoice' };
export const SALES_DOCUMENT_TYPE_PREFIX: Record<SalesDocumentType, string> = { ESTIMATE: 'EST', SALES_ORDER: 'SO', INVOICE: 'INV' };
/** The Tally voucher type a pushed document becomes (09 §3.1). Estimates have none: they are never pushed (D-04). */
export const SALES_DOCUMENT_VOUCHER_TYPE: Record<SalesDocumentType, string | null> = { ESTIMATE: null, SALES_ORDER: 'Sales Order', INVOICE: 'Sales' };

/**
 * A document's life. Estimates: draft → sent → accepted / rejected / expired.
 * Sales orders: draft → confirmed (queued for Tally) → the sync state says
 * the rest; cancelled from draft. `ESTIMATE_STATUSES` keeps its old name for
 * the callers that only ever meant estimates.
 */
export const ESTIMATE_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];
export const ESTIMATE_STATUS_LABELS: Record<EstimateStatus, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
};

/** REQ-W-08: an order whose discount crosses the threshold waits in the approvals inbox as PENDING_APPROVAL. */
export const SALES_ORDER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'CANCELLED'] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];
export const SALES_ORDER_STATUS_LABELS: Record<SalesOrderStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Awaiting approval',
  CONFIRMED: 'Confirmed',
  CANCELLED: 'Cancelled',
};

/** REQ-W-08: the discount percentage above which an order waits for `sales.discount.approve`; null means never. */
export const salesSettingsSchema = z.object({
  discountApprovalPct: z.number().min(0).max(100).nullable(),
});
export type SalesSettings = z.infer<typeof salesSettingsSchema>;
export const DEFAULT_SALES_SETTINGS: SalesSettings = { discountApprovalPct: null };

/** Labels across both lives, for a caller holding a row of either type. */
export const SALES_DOCUMENT_STATUS_LABELS: Record<EstimateStatus | SalesOrderStatus, string> = {
  ...ESTIMATE_STATUS_LABELS,
  ...SALES_ORDER_STATUS_LABELS,
};

/** True when a status belongs to an estimate's life. */
export function isEstimateStatus(status: string): status is EstimateStatus {
  return (ESTIMATE_STATUSES as readonly string[]).includes(status);
}

/**
 * REQ-W-06: every pushed document carries a visible sync state, and it is
 * never inferred — only what the agent reported. `NOT_PUSHED` is a draft;
 * `QUEUED` is a job waiting for the agent; `PUSHED` and `FAILED` are the
 * agent's word, with the GUID or Tally's verbatim error beside it.
 */
export const SYNC_STATES = ['NOT_PUSHED', 'QUEUED', 'PUSHED', 'FAILED'] as const;
export type DocumentSyncState = (typeof SYNC_STATES)[number];
export const SYNC_STATE_LABELS: Record<DocumentSyncState, string> = {
  NOT_PUSHED: 'Not in Tally',
  QUEUED: 'Queued for Tally',
  PUSHED: 'In Tally',
  FAILED: 'Rejected by Tally',
};

/**
 * Which moves are allowed. Draft may go anywhere it makes sense; a sent
 * estimate is decided or expires; a decided one is final. Editing lines is a
 * draft's privilege — anything later is a new estimate.
 */
export const ESTIMATE_TRANSITIONS: Record<EstimateStatus, readonly EstimateStatus[]> = {
  DRAFT: ['SENT', 'ACCEPTED', 'REJECTED'],
  SENT: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'DRAFT'],
  ACCEPTED: [],
  REJECTED: ['DRAFT'],
  EXPIRED: ['DRAFT'],
};

const moneyText = z.string().trim().regex(/^\d{1,14}(\.\d{1,2})?$/u, 'a number with up to two decimals');
const quantityText = z.string().trim().regex(/^\d{1,12}(\.\d{1,3})?$/u, 'a quantity with up to three decimals');
const percentText = z.string().trim().regex(/^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/u, 'a percentage from 0 to 100');

export const salesLineInputSchema = z
  .object({
    /** A stock item from the projection, or null for a free-text line. */
    stockItemId: z.uuid().nullish(),
    /** Defaults to the item's name when an item is given; required otherwise. */
    description: z.string().trim().max(200).default(''),
    quantity: quantityText,
    unit: z.string().trim().max(20).nullish(),
    /** 15 REQ-AN-13: omitted, the server writes the rate the price lists resolve; given, it is the salesperson's own. */
    rate: moneyText.optional(),
    /** REQ-AN-16: required when the rate is below what resolved. */
    rateOverrideReason: z.string().trim().min(3).max(500).nullish(),
    discountPct: percentText.default('0'),
    /**
     * Shown for information (REQ-W-01). Omitted, the item's GST rate fills it
     * in; given, it stands -- including when it is given as zero.
     *
     * No default, deliberately. It used to default to '0', which made zero
     * indistinguishable from "not supplied", and `resolveDocumentLines` read
     * that as permission to overwrite it with the item's rate. A line
     * deliberately zero-rated -- an exempt supply, a zero-rated export, a
     * sample -- silently became an 18% line.
     */
    taxPct: percentText.optional(),
    /** GST's HSN (goods) or SAC (services) code, printed per line and summarised per code. */
    hsnCode: z.string().trim().max(12).nullish(),
  })
  .refine((line) => line.stockItemId != null || line.description !== '', {
    message: 'a description is required for a line without a stock item',
    path: ['description'],
  });
export type SalesLineInput = z.infer<typeof salesLineInputSchema>;

export interface SalesLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly stockItemId: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string | null;
  readonly rate: string;
  readonly discountPct: string;
  readonly taxPct: string;
  /** quantity × rate × (1 − discount), exact. */
  readonly amount: string;
  /** amount × tax, exact. */
  readonly taxAmount: string;
  readonly hsnCode: string | null;
  /** 15 REQ-AN-15: what resolved when the line was written -- values, not a pointer that can move. */
  readonly priceListId: string | null;
  readonly priceListVersion: number | null;
  readonly resolvedRate: string | null;
  readonly appliedDiscountPct: string | null;
  readonly rateOverrideReason: string | null;
  /**
   * 15 REQ-AK-09 / D-51: a replacement line the company decided to give
   * away. It has no invoice to wait for, and no floor to sit above. Set only
   * by the return that raised the order — there is no field for it on the
   * line editor, because a salesperson marking a line free of charge would
   * be a way around both rules.
   */
  readonly freeOfCharge: boolean;
  /** REQ-AA-01/AA-29: the state, as numbers. Zero on an estimate. */
  readonly pickedQty: string;
  readonly packedQty: string;
  readonly invoicedQty: string;
  readonly dispatchedQty: string;
  /** P8-2: on Vyuha-raised invoices confirmed but not yet accepted by Tally — spoken for, not yet invoiced. Zero except on an order. */
  readonly invoicingQty: string;
}

/**
 * REQ-AA-02/AA-03 (+ D-34): derived from the line quantities, never stored.
 * The word summarises; the numbers beside it are what count.
 */
export const FULFILMENT_STATES = ['open', 'picking', 'awaiting_invoice', 'ready_to_dispatch', 'partially_dispatched', 'closed', 'short_closed'] as const;
export type FulfilmentState = (typeof FULFILMENT_STATES)[number];
export const FULFILMENT_STATE_LABELS: Record<FulfilmentState, string> = {
  open: 'Open',
  picking: 'Picking',
  awaiting_invoice: 'Awaiting invoice',
  ready_to_dispatch: 'Ready to dispatch',
  partially_dispatched: 'Partially dispatched',
  closed: 'Closed',
  short_closed: 'Short-closed',
};

/** Every status a document row may carry; which apply is decided by `docType`. */
export type SalesDocumentStatus = EstimateStatus | SalesOrderStatus;

export interface EstimateView {
  readonly id: string;
  readonly docType: SalesDocumentType;
  readonly number: string;
  readonly status: SalesDocumentStatus;
  readonly date: string;
  readonly validUntil: string | null;
  /** The Tally party, when the customer is one. */
  readonly partyId: string | null;
  /** The CRM company, when the customer is a prospect (REQ-U-03: never a ledger until they buy). */
  readonly companyId: string | null;
  readonly dealId: string | null;
  /** Whom it is addressed to, as printed. */
  readonly customerName: string;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly notes: string | null;
  readonly terms: string | null;
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
  /** The estimate a sales order was converted from (REQ-W-03), when it was. */
  readonly sourceDocumentId: string | null;
  /** REQ-W-06. Always `NOT_PUSHED` on an estimate. */
  readonly syncState: DocumentSyncState;
  readonly remoteGuid: string | null;
  readonly remoteVoucherNumber: string | null;
  readonly lastPushedAt: string | null;
  /** Tally's verbatim words when the push was rejected (REQ-T-01). */
  readonly lastError: string | null;
  /** Orders only (null on an estimate): the derived fulfilment word. */
  readonly fulfilment: FulfilmentState | null;
  readonly shortClosedAt: string | null;
  readonly shortCloseReason: string | null;
  /** REQ-AA-28: where the customer is told, overridable per order. */
  readonly customerEmail: string | null;
  readonly customerWhatsapp: string | null;
  /** The GST header: place of supply, consignee, the Tally details grid. */
  readonly placeOfSupply: string | null;
  readonly shipTo: ShipTo | null;
  readonly details: DocumentDetails | null;
  readonly lines: readonly SalesLineView[];
  /** Orders only: the invoices Tally raised against it (REQ-AA-12). */
  readonly invoices: readonly OrderInvoiceView[];
  /** Orders only (13 REQ-X-26): why it waits and what it waits on — each open requirement with the POs raised against it. Empty when nothing waits. */
  readonly waitingOn: readonly OrderWaitingOnView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrderWaitingOnView {
  readonly requirementId: string;
  readonly lineId: string | null;
  readonly stockItemName: string;
  readonly quantity: string;
  readonly orderedQty: string;
  readonly receivedQty: string;
  readonly state: 'open' | 'ordered' | 'received' | 'closed';
  readonly neededBy: string | null;
  readonly purchaseOrders: readonly { id: string; number: string; vendorName: string; status: string; expectedDate: string | null; quantity: string }[];
}

export interface OrderInvoiceView {
  /** The Tally voucher, when it has arrived; null for a Vyuha-raised invoice not yet pulled back. */
  readonly voucherId: string | null;
  /** The Vyuha invoice document, when it was raised here (D-38). */
  readonly invoiceDocumentId: string | null;
  readonly voucherNumber: string;
  readonly date: string;
  readonly amount: string;
  readonly method: 'narration' | 'manual' | 'vyuha';
  readonly linkedAt: string;
}

/** The list row: the header without its lines. */
export type EstimateSummary = Omit<EstimateView, 'lines' | 'invoices' | 'waitingOn'>;

/** A sales order is the same shape; the type says which life it leads. */
export type SalesDocumentView = EstimateView;
export type SalesDocumentSummary = EstimateSummary;

export const estimateListQuerySchema = pageQuerySchema.extend({
  /** Free text over number and customer name. */
  q: z.string().trim().min(1).max(80).optional(),
  status: z.enum(ESTIMATE_STATUSES).optional(),
  syncState: z.enum(SYNC_STATES).optional(),
  partyId: z.uuid().optional(),
  companyId: z.uuid().optional(),
  dealId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  sort: z.string().max(200).optional(),
});
export type EstimateListQuery = z.infer<typeof estimateListQuerySchema>;

export const ESTIMATE_SORT_FIELDS = ['number', 'date', 'grandTotal', 'customerName', 'updatedAt'] as const;
export const DEFAULT_ESTIMATE_SORT = '-date';

/**
 * The header a GST tax invoice carries beyond the party (the Tally layout
 * everyone knows): where the goods ship, and the small boxes — delivery
 * note, terms of payment, references, the buyer's order, dispatch. All
 * optional; each prints only when filled. e-Invoice's IRN and acknowledgement
 * live here too, typed until the IRP integration writes them.
 */
export const documentDetailsSchema = z.object({
  deliveryNote: z.string().trim().max(120).optional(),
  paymentTerms: z.string().trim().max(120).optional(),
  referenceNo: z.string().trim().max(120).optional(),
  otherReferences: z.string().trim().max(200).optional(),
  buyersOrderNo: z.string().trim().max(120).optional(),
  buyersOrderDate: z.string().trim().max(20).optional(),
  dispatchDocNo: z.string().trim().max(120).optional(),
  deliveryNoteDate: z.string().trim().max(20).optional(),
  dispatchedThrough: z.string().trim().max(120).optional(),
  destination: z.string().trim().max(120).optional(),
  termsOfDelivery: z.string().trim().max(200).optional(),
  irn: z.string().trim().max(80).optional(),
  ackNo: z.string().trim().max(40).optional(),
  ackDate: z.string().trim().max(20).optional(),
});
export type DocumentDetails = z.infer<typeof documentDetailsSchema>;

/** Consignee (Ship to), when it differs from the buyer. */
export const shipToSchema = z.object({
  name: z.string().trim().max(200).optional(),
  address: z.string().trim().max(600).optional(),
  gstin: z.string().trim().max(20).optional(),
  stateName: z.string().trim().max(60).optional(),
  stateCode: z.string().trim().max(2).optional(),
});
export type ShipTo = z.infer<typeof shipToSchema>;

/** The GST header fields every sales document may carry. */
const gstHeaderShape = {
  /** The buyer's state code (two digits); decides CGST+SGST against IGST when the seller's is known. */
  placeOfSupply: z.string().trim().max(2).nullish(),
  shipTo: shipToSchema.nullish(),
  details: documentDetailsSchema.nullish(),
};

const customerSchema = z
  .object({
    partyId: z.uuid().nullish(),
    companyId: z.uuid().nullish(),
    /** Required when neither id is given; otherwise defaults to the record's name. */
    customerName: z.string().trim().min(1).max(200).nullish(),
  })
  .refine((c) => c.partyId != null || c.companyId != null || (c.customerName != null && c.customerName !== ''), {
    message: 'a party, a company, or a customer name is required',
    path: ['customerName'],
  });

export const createEstimateSchema = customerSchema.safeExtend({
  date: z.iso.date().optional(),
  validUntil: z.iso.date().nullish(),
  dealId: z.uuid().nullish(),
  ownerId: z.uuid().nullish(),
  notes: z.string().trim().max(4000).nullish(),
  terms: z.string().trim().max(4000).nullish(),
  ...gstHeaderShape,
  lines: z.array(salesLineInputSchema).max(200).default([]),
});
export type CreateEstimateInput = z.infer<typeof createEstimateSchema>;

/** Header and lines together; lines, when given, replace the set (a draft's privilege). */
export const updateEstimateSchema = z.object({
  partyId: z.uuid().nullish(),
  companyId: z.uuid().nullish(),
  customerName: z.string().trim().min(1).max(200).optional(),
  date: z.iso.date().optional(),
  validUntil: z.iso.date().nullish(),
  dealId: z.uuid().nullish(),
  ownerId: z.uuid().nullish(),
  notes: z.string().trim().max(4000).nullish(),
  terms: z.string().trim().max(4000).nullish(),
  ...gstHeaderShape,
  lines: z.array(salesLineInputSchema).max(200).optional(),
});
export type UpdateEstimateInput = z.infer<typeof updateEstimateSchema>;

export const estimateStatusSchema = z.object({ status: z.enum(ESTIMATE_STATUSES) });
export type EstimateStatusInput = z.infer<typeof estimateStatusSchema>;

/**
 * REQ-W-02: what this party was quoted and invoiced for this item before —
 * from the backfilled vouchers and from earlier estimates. The reason the
 * backfill is worth its cost, opened from the line editor.
 */
export const itemHistoryQuerySchema = z.object({
  stockItemId: z.uuid(),
  partyId: z.uuid().optional(),
  companyId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
export type ItemHistoryQuery = z.infer<typeof itemHistoryQuerySchema>;

export interface ItemHistoryEntry {
  readonly source: 'voucher' | 'estimate';
  readonly date: string;
  /** "Sales INV-0042" or "Estimate EST-0007". */
  readonly reference: string;
  readonly quantity: string | null;
  readonly rate: string | null;
  readonly discountPct: string | null;
  readonly amount: string | null;
  readonly status: string | null;
}

export interface ItemHistoryView {
  readonly stockItemName: string;
  readonly currentSalePrice: string | null;
  /** REQ-AC-08: the other fact a salesperson needs at the same instant. */
  readonly availability: StockAvailability | null;
  readonly entries: readonly ItemHistoryEntry[];
  /** REQ-Y-07 in miniature: how fresh the voucher side is. */
  readonly vouchersAsOf: string | null;
}


// ------------------------------------------------------------ sales orders

export const salesOrderListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().min(1).max(80).optional(),
  status: z.enum(SALES_ORDER_STATUSES).optional(),
  syncState: z.enum(SYNC_STATES).optional(),
  partyId: z.uuid().optional(),
  companyId: z.uuid().optional(),
  dealId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  sort: z.string().max(200).optional(),
});
export type SalesOrderListQuery = z.infer<typeof salesOrderListQuerySchema>;

/**
 * REQ-W-03: created fresh, or converted from an accepted estimate carrying
 * its lines. A sales order pushes to Tally, so its customer must be a Tally
 * party — Tally has no ledger for a prospect (REQ-U-03), and an order for
 * one cannot land anywhere.
 */
export const createSalesOrderSchema = z.object({
  partyId: z.uuid(),
  date: z.iso.date().optional(),
  dealId: z.uuid().nullish(),
  ownerId: z.uuid().nullish(),
  notes: z.string().trim().max(4000).nullish(),
  terms: z.string().trim().max(4000).nullish(),
  /** REQ-AA-28: the party master's contact by default; these override it for this order. */
  customerEmail: z.email().max(254).nullish(),
  customerWhatsapp: z.string().trim().min(6).max(24).nullish(),
  ...gstHeaderShape,
  lines: z.array(salesLineInputSchema).min(1).max(200),
});
export type CreateSalesOrderInput = z.infer<typeof createSalesOrderSchema>;

export const updateSalesOrderSchema = z.object({
  partyId: z.uuid().optional(),
  date: z.iso.date().optional(),
  dealId: z.uuid().nullish(),
  ownerId: z.uuid().nullish(),
  notes: z.string().trim().max(4000).nullish(),
  terms: z.string().trim().max(4000).nullish(),
  customerEmail: z.email().max(254).nullish(),
  customerWhatsapp: z.string().trim().min(6).max(24).nullish(),
  ...gstHeaderShape,
  lines: z.array(salesLineInputSchema).min(1).max(200).optional(),
});
export type UpdateSalesOrderInput = z.infer<typeof updateSalesOrderSchema>;

/** REQ-W-09: confirming past a credit block needs the override key and a reason; empty otherwise. */
export const confirmSalesOrderSchema = z.preprocess(
  // Confirm has always been a bare POST; a missing body is the common case, not a malformed one.
  (value) => (value === undefined || value === null || value === '' ? {} : value),
  z.object({
    creditOverrideReason: z.string().trim().min(3).max(1000).optional(),
  }),
);
export type ConfirmSalesOrderInput = z.infer<typeof confirmSalesOrderSchema>;

/** What the block says (REQ-W-09, REQ-Y-03): the party's limit, exposure and headroom, so the person can act. */
export interface CreditPosition {
  readonly partyId: string;
  readonly partyName: string;
  readonly creditLimit: string | null;
  readonly creditDays: number | null;
  /** Debits less credits across the party's classified vouchers, as the credit cycle report counts them. */
  readonly exposure: string;
  /** Confirmed, undispatched Vyuha orders not yet in Tally as invoices — committed money, the way stock is committed. */
  readonly openOrders: string;
  readonly headroom: string | null;
  /** 15 REQ-AJ-10 / D-54: promises this party did not keep. A flag beside the limit, never a second way to be blocked. */
  readonly brokenPromises: number;
  readonly brokenPromiseAmount: string;
}

export const convertEstimateSchema = z.object({
  /** The Tally party the order is for; required when the estimate was addressed to a prospect. */
  partyId: z.uuid().optional(),
});
export type ConvertEstimateInput = z.infer<typeof convertEstimateSchema>;

/**
 * What the agent renders into Tally XML (09 §3.3: "agent … generates Tally
 * XML"). The API never writes XML; it hands the agent the document as data
 * and the agent owns the wire format on the push path as it does on the
 * pull path. `idempotencyKey` travels in the voucher's narration, and is
 * what the agent queries Tally for before any retry.
 */
/**
 * Everything that pushes (D-37). One outcome handler per kind; every pushed
 * record carries the same sync-state columns and the same Alter semantics.
 */
export const PUSH_KINDS = ['SALES_ORDER', 'DELIVERY_NOTE', 'PURCHASE_ORDER', 'RECEIPT_NOTE', 'SALES_INVOICE'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
export const PUSH_KIND_VOUCHER_TYPE: Record<PushKind, string> = {
  SALES_ORDER: 'Sales Order',
  DELIVERY_NOTE: 'Delivery Note',
  PURCHASE_ORDER: 'Purchase Order',
  RECEIPT_NOTE: 'Receipt Note',
  /** D-38: a Vyuha-raised invoice is a Sales voucher in Tally. */
  SALES_INVOICE: 'Sales',
};

export const voucherPushPayloadSchema = z.object({
  documentId: z.uuid(),
  kind: z.enum(PUSH_KINDS),
  voucherType: z.string().min(1).max(60),
  /** Vyuha's document number, carried as the voucher's reference. */
  reference: z.string().min(1).max(60),
  date: z.iso.date(),
  partyName: z.string().min(1).max(200),
  narration: z.string().max(4000),
  idempotencyKey: z.string().min(1).max(120),
  /** Set on an alter (REQ-W-07): the agent alters this voucher and never creates a second. */
  remoteGuid: z.string().min(1).max(80).nullable(),
  lines: z.array(
    z.object({
      stockItemName: z.string().min(1).max(200),
      quantity: z.string().min(1).max(40),
      unit: z.string().max(20).nullable(),
      rate: z.string().min(1).max(40),
      discountPct: z.string().max(10),
      amount: z.string().min(1).max(40),
    }),
  ).min(1),
});
export type VoucherPushPayload = z.infer<typeof voucherPushPayloadSchema>;


// ------------------------------------------------------- pick, pack, invoice

const qtyText = z.string().trim().regex(/^\d{1,12}(\.\d{1,3})?$/u, 'a quantity with up to three decimals');

/** REQ-AA-06/AA-07/AA-08/AA-09: one packing session. Lines not named are untouched. */
/** D-48: a picking session — who took how much off the shelf. */
export const createPickRecordSchema = z.object({
  comment: z.string().trim().max(2000).nullish(),
  lines: z.array(z.object({ lineId: z.uuid(), quantity: qtyText, comment: z.string().trim().max(1000).nullish() })).min(1).max(200),
});
export type CreatePickRecordInput = z.infer<typeof createPickRecordSchema>;

export interface PickRecordView {
  readonly id: string;
  readonly documentId: string;
  readonly pickedById: string | null;
  readonly pickedByName: string | null;
  readonly pickedAt: string;
  readonly comment: string | null;
  readonly lines: readonly { lineId: string; description: string; quantity: string; comment: string | null }[];
}

export const createPackRecordSchema = z.object({
  boxCount: z.number().int().min(1).max(999).default(1),
  comment: z.string().trim().max(2000).nullish(),
  lines: z.array(z.object({ lineId: z.uuid(), quantity: qtyText, comment: z.string().trim().max(1000).nullish() })).min(1).max(200),
});
export type CreatePackRecordInput = z.infer<typeof createPackRecordSchema>;

export interface PackRecordView {
  readonly id: string;
  readonly documentId: string;
  /** D-47: a pack is read across orders on the Packed screen, so it names its order and customer. */
  readonly orderNumber: string;
  readonly customerName: string;
  /** The slip number the paper prints and the scan reads: order number / last four of the pack id. */
  readonly slipNumber: string;
  readonly boxCount: number;
  readonly packedById: string | null;
  readonly packedByName: string | null;
  readonly packedAt: string;
  readonly comment: string | null;
  readonly lines: readonly { lineId: string; description: string; quantity: string; comment: string | null }[];
}

/** D-47: the Packed screen's query — every pack record, newest first, optionally narrowed by order number or customer. */
export const packListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().min(1).max(80).optional(),
});
export type PackListQuery = z.infer<typeof packListQuerySchema>;

/** REQ-AA-06: an open order with something left to pack, as the picker sees it. */
export interface PickQueueEntry {
  readonly documentId: string;
  readonly number: string;
  readonly customerName: string;
  readonly date: string;
  readonly fulfilment: FulfilmentState;
  readonly balanceLines: number;
  readonly balanceQty: string;
  /** REQ-X-26: what it waits on, when a shortage requirement is open. */
  readonly waitingOnRequirements: number;
}

/** REQ-AA-11/AA-15: packed, uninvoiced, and for how long. */
export interface AwaitingInvoiceEntry {
  readonly documentId: string;
  readonly number: string;
  readonly customerName: string;
  readonly packedUninvoicedQty: string;
  readonly waitingSince: string;
  readonly waitingHours: number;
}

/** REQ-AA-13: a Sales voucher with a party and no order behind it. */
export interface UnlinkedInvoice {
  readonly voucherId: string;
  readonly voucherNumber: string;
  readonly date: string;
  readonly partyId: string | null;
  readonly partyName: string;
  readonly amount: string;
  readonly narration: string | null;
  /** Open orders for the same party, for the manual link. */
  readonly candidateOrders: readonly { documentId: string; number: string; date: string; grandTotal: string }[];
}

export const linkInvoiceSchema = z.object({ voucherId: z.uuid() });
export type LinkInvoiceInput = z.infer<typeof linkInvoiceSchema>;

export const shortCloseSchema = z.object({ reason: z.string().trim().min(3).max(1000) });
export type ShortCloseInput = z.infer<typeof shortCloseSchema>;

/** REQ-AC-04: available = Tally closing − committed, with the pull it rests on (REQ-AC-05). */
export interface StockAvailability {
  readonly stockItemId: string;
  readonly closingQty: string | null;
  readonly committedQty: string;
  readonly availableQty: string | null;
  readonly openPoQty: string;
  readonly reorderLevel: string | null;
  readonly minimumOrderQty: string | null;
  readonly asOf: string | null;
}


// ------------------------------------------------------------------ dispatch

/** D-47 (owner, 22 Aug 2026): `customer_collects` is the counter pickup — goods ready, the customer told, the door step when they collect. */
export const DISPATCH_MODES = ['local_auto', 'local_own_vehicle', 'outstation', 'customer_collects'] as const;
export type DispatchMode = (typeof DISPATCH_MODES)[number];
export const DISPATCH_MODE_LABELS: Record<DispatchMode, string> = {
  local_auto: 'Local — auto',
  local_own_vehicle: 'Local — own vehicle',
  outstation: 'Outstation',
  customer_collects: 'Customer collects',
};

/**
 * REQ-AA-16…AA-19: a dispatch is its own record with its own lines. Mode
 * decides which fields are required — the refinements below name each
 * missing one (12 §7). Photographs travel as multipart parts beside this
 * JSON and are checked in the service (REQ-AA-20).
 */
export const createDispatchSchema = z
  .object({
    mode: z.enum(DISPATCH_MODES),
    lines: z.array(z.object({ lineId: z.uuid(), quantity: z.string().trim().regex(/^\d{1,12}(\.\d{1,3})?$/u, 'a quantity') })).min(1).max(200),
    lrNumber: z.string().trim().max(60).nullish(),
    transporterName: z.string().trim().max(120).nullish(),
    transporterContact: z.string().trim().max(60).nullish(),
    vehicleNumber: z.string().trim().max(30).nullish(),
    driverName: z.string().trim().max(120).nullish(),
    expectedDeliveryDate: z.iso.date().nullish(),
    notes: z.string().trim().max(2000).nullish(),
    /** REQ-AA-28: overrides for this dispatch's notification. */
    customerEmail: z.email().max(254).nullish(),
    customerWhatsapp: z.string().trim().min(6).max(24).nullish(),
  })
  .superRefine((d, ctx) => {
    const need = (field: keyof typeof d, label: string) => {
      const value = d[field];
      if (value === undefined || value === null || value === '') ctx.addIssue({ code: 'custom', path: [field], message: `${label} is required for ${DISPATCH_MODE_LABELS[d.mode]}` });
    };
    if (d.mode === 'local_own_vehicle') {
      need('vehicleNumber', 'Vehicle number');
      need('driverName', 'Driver name');
    }
    if (d.mode === 'outstation') {
      need('lrNumber', 'LR number');
      need('transporterName', 'Transporter name');
      need('transporterContact', 'Transporter contact');
    }
  });
export type CreateDispatchInput = z.infer<typeof createDispatchSchema>;

export interface DispatchLineView {
  readonly lineId: string;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string | null;
}

export interface DispatchAttachmentView {
  readonly fileId: string;
  /** D-47: 'delivery' is the photograph at the door. */
  readonly kind: 'box' | 'lr' | 'delivery';
}

/** D-47: the door step — who took the goods, with an optional note; the photograph rides as a multipart part. */
export const deliverDispatchSchema = z.object({
  receivedBy: z.string().trim().min(1, 'Who received it?').max(120),
  note: z.string().trim().max(1000).nullish(),
});
export type DeliverDispatchInput = z.infer<typeof deliverDispatchSchema>;

export const DISPATCH_STATUSES = ['shipped', 'delivered'] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];
export const DISPATCH_STATUS_LABELS: Record<DispatchStatus, string> = { shipped: 'On its way', delivered: 'Delivered' };

export interface DispatchNotificationView {
  readonly id: string;
  readonly channel: 'email' | 'whatsapp';
  /** D-47: the moment the message is about. Absent on a purchase order's notices, which have one moment only. */
  readonly event?: 'dispatched' | 'delivered';
  readonly recipient: string | null;
  /** `pending` until somebody sends it by hand (`manual`, REQ-AA-26); `sent`; `failed`. */
  readonly status: 'pending' | 'sent' | 'failed';
  readonly composedText: string;
  readonly sentAt: string | null;
  readonly error: string | null;
}

export interface DispatchView {
  readonly id: string;
  readonly number: string;
  readonly documentId: string;
  readonly orderNumber: string;
  readonly customerName: string;
  readonly mode: DispatchMode;
  readonly dispatchedById: string | null;
  readonly dispatchedByName: string | null;
  readonly dispatchedAt: string;
  readonly lrNumber: string | null;
  readonly transporterName: string | null;
  readonly transporterContact: string | null;
  readonly vehicleNumber: string | null;
  readonly driverName: string | null;
  readonly expectedDeliveryDate: string | null;
  readonly notes: string | null;
  /** D-47: shipped until the door step marks it delivered. */
  readonly status: DispatchStatus;
  readonly deliveredAt: string | null;
  readonly deliveredByName: string | null;
  readonly receivedBy: string | null;
  readonly deliveryNote: string | null;
  readonly syncState: DocumentSyncState;
  readonly remoteGuid: string | null;
  readonly remoteVoucherNumber: string | null;
  readonly lastError: string | null;
  readonly lines: readonly DispatchLineView[];
  readonly attachments: readonly DispatchAttachmentView[];
  readonly notifications: readonly DispatchNotificationView[];
}

export const dispatchListQuerySchema = pageQuerySchema.extend({
  documentId: z.uuid().optional(),
  mode: z.enum(DISPATCH_MODES).optional(),
  syncState: z.enum(SYNC_STATES).optional(),
  q: z.string().trim().min(1).max(80).optional(),
});
export type DispatchListQuery = z.infer<typeof dispatchListQuerySchema>;

export const markNotificationSentSchema = z.object({ status: z.enum(['sent', 'failed']), error: z.string().trim().max(1000).nullish() });
export type MarkNotificationSentInput = z.infer<typeof markNotificationSentSchema>;


// ------------------------------------------------------------- invoices (D-38)

/**
 * A Vyuha-raised invoice against a sales order: the packed-and-uninvoiced
 * balance of the named lines (all of them when none is named), at the
 * order's rates. Confirming pushes it as a Sales voucher and advances the
 * order's invoiced quantities; the pulled-back voucher then attaches to
 * the same link rather than counting twice.
 */
export const createInvoiceSchema = z.object({
  date: z.iso.date().optional(),
  lines: z.array(z.object({ lineId: z.uuid(), quantity: z.string().trim().regex(/^\d{1,12}(\.\d{1,3})?$/u, 'a quantity') })).max(200).optional(),
  notes: z.string().trim().max(4000).nullish(),
  ...gstHeaderShape,
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const invoiceListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().min(1).max(80).optional(),
  status: z.enum(SALES_ORDER_STATUSES).optional(),
  syncState: z.enum(SYNC_STATES).optional(),
  partyId: z.uuid().optional(),
  sourceDocumentId: z.uuid().optional(),
  sort: z.string().max(200).optional(),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;
