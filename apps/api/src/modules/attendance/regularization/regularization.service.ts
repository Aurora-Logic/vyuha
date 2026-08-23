import { Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  ON_DUTY_MAX_DAYS,
  PERMISSIONS,
  pageSlice,
  paginated,
  type ApprovalDecision,
  type KnownApprovalSubjectType,
  type OnDutyInput,
  type OnDutyQuery,
  type OnDutyRequest,
  type Paginated,
  type RecomputeSummary,
  type RegularizationComplete,
  type RegularizationInput,
  type RegularizationPolicyView,
  type RegularizationQuery,
  type RegularizationRefusal,
  type RegularizationRequest,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { AuditContext } from '../../../platform/audit/audit-context.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { AppError, describeError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { isUniqueViolation } from '../../../platform/db/pg-error.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import { NOTIFICATION_EVENTS } from '../../../platform/notifications/notification-events.js';
import { NotificationDispatcher } from '../../../platform/notifications/notification.dispatcher.js';
import { hasAnyPermission, orgContextOf, type Principal } from '../../../platform/rbac/principal.js';
import { ScopeService, type ScopeGrants } from '../../../platform/rbac/scope.service.js';
import { ApprovalRoutingService } from '../../../platform/approvals/approval-routing.service.js';
import type {
  ApprovalSubjectDecision,
  ApprovalSubjectSettlement,
} from '../../../platform/approvals/approval-subject.registry.js';
import { ApprovalService } from '../../../platform/approvals/approval.service.js';
import { addDays } from '../day-engine/calendar-date.js';
import { DayEngineService } from '../day-engine/day-engine.service.js';
import { onDutyRequests, regularizations } from '../schema/index.js';
import {
  earliestRegularizableDate,
  monthBounds,
  refusalMessage,
  refuseRegularization,
} from './regularization-policy.js';
import {
  RegularizationRepository,
  type EmployeeRegularizationContext,
  type OnDutyRow,
  type RegularizationRow,
} from './regularization.repository.js';

/**
 * Regularization and on-duty (REQ-F-01 … REQ-F-05).
 *
 * Three things shape this file.
 *
 * **The limits are settings, and they are read every time.** REQ-F-02's window
 * and monthly cap live in `settings`, and `regularization-policy.ts` takes both
 * as arguments so nothing here can quietly become the place a default lives.
 * The settings catalogue names this slice as what enforces them; before this
 * existed it said "nothing reads it yet", and that was true.
 *
 * **Approval writes a record and recomputes, in that order, inline.** REQ-F-03:
 * "On approval, an adjusting record is written and the day is recomputed. The
 * original punches remain untouched and visible." `HolidayService` set the
 * pattern and the reasoning transfers whole -- an attendance day still reading
 * PENDING after its correction was approved is the bug that reaches payroll, so
 * the work happens in the request and reports what it did rather than waiting
 * for a queue that does not yet declare a `recompute-day` job.
 *
 * **A locked period is asked about before anything is written, not after.**
 * `computeDay` refuses a locked date on its own, which is enough for a caller
 * that only recomputes. It is not enough here: an adjustment stored against a
 * locked month would sit inert and then apply itself the moment somebody
 * reopened the month. REQ-E-09 says a locked period is not affected by a
 * regularization, and "not affected" has to include later.
 *
 * **It decides through the approval framework, not beside it.** REQ-I-01 wants
 * one approval mechanism for leave, regularization, on-duty, flagged punches
 * and device rebinding. Raising a request now raises an `approval_requests` row
 * in the same transaction, so it reaches the inbox and REQ-G-09's escalation
 * sweep can see it; deciding one goes through `ApprovalService.decide`, which
 * is the single place REQ-I-05, delegation (REQ-I-04) and the step route are
 * enforced. The framework then calls back into `applyApprovalDecision` /
 * `applyOnDutyDecision` through `ApprovalSubjectRegistry`, and those two
 * methods are the only writers of the adjustment row and the only callers of
 * the recompute.
 *
 * The `/regularizations/:id/approve` endpoints are kept and are **not** a
 * second path: they resolve the attached approval and hand it to the framework,
 * so a correction decided in the inbox and one decided on its own screen run
 * identical code and cannot produce different adjustments.
 */

/**
 * Who may see whose requests. The self key is `punch.self`, which every
 * employee holds, and the team key is `attendance.edit` -- the two the
 * approval catalogue names for this subject (approval-keys.ts), now that the
 * regularization keys are gone from the permission catalogue (owner, 21 Aug
 * 2026; PENDING A-01).
 */
export const REGULARIZATION_SCOPE_GRANTS: ScopeGrants = {
  self: PERMISSIONS.PUNCH_SELF,
  team: PERMISSIONS.ATTENDANCE_EDIT,
};

const APPROVER_KEYS = [PERMISSIONS.ATTENDANCE_EDIT] as const;

/**
 * REQ-I-01's polymorphic subjects, for the two kinds this slice owns.
 *
 * Typed against the shared contract's list rather than written as bare strings,
 * so a typo is a compile error rather than an approval request nothing will
 * ever pick up.
 */
export const REGULARIZATION_SUBJECT_TYPE: KnownApprovalSubjectType = 'regularization';
export const ON_DUTY_SUBJECT_TYPE: KnownApprovalSubjectType = 'on_duty_request';

@Injectable()
export class RegularizationService {
  private readonly logger = new Logger(RegularizationService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly scopes: ScopeService,
    private readonly auditContext: AuditContext,
    private readonly audit: AuditService,
    private readonly notifications: NotificationDispatcher,
    private readonly dayEngine: DayEngineService,
    private readonly approvals: ApprovalService,
    private readonly routing: ApprovalRoutingService,
  ) {}

  // ------------------------------------------------------------ REQ-F-02

  /**
   * The limits in force, and how much of the monthly one is spent.
   *
   * A GET, so the form can render honest bounds — the earliest date the
   * calendar should offer, and how many raises are left — instead of printing
   * 7 and 3 from a constant that goes stale the moment an administrator moves
   * the setting.
   */
  async policy(principal: Principal, requestedEmployeeId?: string): Promise<RegularizationPolicyView> {
    const repository = this.repository(principal);
    const employeeId = this.resolveEmployee(principal, requestedEmployeeId);
    const employee = await this.loadEmployee(repository, employeeId);

    const [limits, today] = await Promise.all([
      repository.readPolicy(),
      repository.todayFor(employee.timezone),
    ]);
    const month = monthBounds(today);
    const raisedThisMonth = await repository.countRaisedBetween(employeeId, month.from, month.to);

    return {
      windowDays: limits.windowDays,
      maxPerMonth: limits.maxPerMonth,
      earliestDate: earliestRegularizableDate({ today, windowDays: limits.windowDays }),
      today,
      raisedThisMonth,
      remainingThisMonth: Math.max(0, limits.maxPerMonth - raisedThisMonth),
    };
  }

  // ------------------------------------------------------------ REQ-F-01

  async raise(principal: Principal, input: RegularizationInput): Promise<RegularizationRequest> {
    const repository = this.repository(principal);
    const employeeId = this.resolveEmployee(principal, input.employeeId);
    const employee = await this.loadEmployee(repository, employeeId);

    const [limits, today] = await Promise.all([
      repository.readPolicy(),
      repository.todayFor(employee.timezone),
    ]);
    const month = monthBounds(today);
    const raisedThisMonth = await repository.countRaisedBetween(employeeId, month.from, month.to);

    const attempt = {
      date: input.date,
      today,
      windowDays: limits.windowDays,
      maxPerMonth: limits.maxPerMonth,
      raisedThisMonth,
      dateOfJoining: employee.dateOfJoining,
    };

    const refusal = refuseRegularization(attempt);
    if (refusal !== null) throw refusalError(refusal, attempt);

    // Before the write, not after: see the class comment on locked periods.
    if (await this.dayEngine.forOrg(orgContextOf(principal)).isLocked(employeeId, input.date)) {
      throw new AppError(ERROR_CODES.PERIOD_LOCKED, refusalMessage('PERIOD_LOCKED', attempt), {
        details: { reason: 'PERIOD_LOCKED', date: input.date },
      });
    }

    if ((await repository.findOpenForDate(employeeId, input.date)) !== null) {
      throw refusalError('ALREADY_PENDING', attempt);
    }

    const existingIn = await repository.firstInPunchAt(employeeId, input.date);
    const times = await repository.composeTimes({
      date: input.date,
      timezone: employee.timezone,
      requestedIn: input.requestedIn,
      requestedOut: input.requestedOut,
      existingIn,
    });

    const ctx = orgContextOf(principal);
    // The person the correction is *about*, not whoever typed it in. An
    // employee with no login falls back to the raiser, which is the only user
    // account there is to name.
    const requesterUserId =
      (await repository.findUserIdForEmployee(employeeId)) ?? principal.userId;
    const route = await this.routeFor(principal.orgId, requesterUserId);

    // One transaction, because a correction and the approval that governs it
    // are one fact. Raised second and linked back rather than first, because
    // the approval's subject is the request's id -- and committed together,
    // because a request whose raise then failed would be a row no inbox can
    // show and nobody can decide.
    const { id, approvalRequestId } = await repository.transaction(async (tx, executor) => {
      const requestId = await this.insertRegularization(tx, {
        employeeId,
        date: input.date,
        kind: input.kind,
        requestedIn: times.adjustedIn,
        requestedOut: times.adjustedOut,
        reason: input.reason,
        attachmentFileId: input.attachmentFileId,
        attempt,
      });

      const approval = await this.approvals.raise(
        ctx,
        {
          type: 'REGULARIZATION',
          subjectType: REGULARIZATION_SUBJECT_TYPE,
          subjectId: requestId,
          subject: regularizationSubjectLine({
            employeeName: employee.name,
            date: input.date,
            kind: input.kind,
          }),
          requesterUserId,
          approverUserIds: route,
        },
        executor,
      );

      const linked = await tx.linkRegularizationApproval(requestId, approval.id);
      if (!linked) throw AppError.notFound('Regularization', requestId);

      return { id: requestId, approvalRequestId: approval.id };
    });

    const record = await this.readRegularization(principal, id);

    this.auditContext.record({
      action: 'regularization.raised',
      entityType: 'regularization',
      entityId: id,
      before: null,
      after: {
        employeeId,
        date: input.date,
        kind: input.kind,
        requestedIn: times.adjustedIn?.toISOString() ?? null,
        requestedOut: times.adjustedOut?.toISOString() ?? null,
        reason: input.reason,
        raisedThisMonth: raisedThisMonth + 1,
        maxPerMonth: limits.maxPerMonth,
        approvalRequestId,
      },
    });

    return record;
  }

  // -------------------------------------------------- auto-file (system)

  /**
   * `attendance.regularization_auto_file`'s effect. Called by the punch
   * pipeline right after a day recomputes with a `late` or `outside_window`
   * flag, so the employee does not have to notice and raise a correction
   * themselves -- a `WRONG_TIME` draft appears in their own queue instead,
   * proposing no change (the times equal the punch as it stands), reason left
   * null. It is not raised into the approvals framework here: `completeDraft`
   * does that once the employee supplies the one thing the system cannot --
   * why.
   *
   * Declines silently rather than throwing when the setting is off, there is
   * no IN punch to propose a time from, or a request already covers the day
   * (draft, raised, or decided). A punch that failed because this could not
   * write a row would be the setting breaking attendance, which is the one
   * thing turning it on must never do -- the same reasoning `raiseFlagAlerts`
   * gives for never failing a punch over a notification.
   */
  async raiseSystemDraft(
    ctx: OrgContext,
    input: { employeeId: string; date: string; actualIn: Date | null; actualOut: Date | null },
  ): Promise<void> {
    if (input.actualIn === null) return;

    const repository = new RegularizationRepository(this.db, ctx);
    if (!(await repository.readAutoFileEnabled())) return;
    if ((await repository.findOpenForDate(input.employeeId, input.date)) !== null) return;

    let id: string;
    try {
      id = await repository.insertSystemDraft({
        employeeId: input.employeeId,
        date: input.date,
        requestedIn: input.actualIn,
        requestedOut: input.actualOut,
      });
    } catch (error: unknown) {
      // Two punches racing the same day's recompute both pass the open-request
      // check above and both try to insert; the loser hits the same unique
      // index `raise` does. Nothing to do -- a request already exists for the
      // day, which was the point.
      if (isUniqueViolation(error)) return;
      throw error;
    }

    await this.audit.write({
      orgId: ctx.orgId,
      actorUserId: null,
      action: 'regularization.auto_filed',
      entityType: 'regularization',
      entityId: id,
      before: null,
      after: { employeeId: input.employeeId, date: input.date, kind: 'WRONG_TIME' },
    });
  }

  /**
   * The other half of `raiseSystemDraft`: the employee's reason (and, if they
   * choose, a corrected time) turns the draft into a real request, raised
   * into the approvals framework exactly as `raise` raises one an employee
   * wrote from scratch. Nobody else could see the draft before this — see
   * `draftVisibleTo` — so completing it is the only way it becomes decidable.
   *
   * No REQ-F-02 window/cap check here. Those bound how often an employee asks
   * for a correction; this row already exists because the system, not the
   * employee, decided to ask. Re-refusing it at the one moment the employee
   * is trying to close it out would make the setting a trap.
   */
  async completeDraft(
    principal: Principal,
    id: string,
    input: RegularizationComplete,
  ): Promise<RegularizationRequest> {
    const employeeId = this.resolveEmployee(principal, undefined);
    const repository = this.repository(principal);

    const draft = await repository.findOwnDraft(id, employeeId);
    if (draft === null) throw AppError.notFound('Regularization', id);

    const employee = await this.loadEmployee(repository, employeeId);

    if (await this.dayEngine.forOrg(orgContextOf(principal)).isLocked(employeeId, draft.date)) {
      throw new AppError(
        ERROR_CODES.PERIOD_LOCKED,
        `Attendance for ${draft.date} is in a locked period and cannot be corrected. Unlock the period first.`,
        { details: { reason: 'PERIOD_LOCKED', date: draft.date } },
      );
    }

    let requestedIn = draft.requestedIn === null ? null : new Date(draft.requestedIn);
    let requestedOut = draft.requestedOut === null ? null : new Date(draft.requestedOut);
    // Only recomposed when the employee actually resent a time -- the field
    // they left alone keeps the draft's own proposal rather than being wiped
    // to null by a request that only meant to change the other one.
    if (input.requestedIn !== undefined || input.requestedOut !== undefined) {
      const existingIn = await repository.firstInPunchAt(employeeId, draft.date);
      const times = await repository.composeTimes({
        date: draft.date,
        timezone: employee.timezone,
        requestedIn: input.requestedIn ?? null,
        requestedOut: input.requestedOut ?? null,
        existingIn,
      });
      if (input.requestedIn !== undefined) requestedIn = times.adjustedIn;
      if (input.requestedOut !== undefined) requestedOut = times.adjustedOut;
    }

    const ctx = orgContextOf(principal);
    const requesterUserId =
      (await repository.findUserIdForEmployee(employeeId)) ?? principal.userId;
    const route = await this.routeFor(principal.orgId, requesterUserId);

    const { approvalRequestId } = await repository.transaction(async (tx, executor) => {
      const completed = await tx.completeSystemDraft(id, {
        reason: input.reason,
        requestedIn,
        requestedOut,
      });
      if (!completed) {
        throw AppError.conflict('This draft was already completed or no longer exists.', {
          regularizationId: id,
        });
      }

      const approval = await this.approvals.raise(
        ctx,
        {
          type: 'REGULARIZATION',
          subjectType: REGULARIZATION_SUBJECT_TYPE,
          subjectId: id,
          subject: regularizationSubjectLine({
            employeeName: employee.name,
            date: draft.date,
            kind: 'WRONG_TIME',
          }),
          requesterUserId,
          approverUserIds: route,
        },
        executor,
      );

      const linked = await tx.linkRegularizationApproval(id, approval.id);
      if (!linked) throw AppError.notFound('Regularization', id);

      return { approvalRequestId: approval.id };
    });

    const record = await this.readRegularization(principal, id);

    this.auditContext.record({
      action: 'regularization.raised',
      entityType: 'regularization',
      entityId: id,
      before: null,
      after: {
        employeeId,
        date: draft.date,
        kind: 'WRONG_TIME',
        requestedIn: requestedIn?.toISOString() ?? null,
        requestedOut: requestedOut?.toISOString() ?? null,
        reason: input.reason,
        origin: 'SYSTEM',
        approvalRequestId,
      },
    });

    return record;
  }

  /**
   * Who a correction or an on-duty declaration routes to.
   *
   * The nearest reporting manager, one step, exactly as `LeaveService.routeFor`
   * does for a leave type that is not two-step. Handing the framework its whole
   * `defaultRoute` instead would write the manager, their manager and every
   * org-wide approver as separate steps, and a missing punch would then need
   * four approvals -- REQ-F-03 describes one.
   *
   * The org-wide tail is the fallback when there is no manager at all: somebody
   * at the top of the tree, or whose manager has no login. Without it `raise`
   * refuses, and raising a correction would fail for the people least able to
   * do anything about it.
   */
  private async routeFor(orgId: string, requesterUserId: string): Promise<string[]> {
    const [chain, orgWide] = await Promise.all([
      this.routing.managerChain(orgId, requesterUserId),
      this.routing.orgWideApprovers(orgId),
    ]);
    const nearest = chain[0];
    return nearest === undefined ? orgWide : [nearest];
  }

  async list(
    principal: Principal,
    query: RegularizationQuery,
  ): Promise<Paginated<RegularizationRequest>> {
    const { limit, offset } = pageSlice(query);
    const { rows, total } = await this.repository(principal).listRegularizations({
      scope: this.scopeFor(principal, regularizations.employeeId),
      status: query.status,
      employeeId: query.employeeId,
      from: query.from,
      to: query.to,
      limit,
      offset,
      viewerEmployeeId: principal.employeeId,
    });
    return paginated(rows.map(toRegularization), query, total);
  }

  async get(principal: Principal, id: string): Promise<RegularizationRequest> {
    return this.readRegularization(principal, id);
  }

  // ------------------------------------------------------------ REQ-F-03

  /**
   * "On approval, an adjusting record is written and the day is recomputed."
   *
   * The status move and the adjustment insert are one transaction, because
   * `attendance_adjustments` is what the day engine reads: a request marked
   * approved with no adjustment beside it is a correction the muster will never
   * show, and a retry cannot tell that state from a fresh one. The recompute
   * runs *after* the commit, so the engine reads the row that was written
   * rather than one still inside an open transaction.
   */
  async approve(
    principal: Principal,
    id: string,
    reason: string | null,
  ): Promise<RegularizationRequest> {
    return this.decideThroughFramework(principal, id, 'APPROVE', reason);
  }

  /** REQ-F-05: "Rejection requires a reason. The employee is notified with it." */
  async reject(principal: Principal, id: string, reason: string): Promise<RegularizationRequest> {
    return this.decideThroughFramework(principal, id, 'REJECT', reason);
  }

  /**
   * REQ-F-03 and REQ-F-05, through the framework rather than beside it.
   *
   * Not a second decision path. It resolves the approval attached to the
   * correction and hands it to `ApprovalService.decide`, which is the one place
   * REQ-I-05, delegation (REQ-I-04) and the step route are enforced; the
   * framework then calls back into `applyApprovalDecision` below.
   *
   * What is still checked here is visibility: an id outside the caller's scope
   * answers 404 rather than the framework's 403, so the id cannot be probed
   * for. That is the same answer this endpoint has always given.
   */
  private async decideThroughFramework(
    principal: Principal,
    id: string,
    action: ApprovalDecision,
    reason: string | null,
  ): Promise<RegularizationRequest> {
    const repository = this.repository(principal);
    const request = await repository.findRegularization(
      id,
      this.scopeFor(principal, regularizations.employeeId),
      principal.employeeId,
    );
    if (request === null) throw AppError.notFound('Regularization', id);

    if (request.approvalRequestId === null) {
      // Only reachable for a request written before this join existed: `raise`
      // has raised an approval in the same transaction ever since, so a null
      // here means there is no route, no step and nobody the framework could
      // name as the approver. Refused rather than decided on the old terms,
      // because a second way to write the adjustment row is exactly what this
      // change removed.
      throw AppError.conflict(
        'This correction predates the approvals inbox and has no approval attached, so it cannot be decided. Ask the employee to raise it again.',
        { regularizationId: id },
      );
    }

    await this.approvals.decide(principal, request.approvalRequestId, action, reason);
    return this.readRegularization(principal, id);
  }

  /**
   * What a decision *means* for a correction (REQ-F-03, REQ-F-05).
   *
   * Called by the framework through `ApprovalSubjectRegistry`, inside the
   * framework's transaction, and **deliberately without re-checking the
   * approver**: by the time this runs the framework has established that this
   * actor holds `regularization.approve` and may act on this step under
   * REQ-I-05 and REQ-I-04, and a second opinion here is a second place that
   * rule can be wrong.
   *
   * The adjustment row is written here and nowhere else, in the same
   * transaction as the step that approved it -- REQ-F-03's "an adjusting record
   * is written" and the approval that authorised it cannot be allowed to commit
   * apart, because a request marked approved with no adjustment beside it is a
   * correction the muster will never show and a retry cannot tell that state
   * from a fresh one.
   */
  async applyApprovalDecision(
    ctx: OrgContext,
    decision: ApprovalSubjectDecision,
    executor: Database,
  ): Promise<ApprovalSubjectSettlement | null> {
    const repository = new RegularizationRepository(executor, ctx);
    // No scope predicate: the framework has already decided this actor may act
    // on this request, and the handler's job is the record, not the reader.
    const request = await repository.findRegularization(decision.subjectId, sql`true`);
    if (request === null) throw AppError.notFound('Regularization', decision.subjectId);

    if (request.status !== 'PENDING' && request.status !== 'ESCALATED') {
      // The framework's compare-and-swap should have made this unreachable.
      // Refused rather than trusted, because the cost of being wrong is a
      // second adjustment on a day that already has one.
      throw new AppError(
        ERROR_CODES.APPROVAL_ALREADY_ACTIONED,
        `This regularization is already ${request.status.toLowerCase()}.`,
        { details: { status: request.status } },
      );
    }

    if (decision.status === 'ESCALATED') {
      const moved = await repository.escalateRegularization(decision.subjectId);
      if (!moved) throw alreadyActionedError(decision.subjectId);
      return async () => {
        // Straight to the trail: escalation is the job's doing and there is no
        // request for the audit interceptor to hang an entry on.
        await this.audit.write({
          orgId: ctx.orgId,
          actorUserId: null,
          action: 'regularization.escalated',
          entityType: 'regularization',
          entityId: decision.subjectId,
          before: { status: request.status },
          after: { status: 'ESCALATED', approvalRequestId: decision.approvalRequestId },
        });
      };
    }

    if (decision.status === 'REJECTED') {
      // No adjustment and no recompute: a rejected correction changed nothing,
      // which is why the adjustment is written on approval rather than on raise.
      const moved = await repository.decideRegularization(decision.subjectId, {
        status: 'REJECTED',
        decidedAt: decision.at,
        decidedBy: decision.decidedByUserId,
        reason: decision.reason,
      });
      if (!moved) throw alreadyActionedError(decision.subjectId);

      return async () => {
        this.auditContext.record({
          action: 'regularization.rejected',
          entityType: 'regularization',
          entityId: decision.subjectId,
          orgId: ctx.orgId,
          before: { status: request.status },
          after: { status: 'REJECTED', reason: decision.reason },
        });
        await this.notifyDecision(ctx.orgId, request, 'rejected', decision.reason);
      };
    }

    // REQ-E-09 asked *before* anything is written, not after. `computeDay`
    // refuses a locked date on its own, which is enough for a caller that only
    // recomputes; it is not enough here, because an adjustment stored against a
    // locked month would sit inert and then apply itself the moment somebody
    // reopened the month. Throwing rolls the framework's transaction back, so
    // the step that approved it is unwritten too.
    if (await this.dayEngine.forOrg(ctx).isLocked(request.employeeId, request.date)) {
      throw new AppError(
        ERROR_CODES.PERIOD_LOCKED,
        `Attendance for ${request.date} is in a locked period, so this correction cannot be applied. Unlock the period first.`,
        { details: { reason: 'PERIOD_LOCKED', date: request.date } },
      );
    }

    if (request.reason === null) {
      // Unreachable in practice: a row only reaches a decision once it has a
      // reason on it. An EMPLOYEE-origin row has always required one to be
      // raised at all, and a SYSTEM-origin draft only gets an approval to
      // decide once `completeDraft` sets its reason and raises it in the same
      // transaction. Thrown rather than defaulted to an empty string, because
      // that would write an adjustment nobody can explain.
      throw new Error(`Regularization ${decision.subjectId} was decided with no reason on record.`);
    }

    const moved = await repository.decideRegularization(decision.subjectId, {
      status: 'APPROVED',
      decidedAt: decision.at,
      decidedBy: decision.decidedByUserId,
      reason: decision.reason,
    });
    if (!moved) throw alreadyActionedError(decision.subjectId);

    const adjustmentId = await repository.insertAdjustment({
      employeeId: request.employeeId,
      attendanceDate: request.date,
      regularizationId: decision.subjectId,
      adjustedIn: request.requestedIn === null ? null : new Date(request.requestedIn),
      adjustedOut: request.requestedOut === null ? null : new Date(request.requestedOut),
      // The employee's own words, not the approver's. A report showing why a
      // day was corrected wants the reason the correction was asked for.
      reason: request.reason,
      approvedBy: decision.decidedByUserId,
    });

    return async () => {
      // After the commit, so the engine reads the adjustment that was written
      // rather than one still inside an open transaction.
      const recompute = await this.recomputeDates(ctx, request.employeeId, [request.date]);

      this.auditContext.record({
        action: 'regularization.approved',
        entityType: 'regularization',
        entityId: decision.subjectId,
        orgId: ctx.orgId,
        before: { status: request.status },
        after: {
          status: 'APPROVED',
          adjustmentId,
          date: request.date,
          adjustedIn: request.requestedIn,
          adjustedOut: request.requestedOut,
          reason: decision.reason,
          recompute,
        },
      });

      await this.notifyDecision(ctx.orgId, request, 'approved', decision.reason);
    };
  }

  // ------------------------------------------------------------ REQ-F-04

  async raiseOnDuty(principal: Principal, input: OnDutyInput): Promise<OnDutyRequest> {
    const repository = this.repository(principal);
    const employeeId = this.resolveEmployee(principal, input.employeeId);
    const employee = await this.loadEmployee(repository, employeeId);

    const dates = datesBetween(input.fromDate, input.toDate);
    if (dates.length > ON_DUTY_MAX_DAYS) {
      throw AppError.validation(
        `An on-duty request may cover at most ${String(ON_DUTY_MAX_DAYS)} days; this one covers ${String(dates.length)}. Raise it in shorter stretches.`,
        { fields: [{ path: 'toDate', message: 'range too long', value: input.toDate }] },
      );
    }

    if (input.fromDate < employee.dateOfJoining) {
      throw AppError.validation(
        `${input.fromDate} is before this employee joined on ${employee.dateOfJoining}.`,
        { fields: [{ path: 'fromDate', message: 'before the date of joining' }] },
      );
    }

    // Unlike a regularization, on duty is raised *ahead* of the days it covers
    // -- REQ-F-04 is a field-duty declaration, not a correction -- so there is
    // no backward window and no future-date refusal here.
    const overlapping = await repository.findOverlappingOnDuty(
      employeeId,
      input.fromDate,
      input.toDate,
    );
    if (overlapping !== null) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'Another on-duty request already covers part of these dates.',
        { details: { reason: 'OVERLAPPING_ON_DUTY', onDutyRequestId: overlapping } },
      );
    }

    const ctx = orgContextOf(principal);
    const requesterUserId =
      (await repository.findUserIdForEmployee(employeeId)) ?? principal.userId;
    const route = await this.routeFor(principal.orgId, requesterUserId);

    // One transaction, for the reason `raise` gives above.
    const { id, approvalRequestId } = await repository.transaction(async (tx, executor) => {
      const requestId = await tx.insertOnDuty({
        employeeId,
        fromDate: input.fromDate,
        toDate: input.toDate,
        reason: input.reason,
        siteName: input.siteName,
      });

      const approval = await this.approvals.raise(
        ctx,
        {
          type: 'ON_DUTY',
          subjectType: ON_DUTY_SUBJECT_TYPE,
          subjectId: requestId,
          subject: onDutySubjectLine({
            employeeName: employee.name,
            fromDate: input.fromDate,
            toDate: input.toDate,
            days: dates.length,
            siteName: input.siteName,
          }),
          requesterUserId,
          approverUserIds: route,
        },
        executor,
      );

      const linked = await tx.linkOnDutyApproval(requestId, approval.id);
      if (!linked) throw AppError.notFound('On-duty request', requestId);

      return { id: requestId, approvalRequestId: approval.id };
    });

    this.auditContext.record({
      action: 'on_duty.raised',
      entityType: 'on_duty_request',
      entityId: id,
      before: null,
      after: {
        employeeId,
        fromDate: input.fromDate,
        toDate: input.toDate,
        reason: input.reason,
        siteName: input.siteName,
        days: dates.length,
        approvalRequestId,
      },
    });

    return this.readOnDuty(principal, id);
  }

  async listOnDuty(principal: Principal, query: OnDutyQuery): Promise<Paginated<OnDutyRequest>> {
    const { limit, offset } = pageSlice(query);
    const { rows, total } = await this.repository(principal).listOnDuty({
      scope: this.scopeFor(principal, onDutyRequests.employeeId),
      status: query.status,
      employeeId: query.employeeId,
      from: query.from,
      to: query.to,
      limit,
      offset,
    });
    return paginated(rows.map(toOnDuty), query, total);
  }

  async getOnDuty(principal: Principal, id: string): Promise<OnDutyRequest> {
    return this.readOnDuty(principal, id);
  }

  /**
   * REQ-F-04: "On approval, those days become ON_DUTY and count as present."
   *
   * There is no adjustment row here. The day engine reads
   * `on_duty_requests` directly (`hasApprovedOnDuty`, step 4), so approving is
   * the whole of the write and the recompute is what makes it visible.
   */
  async approveOnDuty(
    principal: Principal,
    id: string,
    reason: string | null,
  ): Promise<OnDutyRequest> {
    return this.decideOnDutyThroughFramework(principal, id, 'APPROVE', reason);
  }

  /** REQ-F-05, the on-duty half. */
  async rejectOnDuty(principal: Principal, id: string, reason: string): Promise<OnDutyRequest> {
    return this.decideOnDutyThroughFramework(principal, id, 'REJECT', reason);
  }

  /** See `decideThroughFramework`; this is the same arrangement for REQ-F-04. */
  private async decideOnDutyThroughFramework(
    principal: Principal,
    id: string,
    action: ApprovalDecision,
    reason: string | null,
  ): Promise<OnDutyRequest> {
    const repository = this.repository(principal);
    const request = await repository.findOnDuty(
      id,
      this.scopeFor(principal, onDutyRequests.employeeId),
    );
    if (request === null) throw AppError.notFound('On-duty request', id);

    if (request.approvalRequestId === null) {
      throw AppError.conflict(
        'This on-duty request predates the approvals inbox and has no approval attached, so it cannot be decided. Ask the employee to raise it again.',
        { onDutyRequestId: id },
      );
    }

    await this.approvals.decide(principal, request.approvalRequestId, action, reason);
    return this.readOnDuty(principal, id);
  }

  /**
   * What a decision *means* for an on-duty request (REQ-F-04).
   *
   * There is no adjustment row here. The day engine reads `on_duty_requests`
   * directly (`hasApprovedOnDuty`, step 4), so moving the status is the whole
   * of the write and the recompute after the commit is what makes it visible.
   *
   * No lock check, unlike a correction: an on-duty request is raised *ahead* of
   * the days it covers, so the ordinary case has no closed period to collide
   * with, and `computeDay` answers `locked` without writing for any day that
   * does -- counted and reported in the summary rather than refused. Refusing
   * the whole request because one day of a fortnight sits in a closed month
   * would lose the other thirteen.
   */
  async applyOnDutyDecision(
    ctx: OrgContext,
    decision: ApprovalSubjectDecision,
    executor: Database,
  ): Promise<ApprovalSubjectSettlement | null> {
    const repository = new RegularizationRepository(executor, ctx);
    const request = await repository.findOnDuty(decision.subjectId, sql`true`);
    if (request === null) throw AppError.notFound('On-duty request', decision.subjectId);

    if (request.status !== 'PENDING' && request.status !== 'ESCALATED') {
      throw new AppError(
        ERROR_CODES.APPROVAL_ALREADY_ACTIONED,
        `This on-duty request is already ${request.status.toLowerCase()}.`,
        { details: { status: request.status } },
      );
    }

    if (decision.status === 'ESCALATED') {
      const moved = await repository.escalateOnDuty(decision.subjectId);
      if (!moved) throw alreadyActionedError(decision.subjectId);
      return async () => {
        await this.audit.write({
          orgId: ctx.orgId,
          actorUserId: null,
          action: 'on_duty.escalated',
          entityType: 'on_duty_request',
          entityId: decision.subjectId,
          before: { status: request.status },
          after: { status: 'ESCALATED', approvalRequestId: decision.approvalRequestId },
        });
      };
    }

    const moved = await repository.decideOnDuty(decision.subjectId, {
      status: decision.status,
      decidedAt: decision.at,
      decidedBy: decision.decidedByUserId,
      reason: decision.reason,
    });
    if (!moved) throw alreadyActionedError(decision.subjectId);

    if (decision.status === 'REJECTED') {
      return async () => {
        this.auditContext.record({
          action: 'on_duty.rejected',
          entityType: 'on_duty_request',
          entityId: decision.subjectId,
          orgId: ctx.orgId,
          before: { status: request.status },
          after: { status: 'REJECTED', reason: decision.reason },
        });
        await this.notifyOnDutyDecision(ctx.orgId, request, 'rejected', decision.reason);
      };
    }

    return async () => {
      const recompute = await this.recomputeDates(
        ctx,
        request.employeeId,
        datesBetween(request.fromDate, request.toDate),
      );

      this.auditContext.record({
        action: 'on_duty.approved',
        entityType: 'on_duty_request',
        entityId: decision.subjectId,
        orgId: ctx.orgId,
        before: { status: request.status },
        after: {
          status: 'APPROVED',
          fromDate: request.fromDate,
          toDate: request.toDate,
          reason: decision.reason,
          recompute,
        },
      });

      await this.notifyOnDutyDecision(ctx.orgId, request, 'approved', decision.reason);
    };
  }

  // ------------------------------------------------------------ internals

  private repository(principal: Principal): RegularizationRepository {
    return new RegularizationRepository(this.db, orgContextOf(principal));
  }

  private scopeFor(principal: Principal, employeeColumn: Parameters<ScopeService['resolve']>[2]) {
    return this.scopes.resolve(principal, REGULARIZATION_SCOPE_GRANTS, employeeColumn).where;
  }

  /**
   * Whose record this call acts on.
   *
   * Raising for yourself needs only `regularization.raise`, which every
   * Employee holds. Naming somebody else is the privileged act and is checked
   * here rather than at the route, because a guard cannot see which employee
   * the body asked for.
   */
  private resolveEmployee(principal: Principal, requested?: string): string {
    const own = principal.employeeId;
    if (requested === undefined || requested === own) {
      if (own === null) {
        throw AppError.validation(
          'This account has no employee record, so it has no attendance to correct. Name an employee.',
          { fields: [{ path: 'employeeId', message: 'required for this account' }] },
        );
      }
      return own;
    }
    if (!hasAnyPermission(principal, APPROVER_KEYS)) {
      throw AppError.forbidden('You may only raise a request for yourself.');
    }
    return requested;
  }

  private async loadEmployee(
    repository: RegularizationRepository,
    employeeId: string,
  ): Promise<EmployeeRegularizationContext> {
    const employee = await repository.findEmployee(employeeId);
    if (employee === null) throw AppError.notFound('Employee', employeeId);
    return employee;
  }

  private async readRegularization(
    principal: Principal,
    id: string,
  ): Promise<RegularizationRequest> {
    const row = await this.repository(principal).findRegularization(
      id,
      this.scopeFor(principal, regularizations.employeeId),
      principal.employeeId,
    );
    // Out of scope and non-existent answer the same, as everywhere else: a 403
    // would confirm that the id names a real request.
    if (row === null) throw AppError.notFound('Regularization', id);
    return toRegularization(row);
  }

  private async readOnDuty(principal: Principal, id: string): Promise<OnDutyRequest> {
    const row = await this.repository(principal).findOnDuty(
      id,
      this.scopeFor(principal, onDutyRequests.employeeId),
    );
    if (row === null) throw AppError.notFound('On-duty request', id);
    return toOnDuty(row);
  }

  private async insertRegularization(
    repository: RegularizationRepository,
    input: {
      employeeId: string;
      date: string;
      kind: RegularizationInput['kind'];
      requestedIn: Date | null;
      requestedOut: Date | null;
      reason: string;
      attachmentFileId: string | null;
      attempt: Parameters<typeof refusalMessage>[1];
    },
  ): Promise<string> {
    try {
      return await repository.insertRegularization({ ...input, origin: 'EMPLOYEE' });
    } catch (error: unknown) {
      // Two submissions racing each other land on the partial unique index
      // rather than on the read above; migration 0014 exists for exactly this.
      if (isUniqueViolation(error)) throw refusalError('ALREADY_PENDING', input.attempt, error);
      throw error;
    }
  }

  /**
   * REQ-F-03's recompute, and REQ-E-09's lock, in the shape `HolidayService`
   * uses.
   *
   * `computeDay` decides the lock itself and answers `locked` without writing,
   * so a race between the check above and this call cannot corrupt a closed
   * month. What this has to survive is one employee's misconfiguration: the
   * engine refuses a date the employee has no shift for, and an approval must
   * not fail because somebody's roster has a gap. Counted, logged with the
   * cause, and reported back.
   */
  private async recomputeDates(
    ctx: OrgContext,
    employeeId: string,
    dates: readonly string[],
  ): Promise<RecomputeSummary> {
    const summary = { considered: 0, recomputed: 0, locked: 0, failed: 0 };
    const engine = this.dayEngine.forOrg(ctx);

    for (const date of dates) {
      summary.considered += 1;
      try {
        const outcome = await engine.computeDay(employeeId, date);
        if (outcome.outcome === 'locked') summary.locked += 1;
        else summary.recomputed += 1;
      } catch (error: unknown) {
        summary.failed += 1;
        this.logger.warn(
          `Approved request on ${date} could not recompute employee ${employeeId}: ${describeError(error)}`,
        );
      }
    }

    return summary;
  }

  /** REQ-K-03: "regularization outcome" is on the list of events that notify. */
  private async notifyDecision(
    orgId: string,
    request: RegularizationRow,
    outcome: 'approved' | 'rejected',
    reason: string | null,
  ): Promise<void> {
    await this.notifications.emit({
      orgId,
      type: NOTIFICATION_EVENTS.REGULARIZATION_DECIDED,
      audience: { kind: 'employees', employeeIds: [request.employeeId] },
      payload: {
        outcome,
        date: request.date,
        regularizationId: request.id,
        // REQ-F-05: the employee is notified *with* the reason, so it travels
        // in the payload rather than only into the audit trail.
        reason,
      },
    });
  }

  private async notifyOnDutyDecision(
    orgId: string,
    request: OnDutyRow,
    outcome: 'approved' | 'rejected',
    reason: string | null,
  ): Promise<void> {
    await this.notifications.emit({
      orgId,
      type: NOTIFICATION_EVENTS.REGULARIZATION_DECIDED,
      audience: { kind: 'employees', employeeIds: [request.employeeId] },
      payload: {
        outcome,
        date:
          request.fromDate === request.toDate
            ? request.fromDate
            : `${request.fromDate} to ${request.toDate}`,
        regularizationId: request.id,
        reason,
      },
    });
  }
}

// ---------------------------------------------------------------- helpers

/**
 * The sentence the inbox renders for a correction (REQ-I-01).
 *
 * Written here because the framework must not join five subject tables to find
 * out what a request is about -- that is four inboxes wearing one URL. Times
 * are deliberately absent: they are instants that need the employee's zone to
 * render, and the detail screen behind the row has both.
 */
function regularizationSubjectLine(input: {
  employeeName: string;
  date: string;
  kind: RegularizationInput['kind'];
}): string {
  return `${input.employeeName}, ${REGULARIZATION_SUBJECT_WORDS[input.kind]} on ${input.date}`;
}

/** Plain words for the inbox, not the enum. `REGULARIZATION_KIND_LABELS` is the
 * client's copy of the same idea; this one has to read inside a sentence. */
const REGULARIZATION_SUBJECT_WORDS: Record<RegularizationInput['kind'], string> = {
  MISSING_IN: 'missing in punch',
  MISSING_OUT: 'missing out punch',
  WRONG_TIME: 'wrong punch time',
  FORGOT_TO_PUNCH: 'forgot to punch',
};

function onDutySubjectLine(input: {
  employeeName: string;
  fromDate: string;
  toDate: string;
  days: number;
  siteName: string | null;
}): string {
  const range =
    input.fromDate === input.toDate
      ? input.fromDate
      : `${input.fromDate} to ${input.toDate}, ${String(input.days)} days`;
  return `${input.employeeName}, on duty ${range}${input.siteName === null ? '' : ` at ${input.siteName}`}`;
}

function alreadyActionedError(id: string): AppError {
  return new AppError(
    ERROR_CODES.APPROVAL_ALREADY_ACTIONED,
    'Somebody else decided this request a moment ago. Reload to see the outcome.',
    { details: { id } },
  );
}

function refusalError(
  refusal: RegularizationRefusal,
  attempt: Parameters<typeof refusalMessage>[1],
  cause?: unknown,
): AppError {
  // A refusal here is always a statement about the state the request met -- a
  // date too old, a cap already spent -- rather than about the shape of the
  // request, which is why none of them is a 400. `HolidayService.elect` makes
  // the same call for the same reason.
  return new AppError(ERROR_CODES.CONFLICT, refusalMessage(refusal, attempt), {
    details: { reason: refusal, date: attempt.date },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Every calendar date in an inclusive range. */
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function toRegularization(row: RegularizationRow): RegularizationRequest {
  return {
    id: row.id,
    employee: { id: row.employeeId, name: row.employeeName },
    employeeCode: row.employeeCode,
    date: row.date,
    kind: row.kind,
    requestedIn: row.requestedIn,
    requestedOut: row.requestedOut,
    reason: row.reason,
    origin: row.origin,
    attachmentFileId: row.attachmentFileId,
    status: row.status,
    approvalRequestId: row.approvalRequestId,
    raisedAt: row.raisedAt,
    decidedAt: row.decidedAt,
    decidedBy:
      row.decidedById === null
        ? null
        : { id: row.decidedById, name: row.decidedByName ?? row.decidedById },
    decisionReason: row.decisionReason,
  };
}

function toOnDuty(row: OnDutyRow): OnDutyRequest {
  return {
    id: row.id,
    employee: { id: row.employeeId, name: row.employeeName },
    employeeCode: row.employeeCode,
    fromDate: row.fromDate,
    toDate: row.toDate,
    reason: row.reason,
    siteName: row.siteName,
    status: row.status,
    approvalRequestId: row.approvalRequestId,
    raisedAt: row.raisedAt,
    decidedAt: row.decidedAt,
    decidedBy:
      row.decidedById === null
        ? null
        : { id: row.decidedById, name: row.decidedByName ?? row.decidedById },
    decisionReason: row.decisionReason,
  };
}
