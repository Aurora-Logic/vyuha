import { z } from 'zod';

import { pageQuerySchema } from './pagination.js';

/**
 * Area AJ (docs/15): collections. Ageing, statements, tasks and notices
 * already exist; this assembles them into a process -- a promise to pay,
 * a collector per party with a target, follow-up tasks on the party, a
 * reminder with the statement, and the two reports the area exists for.
 *
 * The one rule: collections never writes to a balance (REQ-AJ-12). A
 * promise is intent; whether it was kept is read from the receipts Tally
 * sends against the named bills (REQ-AJ-02), never set by hand. A broken
 * promise flags the credit check and never blocks (docs/11 D-54).
 */

const moneyText = z.string().trim().regex(/^\d{1,14}(\.\d{1,2})?$/u, 'a number with up to two decimals');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'a date as YYYY-MM-DD');

export const PROMISE_STATES = ['open', 'kept', 'partially_kept', 'broken'] as const;
export type PromiseState = (typeof PROMISE_STATES)[number];
export const PROMISE_STATE_LABELS: Record<PromiseState, string> = {
  open: 'Open',
  kept: 'Kept',
  partially_kept: 'Partly kept',
  broken: 'Broken',
};

export const createPromiseSchema = z.object({
  partyId: z.uuid(),
  amount: moneyText.refine((v) => Number(v) > 0, 'more than zero'),
  promisedDate: isoDate,
  /** Bill names as Tally holds them; empty means any receipt from the party counts. */
  bills: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  /** When the promise was taken; defaults to today. */
  takenOn: isoDate.optional(),
  notes: z.string().trim().max(2000).nullish(),
});
export type CreatePromiseInput = z.infer<typeof createPromiseSchema>;

export interface PromiseView {
  readonly id: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly amount: string;
  readonly promisedDate: string;
  readonly bills: readonly string[];
  readonly takenById: string | null;
  readonly takenByName: string | null;
  readonly takenOn: string;
  readonly notes: string | null;
  /** REQ-AJ-02: derived from receipts against the named bills since the promise was taken. */
  readonly state: PromiseState;
  readonly receivedAmount: string;
  /** The latest receipt that counted, when one did. */
  readonly receivedOn: string | null;
  readonly evaluatedAt: string;
  readonly collectorId: string | null;
  readonly collectorName: string | null;
  readonly createdAt: string;
}

export const promiseListQuerySchema = pageQuerySchema.extend({
  partyId: z.uuid().optional(),
  collectorId: z.uuid().optional(),
  state: z.enum(PROMISE_STATES).optional(),
  /** Promised-date window. */
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type PromiseListQuery = z.infer<typeof promiseListQuerySchema>;

/** REQ-AJ-03: one party, one collector at a time; the target is per period. */
export const assignCollectorSchema = z
  .object({
    partyId: z.uuid(),
    /** An employee. */
    collectorId: z.uuid(),
    targetAmount: moneyText.nullish(),
    periodFrom: isoDate,
    periodTo: isoDate.nullish(),
  })
  .refine((a) => a.periodTo === null || a.periodTo === undefined || a.periodFrom <= a.periodTo, { message: 'The period ends before it starts.', path: ['periodTo'] });
export type AssignCollectorInput = z.infer<typeof assignCollectorSchema>;

export interface CollectorAssignmentView {
  readonly id: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly collectorId: string;
  readonly collectorName: string;
  readonly targetAmount: string | null;
  readonly periodFrom: string;
  readonly periodTo: string | null;
  readonly createdAt: string;
}

export const assignmentListQuerySchema = pageQuerySchema.extend({
  collectorId: z.uuid().optional(),
  partyId: z.uuid().optional(),
});
export type AssignmentListQuery = z.infer<typeof assignmentListQuerySchema>;

/** REQ-AJ-07: one collector's morning, or everyone's for a holder of the all key. */
export interface CollectorDashboardRow {
  readonly partyId: string;
  readonly partyName: string;
  readonly collectorId: string | null;
  readonly collectorName: string | null;
  readonly outstanding: string;
  readonly overdue: string;
  /** REQ-AJ-13: the outstanding across the party's open duplicate cluster, when it sits in one; null otherwise. */
  readonly clusterOutstanding: string | null;
  readonly openPromises: number;
  readonly brokenPromises: number;
  readonly nextPromiseDate: string | null;
  readonly lastReminderAt: string | null;
}

export interface CollectorDashboard {
  readonly collector: { readonly id: string; readonly name: string } | null;
  readonly period: { readonly from: string; readonly to: string };
  readonly assignedParties: number;
  readonly totalOutstanding: string;
  readonly overdue: string;
  readonly promisesOpen: number;
  readonly promisesDueToday: number;
  readonly promisesBroken: number;
  /** Receipts from assigned parties in the period. */
  readonly collectedThisPeriod: string;
  readonly target: string | null;
  readonly rows: readonly CollectorDashboardRow[];
}

export const dashboardQuerySchema = z.object({
  collectorId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/**
 * REQ-AJ-05/06: the reminder, and the record of it. The channels are the
 * dispatch notice's own -- email sends itself, WhatsApp waits for a person
 * to say it went (the `manual` fallback until the API lands).
 */
export const REMINDER_CHANNELS = ['email', 'whatsapp', 'manual'] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];
export const REMINDER_CHANNEL_LABELS: Record<ReminderChannel, string> = { email: 'Email', whatsapp: 'WhatsApp', manual: 'By hand' };

export const REMINDER_STATUSES = ['pending', 'sent', 'failed'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];
export const REMINDER_STATUS_LABELS: Record<ReminderStatus, string> = { pending: 'Waiting to be sent', sent: 'Sent', failed: 'Failed' };

export const sendReminderSchema = z.object({
  partyId: z.uuid(),
  channels: z.array(z.enum(REMINDER_CHANNELS)).max(3).default(['email']),
  /** The statement's as-of date; today when absent. */
  asOf: isoDate.optional(),
});
export type SendReminderInput = z.infer<typeof sendReminderSchema>;

/** REQ-AJ-01: the bills a promise can name, as the ageing report reads them. */
export interface OpenBillView {
  readonly billName: string;
  readonly billDate: string | null;
  readonly dueDate: string | null;
  readonly outstanding: string;
  readonly overdue: boolean;
}

export interface ReminderNoticeView {
  readonly id: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly channel: ReminderChannel;
  readonly recipient: string | null;
  readonly status: ReminderStatus;
  readonly composedText: string;
  /** REQ-AJ-06: which day's figures the customer was shown. */
  readonly statementAsOf: string;
  readonly outstandingAtSend: string;
  readonly sentAt: string | null;
  readonly error: string | null;
  readonly createdAt: string;
}
