import { sql, type SQL } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { ALIVE, primaryId, standardColumns } from '../columns.js';
import { users } from './identity.schema.js';
import { organizations } from './organizations.schema.js';

export const approvalTypeEnum = pgEnum('approval_type', [
  'LEAVE',
  'REGULARIZATION',
  'ON_DUTY',
  'FLAGGED_PUNCH',
  'DEVICE_REBIND',
  'PURCHASE_ORDER',
  'SALES_DISCOUNT',
  // 15 REQ-AN-09: a price list awaiting pricing.approve.
  'PRICE_LIST',
]);

export const approvalStatusEnum = pgEnum('approval_status', [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'ESCALATED',
]);

/** Null on a step nobody has acted on yet, which is how "awaiting" is stored. */
export const approvalActionEnum = pgEnum('approval_action', [
  'APPROVE',
  'REJECT',
  'DELEGATE',
  'ESCALATE',
]);

/**
 * REQ-I-01. One framework for every approvable thing, which is why the subject
 * is a polymorphic (type, id) pair rather than five nullable foreign keys: CRM
 * and ERP will raise approvals too (technical design §14.4), and a column per
 * subject type would mean a migration for each.
 */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    type: approvalTypeEnum('type').notNull(),
    requesterUserId: uuid('requester_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    /**
     * REQ-I-03: the one line the inbox renders, written by whoever raised the
     * request. It lives here rather than being joined per type because the
     * join is the thing REQ-I-01 forbids -- five subject tables would mean
     * five branches in the inbox query, which is four separate inboxes wearing
     * one URL.
     */
    subjectSummary: text('subject_summary').notNull(),
    currentStep: integer('current_step').notNull().default(1),
    status: approvalStatusEnum('status').notNull().default('PENDING'),
    /**
     * When the current step began. REQ-G-09's "untouched for N days" is
     * measured from here and not from `updated_at`, which any write touches --
     * a notification flag flipped by a job would otherwise reset the clock the
     * escalation depends on.
     */
    currentStepStartedAt: timestamp('current_step_started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * REQ-G-09's N, carried on the request rather than read at escalation
     * time. The leave type that configured it may be edited afterwards, and a
     * request must escalate on the terms it was raised under.
     */
    escalateAfterDays: integer('escalate_after_days').notNull().default(3),
    /** REQ-G-09: set by the escalation job, so it is a fact, not a flag. */
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    ...standardColumns(),
  },
  (t) => [
    // Technical design §4.3, verbatim: the approvals inbox query.
    index('approval_requests_queue_idx').on(t.orgId, t.status, t.currentStep),
    index('approval_requests_subject_idx').on(t.orgId, t.subjectType, t.subjectId),
    index('approval_requests_requester_idx').on(t.orgId, t.requesterUserId),
    // The escalation sweep runs org-wide across every organisation, so org_id
    // is deliberately not the leading column: the job asks "what is stale
    // anywhere", and a leading org_id would make that a full scan per org.
    index('approval_requests_escalation_idx').on(t.status, t.currentStepStartedAt),
  ],
);

/**
 * Durable post-commit work for a decision/escalation. The subject's state is
 * changed in the same transaction that inserts this row; derived recomputes,
 * notifications and external queue hand-offs may then retry independently
 * without making a committed decision look like an HTTP failure.
 */
export const approvalSettlementOutbox = pgTable(
  'approval_settlement_outbox',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    approvalRequestId: uuid('approval_request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').notNull(),
    /** JSON form of `ApprovalSubjectDecision`, validated on recovery. */
    decision: jsonb('decision').notNull(),
    eventKey: text('event_key').notNull(),
    state: text('state').notNull().default('PENDING'), // PENDING | DONE
    attempts: integer('attempts').notNull().default(0),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    claimToken: uuid('claim_token'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    lastError: text('last_error'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('approval_settlement_outbox_event_uq').on(t.eventKey),
    index('approval_settlement_outbox_pending_idx').on(t.state, t.runAfter),
  ],
);

/** REQ-I-02/I-03: the per-step record, including who a step was delegated from. */
export const approvalSteps = pgTable(
  'approval_steps',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    approvalRequestId: uuid('approval_request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    stepNo: integer('step_no').notNull(),
    /** Who the step was routed to. Never changes once the step exists. */
    approverUserId: uuid('approver_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /**
     * REQ-I-04: "Delegated actions record both identities." `acted_by` is the
     * person who clicked and `delegated_from` is the approver whose authority
     * they borrowed; on an ordinary decision `acted_by` equals
     * `approver_user_id` and `delegated_from` is null. Storing only one of the
     * two would make a delegated approval indistinguishable from the approver
     * having done it themselves, which is exactly what the requirement is
     * about.
     */
    actedByUserId: uuid('acted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    delegatedFromUserId: uuid('delegated_from_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    action: approvalActionEnum('action'),
    /** REQ-F-05: a rejection is not valid without one. */
    reason: text('reason'),
    actedAt: timestamp('acted_at', { withTimezone: true }),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('approval_steps_request_step_uq')
      .on(t.approvalRequestId, t.stepNo)
      .where(ALIVE),
    index('approval_steps_approver_idx').on(t.orgId, t.approverUserId),
  ],
);

/**
 * REQ-I-04: "an approver can delegate to another user for a date range."
 *
 * A standing grant rather than a per-request handover, because the case it
 * exists for is an approver going on leave -- they cannot enumerate the
 * requests that have not arrived yet. Whether a delegation is live is a
 * question about today's date, asked at decision time; nothing is copied onto
 * a request when a delegation is created, so revoking one takes effect
 * immediately rather than leaving already-routed requests behind.
 */
export const approvalDelegations = pgTable(
  'approval_delegations',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Inclusive at both ends. NFR-05: calendar dates, not instants. */
    fromDate: date('from_date').notNull(),
    toDate: date('to_date').notNull(),
    reason: text('reason'),
    /** Revoked rather than deleted: the trail has to keep saying it existed. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...standardColumns(),
  },
  (t) => [
    // The decision-time lookup: "is anyone delegating to me today". Ordered
    // delegate-first because that is the bound column on every check.
    index('approval_delegations_delegate_idx').on(t.orgId, t.toUserId, t.fromDate, t.toDate),
    index('approval_delegations_owner_idx').on(t.orgId, t.fromUserId),
  ],
);

/**
 * The predicate for "this delegation is live on `on`", written once.
 *
 * Exported from the schema rather than a repository because both the decision
 * path and the delegation list ask it, and two hand-written copies of a date
 * range comparison is how a revoked delegation stays usable for a day.
 */
export function delegationLiveOn(on: SQL | string): SQL {
  return sql`${approvalDelegations.revokedAt} IS NULL
    AND ${approvalDelegations.fromDate} <= ${on}
    AND ${approvalDelegations.toDate} >= ${on}`;
}
