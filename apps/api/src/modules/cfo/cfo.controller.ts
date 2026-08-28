import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { METRIC_REGISTRY, PERMISSIONS, PIVOT_COLUMNS, PIVOT_DIMENSIONS, PIVOT_METRICS, type MetricDefinition } from '@vyuha/shared';

import { createZodDto } from '../../platform/common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../../platform/rbac/principal.js';
import { RequirePermission } from '../../platform/rbac/route-policy.js';
import { CreditControlService, type CreditOverview, type WorkLists } from './credit-control.service.js';
import { type GrowthBridge } from './growth-bridge.js';
import { MyCfoService, type MyCfo } from './my-cfo.service.js';
import { AlertsService, type Alerts } from './alerts.service.js';
import { AnalyticsService, type AbcXyzCell, type CohortRow, type Concentration, type PriceBand } from './analytics.service.js';
import { BrandService, type BrandRow, type SlabRow } from './brand.service.js';
import { CfoExportService, EXPORT_REPORTS } from './cfo-export.service.js';
import { DataQualityService, type DataQuality } from './data-quality.service.js';
import { MarginService, type MarginRead } from './margin.service.js';
import { DESK_OUTCOMES, DeskService, type CallSheet, type DeskToday, type WeekClose } from './desk.service.js';
import { EXCEPTION_STATES, ExceptionsService, type Exceptions } from './exceptions.service.js';
import { PenetrationService, type Penetration } from './penetration.service.js';
import { SalesAnalysisService, type PivotResult, type SalesAnalysis } from './sales-analysis.service.js';
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

const pivotQuerySchema = salesScopeSchema.extend({
  expr: z.string().trim().min(1).max(200).optional(),
  rows: z.enum(PIVOT_DIMENSIONS),
  columns: z.enum(PIVOT_COLUMNS).optional(),
  metric: z.enum(PIVOT_METRICS).default('net'),
  top: z.coerce.number().int().min(5).max(100).default(20),
});
class PivotQueryDto extends createZodDto(pivotQuerySchema) {}

const deskQuerySchema = z.object({
  cap: z.coerce.number().int().min(5).max(20).default(10),
  mixed: z.enum(['0', '1']).default('0'),
});
class DeskQueryDto extends createZodDto(deskQuerySchema) {}

const weekQuerySchema = z.object({ week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) });
class WeekQueryDto extends createZodDto(weekQuerySchema) {}

const plannerQuerySchema = weekQuerySchema.extend({ cap: z.coerce.number().int().min(5).max(20).default(10) });
class PlannerQueryDto extends createZodDto(plannerQuerySchema) {}

const exportQuerySchema = salesScopeSchema.extend({ report: z.enum(EXPORT_REPORTS) });
class ExportQueryDto extends createZodDto(exportQuerySchema) {}

const scheduleSchema = z.object({
  id: z.string().regex(UUID).optional(),
  report: z.enum(EXPORT_REPORTS),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  recipients: z.string().trim().min(3).max(500),
});
class ScheduleDto extends createZodDto(scheduleSchema) {}

const slabSchema = z.object({
  id: z.string().regex(UUID).optional(),
  brand: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(80),
  threshold: z.string().regex(/^\d{1,14}(\.\d{1,2})?$/u),
  reward: z.string().trim().max(200).default(''),
  active: z.boolean().default(true),
});
class SlabDto extends createZodDto(slabSchema) {}

const snoozeSchema = z.object({
  alertKey: z.string().trim().min(1).max(40),
  partyId: z.string().regex(UUID).nullable().default(null),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  reason: z.string().trim().min(1).max(500),
});
class SnoozeDto extends createZodDto(snoozeSchema) {}

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

const exceptionReviewSchema = z.object({
  checkKey: z.string().trim().min(1).max(40),
  voucherId: z.string().regex(UUID),
  state: z.enum(EXCEPTION_STATES),
  reason: z.string().trim().max(500).default(''),
});
class ExceptionReviewDto extends createZodDto(exceptionReviewSchema) {}

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
    private readonly exceptions: ExceptionsService,
    private readonly exporter: CfoExportService,
    private readonly alerts: AlertsService,
    private readonly margin: MarginService,
    private readonly brands: BrandService,
    private readonly analytics: AnalyticsService,
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

  /** O5.2: the week ahead, read-only, one column per weekday. */
  @Get('desk/planner')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  planner(@CurrentUser() principal: Principal, @Query() query: PlannerQueryDto): ReturnType<DeskService['planner']> {
    return this.deskService.planner(principal, query.week, query.cap);
  }

  /** O5.3: the week close, for the week starting on the given Monday. */
  @Get('desk/week-close')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  weekClose(@CurrentUser() principal: Principal, @Query() query: WeekQueryDto): Promise<WeekClose> {
    return this.deskService.weekClose(principal, query.week);
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

  /** S1.1: rows x columns x metric over the sales fact, at any scope. */
  @Get('pivot')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  pivot(@CurrentUser() principal: Principal, @Query() query: PivotQueryDto): Promise<PivotResult> {
    const { from, to, rows, columns, metric, top, expr, ...scope } = query;
    return this.salesAnalysis.pivot(principal, from, to, scope, { rows, columns: columns ?? null, metric, top, ...(expr === undefined ? {} : { expr }) });
  }

  /** Q4: the registry, for exports and any client that must print a definition. */
  @Get('metrics')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  metrics(): readonly MetricDefinition[] {
    return METRIC_REGISTRY;
  }

  /** F2: the exception list for a window. */
  @Get('exceptions')
  @RequirePermission(PERMISSIONS.CFO_EXCEPTIONS_VIEW)
  exceptionList(@CurrentUser() principal: Principal, @Query() query: CreditQueryDto): Promise<Exceptions> {
    return this.exceptions.list(principal, query.from, query.to);
  }

  @Post('exceptions/review')
  @RequirePermission(PERMISSIONS.CFO_EXCEPTIONS_VIEW)
  async reviewException(@CurrentUser() principal: Principal, @Body() body: ExceptionReviewDto): Promise<{ ok: true }> {
    await this.exceptions.review(principal, body.checkKey, body.voucherId, body.state, body.reason);
    return { ok: true };
  }

  /** O6: the catalogue, filtered to what the caller's own keys open. */
  @Get('export-catalogue')
  @RequirePermission(PERMISSIONS.CFO_EXPORT)
  exportCatalogue(@CurrentUser() principal: Principal): { report: string; title: string; blurb: string }[] {
    return this.exporter.catalogue(principal);
  }

  /** O6.3: a report on a cadence, delivered by the nightly as a summary with a link. */
  @Get('schedules')
  @RequirePermission(PERMISSIONS.CFO_EXPORT)
  async schedules(@CurrentUser() principal: Principal): Promise<{ id: string; report: string; cadence: string; recipients: string; lastRunOn: string | null }[]> {
    return this.exporter.listSchedules(principal);
  }

  @Put('schedules')
  @RequirePermission(PERMISSIONS.CFO_EXPORT)
  async saveSchedule(@CurrentUser() principal: Principal, @Body() body: ScheduleDto): Promise<{ ok: true }> {
    await this.exporter.saveSchedule(principal, body);
    return { ok: true };
  }

  @Delete('schedules/:id')
  @RequirePermission(PERMISSIONS.CFO_EXPORT)
  @HttpCode(204)
  async deleteSchedule(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.exporter.deleteSchedule(principal, id);
  }

  /** R6, O6: export exactly what is on screen, logged. */
  @Get('export')
  @RequirePermission(PERMISSIONS.CFO_EXPORT)
  async exportReport(@CurrentUser() principal: Principal, @Query() query: ExportQueryDto, @Res() res: Response): Promise<void> {
    const { report, from, to, ...scope } = query;
    const file = await this.exporter.build(principal, report, { from, to, scope });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(file.buffer);
  }

  /** Part L, Q5: today's alerts, disciplined -- capped, deduplicated, snoozable. */
  @Get('alerts')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  alertList(@CurrentUser() principal: Principal): Promise<Alerts> {
    return this.alerts.list(principal);
  }

  @Post('alerts/snooze')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  async snoozeAlert(@CurrentUser() principal: Principal, @Body() body: SnoozeDto): Promise<{ ok: true }> {
    await this.alerts.snooze(principal, body.alertKey, body.partyId, body.until, body.reason);
    return { ok: true };
  }

  /** C2: the pocket-price waterfall and margin slices, rupees behind cfo.margin.view. */
  @Get('margin')
  @RequirePermission(PERMISSIONS.CFO_MARGIN_VIEW)
  marginRead(@CurrentUser() principal: Principal, @Query() query: SalesScopeDto): Promise<MarginRead> {
    const { from, to, ...scope } = query;
    return this.margin.read(principal, from, to, scope);
  }

  /** G2: brand performance, slabs and all. */
  @Get('brands')
  @RequirePermission(PERMISSIONS.CFO_BRAND_VIEW)
  brandRead(@CurrentUser() principal: Principal, @Query() query: CreditQueryDto): Promise<{ brands: readonly BrandRow[]; asOf: string }> {
    return this.brands.read(principal, query.from, query.to);
  }

  @Get('brand-slabs')
  @RequirePermission(PERMISSIONS.CFO_BRAND_VIEW)
  slabList(@CurrentUser() principal: Principal): Promise<SlabRow[]> {
    return this.brands.slabRows(principal);
  }

  @Put('brand-slabs')
  @RequirePermission(PERMISSIONS.CFO_TARGETS_MANAGE)
  async saveSlab(@CurrentUser() principal: Principal, @Body() body: SlabDto): Promise<{ ok: true }> {
    await this.brands.saveSlab(principal, body);
    return { ok: true };
  }

  @Delete('brand-slabs/:id')
  @RequirePermission(PERMISSIONS.CFO_TARGETS_MANAGE)
  @HttpCode(204)
  async deleteSlab(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.brands.deleteSlab(principal, id);
  }

  /** M10, M11: bands of what each SKU actually sold at, and the gap to the median. */
  @Get('price-bands')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  priceBands(@CurrentUser() principal: Principal, @Query() query: CreditQueryDto): Promise<PriceBand[]> {
    return this.analytics.priceBands(principal, query.from, query.to);
  }

  /** Q2.9: revenue contribution against demand steadiness, a stocking policy per cell. */
  @Get('abc-xyz')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  abcXyz(@CurrentUser() principal: Principal): Promise<{ cells: AbcXyzCell[] }> {
    return this.analytics.abcXyz(principal);
  }

  /** Q2.21: whether newly won customers are getting better or worse. */
  @Get('cohorts')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  cohorts(@CurrentUser() principal: Principal): Promise<CohortRow[]> {
    return this.analytics.cohorts(principal);
  }

  /** C10, C11: how much of the business a handful of names carries. */
  @Get('concentration')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  concentration(@CurrentUser() principal: Principal): Promise<Concentration> {
    return this.analytics.concentration(principal);
  }

  /** G3: what each person sees about their own book. Scoped in the service, not the query. */
  @Get('me')
  @RequirePermission(PERMISSIONS.CFO_SALES_VIEW)
  me(@CurrentUser() principal: Principal, @Query() query: CreditQueryDto): Promise<MyCfo> {
    return this.myCfo.read(principal, query.from, query.to);
  }
}
