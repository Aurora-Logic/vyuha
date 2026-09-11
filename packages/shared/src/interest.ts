import { z } from 'zod';

/**
 * Interest cost (D-22): the contracts for the per-party overrides and the
 * on-demand recompute. The report row shapes live in `reports.ts` beside
 * every other report's; this file is the configuration surface.
 *
 * The overrides exist because `parties` is a Tally projection with no
 * application write path: Tally's `credit_days` is read where present and a
 * Vyuha-side row here beats it. A party with neither is flagged "credit
 * terms missing" and accrues from day zero — never a silent 30.
 */

export const INTEREST_DAY_BASES = [365, 360] as const;
export type InterestDayBasis = (typeof INTEREST_DAY_BASES)[number];

export interface InterestPartySettingView {
  readonly partyId: string;
  readonly partyName: string;
  readonly parentGroup: string;
  /** Tally's credit period on the ledger, when the company sets one. */
  readonly tallyCreditDays: number | null;
  readonly creditDaysOverride: number | null;
  /** Percent per annum, to two decimals, or null for the org rate. */
  readonly interestRateOverride: string | null;
  /** Neither Tally nor an override names credit days: accrues from day zero. */
  readonly creditTermsMissing: boolean;
}

export const upsertInterestPartySettingSchema = z
  .object({
    /** Percent per annum. Null clears the override back to the org rate. */
    interestRateOverride: z.number().min(0).max(100).nullable().optional(),
    creditDaysOverride: z.number().int().min(0).max(365).nullable().optional(),
  })
  .refine(
    (value) => value.interestRateOverride !== undefined || value.creditDaysOverride !== undefined,
    { message: 'Send at least one of interestRateOverride or creditDaysOverride.' },
  );

export type UpsertInterestPartySettingInput = z.infer<typeof upsertInterestPartySettingSchema>;

export const recomputeInterestSchema = z.object({
  partyId: z.uuid().optional(),
  stockItemId: z.uuid().optional(),
  /** Rebuild from this date; omitted means the recompute window. */
  from: z.iso.date().optional(),
});

export type RecomputeInterestInput = z.infer<typeof recomputeInterestSchema>;

/** What `POST /interest/recompute` answers: the queued job, for the trail. */
export interface RecomputeInterestReceipt {
  readonly jobId: string;
}

export interface StockInterestSettingView {
  readonly id: string;
  readonly targetType: 'item' | 'category' | 'group';
  readonly targetId: string | null;
  readonly targetName: string;
  /** Percent per annum, or null for org rate. */
  readonly interestRateOverride: string | null;
  /** Holding days before interest starts, or null for org default. */
  readonly holdingPeriodDaysOverride: number | null;
}

export const upsertStockInterestSettingSchema = z.object({
  targetType: z.enum(['item', 'category', 'group']),
  targetId: z.string().nullable().optional(),
  targetName: z.string().min(1),
  interestRateOverride: z.number().min(0).max(100).nullable().optional(),
  holdingPeriodDaysOverride: z.number().int().min(0).max(365).nullable().optional(),
});

export type UpsertStockInterestSettingInput = z.infer<typeof upsertStockInterestSettingSchema>;

export interface StockInterestReportItem {
  readonly stockItemId: string;
  readonly stockItemName: string;
  readonly category: string | null;
  readonly parentGroup: string | null;
  readonly inwardDate: string;
  readonly quantity: number;
  readonly unit: string;
  readonly purchaseRate: string;
  readonly closingValue: string;
  readonly advanceAmount: string;
  readonly advanceTransitDays: number;
  readonly transitInterestAmount: string;
  readonly shelfDays: number;
  readonly holdingPeriodDays: number;
  readonly holdingInterestAmount: string;
  readonly totalInterestAmount: string;
  readonly isNonMoving: boolean;
}

export interface StockInterestReportSummary {
  readonly totalStockValue: string;
  readonly fundedStockValue: string;
  readonly totalTransitInterest: string;
  readonly totalHoldingInterest: string;
  readonly totalAccumulatedInterest: string;
  readonly nonMovingItemsCount: number;
  readonly items: readonly StockInterestReportItem[];
}

export const CATEGORIES = ['MCB', 'MCCB', 'ACB', 'RCCB', 'PQ', 'Other'] as const;
export type Category = (typeof CATEGORIES)[number];

const CATEGORY_RULES: readonly { category: Exclude<Category, 'Other'>; pattern: RegExp }[] = [
  { category: 'MCCB', pattern: /\bMCCB\b|moulded case/iu },
  { category: 'RCCB', pattern: /\bRCCB\b|\bRCBO\b|\bELCB\b|residual current/iu },
  { category: 'ACB', pattern: /\bACB\b|air circuit/iu },
  { category: 'MCB', pattern: /\bMCB\b|miniature circuit|\bDP\b.*\bA\b|\bSP\b.*\bA\b/iu },
  { category: 'PQ', pattern: /\bPQ\b|\bAPFC\b|capacitor|power quality|harmonic|\bkVAr\b/iu },
];

export function categoryOf(itemName: string | null | undefined): Category {
  const name = (itemName ?? '').trim();
  if (name === '') return 'Other';
  for (const rule of CATEGORY_RULES) if (rule.pattern.test(name)) return rule.category;
  return 'Other';
}


