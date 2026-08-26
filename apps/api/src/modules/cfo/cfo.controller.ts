import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@vyuha/shared';

import { createZodDto } from '../../platform/common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../../platform/rbac/principal.js';
import { RequirePermission } from '../../platform/rbac/route-policy.js';
import { CreditControlService, type CreditOverview, type WorkLists } from './credit-control.service.js';

const creditQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});

class CreditQueryDto extends createZodDto(creditQuerySchema) {}

/**
 * The Virtual CFO's first routes (Phase 2). Receivables detail behind
 * cfo.receivables.view, the work lists behind the module key -- each list
 * already scoped to what the caller may act on.
 */
@Controller('cfo')
export class CfoController {
  constructor(private readonly credit: CreditControlService) {}

  @Get('receivables')
  @RequirePermission(PERMISSIONS.CFO_RECEIVABLES_VIEW)
  receivables(@CurrentUser() principal: Principal, @Query() query: CreditQueryDto): Promise<CreditOverview> {
    return this.credit.receivables(principal, query.from, query.to);
  }

  @Get('work-lists')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  workLists(@CurrentUser() principal: Principal): Promise<WorkLists> {
    return this.credit.workLists(principal);
  }
}
