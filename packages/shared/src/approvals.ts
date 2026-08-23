import { z } from 'zod';

import {
  APPROVAL_STATUSES,
  APPROVAL_TYPES,
  type ApprovalStatus,
  type ApprovalType,
} from './enums.js';
import { pageQuerySchema } from './pagination.js';
import type { NamedRef } from './people.js';

/**
 * The generic approval framework (REQ-I-01 to REQ-I-05).
 *
 * One mechanism serves leave, regularization, on-duty, flagged punches and
 * device rebinding, and later the CRM and ERP modules. Nothing in this file
 * names a domain: a request is a `(type, subjectType, subjectId)` triple plus
 * a route of steps, and the one human-readable sentence about what is being
 * asked -- `subject` -- is written by whoever raised it.
 *
 * That is the whole reason the subject is a polymorphic pair rather than five
 * nullable foreign keys. A slice attaches to this framework by raising a
 * request with its own `subjectType`; it never adds a column, an enum value,
 * or a branch in here. The moment this file grows a `leaveTypeId`, REQ-I-01's
 * "do not build four separate ones" has happened inside one file.
 */

// ------------------------------------------------------------------ actions

/**
 * Mirrors the `approval_action` Postgres enum. `DELEGATE` and `ESCALATE` are
 * recorded on a step the same way a decision is, so the REQ-I-02 history reads
 * as one sequence rather than a decision list with two side channels.
 */
export const APPROVAL_ACTIONS = ['APPROVE', 'REJECT', 'DELEGATE', 'ESCALATE'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/** The subset a human may perform through the inbox (REQ-I-03). */
export const APPROVAL_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/**
 * The statuses that can still be decided.
 *
 * `ESCALATED` is open, not terminal: REQ-G-09 escalates an untouched request
 * to the next level, and a status that closed it would silently drop the
 * request the escalation existed to rescue.
 */
export const OPEN_APPROVAL_STATUSES = ['PENDING', 'ESCALATED'] as const;

export function isOpenApprovalStatus(status: ApprovalStatus): boolean {
  return (OPEN_APPROVAL_STATUSES as readonly ApprovalStatus[]).includes(status);
}

// ----------------------------------------------------------------- subjects

/**
 * The subject types in use today. Advisory, not a closed set -- the column is
 * text precisely so a later module can attach without a migration -- but a
 * slice should add its value here rather than inventing a string at a call
 * site, so the inbox filter and the audit trail agree on spelling.
 */
export const APPROVAL_SUBJECT_TYPES = [
  'leave_request',
  'comp_off_request',
  'regularization',
  'on_duty_request',
  'punch',
  'device',
  'purchase_order',
  'sales_order',
  'price_list',
] as const;

export type KnownApprovalSubjectType = (typeof APPROVAL_SUBJECT_TYPES)[number];

/**
 * `snake_case`, so a subject type can never collide with a table alias or
 * arrive as a URL-encoded surprise in a query string.
 */
export const approvalSubjectTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u, 'must be lower snake_case');

// ---------------------------------------------------------------- constants

/** REQ-G-09: "Auto-escalate to HR if untouched for N days (default 3)." */
export const DEFAULT_APPROVAL_ESCALATION_DAYS = 3;
export const MAX_APPROVAL_ESCALATION_DAYS = 60;

export const MAX_APPROVAL_REASON_CHARS = 500;
export const MAX_APPROVAL_SUBJECT_CHARS = 300;

/**
 * One page of the inbox is the most a bulk decision may cover. A bulk action
 * runs in one transaction and writes one audit row per request; unbounded, a
 * crafted body would hold the whole table's rows locked.
 */
export const MAX_BULK_APPROVAL_IDS = 200;

// -------------------------------------------------------------- read models

/**
 * One row of the inbox (REQ-I-03).
 *
 * Deliberately identical for every type. `subject` is the raiser's one-line
 * statement of what is being asked -- "Casual Leave, 24-08-2026 to 25-08-2026,
 * 2 days" -- so the inbox can render a leave request and a device rebind with
 * the same code and no branch on `type`.
 */
export interface ApprovalRequestSummary {
  readonly id: string;
  readonly type: ApprovalType;
  /** `snake_case`, from `APPROVAL_SUBJECT_TYPES`; what the row's actions are for. */
  readonly subjectType: string;
  /** The subject's own id, so a row can act on the thing it is about. */
  readonly subjectId: string;
  /** The user who raised it, named. REQ-I-05 refuses to let them decide it. */
  readonly requester: NamedRef;
  readonly subject: string;
  readonly submittedAt: string;
  /** REQ-I-02: which step of the route it is sitting on, 1-based. */
  readonly currentStep: number;
  readonly status: ApprovalStatus;
}

/** REQ-I-02: "history of actions with reasons and timestamps." */
export interface ApprovalStepRecord {
  readonly id: string;
  readonly stepNo: number;
  /** Who the step was routed to. */
  readonly approver: NamedRef;
  /** Who actually acted. Differs from `approver` only under a delegation. */
  readonly actedBy: NamedRef | null;
  /** REQ-I-04: "Delegated actions record both identities." */
  readonly delegatedFrom: NamedRef | null;
  readonly action: ApprovalAction | null;
  readonly reason: string | null;
  readonly actedAt: string | null;
}

export interface ApprovalRequestDetail extends ApprovalRequestSummary {
  /** REQ-I-01's polymorphic subject, for a client that wants to link to it. */
  readonly subjectType: string;
  readonly subjectId: string;
  /** Null once the request is closed. */
  readonly awaiting: NamedRef | null;
  readonly escalatedAt: string | null;
  /** When the current step started; what the escalation job measures from. */
  readonly currentStepStartedAt: string;
  readonly escalateAfterDays: number;
  readonly steps: readonly ApprovalStepRecord[];
}

/** REQ-I-04: an approver hands their decisions to someone for a date range. */
export interface ApprovalDelegation {
  readonly id: string;
  readonly from: NamedRef;
  readonly to: NamedRef;
  /** Date-only `YYYY-MM-DD`, inclusive at both ends. */
  readonly fromDate: string;
  readonly toDate: string;
  readonly reason: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

// -------------------------------------------------------------- the queries

/**
 * Which slice of the approvals the caller is asking about.
 *
 * Separating these is what lets REQ-I-03's inbox and "a requester may always
 * see their own" be one endpoint. They are different questions, and collapsing
 * them into one default would either hide a requester's own request or fill an
 * approver's inbox with everything they ever raised.
 */
export const APPROVAL_VIEWS = ['inbox', 'raised', 'all'] as const;
export type ApprovalView = (typeof APPROVAL_VIEWS)[number];

export const approvalInboxQuerySchema = pageQuerySchema.extend({
  /** Defaults to the inbox: what has been routed to the caller. */
  view: z.enum(APPROVAL_VIEWS).default('inbox'),
  type: z.enum(APPROVAL_TYPES).optional(),
  status: z.enum(APPROVAL_STATUSES).optional(),
  subjectType: approvalSubjectTypeSchema.optional(),
});

export type ApprovalInboxQuery = z.infer<typeof approvalInboxQuerySchema>;

// ------------------------------------------------------------- the commands

const reasonField = z.string().trim().min(1).max(MAX_APPROVAL_REASON_CHARS);

/** An approval may carry a note; REQ-I-02 records it either way. */
export const approveRequestSchema = z.object({
  reason: reasonField.optional(),
});

export type ApproveRequestInput = z.infer<typeof approveRequestSchema>;

/**
 * REQ-F-05: "Rejection requires a reason. The employee is notified with it."
 * Required here rather than checked in a service, so the refusal is a 400 that
 * names the field instead of a domain error the client has to decode.
 */
export const rejectRequestSchema = z.object({
  reason: reasonField,
});

export type RejectRequestInput = z.infer<typeof rejectRequestSchema>;

/**
 * REQ-I-03's bulk action. One request rather than a loop of single calls: a
 * loop that fails halfway leaves the inbox in a state nobody chose.
 *
 * The refinement is the same rule `rejectRequestSchema` states, applied to the
 * shape that can express both verbs. Without it a bulk reject could slip
 * through with no reason while a single reject could not.
 */
export const bulkApprovalDecisionSchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(MAX_BULK_APPROVAL_IDS),
    action: z.enum(APPROVAL_DECISIONS),
    reason: reasonField.optional(),
  })
  .refine((value) => value.action !== 'REJECT' || value.reason !== undefined, {
    path: ['reason'],
    message: 'A rejection must say why.',
  });

export type BulkApprovalDecisionInput = z.infer<typeof bulkApprovalDecisionSchema>;

/**
 * REQ-I-04. Dates rather than instants: a delegation covers working days, and
 * "from the 3rd to the 7th" must not depend on the delegate's timezone.
 */
export const createDelegationSchema = z
  .object({
    toUserId: z.uuid(),
    fromDate: z.iso.date(),
    toDate: z.iso.date(),
    reason: reasonField.optional(),
  })
  .refine((value) => value.toDate >= value.fromDate, {
    path: ['toDate'],
    message: 'The end of a delegation cannot precede its start.',
  });

export type CreateDelegationInput = z.infer<typeof createDelegationSchema>;

// -------------------------------------------------------------- the results

/**
 * Why one request in a bulk action was not acted on.
 *
 * A bulk decision is all-or-nothing per request, never per batch: refusing the
 * whole batch because one row had already been decided by a colleague would
 * make the button unusable on a busy inbox, and silently dropping that row
 * would make the count a lie. Each skip names its reason instead.
 */
export interface BulkApprovalSkip {
  readonly id: string;
  /** An `ErrorCode` from `errors.ts`, so the client maps it like any other. */
  readonly code: string;
  readonly message: string;
}

export interface BulkApprovalResult {
  readonly applied: readonly string[];
  readonly skipped: readonly BulkApprovalSkip[];
}

/**
 * What an approve or reject answers with. The updated request, so the inbox
 * can reconcile without a second round trip, and nothing else.
 */
export type ApprovalDecisionResult = ApprovalRequestDetail;
