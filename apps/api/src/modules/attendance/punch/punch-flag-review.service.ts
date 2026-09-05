import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  declaredApprovalKeys,
  type PunchFlagReviewInput,
  type PunchRecord,
} from '@vyuha/shared';
import { and, eq, sql } from 'drizzle-orm';

import { ApprovalService } from '../../../platform/approvals/approval.service.js';
import {
  ApprovalSubjectRegistry,
  type ApprovalSubjectDecision,
  type ApprovalSubjectHandler,
  type ApprovalSubjectSettlement,
} from '../../../platform/approvals/approval-subject.registry.js';
import { AuditContext } from '../../../platform/audit/audit-context.js';
import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import { orgContextOf, type Principal } from '../../../platform/rbac/principal.js';
import { DayEngineService } from '../day-engine/day-engine.service.js';
import { AttendanceOverrideService } from '../days/attendance-override.service.js';
import { punchFlagReviews, punches } from '../schema/index.js';
import { PunchRepository } from './punch.repository.js';

export const PUNCH_SUBJECT_TYPE = 'punch';
const PUNCH_KEYS = declaredApprovalKeys(PUNCH_SUBJECT_TYPE);

/**
 * Owner, 21 Aug 2026: the four things an admin does with a flagged punch.
 *
 * Accept clears the flag (the day engine stops raising it), Keep leaves it,
 * Mark half day pins the day through the same override HR already uses, and
 * Add note closes nothing. The first three also settle the approval the punch
 * raised, so the inbox and the day record agree. A punch row is never edited
 * (REQ-D-12); the review is its own row, and the latest decisive one is what
 * every reader sees.
 */
@Injectable()
export class PunchFlagReviewService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly approvals: ApprovalService,
    private readonly dayEngine: DayEngineService,
    private readonly override: AttendanceOverrideService,
    private readonly auditContext: AuditContext,
  ) {}

  async review(principal: Principal, punchId: string, input: PunchFlagReviewInput): Promise<PunchRecord> {
    const ctx = orgContextOf(principal);
    const repository = new PunchRepository(this.db, ctx);
    const punch = await repository.findById(punchId, sql`true`);
    if (punch === null) throw AppError.notFound('Punch', punchId);

    await this.db.insert(punchFlagReviews).values({
      orgId: principal.orgId,
      punchId,
      action: input.action,
      note: input.note ?? null,
      decidedBy: principal.userId,
    });
    this.auditContext.record({
      action: 'punch.flag_reviewed',
      entityType: 'punch',
      entityId: punchId,
      after: {
        action: input.action,
        note: input.note ?? null,
        employeeId: punch.employee.id,
        attendanceDate: punch.attendanceDate,
        ...(input.halfDayPart === undefined ? {} : { halfDayPart: input.halfDayPart }),
      },
    });

    if (input.action === 'HALF_DAY') {
      await this.override.override(principal, punch.employee.id, punch.attendanceDate, {
        status: 'HALF_DAY',
        reason: input.note ?? `Marked half day from a flagged ${punch.type} punch`,
      });
    }

    if (input.action !== 'NOTE') {
      // The whole day, not just this punch (owner, 1 Sep 2026: "once is
      // fine"). A late morning flags several punches, and answering for one
      // of them while the others stay pending is how the reviewer ended up
      // accepting the same morning four times. `raiseFlagApproval` now opens
      // one request per day; this settles every request the day still has,
      // including any raised before that change.
      const decision = input.action === 'KEEP' ? ('REJECT' as const) : ('APPROVE' as const);
      const dayPunches = await repository.findForDay(punch.employee.id, punch.attendanceDate);
      const subjects = [punchId, ...dayPunches.map((row) => row.id).filter((id) => id !== punchId)];

      for (const subjectId of subjects) {
        const approval = await this.approvals.findForSubject(ctx, PUNCH_SUBJECT_TYPE, subjectId);
        if (approval === null) continue;
        if (approval.status !== 'PENDING' && approval.status !== 'ESCALATED') continue;
        await this.approvals.decide(principal, approval.id, decision, input.note ?? null);
      }

      // And a review row for each flagged sibling, not only for the approvals.
      // The day engine clears a flag by reading the reviews, so settling the
      // inbox alone left the day still showing the flag that had just been
      // accepted -- the reviewer would have seen the decision take and the day
      // disagree with it.
      for (const sibling of dayPunches) {
        if (sibling.id === punchId) continue;
        if (sibling.flags.length === 0) continue;
        const reviewed = await this.db
          .select({ id: punchFlagReviews.id })
          .from(punchFlagReviews)
          .where(and(eq(punchFlagReviews.punchId, sibling.id), eq(punchFlagReviews.orgId, principal.orgId)))
          .limit(1);
        if (reviewed.length > 0) continue;
        await this.db.insert(punchFlagReviews).values({
          orgId: principal.orgId,
          punchId: sibling.id,
          action: input.action,
          note: input.note ?? 'Decided with the rest of the day',
          decidedBy: principal.userId,
        });
      }
      // The engine re-reads the reviews, so an accepted flag clears now rather
      // than at the next sweep. The override above already recomputed for a
      // half day, and a kept flag changes nothing the engine reads.
      if (input.action === 'ACCEPT') {
        await this.dayEngine.forOrg(ctx).computeDay(punch.employee.id, punch.attendanceDate, { now: new Date() });
      }
    }

    const fresh = await repository.findById(punchId, sql`true`);
    if (fresh === null) throw AppError.notFound('Punch', punchId);
    return fresh;
  }

  /**
   * A decision taken through the inbox's plain Approve / Reject rather than
   * the four buttons: Approve accepts, Reject keeps. Written only when the
   * punch has no decisive review yet, so the review endpoint's own row is
   * not duplicated when it settles the same approval a moment earlier.
   */
  async applyApprovalDecision(
    ctx: OrgContext,
    decision: ApprovalSubjectDecision,
    tx: Database,
  ): Promise<ApprovalSubjectSettlement | null> {
    if (decision.status !== 'APPROVED' && decision.status !== 'REJECTED') return null;
    const existing = await tx
      .select({ id: punchFlagReviews.id })
      .from(punchFlagReviews)
      .where(and(eq(punchFlagReviews.punchId, decision.subjectId), eq(punchFlagReviews.orgId, ctx.orgId)))
      .limit(1);
    const target = await tx
      .select({ employeeId: punches.employeeId, attendanceDate: punches.attendanceDate })
      .from(punches)
      .where(and(eq(punches.id, decision.subjectId), eq(punches.orgId, ctx.orgId)))
      .limit(1);
    const punch = target[0];
    if (punch === undefined) return null;
    if (existing.length === 0) {
      await tx.insert(punchFlagReviews).values({
        orgId: ctx.orgId,
        punchId: decision.subjectId,
        action: decision.status === 'APPROVED' ? 'ACCEPT' : 'KEEP',
        note: decision.reason,
        decidedBy: decision.decidedByUserId,
      });
    }
    return async () => {
      await this.dayEngine.forOrg(ctx).computeDay(punch.employeeId, punch.attendanceDate, { now: new Date() });
    };
  }

  async recoverApprovalSettlement(
    ctx: OrgContext,
    decision: ApprovalSubjectDecision,
  ): Promise<void> {
    if (decision.status !== 'APPROVED' && decision.status !== 'REJECTED') return;
    const target = await this.db
      .select({ employeeId: punches.employeeId, attendanceDate: punches.attendanceDate })
      .from(punches)
      .where(and(eq(punches.id, decision.subjectId), eq(punches.orgId, ctx.orgId)))
      .limit(1);
    const punch = target[0];
    if (punch === undefined) throw AppError.notFound('Punch', decision.subjectId);
    await this.dayEngine
      .forOrg(ctx)
      .computeDay(punch.employeeId, punch.attendanceDate, { now: new Date() });
  }
}

/** The registry entry for `punch`, thin like the regularization one. */
@Injectable()
export class PunchFlagApprovalHandler implements ApprovalSubjectHandler, OnModuleInit {
  readonly subjectType = PUNCH_SUBJECT_TYPE;
  readonly actPermissions = PUNCH_KEYS.act;
  readonly overridePermissions = PUNCH_KEYS.override;

  constructor(
    private readonly reviews: PunchFlagReviewService,
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
    return this.reviews.applyApprovalDecision(ctx, decision, tx);
  }

  recoverSettlement(ctx: OrgContext, decision: ApprovalSubjectDecision): Promise<void> {
    return this.reviews.recoverApprovalSettlement(ctx, decision);
  }
}
