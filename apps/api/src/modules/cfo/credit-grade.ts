/**
 * The payment grade A-E (brief D18, weights M9: payment history 40, ageing
 * 25, limit utilisation 15, order-gap trend 10, disputes 10), pure. It
 * answers "will they pay?" -- the system's judgment, nightly -- and must
 * never be confused with the customer class, which answers "how important
 * are they to us?" and is a person's decision (P1).
 *
 * Each factor is a 0-1 badness, weighted and summed to a 0-100 risk;
 * A is under 20, B under 40, C under 60, D under 80, E the rest. The
 * breakdown travels with the grade so a screen can say why.
 */

export interface GradeWeights {
  readonly paymentHistory: number;
  readonly ageing: number;
  readonly utilisation: number;
  readonly orderGap: number;
  readonly disputes: number;
}

export const DEFAULT_GRADE_WEIGHTS: GradeWeights = { paymentHistory: 40, ageing: 25, utilisation: 15, orderGap: 10, disputes: 10 };

export interface GradeSignals {
  /** Days late on average against agreed terms, value-weighted; 0 when on time. */
  readonly avgDaysLate: number;
  /** Promises broken over promises made; 0 when none made. */
  readonly brokenPromiseRate: number;
  /** Overdue as a share of outstanding, 0-1. */
  readonly overdueShare: number;
  /** Outstanding over credit limit, percent; 0 when no limit. */
  readonly utilisationPct: number;
  /** Recent order gaps against their own median: 1 = as usual, 2 = twice as slow. */
  readonly gapRatio: number;
  /** Disputes raised in the trailing year. */
  readonly disputes: number;
}

export type CreditGrade = 'A' | 'B' | 'C' | 'D' | 'E';

export interface GradeReading {
  readonly grade: CreditGrade;
  readonly risk: number;
  readonly breakdown: Record<keyof GradeWeights, number>;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function creditGrade(s: GradeSignals, w: GradeWeights = DEFAULT_GRADE_WEIGHTS): GradeReading {
  // Ninety days late is fully bad; a broken promise counts as much as the
  // lateness it hides.
  const paymentHistory = clamp01(Math.max(s.avgDaysLate / 90, s.brokenPromiseRate));
  const ageing = clamp01(s.overdueShare);
  const utilisation = clamp01((s.utilisationPct - 80) / 70);
  const orderGap = clamp01((s.gapRatio - 1) / 1);
  const disputes = clamp01(s.disputes / 3);
  const breakdown = {
    paymentHistory: round1(paymentHistory * w.paymentHistory),
    ageing: round1(ageing * w.ageing),
    utilisation: round1(utilisation * w.utilisation),
    orderGap: round1(orderGap * w.orderGap),
    disputes: round1(disputes * w.disputes),
  };
  const risk = round1(Object.values(breakdown).reduce((a, b) => a + b, 0));
  const grade: CreditGrade = risk < 20 ? 'A' : risk < 40 ? 'B' : risk < 60 ? 'C' : risk < 80 ? 'D' : 'E';
  return { grade, risk, breakdown };
}
