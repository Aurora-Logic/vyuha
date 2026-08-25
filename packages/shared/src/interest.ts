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
