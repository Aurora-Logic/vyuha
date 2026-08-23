import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  PERMISSIONS,
  priceListDraftSchema,
  priceListsQuerySchema,
  rateSimulationQuerySchema,
  type Paginated,
  type PriceListDetail,
  type PriceListDiff,
  type PriceListSummary,
  type RateSimulation,
} from '@vyuha/shared';

import { createZodDto } from '../common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../rbac/principal.js';
import { RequirePermission } from '../rbac/route-policy.js';
import { PricingService } from './pricing.service.js';

class PriceListDraftDto extends createZodDto(priceListDraftSchema) {}
class PriceListsQueryDto extends createZodDto(priceListsQuerySchema) {}
class RateSimulationQueryDto extends createZodDto(rateSimulationQuerySchema) {}

/** Area AN: price lists, their versions and approval, and the simulator. Reading needs the masters key; writing, pricing.manage. */
@Controller('pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get('lists')
  @RequirePermission(PERMISSIONS.MASTERS_TALLY_VIEW)
  list(@CurrentUser() principal: Principal, @Query() query: PriceListsQueryDto): Promise<Paginated<PriceListSummary>> {
    return this.pricing.list(principal, query);
  }

  /** REQ-AN-18: declared before lists/:id so the literal wins. */
  @Get('simulate')
  @RequirePermission(PERMISSIONS.MASTERS_TALLY_VIEW)
  simulate(@CurrentUser() principal: Principal, @Query() query: RateSimulationQueryDto): Promise<RateSimulation> {
    return this.pricing.simulate(principal, query);
  }

  @Get('lists/:id')
  @RequirePermission(PERMISSIONS.MASTERS_TALLY_VIEW)
  find(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<PriceListDetail> {
    return this.pricing.find(principal, id);
  }

  @Get('lists/:id/diff')
  @RequirePermission(PERMISSIONS.MASTERS_TALLY_VIEW)
  diff(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<PriceListDiff> {
    return this.pricing.diff(principal, id);
  }

  @Post('lists')
  @RequirePermission(PERMISSIONS.PRICING_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() principal: Principal, @Body() body: PriceListDraftDto): Promise<PriceListDetail> {
    return this.pricing.createDraft(principal, body);
  }

  @Put('lists/:id')
  @RequirePermission(PERMISSIONS.PRICING_MANAGE)
  update(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: PriceListDraftDto): Promise<PriceListDetail> {
    return this.pricing.updateDraft(principal, id, body);
  }

  @Post('lists/:id/versions')
  @RequirePermission(PERMISSIONS.PRICING_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  newVersion(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<PriceListDetail> {
    return this.pricing.newVersion(principal, id);
  }

  @Post('lists/:id/submit')
  @RequirePermission(PERMISSIONS.PRICING_MANAGE)
  @HttpCode(HttpStatus.OK)
  submit(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<PriceListDetail> {
    return this.pricing.submit(principal, id);
  }
}
