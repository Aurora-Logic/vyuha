import { Module } from '@nestjs/common';

import { ApprovalModule } from '../approvals/approvals.module.js';
import { PriceListApprovalHandler } from './price-list-approval.handler.js';
import { PricingController } from './pricing.controller.js';
import { PricingService } from './pricing.service.js';

/**
 * Area AN (docs/15): price lists Vyuha owns. Platform rather than a module
 * (docs/11 D-49): the sales module resolves a line's rate through
 * `pricing-resolver.ts` when it writes the line, and modules may not
 * import each other. The handler registers the `price_list` approval
 * subject on init, so the inbox can decide a list from the first request.
 */
@Module({
  imports: [ApprovalModule],
  controllers: [PricingController],
  providers: [PricingService, PriceListApprovalHandler],
  exports: [PricingService],
})
export class PricingModule {}
