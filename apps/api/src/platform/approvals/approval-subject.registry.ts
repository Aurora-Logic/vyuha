import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  APPROVAL_SUBJECT_KEYS,
  type ApprovalSubjectKeyDeclaration,
  type PermissionKey,
} from '@vyuha/shared';

import type { Database } from '../db/db.provider.js';
import type { OrgContext } from '../db/scoped-repository.js';

/**
 * Keyed by plain string: subject types are an open set on the wire, and the
 * registry meets a handler before it can know whether the type is "known".
 */
export type ApprovalKeyCatalogue = Readonly<Record<string, ApprovalSubjectKeyDeclaration>>;

/**
 * How a slice attaches its own records to the approval framework (REQ-I-01).
 *
 * The framework must not import leave, regularization, or anything else it
 * decides for -- those slices already import it, and an arrow that points both
 * ways is a cycle `forwardRef` would hide rather than remove. So the shape is
 * the one `JobRegistry` uses: a map from a key to a handler, each slice putting
 * itself in during `onModuleInit`, and the framework looking a handler up by
 * key when it has something to say. Nothing in `approvals/` knows what a leave
 * request is; it knows that `leave_request` has an owner.
 *
 * **A subject type with no handler cannot be raised or decided.** That is the
 * whole safety property. Without it, a slice that raises a request and forgets
 * to register would produce an inbox that says "approved" while the record it
 * was about never moved -- no error anywhere, and an append-only ledger that
 * silently disagrees with the decision. `ApprovalService` therefore asks this
 * registry at both ends: at `raise`, so a request that can never be completed
 * is never created, and at the decision, so a row raised before its handler
 * existed is refused rather than half-applied.
 */

/**
 * The statuses a handler is told about.
 *
 * `APPROVED` and `REJECTED` are terminal. `ESCALATED` is not -- REQ-G-09 moves
 * an untouched request up a level and it stays decidable -- but the subject has
 * to hear about it, because a leave request sitting at "pending" while its
 * approval says "escalated" is two records disagreeing about the same fact.
 *
 * `CANCELLED` is deliberately absent: the framework only ever cancels through
 * `cancelForSubject`, which the owning slice calls while it is cancelling the
 * subject itself. Telling it what it just told us would be a second write.
 */
export type ApprovalSubjectStatus = 'APPROVED' | 'REJECTED' | 'ESCALATED';

export interface ApprovalSubjectDecision {
  readonly approvalRequestId: string;
  /** The subject's own id -- the leave request, the regularization, and so on. */
  readonly subjectId: string;
  readonly status: ApprovalSubjectStatus;
  readonly reason: string | null;
  /** Null when the escalation job moved it; a job has no user to name. */
  readonly decidedByUserId: string | null;
  /** When the decision was recorded, so subject and approval agree to the ms. */
  readonly at: Date;
}

/**
 * Work the handler wants done once the decision has actually committed.
 *
 * Returned rather than performed, because the two halves have opposite failure
 * rules. The ledger write and the status change must roll back together with
 * the approval -- an approved request whose ledger recorded nothing is the
 * exact failure this whole design exists to prevent. Recomputing the muster and
 * sending the employee an email must not: they read the committed row, and a
 * transaction still open cannot be read by the day engine's own connection.
 */
export type ApprovalSubjectSettlement = () => Promise<void>;

export interface ApprovalSubjectHandler {
  /** `snake_case`; see `APPROVAL_SUBJECT_TYPES` in the shared contract. */
  readonly subjectType: string;

  /**
   * The permission keys that let a holder decide *this kind* of request.
   *
   * Declared by the slice rather than fixed in the framework, and that is the
   * whole reason it exists. One inbox decides several kinds of request, and
   * the keys that authorise them are not the same: leave is
   * `leave.approve.team` / `leave.approve.all`, a correction is
   * `regularization.approve`. Without this, routing a second subject type into
   * the inbox would silently make the leave keys grant it -- PRD §2.1 gives
   * `regularization.approve` its own existence precisely so that they are
   * separable -- and a manager routed a leave request because they are the
   * reporting manager, holding only `regularization.approve`, would be able to
   * approve it. The route guard on `/approvals/:id/approve` can only ask
   * whether the caller approves *something*; this is what narrows it to the
   * request in front of them.
   *
   * Checked in `ApprovalService.decideWithin` and nowhere else, so the single
   * and bulk paths cannot disagree.
   */
  readonly actPermissions: readonly PermissionKey[];

  /**
   * The keys that additionally let a holder act on a step never routed to them.
   *
   * REQ-G-09 escalates to HR, so an org-wide approver has to be able to answer
   * a step somebody else was named on. Evaluated *after* REQ-I-05's
   * self-approval refusal, never before -- see `evaluateDecision`, where the
   * order is the requirement.
   */
  readonly overridePermissions: readonly PermissionKey[];

  /**
   * Applies the decision to the subject, inside the framework's transaction.
   *
   * **The approver is not re-checked here.** The framework has already decided
   * that this actor may act on this request, at this step, under this
   * delegation (REQ-I-05 included), and a second opinion in the handler is a
   * second place the rule can be wrong. What the handler owns is what the
   * decision *means* for its own records.
   */
  applyDecision(
    ctx: OrgContext,
    decision: ApprovalSubjectDecision,
    tx: Database,
  ): Promise<ApprovalSubjectSettlement | null>;

  /**
   * Rebuilds only the idempotent post-commit work from durable decision data.
   * Production handlers that return a settlement implement this; optional so
   * lightweight third-party/test handlers that never return one remain valid.
   */
  recoverSettlement?(
    ctx: OrgContext,
    decision: ApprovalSubjectDecision,
  ): Promise<void>;
}

@Injectable()
export class ApprovalSubjectRegistry {
  private readonly logger = new Logger(ApprovalSubjectRegistry.name);
  private readonly handlers = new Map<string, ApprovalSubjectHandler>();
  private readonly catalogue: ApprovalKeyCatalogue;

  /**
   * The catalogue is a parameter so a test can rehearse a module that does
   * not exist yet — declaring its keys the same way the real one will, in
   * data, rather than the test being exempt from the rule it exercises.
   * Nothing in production passes one; `@Optional()` lets Nest construct this
   * with no provider and the shared catalogue is the default.
   */
  constructor(@Optional() catalogue?: ApprovalKeyCatalogue) {
    this.catalogue = catalogue ?? APPROVAL_SUBJECT_KEYS;
  }

  register(handler: ApprovalSubjectHandler): void {
    if (this.handlers.has(handler.subjectType)) {
      // Two handlers for one subject type means one of them silently never
      // runs, and which one would depend on module initialisation order.
      throw new Error(
        `Approval subject "${handler.subjectType}" already has a handler registered.`,
      );
    }
    this.assertMatchesCatalogue(handler);
    this.handlers.set(handler.subjectType, handler);
    this.logger.log({ msg: `Approval subject handler registered: ${handler.subjectType}` });
  }

  /**
   * A *declared* subject's handler must carry the catalogue's keys, and a
   * disagreement is a boot failure rather than a review item.
   *
   * The route guards are derived from the catalogue at class definition; the
   * per-request narrowing reads the handler at run time. If the two drift,
   * one layer admits what the other refuses — an approver the guard turns
   * away at the door, or a key the guard honours that no handler narrows —
   * and both failures are silent until somebody is wrongly refused or
   * wrongly allowed. Handlers therefore *read* their keys from the catalogue;
   * this check is what catches the one that hand-writes them instead.
   *
   * An **undeclared** subject type registers freely, on purpose. Subject
   * types are an open set — the framework's own tests register synthetic
   * ones — and a module that ships without declaring only hurts itself: the
   * guards never heard of its keys, so its approvers answer 403 at the door
   * and its first endpoint test says so. What must never happen quietly is a
   * declared subject meaning two different things in two layers.
   */
  private assertMatchesCatalogue(handler: ApprovalSubjectHandler): void {
    const declared = Object.hasOwn(this.catalogue, handler.subjectType)
      ? this.catalogue[handler.subjectType]
      : undefined;
    if (declared === undefined) return;

    const same = (a: readonly PermissionKey[], b: readonly PermissionKey[]): boolean => {
      if (a.length !== b.length) return false;
      const sortedA = [...a].sort();
      const sortedB = [...b].sort();
      return sortedA.every((key, i) => key === sortedB[i]);
    };

    if (!same(declared.act, handler.actPermissions)) {
      throw new Error(
        `Approval subject "${handler.subjectType}" declares act keys ` +
          `[${handler.actPermissions.join(', ')}] but the catalogue says [${declared.act.join(', ')}].`,
      );
    }
    if (!same(declared.override, handler.overridePermissions)) {
      throw new Error(
        `Approval subject "${handler.subjectType}" declares override keys ` +
          `[${handler.overridePermissions.join(', ')}] but the catalogue says [${declared.override.join(', ')}].`,
      );
    }
  }

  get(subjectType: string): ApprovalSubjectHandler | null {
    return this.handlers.get(subjectType) ?? null;
  }

  registeredSubjectTypes(): readonly string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Per subject type, every key that lets a holder decide it (REQ-P-04).
   *
   * For SQL that has to narrow per row. The inbox's delegation filter used to
   * carry its own `CASE` -- LEAVE to the leave keys, everything else to
   * `regularization.approve` -- and its comment named the duplication as a real
   * cost. It was worse than duplication: `ELSE` is not a default, it is a
   * guess, and the guess was an attendance key. A CRM discount approval would
   * have required `regularization.approve` to appear in a delegate's inbox,
   * which no salesperson holds and no CRM role should ever be given.
   *
   * A subject type with no handler yields no entry, so a caller building a
   * predicate from this matches nothing for it. That is the same fail-closed
   * property `get` already gives the decision path: unregistered means
   * undecidable, never "decidable by whoever was listed last".
   */
  decidingPermissionsBySubjectType(): ReadonlyArray<{
    readonly subjectType: string;
    readonly permissions: readonly PermissionKey[];
  }> {
    return [...this.handlers.values()].map((handler) => ({
      subjectType: handler.subjectType,
      permissions: [...new Set([...handler.actPermissions, ...handler.overridePermissions])],
    }));
  }

  /**
   * The keys that let a holder answer a step they were never routed to, across
   * every registered subject type.
   *
   * This is what "approves for the whole organisation" means once more than one
   * module raises approvals, and it is who REQ-G-09 escalates to when the
   * reporting line runs out. Derived rather than declared so that a module
   * added later is escalated to by its own key instead of silently routing to
   * whoever holds `leave.approve.all`.
   */
  orgWidePermissions(): readonly PermissionKey[] {
    return [...new Set([...this.handlers.values()].flatMap((h) => [...h.overridePermissions]))];
  }
}
