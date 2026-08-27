import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@vyuha/shared';

import { createZodDto } from '../../platform/common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../../platform/rbac/principal.js';
import { RequirePermission } from '../../platform/rbac/route-policy.js';
import { CreditControlService, type CreditOverview, type WorkLists } from './credit-control.service.js';
import { type GrowthBridge } from './growth-bridge.js';
import { MyCfoService, type MyCfo } from './my-cfo.service.js';
import { TeamService, type LeagueRow, type TargetRow } from './team.service.js';

const creditQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});

class CreditQueryDto extends createZodDto(creditQuerySchema) {}

const targetMonthSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/u) });
class TargetMonthDto extends createZodDto(targetMonthSchema) {}

const targetSetSchema = z.object({
  ownerRef: z.string().min(1).max(64),
  month: z.string().regex(/^\d{4}-\d{2}$/u),
  netTarget: z.string().min(1).max(20),
});
class TargetSetDto extends createZodDto(targetSetSchema) {}

/**
 * The Virtual CFO's first routes (Phase 2). Receivables detail behind
 * cfo.receivables.view, the work lists behind the module key -- each list
 * already scoped to what the caller may act on.
 */
@Controller('cfo')
export class CfoController {
  constructor(
    private readonly credit: CreditControlService,
    private readonly myCfo: MyCfoService,
    private readonly team: TeamService,
  ) {}

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

  /** D1: the five-factor bridge, window against the same days last year. */
  @Get('growth-bridge')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  growthBridge(@CurrentUser() principal: Principal, @Query() query: CreditQueryDto): Promise<GrowthBridge> {
    return this.credit.bridge(principal, query.from, query.to);
  }

  /** D2: the movement matrix, every cell a named list. */
  @Get('movement')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  movement(
    @CurrentUser() principal: Principal,
    @Query() query: CreditQueryDto,
  ): ReturnType<CreditControlService['movement']> {
    return this.credit.movement(principal, query.from, query.to);
  }

  /**
   * G4: the league table. K3's deliberate split: every salesperson sees the
   * league; only team.view opens another person's detail behind it.
   */
  @Get('league')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  league(@CurrentUser() principal: Principal, @Query() query: CreditQueryDto): Promise<LeagueRow[]> {
    return this.team.league(principal, query.from, query.to);
  }

  /** G5: the month's targets, for the entry sheet. */
  @Get('targets')
  @RequirePermission(PERMISSIONS.CFO_TARGETS_MANAGE)
  targets(@CurrentUser() principal: Principal, @Query() query: TargetMonthDto): Promise<TargetRow[]> {
    return this.team.listTargets(principal, query.month);
  }

  @Put('targets')
  @RequirePermission(PERMISSIONS.CFO_TARGETS_MANAGE)
  async setTarget(@CurrentUser() principal: Principal, @Body() body: TargetSetDto): Promise<{ ok: true }> {
    await this.team.setTarget(principal, body.ownerRef, body.month, body.netTarget);
    return { ok: true };
  }

  /** G3: what each person sees about their own book. Scoped in the service, not the query. */
  @Get('me')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  me(@CurrentUser() principal: Principal, @Query() query: CreditQueryDto): Promise<MyCfo> {
    return this.myCfo.read(principal, query.from, query.to);
  }
}
