/**
 * The Director's Desk priority score (brief O2), pure. Score 0-100:
 *
 *   Value x 35 + Urgency x 30 + Risk x 20 + Opportunity x 15 - cooldown
 *
 * Value is trailing-12-month sales, log-scaled against the largest book so
 * an 8,000-rupee customer cannot outrank a 40-lakh one on urgency alone.
 * Urgency is whichever clock is loudest: days overdue over 90, days past
 * their own median gap over 60. Risk is broken promises and limit
 * utilisation (the credit grade joins when grading lands). Opportunity is
 * cross-sell and lost-line money, normalised -- zero until Phase 5 prices
 * it, and the breakdown says so. Cooldown takes 40 points from a name
 * contacted in the last fourteen days with no change.
 *
 * Every factor is returned beside the score: a director will not trust a
 * ranking he cannot inspect.
 */

export interface DeskWeights {
  readonly value: number;
  readonly urgency: number;
  readonly risk: number;
  readonly opportunity: number;
  readonly cooldownPenalty: number;
}

export const DEFAULT_DESK_WEIGHTS: DeskWeights = { value: 35, urgency: 30, risk: 20, opportunity: 15, cooldownPenalty: 40 };

export interface DeskSignals {
  /** Trailing 12-month net sales for this customer. */
  readonly value12m: number;
  /** The largest trailing 12-month net in the company, the top of the log scale. */
  readonly maxValue12m: number;
  readonly daysOverdue: number;
  /** Days since their last order beyond their own median gap; 0 when on time. */
  readonly daysPastGap: number;
  readonly brokenPromises: number;
  /** Outstanding over credit limit, in percent; 0 when no limit. */
  readonly utilisationPct: number;
  /** Cross-sell plus lost-line money, rupees; 0 until Phase 5. */
  readonly opportunityValue: number;
  readonly maxOpportunityValue: number;
  /** Contacted in the last fourteen days without an outcome change. */
  readonly onCooldown: boolean;
}

export interface DeskScore {
  readonly score: number;
  readonly breakdown: {
    readonly value: number;
    readonly urgency: number;
    readonly risk: number;
    readonly opportunity: number;
    readonly cooldown: number;
  };
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function deskScore(s: DeskSignals, w: DeskWeights = DEFAULT_DESK_WEIGHTS): DeskScore {
  const value = s.maxValue12m <= 0 || s.value12m <= 0 ? 0 : clamp01(Math.log1p(s.value12m) / Math.log1p(s.maxValue12m));
  const urgency = clamp01(Math.max(s.daysOverdue / 90, s.daysPastGap / 60));
  // Two broken promises are a fully risky name; utilisation counts from the limit up.
  const risk = clamp01(Math.max(Math.min(s.brokenPromises / 2, 1), (s.utilisationPct - 100) / 100));
  const opportunity = s.maxOpportunityValue <= 0 ? 0 : clamp01(s.opportunityValue / s.maxOpportunityValue);
  const parts = {
    value: round1(value * w.value),
    urgency: round1(urgency * w.urgency),
    risk: round1(risk * w.risk),
    opportunity: round1(opportunity * w.opportunity),
    cooldown: s.onCooldown ? w.cooldownPenalty : 0,
  };
  const score = Math.max(0, round1(parts.value + parts.urgency + parts.risk + parts.opportunity - parts.cooldown));
  return { score, breakdown: parts };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** O3: the weekday's theme, Monday to Friday; Saturday is the week close, Sunday rests. */
export const DESK_THEMES = {
  1: { key: 'money', label: 'Money', hint: 'Collections: the most valuable overdue accounts, not the oldest.' },
  2: { key: 'slipping', label: 'Slipping', hint: 'Declining accounts and widening order gaps.' },
  3: { key: 'quiet', label: 'Quiet', hint: 'Silent churn and win-back.' },
  4: { key: 'price', label: 'Price', hint: 'Margin and leakage -- arrives with the valuation decision (M1).' },
  5: { key: 'grow', label: 'Grow', hint: 'Cross-sell, lost lines and new customers.' },
} as const;

export type DeskThemeKey = (typeof DESK_THEMES)[keyof typeof DESK_THEMES]['key'] | 'mixed' | 'close';

/** Which work lists feed which theme; the score still ranks within it. */
export const THEME_LISTS: Record<Exclude<DeskThemeKey, 'mixed' | 'close'>, readonly string[]> = {
  money: ['overdue-90-plus', 'overdue-61-90', 'overdue-31-60', 'limit-breach', 'overdue-1-30', 'due-this-week'],
  slipping: ['declining', 'gap-widening'],
  quiet: ['silent-churn'],
  price: [],
  grow: [],
};

/** Reasons ranked for the "one customer, one primary reason" rule (O1). */
export const REASON_PRIORITY: readonly string[] = [
  'overdue-90-plus',
  'limit-breach',
  'overdue-61-90',
  'declining',
  'silent-churn',
  'overdue-31-60',
  'gap-widening',
  'overdue-1-30',
  'due-this-week',
];
