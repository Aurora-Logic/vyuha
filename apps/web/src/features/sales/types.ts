import { z } from 'zod';

import { DISPATCH_MODES, ESTIMATE_STATUSES, FULFILMENT_STATES, SALES_DOCUMENT_TYPES, SALES_ORDER_STATUSES, SYNC_STATES, documentDetailsSchema, shipToSchema, type DocumentDetails, type ShipTo } from '@vyuha/shared';

/** What `/sales/estimates` answers (REQ-W-01), parsed at the boundary. */

export const salesLineSchema = z.object({
  id: z.string(),
  lineNo: z.number(),
  stockItemId: z.string().nullable(),
  description: z.string(),
  quantity: z.string(),
  unit: z.string().nullable(),
  rate: z.string(),
  discountPct: z.string(),
  taxPct: z.string(),
  amount: z.string(),
  taxAmount: z.string(),
  hsnCode: z.string().nullable().default(null),
  // 15 REQ-AN-15: what the price lists resolved when the line was written. Absent on older fixtures.
  priceListId: z.string().nullable().default(null),
  priceListVersion: z.number().nullable().default(null),
  resolvedRate: z.string().nullable().default(null),
  appliedDiscountPct: z.string().nullable().default(null),
  rateOverrideReason: z.string().nullable().default(null),
  // 15 REQ-AK-09 / D-51: a replacement line given away. It has no invoice to
  // wait for, so what releases it for dispatch is what was packed. The schema
  // dropped this, so `lineBalances` read the mark as undefined and a free
  // replacement could never be dispatched from a screen at all.
  freeOfCharge: z.boolean().default(false),
  // REQ-AA-01/AA-29: the state, as numbers. Zero on an estimate.
  // D-48: picked sits between ordered and packed. Absent on older fixtures.
  pickedQty: z.string().default('0.000'),
  packedQty: z.string(),
  invoicedQty: z.string(),
  dispatchedQty: z.string(),
  // P8-2: on invoices in flight (confirmed, not yet accepted by Tally). Absent on older fixtures.
  invoicingQty: z.string().default('0.000'),
});
export type SalesLine = z.infer<typeof salesLineSchema>;

/**
 * REQ-AA-29: the figures and the balances every order screen shows per line.
 * D-48 (owner's flow): ordered → picked → packed → invoiced → dispatched;
 * each step may take only what the one before it released.
 */
export function lineBalances(line: SalesLine): { toPick: number; toPack: number; toInvoice: number; invoicing: number; toDispatch: number } {
  const invoicing = Number(line.invoicingQty);
  return {
    toPick: Math.max(0, Number(line.quantity) - Number(line.pickedQty)),
    toPack: Math.max(0, Number(line.pickedQty) - Number(line.packedQty)),
    // What an invoice raised now may take: packed, less invoiced, less what an invoice in flight already holds (P8-2).
    toInvoice: Math.max(0, Number(line.packedQty) - Number(line.invoicedQty) - invoicing),
    invoicing,
    // A free line waits for no invoice: what was packed is what may leave.
    toDispatch: Math.max(0, (line.freeOfCharge ? Number(line.packedQty) : Number(line.invoicedQty)) - Number(line.dispatchedQty)),
  };
}

const headerShape = {
  id: z.string(),
  docType: z.enum(SALES_DOCUMENT_TYPES),
  number: z.string(),
  status: z.enum([...ESTIMATE_STATUSES, ...SALES_ORDER_STATUSES]),
  date: z.string(),
  validUntil: z.string().nullable(),
  partyId: z.string().nullable(),
  companyId: z.string().nullable(),
  dealId: z.string().nullable(),
  customerName: z.string(),
  ownerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  notes: z.string().nullable(),
  terms: z.string().nullable(),
  subtotal: z.string(),
  discountTotal: z.string(),
  taxTotal: z.string(),
  grandTotal: z.string(),
  sourceDocumentId: z.string().nullable(),
  syncState: z.enum(SYNC_STATES),
  remoteGuid: z.string().nullable(),
  remoteVoucherNumber: z.string().nullable(),
  lastPushedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  // Orders only (null on an estimate): the fulfilment word derived from the
  // lines (REQ-AA-02), the short close (REQ-AA-05), and where the customer
  // is told (REQ-AA-28).
  fulfilment: z.enum(FULFILMENT_STATES).nullable(),
  shortClosedAt: z.string().nullable(),
  shortCloseReason: z.string().nullable(),
  customerEmail: z.string().nullable(),
  customerWhatsapp: z.string().nullable(),
  // The GST header (documents.ts); absent on rows written before it existed.
  placeOfSupply: z.string().nullable().default(null),
  shipTo: shipToSchema.nullable().default(null),
  details: documentDetailsSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
};

/** REQ-AA-12 / D-38: an invoice against an order, however it got there. */
export const orderInvoiceSchema = z.object({
  voucherId: z.string().nullable(),
  invoiceDocumentId: z.string().nullable(),
  voucherNumber: z.string(),
  date: z.string(),
  amount: z.string(),
  method: z.enum(['narration', 'manual', 'vyuha']),
  linkedAt: z.string(),
});
export type OrderInvoice = z.infer<typeof orderInvoiceSchema>;
export const ORDER_INVOICE_METHOD_LABELS: Record<OrderInvoice['method'], string> = {
  narration: 'Auto-linked',
  manual: 'Linked by hand',
  vyuha: 'Raised here',
};

/** REQ-X-26: why an order waits and what it waits on — an open requirement and the POs raised against it. */
export const orderWaitingOnSchema = z.object({
  requirementId: z.string(),
  lineId: z.string().nullable(),
  stockItemName: z.string(),
  quantity: z.string(),
  orderedQty: z.string(),
  receivedQty: z.string(),
  state: z.enum(['open', 'ordered', 'received', 'closed']),
  neededBy: z.string().nullable(),
  purchaseOrders: z.array(z.object({ id: z.string(), number: z.string(), vendorName: z.string(), status: z.string(), expectedDate: z.string().nullable(), quantity: z.string() })),
});
export type OrderWaitingOn = z.infer<typeof orderWaitingOnSchema>;
export const WAITING_ON_STATE_LABELS: Record<OrderWaitingOn['state'], string> = { open: 'No PO yet', ordered: 'On order', received: 'Received', closed: 'Closed' };

export const estimateSummarySchema = z.object(headerShape);
export type EstimateSummary = z.infer<typeof estimateSummarySchema>;
export const estimateSchema = z.object({
  ...headerShape,
  lines: z.array(salesLineSchema),
  invoices: z.array(orderInvoiceSchema),
  // Orders only; the estimate and invoice endpoints answer without it.
  waitingOn: z.array(orderWaitingOnSchema).default([]),
});
export type Estimate = z.infer<typeof estimateSchema>;

export const estimatesResponseSchema = z.object({
  data: z.array(estimateSummarySchema),
  meta: z.object({ page: z.number(), pageSize: z.number(), total: z.number() }),
});
export type EstimatesResponse = z.infer<typeof estimatesResponseSchema>;

/** REQ-AC-04: available = Tally closing − committed, with the pull it rests on (REQ-AC-05). */
export const stockAvailabilitySchema = z.object({
  stockItemId: z.string(),
  closingQty: z.string().nullable(),
  committedQty: z.string(),
  availableQty: z.string().nullable(),
  openPoQty: z.string(),
  reorderLevel: z.string().nullable(),
  minimumOrderQty: z.string().nullable(),
  asOf: z.string().nullable(),
});
export type StockAvailability = z.infer<typeof stockAvailabilitySchema>;

export const itemHistorySchema = z.object({
  stockItemName: z.string(),
  currentSalePrice: z.string().nullable(),
  // REQ-AC-08: the other fact a salesperson needs at the same instant.
  availability: stockAvailabilitySchema.nullable(),
  entries: z.array(
    z.object({
      source: z.enum(['voucher', 'estimate']),
      date: z.string(),
      reference: z.string(),
      quantity: z.string().nullable(),
      rate: z.string().nullable(),
      discountPct: z.string().nullable(),
      amount: z.string().nullable(),
      status: z.string().nullable(),
    }),
  ),
  vouchersAsOf: z.string().nullable(),
});
export type ItemHistory = z.infer<typeof itemHistorySchema>;

/** REQ-W-09: what a credit block says, carried in the CREDIT_BLOCKED error's details. */
export const creditPositionSchema = z.object({
  partyId: z.string(),
  partyName: z.string(),
  creditLimit: z.string().nullable(),
  creditDays: z.number().nullable(),
  exposure: z.string(),
  openOrders: z.string(),
  headroom: z.string().nullable(),
  // 15 REQ-AJ-10: a flag beside the limit; absent on older fixtures.
  brokenPromises: z.number().default(0),
  brokenPromiseAmount: z.string().default('0.00'),
});
export type CreditPosition = z.infer<typeof creditPositionSchema>;
export const creditBlockSchema = z.object({ position: creditPositionSchema, requiredPermission: z.string(), orderTotal: z.string() });
export type CreditBlock = z.infer<typeof creditBlockSchema>;

// ------------------------------------------------------- pick, pack, invoice

/** REQ-AA-06: an open order with something left to pack, as the picker sees it. */
export const pickQueueEntrySchema = z.object({
  documentId: z.string(),
  number: z.string(),
  customerName: z.string(),
  date: z.string(),
  fulfilment: z.enum(FULFILMENT_STATES),
  balanceLines: z.number(),
  balanceQty: z.string(),
  waitingOnRequirements: z.number(),
});
export type PickQueueEntry = z.infer<typeof pickQueueEntrySchema>;

/** REQ-AA-11/AA-15: packed, uninvoiced, and for how long. */
export const awaitingInvoiceEntrySchema = z.object({
  documentId: z.string(),
  number: z.string(),
  customerName: z.string(),
  packedUninvoicedQty: z.string(),
  waitingSince: z.string(),
  waitingHours: z.number(),
});
export type AwaitingInvoiceEntry = z.infer<typeof awaitingInvoiceEntrySchema>;

/** REQ-AA-13: a Sales voucher with a party and no order behind it. */
export const unlinkedInvoiceSchema = z.object({
  voucherId: z.string(),
  voucherNumber: z.string(),
  date: z.string(),
  partyId: z.string().nullable(),
  partyName: z.string(),
  amount: z.string(),
  narration: z.string().nullable(),
  candidateOrders: z.array(z.object({ documentId: z.string(), number: z.string(), date: z.string(), grandTotal: z.string() })),
});
export type UnlinkedInvoice = z.infer<typeof unlinkedInvoiceSchema>;

/** REQ-AA-09: one packing session. */
/** D-48: one picking session — who took how much off the shelf. */
export const pickRecordSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  pickedById: z.string().nullable(),
  pickedByName: z.string().nullable(),
  pickedAt: z.string(),
  comment: z.string().nullable(),
  lines: z.array(z.object({ lineId: z.string(), description: z.string(), quantity: z.string(), comment: z.string().nullable() })),
});
export type PickRecord = z.infer<typeof pickRecordSchema>;

export const packRecordSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  orderNumber: z.string(),
  customerName: z.string(),
  slipNumber: z.string(),
  boxCount: z.number(),
  packedById: z.string().nullable(),
  packedByName: z.string().nullable(),
  packedAt: z.string(),
  comment: z.string().nullable(),
  lines: z.array(z.object({ lineId: z.string(), description: z.string(), quantity: z.string(), comment: z.string().nullable() })),
});
export type PackRecord = z.infer<typeof packRecordSchema>;

/** D-47: the Packed screen's page of pack records. */
export const packedListSchema = z.object({ data: z.array(packRecordSchema), meta: z.object({ page: z.number(), pageSize: z.number(), total: z.number() }) });
export type PackedList = z.infer<typeof packedListSchema>;

// ------------------------------------------------------------------ dispatch

export const dispatchNotificationSchema = z.object({
  id: z.string(),
  channel: z.enum(['email', 'whatsapp']),
  recipient: z.string().nullable(),
  status: z.enum(['pending', 'sent', 'failed']),
  event: z.enum(['dispatched', 'delivered']).optional(),
  composedText: z.string(),
  sentAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type DispatchNotification = z.infer<typeof dispatchNotificationSchema>;

/** REQ-AA-16: a dispatch is its own record with its own lines. */
export const dispatchSchema = z.object({
  id: z.string(),
  number: z.string(),
  documentId: z.string(),
  orderNumber: z.string(),
  customerName: z.string(),
  mode: z.enum(DISPATCH_MODES),
  dispatchedById: z.string().nullable(),
  dispatchedByName: z.string().nullable(),
  dispatchedAt: z.string(),
  lrNumber: z.string().nullable(),
  transporterName: z.string().nullable(),
  transporterContact: z.string().nullable(),
  vehicleNumber: z.string().nullable(),
  driverName: z.string().nullable(),
  expectedDeliveryDate: z.string().nullable(),
  notes: z.string().nullable(),
  // D-47: shipped until the door step marks it delivered.
  status: z.enum(['shipped', 'delivered']).default('shipped'),
  deliveredAt: z.string().nullable().default(null),
  deliveredByName: z.string().nullable().default(null),
  receivedBy: z.string().nullable().default(null),
  deliveryNote: z.string().nullable().default(null),
  syncState: z.enum(SYNC_STATES),
  remoteGuid: z.string().nullable(),
  remoteVoucherNumber: z.string().nullable(),
  lastError: z.string().nullable(),
  lines: z.array(z.object({ lineId: z.string(), description: z.string(), quantity: z.string(), unit: z.string().nullable() })),
  attachments: z.array(z.object({ fileId: z.string(), kind: z.enum(['box', 'lr', 'delivery']) })),
  notifications: z.array(dispatchNotificationSchema),
});
export type Dispatch = z.infer<typeof dispatchSchema>;

export const dispatchesResponseSchema = z.object({
  data: z.array(dispatchSchema),
  meta: z.object({ page: z.number(), pageSize: z.number(), total: z.number() }),
});
export type DispatchesResponse = z.infer<typeof dispatchesResponseSchema>;

/** What `GET /sales/dispatches/:id/attachments/:fileId/url` answers: a signed link and its life. */
export const attachmentUrlSchema = z.object({ url: z.string(), expiresInSeconds: z.number() });
export type AttachmentUrl = z.infer<typeof attachmentUrlSchema>;

/** The editor's working copy of a line; strings as typed, validated on save. */
export interface LineDraft {
  key: string;
  stockItemId: string | null;
  description: string;
  quantity: string;
  unit: string;
  rate: string;
  discountPct: string;
  taxPct: string;
  hsnCode: string;
  /** REQ-AN-16: why the rate went below what the price lists resolved. */
  rateOverrideReason: string;
}

export interface EstimateDraft {
  id?: string;
  status: Estimate['status'];
  number: string | null;
  partyId: string | null;
  companyId: string | null;
  customerName: string;
  date: string;
  validUntil: string | null;
  dealId: string | null;
  ownerId: string | null;
  notes: string;
  terms: string;
  /** REQ-AA-28: sales orders only; blank means the party master's contact. Estimates ignore them. */
  customerEmail: string;
  customerWhatsapp: string;
  placeOfSupply: string;
  shipTo: ShipTo;
  details: DocumentDetails;
  lines: LineDraft[];
}

let lineCounter = 0;
export function newLine(overrides: Partial<LineDraft> = {}): LineDraft {
  lineCounter += 1;
  return {
    key: `line-${String(lineCounter)}`,
    stockItemId: null,
    description: '',
    quantity: '1',
    unit: '',
    rate: '',
    discountPct: '0',
    taxPct: '0',
    hsnCode: '',
    rateOverrideReason: '',
    ...overrides,
  };
}

export function emptyEstimateDraft(today: string, overrides: Partial<EstimateDraft> = {}): EstimateDraft {
  return {
    status: 'DRAFT',
    number: null,
    partyId: null,
    companyId: null,
    customerName: '',
    date: today,
    validUntil: null,
    dealId: null,
    ownerId: null,
    notes: '',
    terms: '',
    customerEmail: '',
    customerWhatsapp: '',
    placeOfSupply: '',
    shipTo: {},
    details: {},
    lines: [newLine()],
    ...overrides,
  };
}

export function estimateToDraft(estimate: Estimate): EstimateDraft {
  return {
    id: estimate.id,
    status: estimate.status,
    number: estimate.number,
    partyId: estimate.partyId,
    companyId: estimate.companyId,
    customerName: estimate.customerName,
    date: estimate.date,
    validUntil: estimate.validUntil,
    dealId: estimate.dealId,
    ownerId: estimate.ownerId,
    notes: estimate.notes ?? '',
    terms: estimate.terms ?? '',
    customerEmail: estimate.customerEmail ?? '',
    customerWhatsapp: estimate.customerWhatsapp ?? '',
    placeOfSupply: estimate.placeOfSupply ?? '',
    shipTo: estimate.shipTo ?? {},
    details: estimate.details ?? {},
    lines: estimate.lines.map((line) =>
      newLine({
        stockItemId: line.stockItemId,
        description: line.description,
        quantity: trimZeros(line.quantity),
        unit: line.unit ?? '',
        rate: trimZeros(line.rate),
        discountPct: trimZeros(line.discountPct),
        taxPct: trimZeros(line.taxPct),
        hsnCode: line.hsnCode ?? '',
        // Without this the reason vanished on reopen, and the next save sent a
        // below-floor line with nothing to explain it.
        rateOverrideReason: line.rateOverrideReason ?? '',
      }),
    ),
  };
}

/** `4000.00` → `4000`, `4100.50` → `4100.5`: what a person would type. */
export function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/u, '') : value;
}

/**
 * The editor's preview of a line while it is being typed. The server's SQL
 * is the authority and replaces this on save; this exists so a person does
 * not type blind. Same formula, rounded the same way (half up, two places).
 */
export function previewLine(line: LineDraft): { amount: number; tax: number } | null {
  const qty = Number(line.quantity);
  const rate = Number(line.rate);
  const disc = Number(line.discountPct || '0');
  const tax = Number(line.taxPct || '0');
  if (!Number.isFinite(qty) || !Number.isFinite(rate) || !Number.isFinite(disc) || !Number.isFinite(tax)) return null;
  if (line.quantity.trim() === '' || line.rate.trim() === '') return null;
  const amount = round2(qty * rate * (1 - disc / 100));
  return { amount, tax: round2(amount * (tax / 100)) };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
