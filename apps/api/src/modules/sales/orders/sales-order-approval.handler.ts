import { Injectable, type OnModuleInit } from '@nestjs/common';
import { declaredApprovalKeys } from '@vyuha/shared';

import { ApprovalSubjectRegistry, type ApprovalSubjectDecision, type ApprovalSubjectHandler, type ApprovalSubjectSettlement } from '../../../platform/approvals/approval-subject.registry.js';
import type { Database } from '../../../platform/db/db.provider.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import { SALES_ORDER_SUBJECT_TYPE, SalesOrderService } from './sales-order.service.js';

const KEYS = declaredApprovalKeys(SALES_ORDER_SUBJECT_TYPE);

/**
 * 08 REQ-W-08: a discount past the threshold is decided in the same inbox as
 * leave and purchase orders, and this is the seam. Thin like its siblings:
 * what the decision means for the order — confirmed and queued, or back to
 * draft — is `SalesOrderService`'s.
 */
@Injectable()
export class SalesOrderApprovalHandler implements ApprovalSubjectHandler, OnModuleInit {
  readonly subjectType = SALES_ORDER_SUBJECT_TYPE;
  readonly actPermissions = KEYS.act;
  readonly overridePermissions = KEYS.override;

  constructor(
    private readonly orders: SalesOrderService,
    private readonly registry: ApprovalSubjectRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  applyDecision(ctx: OrgContext, decision: ApprovalSubjectDecision, tx: Database): Promise<ApprovalSubjectSettlement | null> {
    return this.orders.applyApprovalDecision(ctx, decision, tx);
  }

  recoverSettlement(ctx: OrgContext, decision: ApprovalSubjectDecision): Promise<void> {
    return this.orders.recoverApprovalSettlement(ctx, decision);
  }
}
