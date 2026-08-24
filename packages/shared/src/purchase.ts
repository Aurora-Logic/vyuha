import { z } from 'zod';

import { pageQuerySchema } from './pagination.js';
import { SYNC_STATES, documentDetailsSchema, salesLineInputSchema, shipToSchema, type DispatchNotificationView, type DocumentDetails, type DocumentSyncState, type ShipTo } from './sales.js';

/**
 * Procurement (13). Requirements are the record a purchase order is built
 * from; a PO is header and lines with received/rejected as the state; a GRN
 * receives against it and pushes as a Receipt Note.
 */

export const REQUIREMENT_SOURCES = ['shortage', 'reorder', 'manual'] as const;
export const REQUIREMENT_STATES = ['open', 'ordered', 'received', 'closed'] as const;
export type RequirementState = (typeof REQUIREMENT_STATES)[number];

export interface RequirementView {
  readonly id: string;
  readonly stockItemId: string;
  readonly stockItemName: string;
  readonly quantity: string;
  readonly orderedQty: string;
  readonly receivedQty: string;
  readonly source: (typeof REQUIREMENT_SOURCES)[number];
  readonly salesOrderId: string | null;
  readonly salesOrderLineId: string | null;
  readonly salesOrderNumber: string | null;
  readonly customerName: string | null;
  readonly neededBy: string | null;
  readonly state: RequirementState;
  readonly closedReason: string | null;
  readonly createdAt: string;
}

export const requirementListQuerySchema = z.object({
  state: z.enum(REQUIREMENT_STATES).optional(),
  stockItemId: z.uuid().optional(),
  salesOrderId: z.uuid().optional(),
});
export type RequirementListQuery = z.infer<typeof requirementListQuerySchema>;

const qtyText = z.string().trim().regex(/^\d{1,12}(\.\d{1,3})?$/u, 'a quantity with up to three decimals');

export const createRequirementSchema = z.object({
  stockItemId: z.uuid(),
  quantity: qtyText,
  neededBy: z.iso.date().nullish(),
});
export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;

export const closeRequirementSchema = z.object({ reason: z.string().trim().min(3).max(1000) });

export const PURCHASE_ORDER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'CANCELLED'] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];
export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Awaiting approval',
  CONFIRMED: 'Confirmed',
  CANCELLED: 'Cancelled',
};

/** REQ-X-20: derived from the lines, never stored. */
export const PO_FULFILMENT_STATES = ['open', 'partially_received', 'received', 'short_closed'] as const;
export type PoFulfilmentState = (typeof PO_FULFILMENT_STATES)[number];
export const PO_FULFILMENT_LABELS: Record<PoFulfilmentState, string> = {
  open: 'Open',
  partially_received: 'Partially received',
  received: 'Received',
  short_closed: 'Short-closed',
};

export interface PurchaseOrderLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly stockItemId: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string | null;
  readonly rate: string;
  readonly discountPct: string;
  readonly taxPct: string;
  readonly hsnCode: string | null;
  readonly amount: string;
  readonly taxAmount: string;
  readonly receivedQty: string;
  readonly rejectedQty: string;
  /** REQ-X-10: which requirements this line took up, and how much of each. */
  readonly requirements: readonly { requirementId: string; quantity: string; salesOrderNumber: string | null; customerName: string | null }[];
}

export interface PurchaseOrderView {
  readonly id: string;
  readonly number: string;
  readonly status: PurchaseOrderStatus;
  readonly fulfilment: PoFulfilmentState;
  readonly date: string;
  readonly partyId: string;
  readonly vendorName: string;
  readonly salesOrderId: string | null;
  readonly expectedDate: string | null;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly notes: string | null;
  /** D-38: what the printed order carries beyond its lines. */
  readonly terms: string | null;
  readonly details: DocumentDetails | null;
  readonly shipTo: ShipTo | null;
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
  readonly approvalRequired: boolean;
  readonly syncState: DocumentSyncState;
  readonly remoteGuid: string | null;
  readonly remoteVoucherNumber: string | null;
  readonly lastError: string | null;
  readonly shortClosedAt: string | null;
  readonly shortCloseReason: string | null;
  /** REQ-X-18: where the vendor is told; a PO has no party contact in Tally, so the buyer fills these. */
  readonly vendorEmail: string | null;
  readonly vendorWhatsapp: string | null;
  readonly lines: readonly PurchaseOrderLineView[];
  /** REQ-X-18: the message to the vendor, one per channel, composed when the PO is released; `manual` until the API lands (REQ-AA-26). */
  readonly notifications: readonly DispatchNotificationView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PurchaseOrderSummary = Omit<PurchaseOrderView, 'lines' | 'notifications'>;

export const purchaseOrderListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().min(1).max(80).optional(),
  status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
  syncState: z.enum(SYNC_STATES).optional(),
  partyId: z.uuid().optional(),
  salesOrderId: z.uuid().optional(),
  sort: z.string().max(200).optional(),
});
export type PurchaseOrderListQuery = z.infer<typeof purchaseOrderListQuerySchema>;

/** A PO line: a sales line's shape (item, qty, rate, tax) plus which requirements it takes up. */
export const purchaseLineInputSchema = salesLineInputSchema.safeExtend({
  requirementIds: z.array(z.uuid()).max(50).default([]),
});
export type PurchaseLineInput = z.infer<typeof purchaseLineInputSchema>;

export const createPurchaseOrderSchema = z.object({
  partyId: z.uuid(),
  date: z.iso.date().optional(),
  salesOrderId: z.uuid().nullish(),
  expectedDate: z.iso.date().nullish(),
  ownerId: z.uuid().nullish(),
  notes: z.string().trim().max(4000).nullish(),
  vendorEmail: z.email().max(254).nullish(),
  vendorWhatsapp: z.string().trim().min(6).max(24).nullish(),
  terms: z.string().trim().max(4000).nullish(),
  details: documentDetailsSchema.nullish(),
  shipTo: shipToSchema.nullish(),
  lines: z.array(purchaseLineInputSchema).min(1).max(200),
});
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

export const updatePurchaseOrderSchema = createPurchaseOrderSchema.partial();
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>;

/** REQ-X-13: a PO drafted from selected requirements, one line per item, quantities summed. */
export const purchaseOrderFromRequirementsSchema = z.object({
  partyId: z.uuid(),
  requirementIds: z.array(z.uuid()).min(1).max(100),
  expectedDate: z.iso.date().nullish(),
});
export type PurchaseOrderFromRequirementsInput = z.infer<typeof purchaseOrderFromRequirementsSchema>;

export const createGrnSchema = z.object({
  vendorInvoiceRef: z.string().trim().max(80).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  lines: z
    .array(
      z.object({
        purchaseOrderLineId: z.uuid(),
        receivedQty: qtyText.default('0'),
        rejectedQty: qtyText.default('0'),
        rejectionReason: z.string().trim().max(500).nullish(),
      }),
    )
    .min(1)
    .max(200),
});
export type CreateGrnInput = z.infer<typeof createGrnSchema>;

export interface GrnView {
  readonly id: string;
  readonly number: string;
  readonly purchaseOrderId: string;
  readonly purchaseOrderNumber: string;
  readonly vendorName: string;
  readonly receivedById: string | null;
  readonly receivedByName: string | null;
  readonly receivedAt: string;
  readonly vendorInvoiceRef: string | null;
  readonly notes: string | null;
  readonly syncState: DocumentSyncState;
  readonly remoteGuid: string | null;
  readonly remoteVoucherNumber: string | null;
  readonly lastError: string | null;
  readonly lines: readonly { purchaseOrderLineId: string; description: string; receivedQty: string; rejectedQty: string; rejectionReason: string | null }[];
  /** REQ-X-27: what still needs a person's decision — receipts short of the requirements waiting on them. */
  readonly pendingAllocations: readonly {
    purchaseOrderLineId: string;
    stockItemName: string;
    unallocatedQty: string;
    waiting: readonly { requirementId: string; salesOrderNumber: string | null; customerName: string | null; outstandingQty: string }[];
  }[];
}

/** REQ-X-27 / D-30: who gets an insufficient receipt, decided and recorded. */
export const allocateReceiptSchema = z.object({
  allocations: z.array(z.object({ requirementId: z.uuid(), quantity: qtyText })).min(1).max(100),
});
export type AllocateReceiptInput = z.infer<typeof allocateReceiptSchema>;

export const shortClosePurchaseOrderSchema = z.object({ reason: z.string().trim().min(3).max(1000) });

/** D-27 / D-28 / D-33: the Vyuha-owned item facts. */
export const itemVendorSchema = z.object({ partyId: z.uuid(), isPreferred: z.boolean().default(false), leadTimeDays: z.number().int().min(0).max(365).nullish() });
export const putItemVendorsSchema = z.object({ vendors: z.array(itemVendorSchema).max(20) });
export type PutItemVendorsInput = z.infer<typeof putItemVendorsSchema>;
/**
 * A minimum order quantity of zero is not a minimum -- empty is how "no
 * minimum" is said. Stored as zero it reached the reorder sweep, where it is
 * the floor of a GREATEST: an item sitting exactly on its reorder level then
 * produced a requirement to buy nought, which the buyer sees as a job to do
 * and can do nothing with. The refinement sits before `.nullish()` so
 * clearing the box still means null, and compares numerically because '00'
 * and '0.000' both parse.
 */
export const putItemSettingsSchema = z.object({
  reorderLevel: qtyText.nullish(),
  minimumOrderQty: qtyText.refine((value) => Number(value) > 0, 'a minimum order quantity is more than zero; leave it empty for none').nullish(),
});
export type PutItemSettingsInput = z.infer<typeof putItemSettingsSchema>;

export interface ItemVendorView {
  readonly partyId: string;
  readonly partyName: string;
  readonly isPreferred: boolean;
  readonly leadTimeDays: number | null;
}

/** REQ-X-14: what this vendor charged for this item before. */
export const purchaseHistoryQuerySchema = z.object({ stockItemId: z.uuid(), partyId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(12) });
export type PurchaseHistoryQuery = z.infer<typeof purchaseHistoryQuerySchema>;
export interface PurchaseHistoryEntry {
  readonly source: 'voucher' | 'purchase_order';
  readonly date: string;
  readonly reference: string;
  readonly vendorName: string;
  readonly quantity: string | null;
  readonly rate: string | null;
  readonly amount: string | null;
}

/** REQ-X-16 / REQ-AA-15: the purchase and billing thresholds, org-wide. */
export const purchaseSettingsSchema = z.object({
  /** A PO whose grand total is at or above this needs approval; 0 or null means never. */
  approvalThreshold: z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/u, 'an amount').nullable(),
  /** REQ-AA-15: hours a packed order may wait for its invoice before accounts is told; 0 disables. */
  invoiceWaitingHours: z.number().int().min(0).max(720),
});
export type PurchaseSettings = z.infer<typeof purchaseSettingsSchema>;
export const DEFAULT_PURCHASE_SETTINGS: PurchaseSettings = { approvalThreshold: null, invoiceWaitingHours: 24 };
