import type { PurchaseOrder, Grn } from '@/features/purchase/types';
import type { Dispatch, Estimate, PackRecord } from '@/features/sales/types';
import { formatDate } from '@/lib/format';
import { DISPATCH_MODE_LABELS, PURCHASE_ORDER_STATUS_LABELS, SALES_DOCUMENT_STATUS_LABELS, SYNC_STATE_LABELS, voucherPaper, type PrintedDocumentType, type VoucherDetailView } from '@vyuha/shared';

import type { PaperModel, PaperSlipFacts } from './paper';

/**
 * Every record that prints, read into one shape. The sales documents and
 * the purchase order carry it natively; a dispatch, a pack record and a
 * goods receipt are read through the order they belong to (for the party,
 * the units and the HSN codes) and print quantities without money. The
 * print route and each paper page build their PaperModel from this, so a
 * paper looks the same wherever it is drawn.
 */
export interface PaperRecord {
  readonly number: string;
  readonly statusLabel: string;
  readonly date: string;
  readonly validUntil: string | null;
  readonly partyId: string | null;
  readonly customerName: string;
  readonly placeOfSupply: string | null;
  readonly shipTo: PaperModel['shipTo'];
  readonly details: PaperModel['details'] | null;
  readonly reference: string | null;
  readonly lines: readonly { id: string; stockItemId: string | null; description: string; hsnCode: string | null; quantity: string; unit: string | null; rate: string; discountPct: string; taxPct: string; amount: string; taxAmount: string }[];
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
  readonly notes: string | null;
  readonly terms: string | null;
  /** D-47: present on a packing slip only; the party's phone joins it in paperModelOf. */
  readonly slip?: Omit<PaperSlipFacts, 'phone'>;
  /** A heading of its own, when the type's will not do (a Tally voucher). */
  readonly title?: string | null;
}

interface PartyFacts {
  readonly address?: string | null;
  readonly gstin?: string | null;
  readonly phone?: string | null;
}

/** The PaperModel the paper draws, from a record and what is known of its party. */
export function paperModelOf(type: PrintedDocumentType, record: PaperRecord, party: PartyFacts | null | undefined): PaperModel {
  return {
    type,
    number: record.number,
    statusLabel: record.statusLabel,
    date: record.date,
    validUntil: record.validUntil,
    buyer: {
      name: record.customerName,
      address: party?.address ?? '',
      gstin: party?.gstin ?? '',
      stateName: '',
      stateCode: record.placeOfSupply ?? (party?.gstin ?? '').slice(0, 2).replace(/\D/gu, ''),
    },
    shipTo: record.shipTo,
    details: record.details ?? {},
    reference: record.reference,
    lines: record.lines.map((line) => ({ key: line.id, stockItemId: line.stockItemId, description: line.description, hsnCode: line.hsnCode ?? '', quantity: line.quantity, unit: line.unit ?? '', rate: line.rate, discountPct: line.discountPct, taxPct: line.taxPct, amount: line.amount, taxAmount: line.taxAmount })),
    totals: { subtotal: record.subtotal, discountTotal: record.discountTotal, taxTotal: record.taxTotal, grandTotal: record.grandTotal, preview: false },
    notes: record.notes ?? '',
    terms: record.terms ?? '',
    ...(record.title === undefined || record.title === null ? {} : { title: record.title }),
    ...(record.slip === undefined ? {} : { slip: { ...record.slip, phone: party?.phone ?? null } }),
  };
}

/**
 * A details date may be three things: an ISO date the API now stores, a
 * pre-formatted display string an older row saved, or text a user typed by
 * hand. Only the ISO shape is ours to format; anything else prints exactly
 * as it was written.
 */
function displayDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? formatDate(value) : value;
}

export function salesDocumentAsPaper(doc: Estimate): PaperRecord {
  return { ...doc, statusLabel: SALES_DOCUMENT_STATUS_LABELS[doc.status], reference: null };
}

export function purchaseOrderAsPaper(po: PurchaseOrder): PaperRecord {
  return {
    number: po.number,
    statusLabel: PURCHASE_ORDER_STATUS_LABELS[po.status],
    date: po.date,
    validUntil: po.expectedDate,
    partyId: po.partyId,
    customerName: po.vendorName,
    placeOfSupply: null,
    shipTo: po.shipTo,
    details: po.details,
    reference: null,
    lines: po.lines,
    subtotal: po.subtotal,
    discountTotal: po.discountTotal,
    taxTotal: po.taxTotal,
    grandTotal: po.grandTotal,
    notes: po.notes,
    terms: po.terms,
  };
}

const NO_MONEY = { rate: '0', discountPct: '0', taxPct: '0', amount: '0', taxAmount: '0' } as const;
const ZERO_TOTALS = { subtotal: '0.00', discountTotal: '0.00', taxTotal: '0.00', grandTotal: '0.00' } as const;

/** The delivery note: what left, against the order it left for; the transport facts in the details grid. */
export function dispatchAsPaper(dispatch: Dispatch, order: Estimate): PaperRecord {
  const byLine = new Map(order.lines.map((line) => [line.id, line]));
  const through = dispatch.mode === 'outstation' ? [dispatch.transporterName, dispatch.transporterContact].filter((p) => (p ?? '').trim() !== '').join(' · ') : dispatch.mode === 'local_own_vehicle' ? ['Own vehicle', dispatch.vehicleNumber, dispatch.driverName].filter((p) => (p ?? '').trim() !== '').join(' · ') : DISPATCH_MODE_LABELS[dispatch.mode];
  return {
    number: dispatch.number,
    statusLabel: DISPATCH_MODE_LABELS[dispatch.mode],
    date: dispatch.dispatchedAt.slice(0, 10),
    validUntil: dispatch.expectedDeliveryDate,
    partyId: order.partyId,
    customerName: dispatch.customerName,
    placeOfSupply: order.placeOfSupply,
    shipTo: order.shipTo,
    details: {
      ...(order.details ?? {}),
      buyersOrderNo: order.details?.buyersOrderNo ?? order.number,
      buyersOrderDate: displayDate(order.details?.buyersOrderDate ?? order.date),
      dispatchDocNo: dispatch.lrNumber ?? order.details?.dispatchDocNo ?? '',
      dispatchedThrough: through,
      destination: order.details?.destination ?? order.shipTo?.address?.split('\n').at(-1) ?? '',
    },
    reference: `Against ${dispatch.orderNumber}`,
    lines: dispatch.lines.map((line) => {
      const source = byLine.get(line.lineId);
      return { id: line.lineId, stockItemId: source?.stockItemId ?? null, description: line.description, hsnCode: source?.hsnCode ?? null, quantity: line.quantity, unit: line.unit ?? source?.unit ?? null, ...NO_MONEY };
    }),
    ...ZERO_TOTALS,
    notes: dispatch.notes,
    terms: null,
  };
}

/** The packing slip: what went in the boxes of one packing session. */
export function packAsPaper(pack: PackRecord, order: Estimate): PaperRecord {
  const byLine = new Map(order.lines.map((line) => [line.id, line]));
  return {
    number: `${order.number}/${pack.id.slice(-4).toUpperCase()}`,
    statusLabel: `${String(pack.boxCount)} box${pack.boxCount === 1 ? '' : 'es'}`,
    date: pack.packedAt.slice(0, 10),
    validUntil: null,
    partyId: order.partyId,
    customerName: order.customerName,
    placeOfSupply: order.placeOfSupply,
    shipTo: order.shipTo,
    details: {
      buyersOrderNo: order.details?.buyersOrderNo ?? order.number,
      buyersOrderDate: displayDate(order.details?.buyersOrderDate ?? order.date),
      otherReferences: `${String(pack.boxCount)} box${pack.boxCount === 1 ? '' : 'es'}${pack.packedByName ? ` · packed by ${pack.packedByName}` : ''}`,
    },
    reference: `Against ${order.number}`,
    lines: pack.lines.map((line) => {
      const source = byLine.get(line.lineId);
      return { id: line.lineId, stockItemId: source?.stockItemId ?? null, description: line.comment ? `${line.description} — ${line.comment}` : line.description, hsnCode: source?.hsnCode ?? null, quantity: line.quantity, unit: source?.unit ?? null, ...NO_MONEY };
    }),
    ...ZERO_TOTALS,
    notes: pack.comment,
    terms: null,
    slip: { boxCount: pack.boxCount, packedAt: pack.packedAt, packedByName: pack.packedByName },
  };
}

/** The goods receipt note: what arrived against the purchase order, what was rejected and why. */
export function grnAsPaper(grn: Grn, po: PurchaseOrder): PaperRecord {
  const byLine = new Map(po.lines.map((line) => [line.id, line]));
  return {
    number: grn.number,
    statusLabel: SYNC_STATE_LABELS[grn.syncState],
    date: grn.receivedAt.slice(0, 10),
    validUntil: null,
    partyId: po.partyId,
    customerName: grn.vendorName,
    placeOfSupply: null,
    shipTo: null,
    details: {
      buyersOrderNo: grn.purchaseOrderNumber,
      buyersOrderDate: displayDate(po.date),
      referenceNo: grn.vendorInvoiceRef ?? '',
      otherReferences: grn.receivedByName ? `Received by ${grn.receivedByName}` : '',
    },
    reference: `Against ${grn.purchaseOrderNumber}`,
    lines: grn.lines.map((line) => {
      const source = byLine.get(line.purchaseOrderLineId);
      const rejected = Number(line.rejectedQty) > 0 ? ` (${line.rejectedQty} rejected${line.rejectionReason ? `: ${line.rejectionReason}` : ''})` : '';
      return { id: line.purchaseOrderLineId, stockItemId: source?.stockItemId ?? null, description: `${line.description}${rejected}`, hsnCode: source?.hsnCode ?? null, quantity: line.receivedQty, unit: source?.unit ?? null, ...NO_MONEY };
    }),
    ...ZERO_TOTALS,
    notes: grn.notes,
    terms: null,
  };
}

/**
 * A Tally voucher on the organisation's paper (owner, 22 Aug 2026). The
 * reading -- goods as lines, tax ledgers as the tax total, a receipt's
 * ledgers marked Dr and Cr -- is the shared one the Excel export uses.
 */
export function voucherAsPaper(voucher: VoucherDetailView): { type: PrintedDocumentType; record: PaperRecord } {
  const paper = voucherPaper(voucher);
  return {
    type: paper.type,
    record: {
      number: voucher.voucherNumber || paper.title,
      statusLabel: voucher.isCancelled ? 'Cancelled' : 'From Tally',
      date: voucher.date,
      validUntil: null,
      partyId: voucher.partyId,
      customerName: voucher.partyName,
      placeOfSupply: null,
      shipTo: null,
      details: null,
      reference: `Tally ${voucher.voucherType}${voucher.voucherNumber ? ` ${voucher.voucherNumber}` : ''}`,
      lines: paper.lines.map((line) => ({ ...line, hsnCode: null, discountPct: '0', taxPct: '0', taxAmount: '0' })),
      subtotal: paper.subtotal,
      discountTotal: paper.discountTotal,
      taxTotal: paper.taxTotal,
      grandTotal: paper.grandTotal,
      notes: voucher.narration || null,
      terms: null,
      title: paper.title,
    },
  };
}

