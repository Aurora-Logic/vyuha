import { Injectable, type OnModuleInit } from '@nestjs/common';
import { declaredApprovalKeys } from '@vyuha/shared';

import type { Database } from '../../../platform/db/db.provider.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import {
  ApprovalSubjectRegistry,
  type ApprovalSubjectDecision,
  type ApprovalSubjectHandler,
  type ApprovalSubjectSettlement,
} from '../../../platform/approvals/approval-subject.registry.js';
import {
  ON_DUTY_SUBJECT_TYPE,
  REGULARIZATION_SUBJECT_TYPE,
  RegularizationService,
} from './regularization.service.js';

/**
 * What the approval framework calls when a correction or an on-duty request is
 * decided (REQ-I-01, REQ-F-03, REQ-F-04, REQ-G-09).
 *
 * Registered the way the job handlers are -- each puts itself into the registry
 * during `onModuleInit`, and `ApprovalModule` never imports this file. That
 * indirection is the point rather than a detail: this slice already imports the
 * framework, so a framework that imported it back would close a cycle, and the
 * usual fix for one (`forwardRef`) hides it rather than removing it. Here the
 * arrow only ever points at `ApprovalModule`.
 *
 * Two classes rather than one with a branch on subject type. A registry entry
 * is a subject type and its handler; a single object claiming two types would
 * have to be registered twice under a `subjectType` that can only hold one
 * value, and the branch inside it would be the framework's `switch` moved one
 * file to the left.
 *
 * Both are deliberately thin. Everything a decision *means* is
 * `RegularizationService`'s, which is where the adjustment row and the day
 * recompute already live.
 */

/**
 * PRD §2.1's correction key, and nothing else — `regularization.approve` to
 * act, `leave.approve.all` as the REQ-G-09 escalation override, which widens
 * nothing on its own because `actPermissions` is checked first.
 *
 * Read from the REQ-P-04 catalogue rather than named here: the route guards
 * are derived from the same entries, and the registry refuses a handler whose
 * keys disagree with them, so there is exactly one place these can be wrong.
 * The reasoning for the split itself — why a leave approver is not an
 * approver of corrections — is in the catalogue beside the keys.
 */
const REGULARIZATION_KEYS = declaredApprovalKeys(REGULARIZATION_SUBJECT_TYPE);
const ON_DUTY_KEYS = declaredApprovalKeys(ON_DUTY_SUBJECT_TYPE);

@Injectable()
export class RegularizationApprovalHandler implements ApprovalSubjectHandler, OnModuleInit {
  readonly subjectType = REGULARIZATION_SUBJECT_TYPE;
  readonly actPermissions = REGULARIZATION_KEYS.act;
  readonly overridePermissions = REGULARIZATION_KEYS.override;

  constructor(
    private readonly regularization: RegularizationService,
    private readonly registry: ApprovalSubjectRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  applyDecision(
    ctx: OrgContext,
    decision: ApprovalSubjectDecision,
    tx: Database,
  ): Promise<ApprovalSubjectSettlement | null> {
    return this.regularization.applyApprovalDecision(ctx, decision, tx);
  }

  recoverSettlement(ctx: OrgContext, decision: ApprovalSubjectDecision): Promise<void> {
    return this.regularization.recoverApprovalSettlement(ctx, decision);
  }
}

@Injectable()
export class OnDutyApprovalHandler implements ApprovalSubjectHandler, OnModuleInit {
  readonly subjectType = ON_DUTY_SUBJECT_TYPE;
  /** The same keys by declaration. REQ-F-04 is raised and decided by the same people. */
  readonly actPermissions = ON_DUTY_KEYS.act;
  readonly overridePermissions = ON_DUTY_KEYS.override;

  constructor(
    private readonly regularization: RegularizationService,
    private readonly registry: ApprovalSubjectRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  applyDecision(
    ctx: OrgContext,
    decision: ApprovalSubjectDecision,
    tx: Database,
  ): Promise<ApprovalSubjectSettlement | null> {
    return this.regularization.applyOnDutyDecision(ctx, decision, tx);
  }


  recoverSettlement(ctx: OrgContext, decision: ApprovalSubjectDecision): Promise<void> {
    return this.regularization.recoverOnDutySettlement(ctx, decision);
  }
}
