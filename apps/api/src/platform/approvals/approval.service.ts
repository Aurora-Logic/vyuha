import { Injectable, Logger } from '@nestjs/common';
import {
  APPROVAL_ACT_KEYS,
  APPROVAL_SCOPE_KEYS,
  DEFAULT_APPROVAL_ESCALATION_DAYS,
  ERROR_CODES,
  MAX_APPROVAL_ESCALATION_DAYS,
  MAX_APPROVAL_SUBJECT_CHARS,
  PERMISSIONS,
  pageSlice,
  paginated,
  type ApprovalDecision,
  type ApprovalDelegation,
  type ApprovalInboxQuery,
  type ApprovalRequestDetail,
  type ApprovalRequestSummary,
  type ApprovalType,
  type BulkApprovalDecisionInput,
  type BulkApprovalResult,
  type BulkApprovalSkip,
  type CreateDelegationInput,
  type Paginated,
  type PermissionKey,
} from '@vyuha/shared';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, describeError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import type { OrgContext } from '../db/scoped-repository.js';
import { NOTIFICATION_EVENTS } from '../notifications/notification-events.js';
import { NotificationDispatcher } from '../notifications/notification.dispatcher.js';
import {
  hasAnyPermission,
  hasPermission,
  orgContextOf,
  type Principal,
} from '../rbac/principal.js';
import { ScopeService, type ScopeGrants } from '../rbac/scope.service.js';
import { users } from '../db/schema/index.js';
import { approvalDelegations, delegationLiveOn } from '../db/schema/approval.schema.js';
import { ApprovalRoutingService } from './approval-routing.service.js';
import {
  ApprovalSubjectRegistry,
  type ApprovalSubjectSettlement,
} from './approval-subject.registry.js';
import {
  evaluateDecision,
  isStale,
  nextEscalationTarget,
  planRoute,
  type DecisionRefusal,
} from './approval-policy.js';
import {
  ApprovalDelegationRepository,
  ApprovalRepository,
  ApprovalStepRepository,
  ApprovalSweepRepository,
  toDelegation,
  type ApprovalListFilters,
} from './approval.repository.js';

/**
 * The approval framework (REQ-I-01 … REQ-I-05).
 *
 * Two audiences. Over HTTP it is the inbox: list, decide, delegate. In process
 * it is the seam every other slice attaches to -- `raise`, `findForSubject`,
 * `cancelForSubject` -- and that seam is the part that has to stay still,
 * because the leave slice is written against it while this file is being
 * finished. Nothing in here knows what a leave request is.
 *
 * The rules themselves are not here. They are pure functions in
 * `approval-policy.ts`, so REQ-I-05 can be exercised exhaustively without a
 * database; this file supplies the facts those functions decide on and turns
 * their verdicts into `AppError`s.
 */

/**
 * The permission family for approvals, widest first, derived from the
 * REQ-P-04 catalogue rather than named here.
 *
 * `self` is the union of every subject type's raise keys: PRD §5 gives a
 * requester the right to see their own request, whichever kind it is. The
 * `team` and `all` bands are only the keys each subject *declared* as
 * browse-widening — holding `regularization.approve` decides what is routed
 * to you; it has never meant browsing the team's inbox, and deriving that
 * from `act` would have quietly made it so.
 */
export const APPROVAL_SCOPE_GRANTS: ScopeGrants = APPROVAL_SCOPE_KEYS;

/** `exclusion_violation`, Postgres error class 23. */
const EXCLUSION_VIOLATION = '23P01';

/**
 * Drizzle wraps a driver failure in an error whose message is the SQL and puts
 * the real one in `cause`, so the code is never on the error that was thrown.
 * `pg-error.ts` does the same walk for unique violations; this is the one code
 * it does not cover, and it lives here rather than in the platform file
 * because the overlapping-delegation constraint is the only thing that raises
 * it today.
 */
function isExclusionViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth <= 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ('code' in current && current.code === EXCLUSION_VIOLATION) return true;
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}

/**
 * What a slice hands the framework to put something up for approval.
 *
 * `subject` is the sentence the inbox renders, and it is required for the
 * reason REQ-I-01 gives: the alternative is the inbox joining five subject
 * tables and branching on type, which is four inboxes wearing one URL.
 */
export interface RaiseApprovalInput {
  readonly type: ApprovalType;
  /** `snake_case`; see `APPROVAL_SUBJECT_TYPES` in the shared contract. */
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subject: string;
  readonly requesterUserId: string;
  /**
   * The route, nearest approver first. Omit it and the framework builds the
   * REQ-G-09 default: the reporting line, then everyone who can approve for
   * the whole organisation.
   */
  readonly approverUserIds?: readonly string[];
  /** REQ-G-09's N. 0 disables escalation for this request. */
  readonly escalateAfterDays?: number;
}

/** How many stale requests one sweep will move. */
const ESCALATION_BATCH = 500;

export interface EscalationOutcome {
  readonly scanned: number;
  readonly escalated: number;
  /** Stale, but the reporting line above them is exhausted. */
  readonly exhausted: number;
}

/**
 * Rolls the decision transaction back and carries the refusal out of it.
 *
 * A refusal cannot simply be returned from inside the transaction body: by the
 * time one is known the step may already carry a decision (`recordAction`
 * writes before `advance` is attempted), and returning would commit that write
 * while telling the caller nothing happened. Throwing is what rolls it back;
 * this class is what stops the throw being mistaken for a real failure.
 */
class DecisionRefused extends Error {
  constructor(readonly refusal: DecisionRefusal) {
    super(refusal.message);
    this.name = 'DecisionRefused';
  }
}

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly scopes: ScopeService,
    private readonly auditContext: AuditContext,
    private readonly audit: AuditService,
    private readonly routing: ApprovalRoutingService,
    private readonly subjects: ApprovalSubjectRegistry,
    private readonly notifications: NotificationDispatcher,
  ) {}

  // ------------------------------------------------------- the in-process seam

  /**
   * Puts a subject up for approval (REQ-I-01, REQ-I-02).
   *
   * The whole route is written as steps up front rather than one step at a
   * time. That makes "is there a level above this one" a lookup instead of a
   * re-derivation, which matters because the escalation job asks it hours
   * later, when the reporting line may have changed -- re-deriving would move
   * a request to somebody the requester never routed it to.
   *
   * `executor` lets the raising slice pass its own transaction, so the subject
   * row and the approval that governs it are one fact. Without it, a slice
   * whose insert committed and whose raise then failed would own a record
   * nobody can ever see in an inbox and nobody can ever decide.
   */
  async raise(
    ctx: OrgContext,
    input: RaiseApprovalInput,
    executor: Database = this.db,
  ): Promise<ApprovalRequestDetail> {
    // Nothing may be raised that nothing can apply. See
    // `ApprovalSubjectRegistry` -- an approved request whose subject never
    // moved is the failure this framework must not be able to produce, and
    // refusing at the raise is refusing it before it can exist.
    if (this.subjects.get(input.subjectType) === null) {
      throw AppError.conflict(
        `Nothing is registered to apply an approval of subject type "${input.subjectType}", so a request of it could never be carried out.`,
        { subjectType: input.subjectType, registered: this.subjects.registeredSubjectTypes() },
      );
    }

    // Checked here rather than left to the contract's constants to be honoured
    // by convention: `raise` is called in process by other slices, so there is
    // no Zod pipe between them and this, and an exported limit nothing enforces
    // is worse than no limit at all.
    const subject = input.subject.trim();
    if (subject.length === 0 || subject.length > MAX_APPROVAL_SUBJECT_CHARS) {
      throw AppError.validation(
        `An approval needs a subject line of 1 to ${String(MAX_APPROVAL_SUBJECT_CHARS)} characters.`,
        { fields: [{ path: 'subject', message: 'must be a short, readable line' }] },
      );
    }

    // REQ-G-09 / P2-2 (closed 28 Aug 2026): the org's configured escalation
    // window, read when the request is raised so every step it ever takes
    // carries one consistent number. A malformed or absent row falls back to
    // the shared default -- an approval must never fail to be raised because
    // a setting cannot parse.
    const escalateAfterDays = input.escalateAfterDays ?? (await this.configuredEscalationDays(ctx.orgId));
    if (escalateAfterDays < 0 || escalateAfterDays > MAX_APPROVAL_ESCALATION_DAYS) {
      throw AppError.validation(
        `Escalation must be between 0 and ${String(MAX_APPROVAL_ESCALATION_DAYS)} days; 0 disables it.`,
        { fields: [{ path: 'escalateAfterDays', message: 'out of range' }] },
      );
    }

    const candidates =
      input.approverUserIds ?? (await this.routing.defaultRoute(ctx.orgId, input.requesterUserId));

    // REQ-I-05, applied before the request exists: a route whose first level is
    // the requester would sit in its author's own inbox until the escalation
    // job rescued it.
    const route = planRoute(input.requesterUserId, candidates);

    if (route.length === 0) {
      throw AppError.conflict(
        'This request has nobody to approve it. Set a reporting manager, or give someone leave.approve.all.',
        { subjectType: input.subjectType, subjectId: input.subjectId },
      );
    }

    const requests = new ApprovalRepository(executor, ctx, this.subjects);
    const steps = new ApprovalStepRepository(executor, ctx);

    const request = await requests.insert({
      type: input.type,
      requesterUserId: input.requesterUserId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectSummary: subject,
      currentStep: 1,
      status: 'PENDING',
      currentStepStartedAt: new Date(),
      escalateAfterDays,
    });

    await steps.insertMany(
      route.map((approverUserId, index) => ({
        approvalRequestId: request.id,
        stepNo: index + 1,
        approverUserId,
      })),
    );

    this.auditContext.record({
      action: 'approval.raised',
      entityType: 'approval_request',
      entityId: request.id,
      orgId: ctx.orgId,
      after: {
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        route,
      },
    });

    // Read back through the same executor: inside a caller's transaction the
    // rows above are not visible to any other connection yet.
    return this.buildDetail(ctx, request.id, executor);
  }

  /** The current approval for a subject, if it has one. */
  async findForSubject(
    ctx: OrgContext,
    subjectType: string,
    subjectId: string,
  ): Promise<ApprovalRequestDetail | null> {
    const row = await new ApprovalRepository(this.db, ctx, this.subjects).findBySubject(subjectType, subjectId);
    return row === null ? null : this.buildDetail(ctx, row.id);
  }

  /**
   * Withdraws an open request (REQ-G-10: an employee cancels their own leave
   * before it starts). Returns null when there was nothing open to cancel,
   * which is not an error -- the caller's subject is being cancelled either
   * way, and a request already decided is a fact, not a failure.
   */
  async cancelForSubject(
    ctx: OrgContext,
    subjectType: string,
    subjectId: string,
    reason: string,
  ): Promise<ApprovalRequestDetail | null> {
    const requests = new ApprovalRepository(this.db, ctx, this.subjects);
    const row = await requests.findBySubject(subjectType, subjectId);
    if (row === null || (row.status !== 'PENDING' && row.status !== 'ESCALATED')) return null;

    // The open step is deliberately left unanswered. Writing `REJECT` onto it
    // would put "rejected by the requester" in the REQ-I-02 history for
    // something nobody decided -- a withdrawal is the absence of a decision,
    // and the reason for it belongs in the trail, which the audit row carries.
    const now = new Date();
    const updated = await requests.advance(row.id, row.currentStep, row.currentStep, 'CANCELLED', now);
    if (updated === null) return null;

    this.auditContext.record({
      action: 'approval.cancelled',
      entityType: 'approval_request',
      entityId: row.id,
      orgId: ctx.orgId,
      before: { status: row.status },
      after: { status: 'CANCELLED', reason },
    });

    return this.buildDetail(ctx, row.id);
  }

  // ------------------------------------------------------------------ reading

  async list(
    principal: Principal,
    query: ApprovalInboxQuery,
  ): Promise<Paginated<ApprovalRequestSummary>> {
    const { limit, offset } = pageSlice(query);
    const ctx = orgContextOf(principal);

    const { rows, total } = await new ApprovalRepository(this.db, ctx, this.subjects).list({
      ...this.filtersFor(principal, query),
      limit,
      offset,
    });

    return paginated(rows, query, total);
  }

  async detail(principal: Principal, id: string): Promise<ApprovalRequestDetail> {
    const ctx = orgContextOf(principal);
    const requests = new ApprovalRepository(this.db, ctx, this.subjects);

    // Visibility is checked as its own predicate rather than by fetching and
    // comparing: out of scope and non-existent must answer identically, or a
    // 403 confirms that the id names a real request in somebody else's team.
    const visible = await requests.isVisible(id, {
      ...this.filtersFor(principal, { view: 'all', page: 1, pageSize: 1 }),
      limit: 1,
      offset: 0,
    });
    if (!visible) throw AppError.notFound('Approval request', id);

    return this.buildDetail(ctx, id);
  }

  // ----------------------------------------------------------------- deciding

  async decide(
    principal: Principal,
    id: string,
    action: ApprovalDecision,
    reason: string | null,
  ): Promise<ApprovalRequestDetail> {
    const ctx = orgContextOf(principal);
    const outcome = await this.applyDecision(principal, ctx, id, action, reason);
    if (!outcome.ok) throw this.toError(outcome.refusal);
    if (outcome.settle !== null) await outcome.settle();
    return this.buildDetail(ctx, id);
  }

  /**
   * REQ-I-03's bulk action.
   *
   * Each request is decided on its own terms and a refusal skips that request
   * rather than the batch. Refusing everything because one row was decided by
   * a colleague thirty seconds ago would make the button unusable on exactly
   * the inbox it exists for; dropping that row silently would make the count a
   * lie. The skip list is how the client says which and why.
   */
  async bulkDecide(
    principal: Principal,
    input: BulkApprovalDecisionInput,
  ): Promise<BulkApprovalResult> {
    const ctx = orgContextOf(principal);
    const applied: string[] = [];
    const skipped: BulkApprovalSkip[] = [];

    // Deduplicated: the same id twice would be decided once and counted twice.
    for (const id of [...new Set(input.ids)]) {
      const outcome = await this.applyDecision(
        principal,
        ctx,
        id,
        input.action,
        input.reason ?? null,
      );
      if (!outcome.ok) {
        skipped.push({ id, code: outcome.refusal.code, message: outcome.refusal.message });
        continue;
      }
      // Settled one at a time rather than gathered and run at the end: the
      // decision is already committed, so a failure here must not stop the
      // rows after it from being told about their own decisions.
      if (outcome.settle !== null) await outcome.settle();
      applied.push(id);
    }

    return { applied, skipped };
  }

  // -------------------------------------------------------------- delegation

  /** REQ-I-04. The caller delegates their own decisions; never anyone else's. */
  async createDelegation(
    principal: Principal,
    input: CreateDelegationInput,
  ): Promise<ApprovalDelegation> {
    if (input.toUserId === principal.userId) {
      throw AppError.validation('You cannot delegate your approvals to yourself.', {
        fields: [{ path: 'toUserId', message: 'must be another user' }],
      });
    }

    const delegate = await this.delegateOf(principal.orgId, input.toUserId);
    if (delegate === null) {
      throw AppError.notFound('User', input.toUserId);
    }
    if (!delegate.canApprove) {
      // Refused rather than allowed to stand: a delegate with no approval key
      // is refused by the route guard when they try to act, and the approver
      // who delegated would have no way to discover that their cover does not
      // work until a request went unanswered.
      //
      // "Anything" is the honest word now that the inbox carries more than one
      // kind of request: holding an approval key is what this refuses on, and
      // whether the delegate may decide any *particular* request is still the
      // subject handler's `actPermissions` answer at decision time. A delegate
      // who covers leave but not corrections is a working delegation with a
      // hole in it, and that hole is the delegator's to know about.
      throw AppError.conflict(
        'That user cannot approve anything, so a delegation to them would do nothing. Give them leave.approve.team first.',
        { toUserId: input.toUserId },
      );
    }

    const ctx = orgContextOf(principal);
    const repository = new ApprovalDelegationRepository(this.db, ctx);

    let created;
    try {
      created = await repository.insert({
        fromUserId: principal.userId,
        toUserId: input.toUserId,
        fromDate: input.fromDate,
        toDate: input.toDate,
        reason: input.reason ?? null,
      });
    } catch (error: unknown) {
      if (isExclusionViolation(error)) {
        throw AppError.conflict(
          'You already have a live delegation to that user covering some of those dates.',
          { toUserId: input.toUserId, fromDate: input.fromDate, toDate: input.toDate },
        );
      }
      throw error;
    }

    const row = await repository.findJoined(created.id);
    if (row === null) {
      throw new Error('Delegation was written but could not be read back.');
    }

    this.auditContext.record({
      action: 'approval.delegated',
      entityType: 'approval_delegation',
      entityId: created.id,
      orgId: principal.orgId,
      after: {
        toUserId: input.toUserId,
        fromDate: input.fromDate,
        toDate: input.toDate,
        reason: input.reason ?? null,
      },
    });

    return toDelegation(row);
  }

  /** Both directions: what the caller granted, and what was granted to them. */
  async listDelegations(principal: Principal): Promise<ApprovalDelegation[]> {
    const rows = await new ApprovalDelegationRepository(
      this.db,
      orgContextOf(principal),
    ).involving(principal.userId);
    return rows.map(toDelegation);
  }

  async revokeDelegation(principal: Principal, id: string): Promise<ApprovalDelegation> {
    const ctx = orgContextOf(principal);
    const repository = new ApprovalDelegationRepository(this.db, ctx);

    const row = await repository.findJoined(id);
    // Out of scope and non-existent answer identically, as everywhere else.
    if (row === null) throw AppError.notFound('Delegation', id);

    // The owner, or someone who can approve for the whole organisation and so
    // has to be able to undo a delegation made by an approver who has left.
    const isOwner = row.fromUserId === principal.userId;
    if (!isOwner && !hasPermission(principal, PERMISSIONS.LEAVE_APPROVE_ALL)) {
      throw AppError.forbidden('Only the approver who made a delegation can withdraw it.');
    }

    const revoked = await repository.revoke(id, new Date());
    if (!revoked) throw AppError.conflict('That delegation has already been withdrawn.');

    this.auditContext.record({
      action: 'approval.delegation_revoked',
      entityType: 'approval_delegation',
      entityId: id,
      orgId: principal.orgId,
      before: { revokedAt: null },
      after: { revokedAt: new Date().toISOString() },
    });

    const after = await repository.findJoined(id);
    if (after === null) throw new Error('Delegation was revoked but could not be read back.');
    return toDelegation(after);
  }

  // -------------------------------------------------------------- escalation

  /**
   * REQ-G-09: "Auto-escalate to HR if untouched for N days (default 3)."
   *
   * Idempotent by construction rather than by a flag: moving a request sets
   * `current_step_started_at` to now, so a second sweep in the same minute
   * finds nothing stale. A run interrupted halfway leaves exactly the
   * unescalated requests selectable.
   *
   * Not org-scoped, because the job is not a person -- see
   * `ApprovalSweepRepository`. Every write below goes through a scoped
   * repository built with the org id the sweep returned.
   */
  private async configuredEscalationDays(orgId: string): Promise<number> {
    const row = await this.db.execute<{ value: unknown }>(sql`
      SELECT value FROM settings
      WHERE org_id = ${orgId} AND scope = 'ORG' AND scope_id IS NULL AND deleted_at IS NULL
        AND key = 'attendance.auto_escalation_days'
      LIMIT 1
    `);
    const value = Number(row.rows[0]?.value);
    return Number.isInteger(value) && value >= 1 && value <= MAX_APPROVAL_ESCALATION_DAYS
      ? value
      : DEFAULT_APPROVAL_ESCALATION_DAYS;
  }

  async escalateStale(now: Date): Promise<EscalationOutcome> {
    const candidates = await new ApprovalSweepRepository(this.db).stale(now, ESCALATION_BATCH);

    let escalated = 0;
    let exhausted = 0;

    for (const candidate of candidates) {
      // The SQL already applied the threshold; re-asking in the domain
      // function is what keeps the two definitions of "stale" from drifting,
      // and costs nothing per row.
      if (
        !isStale({
          now,
          currentStepStartedAt: candidate.currentStepStartedAt,
          escalateAfterDays: candidate.escalateAfterDays,
        })
      ) {
        continue;
      }

      // Null actor: `columns.ts` says the audit trail is authoritative for
      // who, and a job has no user to name.
      const ctx: OrgContext = { orgId: candidate.orgId, actorUserId: null };

      try {
        if (await this.escalateOne(ctx, candidate.id)) escalated += 1;
        else exhausted += 1;
      } catch (error: unknown) {
        // One bad request must not stop the sweep, and a swallowed failure
        // must not look like a clean run -- so it is counted as untouched and
        // logged with its id.
        exhausted += 1;
        this.logger.error({
          msg: 'Escalating one approval request failed; the sweep continued.',
          approvalRequestId: candidate.id,
          orgId: candidate.orgId,
          reason: describeError(error),
        });
      }
    }

    return { scanned: candidates.length, escalated, exhausted };
  }

  // ---------------------------------------------------------------- internals

  private filtersFor(
    principal: Principal,
    query: Pick<ApprovalInboxQuery, 'view'> & Partial<ApprovalInboxQuery>,
  ): Omit<ApprovalListFilters, 'limit' | 'offset'> {
    return {
      view: query.view,
      scope: this.scopeFor(principal),
      actorUserId: principal.userId,
      type: query.type,
      status: query.status,
      subjectType: query.subjectType,
    };
  }

  /**
   * Technical design §10: the fragment comes from `ScopeService`, never from
   * here. Written against the *requester's* employee id, which is the column
   * naming the person an approval request is about.
   */
  private scopeFor(principal: Principal): SQL {
    return this.scopes.resolve(
      principal,
      APPROVAL_SCOPE_GRANTS,
      sql`"requester_user"."employee_id"`,
    ).where;
  }

  /**
   * One decision, end to end, returning a refusal rather than throwing.
   *
   * Shared by the single and bulk paths so there is exactly one place REQ-I-05
   * is enforced. A bulk path with its own copy of these checks is how the rule
   * ends up true for one endpoint and not the other.
   *
   * **Everything that must agree happens in one transaction**: the step is
   * answered, the request is advanced, and -- when the request has reached a
   * status the subject cares about -- the owning slice applies the decision to
   * its own records. That last part is why the transaction exists. The leave
   * handler writes to an append-only ledger, and a ledger row written by a step
   * whose partner then failed cannot be taken back. Committing them separately
   * would leave "approved, but nothing deducted" or "deducted, but still
   * pending" as reachable states, and neither says which one it is.
   *
   * Exactly-once is a property of `advance`, not of a flag: it is a
   * compare-and-swap on `(current_step, status)`, so of two callers deciding
   * the same request at the same instant, exactly one matches a row and
   * exactly one calls the handler. The loser writes nothing and is told the
   * request was already decided.
   */
  private async applyDecision(
    principal: Principal,
    ctx: OrgContext,
    id: string,
    action: ApprovalDecision,
    reason: string | null,
  ): Promise<
    | { ok: true; settle: ApprovalSubjectSettlement | null }
    | { ok: false; refusal: DecisionRefusal }
  > {
    try {
      return await this.db.transaction(async (tx) => {
        const outcome = await this.decideWithin(tx, principal, ctx, id, action, reason);
        if (!outcome.ok) throw new DecisionRefused(outcome.refusal);
        return outcome;
      });
    } catch (error: unknown) {
      if (error instanceof DecisionRefused) return { ok: false, refusal: error.refusal };
      throw error;
    }
  }

  /** The body of one decision, against whichever executor is in play. */
  private async decideWithin(
    tx: Database,
    principal: Principal,
    ctx: OrgContext,
    id: string,
    action: ApprovalDecision,
    reason: string | null,
  ): Promise<
    | { ok: true; settle: ApprovalSubjectSettlement | null }
    | { ok: false; refusal: DecisionRefusal }
  > {
    const requests = new ApprovalRepository(tx, ctx, this.subjects);
    const steps = new ApprovalStepRepository(tx, ctx);

    const request = await requests.findRow(id);
    if (request === null) {
      // Inside a bulk body this is a skip, not a 404 for the whole batch.
      return {
        ok: false,
        refusal: { code: 'FORBIDDEN', message: 'That request does not exist.' },
      };
    }

    // Defence in depth behind the same check in `raise`: a row raised before
    // its slice registered a handler -- or after that slice was removed --
    // must not be decidable, because deciding it would move the inbox and
    // nothing else. See `ApprovalSubjectRegistry`.
    const handler = this.subjects.get(request.subjectType);
    if (handler === null) {
      return {
        ok: false,
        refusal: {
          code: 'FORBIDDEN',
          message: `Nothing is registered to carry out a decision on a "${request.subjectType}", so this request cannot be decided.`,
        },
      };
    }

    // The key that authorises *this kind* of request, asked of the slice that
    // owns it. The route guard could only ask whether the caller approves
    // anything; see `APPROVAL_ACT_KEYS`. Placed before the eligibility check so
    // somebody with no business deciding this kind of request is told that,
    // rather than being told whose turn it is.
    if (!hasAnyPermission(principal, handler.actPermissions)) {
      return {
        ok: false,
        refusal: {
          code: 'FORBIDDEN',
          message: 'You do not hold the permission that decides this kind of request.',
        },
      };
    }

    const current = await steps.at(id, request.currentStep);

    const eligibility = evaluateDecision({
      actorUserId: principal.userId,
      requesterUserId: request.requesterUserId,
      status: request.status,
      currentApproverUserId: current?.approverUserId ?? null,
      delegatedFromUserIds: await this.liveDelegatorsTo(principal, handler.actPermissions),
      hasApproveAll: hasAnyPermission(principal, handler.overridePermissions),
    });

    if (!eligibility.ok) return { ok: false, refusal: eligibility.refusal };

    if (current === null) {
      // Open, but its route ran out -- an escalation with nowhere to go left
      // it here. Nobody can act until the route is extended.
      return {
        ok: false,
        refusal: {
          code: 'APPROVAL_ALREADY_ACTIONED',
          message: 'This request has no approver at its current step.',
        },
      };
    }

    const now = new Date();

    const recorded = await steps.recordAction({
      stepId: current.id,
      action,
      actedByUserId: principal.userId,
      delegatedFromUserId: eligibility.delegatedFromUserId,
      reason,
      at: now,
    });
    if (!recorded) {
      return {
        ok: false,
        refusal: {
          code: 'APPROVAL_ALREADY_ACTIONED',
          message: 'Somebody decided this step first.',
        },
      };
    }

    const next = action === 'APPROVE' ? await steps.at(id, request.currentStep + 1) : null;
    const updated =
      action === 'REJECT'
        ? await requests.advance(id, request.currentStep, request.currentStep, 'REJECTED', now)
        : next === null
          ? await requests.advance(id, request.currentStep, request.currentStep, 'APPROVED', now)
          : await requests.advance(id, request.currentStep, next.stepNo, 'PENDING', now);

    if (updated === null) {
      return {
        ok: false,
        refusal: {
          code: 'APPROVAL_ALREADY_ACTIONED',
          message: 'Somebody decided this request first.',
        },
      };
    }

    // Only a status the subject has to mirror. An approval that merely moved
    // to the next level is nothing to the subject: it is still pending, and
    // saying so twice would be two records agreeing loudly about nothing.
    const settle =
      updated.status === 'APPROVED' || updated.status === 'REJECTED'
        ? await handler.applyDecision(
            ctx,
            {
              approvalRequestId: id,
              subjectId: request.subjectId,
              status: updated.status,
              reason,
              decidedByUserId: principal.userId,
              at: now,
            },
            tx,
          )
        : null;

    const record = (): void => {
      this.auditContext.record({
        action: action === 'APPROVE' ? 'approval.approved' : 'approval.rejected',
        entityType: 'approval_request',
        entityId: id,
        orgId: ctx.orgId,
        actorUserId: principal.userId,
        before: { status: request.status, currentStep: request.currentStep },
        after: {
          status: updated.status,
          currentStep: updated.currentStep,
          reason,
          // REQ-I-04: the trail names both identities, not just the clicker.
          delegatedFromUserId: eligibility.delegatedFromUserId,
        },
      });
    };

    // The trail is written after the commit, with everything else that must
    // only be true once the decision is a fact. Recording inside the
    // transaction would leave an entry saying "approved" behind a rollback.
    return {
      ok: true,
      settle: async () => {
        record();
        if (settle !== null) await settle();
      },
    };
  }

  /**
   * Approvers with a live delegation to this caller today (REQ-I-04), narrowed
   * to those who could have decided *this kind* of request themselves.
   *
   * A delegation transfers authority; it cannot create it. Without the
   * permission join below it did: `evaluateDecision`'s delegation branch is a
   * bare membership test, and `decideWithin` checks `actPermissions` against
   * the *delegate*, so nothing anywhere asked whether the delegator was
   * entitled.
   *
   * That was reachable. Routing is by reporting manager with no permission
   * filter (`ApprovalRoutingService.managerChain`), so a manager holding only
   * `regularization.approve` has their reports' leave requests routed to them
   * and cannot decide them -- a test asserts exactly that. But they could
   * delegate to any holder of a leave key, and that person would then decide
   * requests they were never routed and whose employees are outside their
   * scope, on the authority of somebody who had none. The widening of
   * `APPROVAL_ACT_KEYS` is what let them reach the delegation endpoint to
   * originate it.
   *
   * Checked at decision time rather than at delegation time on purpose: a
   * delegator can lose the permission after writing the delegation, and the
   * question that matters is whether they hold it when the decision is made.
   */
  private async liveDelegatorsTo(
    principal: Principal,
    actPermissions: readonly PermissionKey[],
  ): Promise<string[]> {
    if (actPermissions.length === 0) return [];

    const rows = await this.db
      .select({ fromUserId: approvalDelegations.fromUserId })
      .from(approvalDelegations)
      .where(
        and(
          eq(approvalDelegations.orgId, principal.orgId),
          eq(approvalDelegations.toUserId, principal.userId),
          isNull(approvalDelegations.deletedAt),
          delegationLiveOn(this.orgTodaySql(principal.orgId)),
          sql`EXISTS (
            SELECT 1
              FROM user_roles ur
              JOIN roles r ON r.id = ur.role_id
              JOIN role_permissions rp ON rp.role_id = ur.role_id
              JOIN permissions p ON p.id = rp.permission_id
             WHERE ur.user_id = ${approvalDelegations.fromUserId}
               AND r.org_id = ${principal.orgId}
               AND r.deleted_at IS NULL
               AND p.key IN ${sql`(${sql.join(
                 actPermissions.map((key) => sql`${key}`),
                 sql`, `,
               )})`}
          )`,
        ),
      );
    return rows.map((row) => row.fromUserId);
  }

  private orgTodaySql(orgId: string): SQL {
    return sql`(now() AT TIME ZONE (SELECT timezone FROM organizations WHERE id = ${orgId}))::date`;
  }

  private async delegateOf(
    orgId: string,
    userId: string,
  ): Promise<{ canApprove: boolean } | null> {
    const rows = await this.db.execute<{ can_approve: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
          FROM user_roles ur
          JOIN roles r ON r.id = ur.role_id
          JOIN role_permissions rp ON rp.role_id = ur.role_id
          JOIN permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = u.id
           -- Live roles in this organisation only, which is what loadGrants
           -- and orgWideApprovers both already require. Without it a user whose
           -- only approval role was soft-deleted still reports as able to
           -- approve, and the delegation is accepted -- producing exactly the
           -- silent dead cover the check below exists to prevent.
           AND r.org_id = ${orgId}
           AND r.deleted_at IS NULL
           AND p.key IN ${sql`(${sql.join(
             APPROVAL_ACT_KEYS.map((key) => sql`${key}`),
             sql`, `,
           )})`}
      ) AS can_approve
      FROM ${users} u
      WHERE u.id = ${userId}
        AND u.org_id = ${orgId}
        AND u.deleted_at IS NULL
        AND u.status = 'ACTIVE'
    `);

    const row = rows.rows[0];
    return row === undefined ? null : { canApprove: row.can_approve };
  }

  /**
   * Moves one request up a level. False when the route above it is exhausted.
   *
   * In a transaction with the subject's own mirror of the move, for the reason
   * the decision path gives: a leave request reading PENDING while its
   * approval reads ESCALATED is two rows disagreeing about the same fact, and
   * the escalation job is exactly the caller nobody is watching when it does.
   */
  private async escalateOne(ctx: OrgContext, id: string): Promise<boolean> {
    const settle = await this.db.transaction(async (tx) => this.escalateWithin(tx, ctx, id));
    if (settle === null) return false;
    await settle();
    return true;
  }

  private async escalateWithin(
    tx: Database,
    ctx: OrgContext,
    id: string,
  ): Promise<ApprovalSubjectSettlement | null> {
    const requests = new ApprovalRepository(tx, ctx, this.subjects);
    const steps = new ApprovalStepRepository(tx, ctx);

    const request = await requests.findRow(id);
    if (request === null || (request.status !== 'PENDING' && request.status !== 'ESCALATED')) {
      return null;
    }

    const handler = this.subjects.get(request.subjectType);
    if (handler === null) {
      // The same refusal the decision path makes, for the same reason: moving
      // a request whose subject nothing owns changes an inbox and nothing else.
      this.logger.warn({
        msg: 'Skipped escalating a request whose subject type has no registered handler.',
        approvalRequestId: id,
        subjectType: request.subjectType,
      });
      return null;
    }

    const route = await steps.forRequest(id);
    const current = route.find((step) => step.stepNo === request.currentStep) ?? null;
    let next = route.find((step) => step.stepNo === request.currentStep + 1) ?? null;

    if (next === null) {
      // The route was written in full at raise time, so reaching here means
      // the request is at its last level. The reporting line is re-derived
      // only now, and only to find somebody above whoever has already had it.
      const target = nextEscalationTarget({
        chain: await this.routing.defaultRoute(ctx.orgId, request.requesterUserId),
        currentApproverUserId: current?.approverUserId ?? null,
        requesterUserId: request.requesterUserId,
        alreadyRoutedUserIds: route.map((step) => step.approverUserId),
      });
      if (target === null) return null;

      const created = await steps.insert({
        approvalRequestId: id,
        stepNo: request.currentStep + 1,
        approverUserId: target,
      });
      next = { id: created.id, stepNo: created.stepNo, approverUserId: target, action: null };
    }

    const now = new Date();

    if (current !== null && current.action === null) {
      // The timer took the step away from its approver, and the history should
      // say so rather than showing an unanswered step that silently moved on.
      await steps.recordAction({
        stepId: current.id,
        action: 'ESCALATE',
        actedByUserId: null,
        delegatedFromUserId: null,
        reason: `No decision within ${String(request.escalateAfterDays)} days.`,
        at: now,
      });
    }

    const updated = await requests.advance(id, request.currentStep, next.stepNo, 'ESCALATED', now);
    if (updated === null) return null;

    const target = next;
    const subjectSettlement = await handler.applyDecision(
      ctx,
      {
        approvalRequestId: id,
        subjectId: request.subjectId,
        status: 'ESCALATED',
        reason: `No decision within ${String(request.escalateAfterDays)} days.`,
        // REQ-G-09's escalation is the timer's doing, not a person's, and
        // `columns.ts` says the trail is authoritative for who.
        decidedByUserId: null,
        at: now,
      },
      tx,
    );

    return async () => {
      // Written straight to the trail: a job has no request for the audit
      // interceptor to hang an entry on, and `AuditContext.record` is a no-op
      // outside one. After the commit, so a rolled-back escalation leaves no
      // row claiming it happened.
      await this.audit.write({
        orgId: ctx.orgId,
        actorUserId: null,
        action: 'approval.escalated',
        entityType: 'approval_request',
        entityId: id,
        before: { currentStep: request.currentStep, status: request.status },
        after: {
          currentStep: target.stepNo,
          status: 'ESCALATED',
          approverUserId: target.approverUserId,
          afterDays: request.escalateAfterDays,
        },
      });

      if (subjectSettlement !== null) await subjectSettlement();

      // REQ-K-03's "approval pending for over N days", to the approver it has
      // just landed on. Emitted here rather than from the sweep handler
      // because this is the only place that knows *who* it moved to; the
      // handler sees three counters. Inside the post-commit closure with the
      // audit write, for the same reason: a rolled-back escalation must not
      // tell somebody they have an approval waiting.
      //
      // Nothing about the requester travels in the payload - not their name,
      // not the subject sentence. The new approver may be two levels above
      // somebody they cannot see the attendance of, and a notification is not
      // a route around `ScopeService`. The inbox behind `actionUrl` shows
      // exactly what that approver is entitled to.
      //
      // The idempotency key is the request plus the step it arrived at, so a
      // sweep that runs twice in a day sends one notification, while a genuine
      // second escalation to the next level up sends its own.
      await this.notifications.emit({
        orgId: ctx.orgId,
        type: NOTIFICATION_EVENTS.APPROVAL_OVERDUE,
        audience: { kind: 'users', userIds: [target.approverUserId] },
        payload: {
          approvalType: request.type.toLowerCase().replace(/_/gu, ' '),
          days: request.escalateAfterDays,
          approvalRequestId: id,
        },
        idempotencyKey: `approval-overdue.${id}.${String(target.stepNo)}`,
      });
    };
  }

  private async buildDetail(
    ctx: OrgContext,
    id: string,
    executor: Database = this.db,
  ): Promise<ApprovalRequestDetail> {
    const requests = new ApprovalRepository(executor, ctx, this.subjects);
    const steps = new ApprovalStepRepository(executor, ctx);

    const [summary, row, history] = await Promise.all([
      requests.summary(id),
      requests.findRow(id),
      steps.history(id),
    ]);

    if (summary === null || row === null) throw AppError.notFound('Approval request', id);

    const open = row.status === 'PENDING' || row.status === 'ESCALATED';
    const currentStep = history.find((step) => step.stepNo === row.currentStep) ?? null;

    return {
      ...summary,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      awaiting: open ? (currentStep?.approver ?? null) : null,
      escalatedAt: row.escalatedAt?.toISOString() ?? null,
      currentStepStartedAt: row.currentStepStartedAt.toISOString(),
      escalateAfterDays: row.escalateAfterDays,
      steps: history,
    };
  }

  private toError(refusal: DecisionRefusal): AppError {
    const code =
      refusal.code === 'APPROVER_IS_REQUESTER'
        ? ERROR_CODES.APPROVER_IS_REQUESTER
        : refusal.code === 'APPROVAL_ALREADY_ACTIONED'
          ? ERROR_CODES.APPROVAL_ALREADY_ACTIONED
          : ERROR_CODES.FORBIDDEN;
    return new AppError(code, refusal.message);
  }
}
