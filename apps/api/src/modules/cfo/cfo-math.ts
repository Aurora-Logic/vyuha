import { epochDay, isoOfEpochDay } from '../../platform/receivables/bill-series.js';

/**
 * Pure date and bucket arithmetic for the receivable snapshot (D-23).
 * Deterministic over its inputs, like the ledger it sits beside: nothing
 * here reads a clock, a database or a setting, so the bucket edges can be
 * pinned exactly in `cfo-math.test.ts`. The snapshot's IST day boundary is
 * `istDateOf` in `platform/tasks/local-date.ts`, shared with the interest
 * build so the two nightly photographs agree on which date a night is.
 */

export type ReceivableBucket = 'current' | '0-30' | '31-60' | '61-90' | '91-180' | '180+';
export type ReceivableSource = 'billwise' | 'voucher';

/** GREATEST(0, snapshot - due): a bill not yet due is 0 days overdue. A bill with no due date cannot age. */
export function daysOverdueOn(snapshotDate: string, dueDate: string | null): number {
  if (dueDate === null) return 0;
  return Math.max(0, epochDay(snapshotDate) - epochDay(dueDate));
}

/**
 * The brief's D02 buckets, aged by DUE date rather than bill date: a bill
 * due today or later is `current`, and each bucket keeps its own last day
 * (overdue day 30 is still '0-30', day 31 opens '31-60').
 */
export function bucketFor(daysOverdue: number): ReceivableBucket {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return '0-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  if (daysOverdue <= 180) return '91-180';
  return '180+';
}

/** Due = the bill's own date plus the credit days, at voucher grain. */
export function dueDateFor(billDate: string, creditDays: number): string {
  return isoOfEpochDay(epochDay(billDate) + creditDays);
}
