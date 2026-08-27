import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@vyuha/shared';

import { createZodDto } from '../../platform/common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../../platform/rbac/principal.js';
import { RequirePermission } from '../../platform/rbac/route-policy.js';
import { CreditControlService, type CreditOverview, type WorkLists } from './credit-control.service.js';
import { type GrowthBridge } from './growth-bridge.js';
import { MyCfoService, type MyCfo } from './my-cfo.service.js';
import { DataQualityService, type DataQuality } from './data-quality.service.js';
import { DESK_OUTCOMES, DeskService, type CallSheet, type DeskToday } from './desk.service.js';
import { PenetrationService, type Penetration } from './penetration.service.js';
import { SalesAnalysisService, type SalesAnalysis } from './sales-analysis.service.js';
import { TeamService, type LeagueRow, type Scorecard, type TargetRow } from './team.service.js';
import { TierService, type PartyClass, type TierRow } from './tier.service.js';

const creditQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});

class CreditQueryDto extends createZodDto(creditQuerySchema) {}

const UUID = /^[0-9a-f-]{36}$/u;
const salesScopeSchema = creditQuerySchema.extend({
  brand: z.string().trim().min(1).max(120).optional(),
  person: z.string().regex(/^(user:[0-9a-f-]{36}|HOUSE|UNASSIGNED)$/u).optional(),
  party: z.string().regex(UUID).optional(),
  item: z.string().regex(UUID).optional(),
});
class SalesScopeDto extends createZodDto(salesScopeSchema) {}

const deskQuerySchema = z.object({
  cap: z.coerce.number().int().min(5).max(20).default(10),
  mixed: z.enum(['0', '1']).default('0'),
});
class DeskQueryDto extends createZodDto(deskQuerySchema) {}

const optionalRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
});
class OptionalRangeDto extends createZodDto(optionalRangeSchema) {}

const money = z.string().regex(/^\d{1,14}(\.\d{1,2})?$/u);
const tierRowSchema = z.object({
  code: z.string().trim().min(1).max(4),
  label: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).default(''),
  colourToken: z.enum(['fresh-1', 'fresh-2', 'fresh-3', 'fresh-4', 'fresh-5']),
  creditDays: z.number().int().min(0).max(365).nullable(),
  creditLimit: money.nullable(),
  maxDiscountPct: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/u).nullable(),
  contactEveryDays: z.number().int().min(1).max(365).nullable(),
  servicePriority: z.string().trim().max(80).default(''),
  reviewEvery: z.string().trim().max(40).default('Quarterly'),
  sortOrder: z.number().int().min(1).max(20),
});
class TierRowDto extends createZodDto(tierRowSchema) {}

const assignClassSchema = z.object({
  tierCode: z.string().trim().min(1).max(4),
  reason: z.string().trim().min(1).max(500),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});
class AssignClassDto extends createZodDto(assignClassSchema) {}

const deskOutcomeSchema = z.object({
  outcome: z.enum(DESK_OUTCOMES),
  amount: z.string().regex(/^\d{1,14}(\.\d{1,2})?$/u).optional(),
  nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  notes: z.string().trim().max(2000).optional(),
});
class DeskOutcomeDto extends createZodDto(deskOutcomeSchema) {}

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
    private readonly salesAnalysis: SalesAnalysisService,
    private readonly deskService: DeskService,
    private readonly quality: DataQualityService,
    private readonly penetration: PenetrationService,
    private readonly tiers: TierService,
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

  /** G4: one person's scorecard. Self under the module key; anyone else needs team.view (checked in the service). */
  @Get('team/:ownerRef')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  scorecard(
    @CurrentUser() principal: Principal,
    @Param('ownerRef') ownerRef: string,
    @Query() query: CreditQueryDto,
  ): Promise<Scorecard> {
    return this.team.scorecard(principal, ownerRef, query.from, query.to);
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

  /** B3: Sales Analysis at any scope -- the filters are the level. */
  @Get('sales-analysis')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  salesAnalysisAt(@CurrentUser() principal: Principal, @Query() query: SalesScopeDto): Promise<SalesAnalysis> {
    const { from, to, ...scope } = query;
    return this.salesAnalysis.analyse(principal, from, to, scope);
  }

  /** Part O: today's ranked, deduplicated, capped list. */
  @Get('desk')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  desk(@CurrentUser() principal: Principal, @Query() query: DeskQueryDto): Promise<DeskToday> {
    return this.deskService.today(principal, { cap: query.cap, mixed: query.mixed === '1' });
  }

  /** O4: the call sheet. */
  @Get('desk/:partyId')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  callSheet(@CurrentUser() principal: Principal, @Param('partyId') partyId: string): Promise<CallSheet> {
    return this.deskService.callSheet(principal, partyId);
  }

  /** O4.1: the outcome that closes the loop. */
  @Post('desk/:partyId/outcome')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  async outcome(
    @CurrentUser() principal: Principal,
    @Param('partyId') partyId: string,
    @Body() body: DeskOutcomeDto,
  ): Promise<{ ok: true }> {
    await this.deskService.logOutcome(principal, partyId, body);
    return { ok: true };
  }

  /** Q3: the screen that admits what is broken. */
  @Get('data-quality')
  @RequirePermission(PERMISSIONS.CFO_EXCEPTIONS_VIEW)
  dataQuality(@CurrentUser() principal: Principal): Promise<DataQuality> {
    return this.quality.read(principal);
  }

  /** Q2.10: the whitespace map. */
  @Get('penetration')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  penetrationGrid(@CurrentUser() principal: Principal, @Query() query: OptionalRangeDto): Promise<Penetration> {
    return this.penetration.read(principal, query.from, query.to);
  }

  /** P3: the class master. Seeded with the brief's five on first read. */
  @Get('tiers')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  listTiers(@CurrentUser() principal: Principal): Promise<TierRow[]> {
    return this.tiers.listTiers(principal);
  }

  @Put('tiers')
  @RequirePermission(PERMISSIONS.CFO_TIER_MASTER)
  async saveTier(@CurrentUser() principal: Principal, @Body() body: TierRowDto): Promise<{ ok: true }> {
    await this.tiers.saveTier(principal, body);
    return { ok: true };
  }

  @Delete('tiers/:code')
  @RequirePermission(PERMISSIONS.CFO_TIER_MASTER)
  @HttpCode(204)
  async deleteTier(@CurrentUser() principal: Principal, @Param('code') code: string): Promise<void> {
    await this.tiers.deleteTier(principal, code);
  }

  /** P4: one customer's class, its history, and the payment grade beside it. */
  @Get('parties/:partyId/class')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  partyClass(@CurrentUser() principal: Principal, @Param('partyId') partyId: string): Promise<PartyClass> {
    return this.tiers.partyClass(principal, partyId);
  }

  @Put('parties/:partyId/class')
  @RequirePermission(PERMISSIONS.CFO_TIER_ASSIGN)
  async assignClass(
    @CurrentUser() principal: Principal,
    @Param('partyId') partyId: string,
    @Body() body: AssignClassDto,
  ): Promise<{ ok: true }> {
    await this.tiers.assign(principal, partyId, body.tierCode, body.reason, body.effectiveFrom);
    return { ok: true };
  }

  /** Q2.2: class x payment grade. */
  @Get('class-grade')
  @RequirePermission(PERMISSIONS.CFO_RECEIVABLES_VIEW)
  classGrade(@CurrentUser() principal: Principal): ReturnType<TierService['classGradeGrid']> {
    return this.tiers.classGradeGrid(principal);
  }

  /** G3: what each person sees about their own book. Scoped in the service, not the query. */
  @Get('me')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  me(@CurrentUser() principal: Principal, @Query() query: CreditQueryDto): Promise<MyCfo> {
    return this.myCfo.read(principal, query.from, query.to);
  }
}
