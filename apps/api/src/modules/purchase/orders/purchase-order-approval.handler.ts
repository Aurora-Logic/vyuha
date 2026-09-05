import { Injectable, type OnModuleInit } from '@nestjs/common';
import { declaredApprovalKeys } from '@vyuha/shared';

import { ApprovalSubjectRegistry, type ApprovalSubjectDecision, type ApprovalSubjectHandler, type ApprovalSubjectSettlement } from '../../../platform/approvals/approval-subject.registry.js';
import type { Database } from '../../../platform/db/db.provider.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import { PURCHASE_ORDER_SUBJECT_TYPE, PurchaseOrderService } from './purchase-order.service.js';

const KEYS = declaredApprovalKeys(PURCHASE_ORDER_SUBJECT_TYPE);

/**
 * 13 REQ-X-16: a purchase order over the threshold is decided in the same
 * inbox as leave, through `platform/approvals`, and this is the seam. Thin
 * on purpose, like the leave handler: what an approval *means* for the PO —
 * confirmed and pushed, or back to draft — is `PurchaseOrderService`'s.
 */
@Injectable()
export class PurchaseOrderApprovalHandler implements ApprovalSubjectHandler, OnModuleInit {
  readonly subjectType = PURCHASE_ORDER_SUBJECT_TYPE;
  readonly actPermissions = KEYS.act;
  readonly overridePermissions = KEYS.override;

  constructor(
    private readonly orders: PurchaseOrderService,
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
