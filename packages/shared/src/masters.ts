import type { DuplicateFlag } from './duplicates.js';
import { z } from 'zod';

import { pageQuerySchema } from './pagination.js';

/**
 * The Tally masters projection, as screens read it (REQ-R-01…R-06, 09 §5).
 *
 * Read-only end to end: there is no create schema in this file and never
 * will be, because REQ-R-04 is permanent — a new customer is created where
 * the accountant creates customers, and appears here on the next pull.
 */

export interface PartyView {
  readonly id: string;
  readonly connectionId: string;
  readonly name: string;
  readonly alias: string | null;
  /** Sundry Debtors / Sundry Creditors, verbatim from Tally's group tree. */
  readonly parentGroup: string;
  readonly gstin: string | null;
  readonly address: string | null;
  /** 12 REQ-AA-28: where the customer is told, when the ledger carries it. */
  readonly email: string | null;
  readonly phone: string | null;
  /** Exact decimal as text (D-01): Tally's figure, held not computed. */
  readonly creditLimit: string | null;
  readonly creditDays: number | null;
  readonly openingBalance: string | null;
  /** REQ-R-06: gone from Tally, kept here so references keep resolving. */
  readonly absentInTally: boolean;
  /** REQ-Y-07's habit, started early: every projected figure says its age. */
  readonly lastPulledAt: string;
  /** 15 REQ-AO-06: set when the record sits in an open duplicate cluster. */
  readonly duplicate: DuplicateFlag | null;
}

export const partyListQuerySchema = pageQuerySchema.extend({
  /** Free text over name, alias and GSTIN. */
  q: z.string().trim().min(1).max(80).optional(),
  /** Filter to one side of the ledger: Sundry Debtors or Sundry Creditors. */
  parentGroup: z.string().trim().min(1).max(120).optional(),
  /** Filter to a specific Tally connection / company. Omitted means all companies (unified). */
  connectionId: z.string().uuid().optional(),
});

export type PartyListQuery = z.infer<typeof partyListQuerySchema>;

export interface StockItemView {
  readonly id: string;
  readonly connectionId: string;
  readonly name: string;
  readonly alias: string | null;
  readonly unit: string;
  readonly parentGroup: string;
  /** GST percentage as exact decimal text, or null where none is set. */
  readonly gstRate: string | null;
  /** Held figures, exact decimal text, null when the source carried none (D-01). */
  readonly closingQty: string | null;
  readonly salePrice: string | null;
  readonly costPrice: string | null;
  readonly absentInTally: boolean;
  readonly lastPulledAt: string;
  /** 15 REQ-AO-06: set when the record sits in an open duplicate cluster. */
  readonly duplicate: DuplicateFlag | null;
}

export const stockItemListQuerySchema = pageQuerySchema.extend({
  /** Free text over name and alias. */
  q: z.string().trim().min(1).max(80).optional(),
  /** Filter to one stock group, verbatim. */
  parentGroup: z.string().trim().min(1).max(120).optional(),
  /** Filter to a specific Tally connection / company. Omitted means all companies (unified). */
  connectionId: z.string().uuid().optional(),
});

export type StockItemListQuery = z.infer<typeof stockItemListQuerySchema>;

export interface PriceListEntryView {
  readonly id: string;
  readonly connectionId: string;
  /** The projected item's name, joined for the screen; the rate means nothing without it. */
  readonly stockItemName: string;
  readonly priceLevel: string;
  /** Exact decimal as text (D-01). */
  readonly rate: string;
  readonly unit: string | null;
  readonly lastPulledAt: string;
}

export const priceListListQuerySchema = pageQuerySchema.extend({
  /** Free text over the item name. */
  q: z.string().trim().min(1).max(80).optional(),
  /** One price level — the per-party-group list REQ-R-03 names. */
  priceLevel: z.string().trim().min(1).max(120).optional(),
  /** Filter to a specific Tally connection / company. Omitted means all companies (unified). */
  connectionId: z.string().uuid().optional(),
});

export type PriceListListQuery = z.infer<typeof priceListListQuerySchema>;

// ------------------------------------------------------------- vouchers

/** A voucher as the screens read it (Phase 6c; Area Y builds on it). */
export interface VoucherView {
  readonly id: string;
  readonly connectionId: string;
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly voucherType: string;
  readonly voucherNumber: string;
  readonly partyName: string;
  /** The projected party this names, when one exists; null otherwise. */
  readonly partyId: string | null;
  readonly narration: string;
  readonly isCancelled: boolean;
  /** Exact decimal as text (D-01). */
  readonly amount: string;
  /** REQ-Y-07: every figure says its age. */
  readonly lastPulledAt: string;

  // Order, terms, dispatch and consignee facts from Tally
  readonly reference?: string | null;
  readonly referenceDate?: string | null;
  readonly orderRef?: string | null;
  readonly buyerOrderNumber?: string | null;
  readonly buyerOrderDate?: string | null;
  readonly paymentTerms?: string | null;
  readonly deliveryTerms?: string | null;
  readonly dispatchedThrough?: string | null;
  readonly dispatchDocNo?: string | null;
  readonly vehicleNumber?: string | null;
  readonly destination?: string | null;
  readonly buyerName?: string | null;
  readonly buyerAddress?: string | null;
  readonly partyGstin?: string | null;
  readonly partyState?: string | null;
  readonly placeOfSupply?: string | null;
  readonly consigneeName?: string | null;
  readonly consigneeState?: string | null;
  readonly consigneePincode?: string | null;
  readonly consigneeGstin?: string | null;
}

export interface VoucherLineView {
  readonly lineNo: number;
  readonly kind: 'ledger' | 'inventory';
  readonly ledgerName: string | null;
  readonly isDeemedPositive: boolean | null;
  readonly stockItemName: string | null;
  readonly stockItemId: string | null;
  readonly actualQty: string | null;
  readonly billedQty: string | null;
  readonly rate: string | null;
  readonly amount: string;
}

export interface VoucherDetailView extends VoucherView {
  readonly lines: readonly VoucherLineView[];
}

/**
 * What a voucher register can be ordered by, named as the table's own columns
 * so a header and a `?sort=` term are the same word.
 *
 * Narration is deliberately absent: it is a paragraph, and sorting a register
 * by the first letter of a sentence answers no question anyone asks.
 */
export const VOUCHER_SORT_FIELDS = ['date', 'type', 'number', 'party', 'amount'] as const;

export type VoucherSortField = (typeof VOUCHER_SORT_FIELDS)[number];

/** Newest first: a register is read from the last thing that happened. */
export const DEFAULT_VOUCHER_SORT = '-date';

export const voucherListQuerySchema = pageQuerySchema.extend({
  /** Free text over voucher number, party name and narration. */
  q: z.string().trim().min(1).max(80).optional(),
  voucherType: z.string().trim().min(1).max(120).optional(),
  partyId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  includeCancelled: z.coerce.boolean().optional(),
  /** `field` or `-field` from VOUCHER_SORT_FIELDS; an unknown term is dropped, not a 400. */
  sort: z.string().trim().max(60).optional(),
  /** Filter to a specific Tally connection / company. Omitted means all companies (unified). */
  connectionId: z.string().uuid().optional(),
});

export type VoucherListQuery = z.infer<typeof voucherListQuerySchema>;

/**
 * The voucher types this organisation actually has, with how many of each.
 *
 * Tally's voucher types are configured per company, so the filter's options
 * cannot be a list this codebase knows -- they are whatever has arrived.
 */
export interface VoucherTypeFacet {
  readonly voucherType: string;
  readonly count: number;
}
