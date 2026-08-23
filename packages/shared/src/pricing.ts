import { z } from 'zod';

import { pageQuerySchema } from './pagination.js';

/**
 * Area AN (docs/15): price lists Vyuha owns, versioned and approved, and
 * the rate they resolve for a document line. The second deliberate
 * exception to D-01 after item_vendors (docs/11 D-49): the list is
 * Vyuha's and does not push to Tally -- Tally takes the rate on each
 * voucher line from the pushed document.
 *
 * The discipline that matters most is REQ-AN-06/07: an active list is
 * immutable; a change is a new version in draft that supersedes it on
 * activation, and the superseded version is kept forever so an invoice
 * from eighteen months ago remains explainable. Every document line
 * stores what resolved as values, never as a pointer to a row that can
 * move (REQ-AN-15).
 */

export const PRICE_LIST_STATES = ['draft', 'pending_approval', 'active', 'superseded', 'expired'] as const;
export type PriceListState = (typeof PRICE_LIST_STATES)[number];
export const PRICE_LIST_STATE_LABELS: Record<PriceListState, string> = {
  draft: 'Draft',
  pending_approval: 'Awaiting approval',
  active: 'Active',
  superseded: 'Superseded',
  expired: 'Expired',
};

/** REQ-AN-02: a fixed rate, a percentage off the Tally rate, or a rate with a further percentage. */
export const PRICE_BASES = ['rate', 'discount_pct', 'both'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];
export const PRICE_BASIS_LABELS: Record<PriceBasis, string> = { rate: 'Fixed rate', discount_pct: 'Percent off Tally rate', both: 'Rate less percent' };

const moneyText = z.string().trim().regex(/^\d{1,14}(\.\d{1,2})?$/u, 'a number with up to two decimals');
const quantityText = z.string().trim().regex(/^\d{1,12}(\.\d{1,3})?$/u, 'a quantity with up to three decimals');
const percentText = z.string().trim().regex(/^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/u, 'a percentage from 0 to 100');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'a date as YYYY-MM-DD');

export const priceListLineInputSchema = z
  .object({
    /** One of the two: a stock item from the projection, or the name of an item group as Tally holds it. */
    stockItemId: z.uuid().nullish(),
    itemGroup: z.string().trim().min(1).max(200).nullish(),
    basis: z.enum(PRICE_BASES),
    rate: moneyText.nullish(),
    discountPct: percentText.nullish(),
    /** REQ-AN-03: the line applies from this quantity (inclusive) ... */
    minQty: quantityText.nullish(),
    /** ... up to this one (inclusive); null means no ceiling. */
    maxQty: quantityText.nullish(),
  })
  .refine((line) => Boolean(line.stockItemId) !== Boolean(line.itemGroup), { message: 'A line names an item or an item group, not both and not neither.', path: ['stockItemId'] })
  .refine((line) => (line.basis === 'discount_pct' ? line.discountPct !== null && line.discountPct !== undefined : line.rate !== null && line.rate !== undefined), {
    message: 'A fixed rate needs a rate; a percent-off line needs a percentage.',
    path: ['rate'],
  })
  .refine((line) => (line.basis === 'both' ? line.discountPct !== null && line.discountPct !== undefined : true), { message: 'Rate-less-percent needs both.', path: ['discountPct'] })
  .refine((line) => line.minQty === null || line.minQty === undefined || line.maxQty === null || line.maxQty === undefined || Number(line.minQty) < Number(line.maxQty), {
    message: 'The slab floor must be below its ceiling.',
    path: ['maxQty'],
  });
export type PriceListLineInput = z.infer<typeof priceListLineInputSchema>;

/** REQ-AN-04: one of a party, a party group, or the default. */
export const priceListAssignmentInputSchema = z
  .object({
    partyId: z.uuid().nullish(),
    partyGroup: z.string().trim().min(1).max(200).nullish(),
    isDefault: z.boolean().default(false),
  })
  .refine((a) => [Boolean(a.partyId), Boolean(a.partyGroup), a.isDefault].filter(Boolean).length === 1, {
    message: 'An assignment is to one party, or one party group, or is the default -- exactly one.',
    path: ['partyId'],
  });
export type PriceListAssignmentInput = z.infer<typeof priceListAssignmentInputSchema>;

export const priceListDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullish(),
    notes: z.string().trim().max(2000).nullish(),
    lines: z.array(priceListLineInputSchema).min(1).max(2000),
    assignments: z.array(priceListAssignmentInputSchema).max(500).default([]),
  })
  .refine((d) => d.effectiveTo === null || d.effectiveTo === undefined || d.effectiveFrom <= d.effectiveTo, { message: 'Effective-to must not precede effective-from.', path: ['effectiveTo'] });
export type PriceListDraftInput = z.infer<typeof priceListDraftSchema>;

export const priceListsQuerySchema = pageQuerySchema.extend({
  state: z.enum(PRICE_LIST_STATES).optional(),
  q: z.string().trim().min(1).max(80).optional(),
});
export type PriceListsQuery = z.infer<typeof priceListsQuerySchema>;

export interface PriceListSummary {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly state: PriceListState;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly supersedesId: string | null;
  readonly lineCount: number;
  readonly assignmentCount: number;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly createdByName: string | null;
  readonly approvedAt: string | null;
  readonly approvedByName: string | null;
  readonly supersededAt: string | null;
  readonly approvalRequestId: string | null;
}

export interface PriceListLineView {
  readonly id: string;
  readonly stockItemId: string | null;
  readonly itemName: string | null;
  readonly itemGroup: string | null;
  readonly basis: PriceBasis;
  readonly rate: string | null;
  readonly discountPct: string | null;
  readonly minQty: string | null;
  readonly maxQty: string | null;
}

export interface PriceListAssignmentView {
  readonly id: string;
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly partyGroup: string | null;
  readonly isDefault: boolean;
}

export interface PriceListDetail extends PriceListSummary {
  readonly lines: readonly PriceListLineView[];
  readonly assignments: readonly PriceListAssignmentView[];
}

/** REQ-AN-12: what the approver reads -- which lines moved, by how much, and who is affected. */
export interface PriceListDiffLine {
  readonly key: string;
  readonly itemName: string | null;
  readonly itemGroup: string | null;
  readonly slab: string;
  readonly basis: PriceBasis;
  readonly rate: string | null;
  readonly discountPct: string | null;
}

export interface PriceListDiff {
  readonly against: { readonly id: string; readonly version: number } | null;
  readonly added: readonly PriceListDiffLine[];
  readonly removed: readonly PriceListDiffLine[];
  readonly changed: readonly { readonly before: PriceListDiffLine; readonly after: PriceListDiffLine }[];
  readonly unchanged: number;
  readonly partiesAffected: readonly { readonly id: string | null; readonly name: string }[];
}

/** REQ-AN-13/14: where a rate came from, as the screen and the document line both say it. */
export const RATE_SOURCES = ['party', 'party_group', 'default', 'tally', 'none'] as const;
export type RateSource = (typeof RATE_SOURCES)[number];
export const RATE_SOURCE_LABELS: Record<RateSource, string> = {
  party: "The party's own price list",
  party_group: "The party group's price list",
  default: 'The default price list',
  tally: "The item's rate in Tally",
  none: 'No rate on record',
};

export interface RateResolution {
  /** The rate the line should carry; null when nothing resolves (a free-text line, or an item with no Tally rate). */
  readonly rate: string | null;
  readonly source: RateSource;
  readonly priceListId: string | null;
  readonly priceListVersion: number | null;
  readonly priceListName: string | null;
  readonly basis: PriceBasis | null;
  readonly listRate: string | null;
  readonly discountPct: string | null;
  readonly slab: { readonly minQty: string | null; readonly maxQty: string | null } | null;
  readonly matchedBy: 'item' | 'item_group' | null;
  /** The Tally master's sale price, the fallback and the base for a percent-off line. */
  readonly tallyRate: string | null;
  /** One sentence a salesperson can read out: "why this rate". */
  readonly explanation: string;
}

export const rateSimulationQuerySchema = z.object({
  partyId: z.uuid().optional(),
  stockItemId: z.uuid(),
  quantity: quantityText.default('1'),
  date: isoDate.optional(),
});
export type RateSimulationQuery = z.infer<typeof rateSimulationQuerySchema>;

export interface RateSimulation extends RateResolution {
  readonly partyName: string | null;
  readonly partyGroup: string | null;
  readonly itemName: string;
  readonly itemGroup: string;
  readonly quantity: string;
  readonly date: string;
  /** Every list considered, in resolution order, and why each did or did not apply. */
  readonly considered: readonly { readonly priceListId: string; readonly name: string; readonly version: number; readonly source: RateSource; readonly applied: boolean; readonly why: string }[];
}

export const PRICE_LIST_SUBJECT_TYPE = 'price_list';
