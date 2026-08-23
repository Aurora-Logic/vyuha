import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PRICE_LIST_SUBJECT_TYPE, declaredApprovalKeys } from '@vyuha/shared';

import { ApprovalSubjectRegistry, type ApprovalSubjectDecision, type ApprovalSubjectHandler, type ApprovalSubjectSettlement } from '../approvals/approval-subject.registry.js';
import type { Database } from '../db/db.provider.js';
import type { OrgContext } from '../db/scoped-repository.js';
import { PricingService } from './pricing.service.js';

const KEYS = declaredApprovalKeys(PRICE_LIST_SUBJECT_TYPE);

/**
 * 15 REQ-AN-09/11: a price list is decided in the same inbox as leave and
 * purchase orders, by `pricing.approve` and nothing else -- the catalogue
 * in the shared contract declares the key, and the registry refuses a
 * handler that drifts from it at boot. Thin like its siblings: what the
 * decision means for the list is `PricingService`'s.
 */
@Injectable()
export class PriceListApprovalHandler implements ApprovalSubjectHandler, OnModuleInit {
  readonly subjectType = PRICE_LIST_SUBJECT_TYPE;
  readonly actPermissions = KEYS.act;
  readonly overridePermissions = KEYS.override;

  constructor(
    private readonly pricing: PricingService,
    private readonly registry: ApprovalSubjectRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  applyDecision(ctx: OrgContext, decision: ApprovalSubjectDecision, tx: Database): Promise<ApprovalSubjectSettlement | null> {
    return this.pricing.applyApprovalDecision(ctx, decision, tx);
  }
}
