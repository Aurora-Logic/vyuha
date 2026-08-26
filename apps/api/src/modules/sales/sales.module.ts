import { Module } from '@nestjs/common';

import { CustomerNoticeService } from './dispatch/customer-notice.service.js';

import { EstimateGoToSource } from './estimates/estimate-goto.source.js';
import { EstimateController } from './estimates/estimate.controller.js';
import { EstimateService } from './estimates/estimate.service.js';
import { SalesOrderController } from './orders/sales-order.controller.js';
import { SalesOrderService } from './orders/sales-order.service.js';
import { FulfilmentController } from './fulfilment/fulfilment.controller.js';
import { FulfilmentService } from './fulfilment/fulfilment.service.js';
import { DispatchController } from './dispatch/dispatch.controller.js';
import { DispatchService } from './dispatch/dispatch.service.js';
import { ApprovalModule } from '../../platform/approvals/approvals.module.js';
import { CollectionsModule } from '../../platform/collections/collections.module.js';
import { InvoiceController } from './invoices/invoice.controller.js';
import { SalesOrderApprovalHandler } from './orders/sales-order-approval.handler.js';
import { DispatchGoToSource, InvoiceGoToSource, SalesOrderGoToSource } from './orders/sales-goto.source.js';
import { InvoiceService } from './invoices/invoice.service.js';
import { ReturnController } from './returns/return.controller.js';
import { ReturnService } from './returns/return.service.js';

/**
 * The sales module (08 Areas W and Y). Opens with the estimate (Phase 8a);
 * sales orders, challans and the push path join as their slices land.
 * Nothing imported: the platform modules it leans on are `@Global()`, and
 * ESLint keeps it from reaching into `modules/crm` or `modules/purchase`.
 */
// The database's sales rules, in words; registered before any handler can trip one.
import './schema/constraint-messages.js';

@Module({
  imports: [ApprovalModule, CollectionsModule],
  controllers: [EstimateController, SalesOrderController, FulfilmentController, DispatchController, InvoiceController, ReturnController],
  providers: [CustomerNoticeService, EstimateService, EstimateGoToSource, SalesOrderService, FulfilmentService, DispatchService, InvoiceService, SalesOrderApprovalHandler, SalesOrderGoToSource, InvoiceGoToSource, DispatchGoToSource, ReturnService],
})
export class SalesModule {}
