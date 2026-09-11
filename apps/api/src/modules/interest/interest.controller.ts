import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  PERMISSIONS,
  recomputeInterestSchema,
  upsertInterestPartySettingSchema,
  upsertStockInterestSettingSchema,
  type InterestPartySettingView,
  type RecomputeInterestReceipt,
  type StockInterestReportSummary,
  type StockInterestSettingView,
} from '@vyuha/shared';

import { createZodDto } from '../../platform/common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../../platform/rbac/principal.js';
import { RequirePermission } from '../../platform/rbac/route-policy.js';
import { InterestService } from './interest.service.js';

/**
 * The interest module's configuration surface (D-22). The three reports go
 * through the report shell like every other report; what lives here is the
 * per-party overrides, stock overrides, stock report, and the recompute, all
 * behind configure/view keys.
 */
class UpsertInterestPartySettingDto extends createZodDto(upsertInterestPartySettingSchema) {}
class UpsertStockInterestSettingDto extends createZodDto(upsertStockInterestSettingSchema) {}
class RecomputeInterestDto extends createZodDto(recomputeInterestSchema) {}

@Controller('interest')
export class InterestController {
  constructor(private readonly interest: InterestService) {}

  @Get('party-settings')
  @RequirePermission(PERMISSIONS.INTEREST_CONFIGURE)
  list(@CurrentUser() principal: Principal): Promise<InterestPartySettingView[]> {
    return this.interest.listPartySettings(principal);
  }

  @Put('party-settings/:partyId')
  @RequirePermission(PERMISSIONS.INTEREST_CONFIGURE)
  upsert(
    @CurrentUser() principal: Principal,
    @Param('partyId', ParseUUIDPipe) partyId: string,
    @Body() body: UpsertInterestPartySettingDto,
  ): Promise<InterestPartySettingView> {
    return this.interest.upsertPartySetting(principal, partyId, body);
  }

  @Delete('party-settings/:partyId')
  @RequirePermission(PERMISSIONS.INTEREST_CONFIGURE)
  remove(
    @CurrentUser() principal: Principal,
    @Param('partyId', ParseUUIDPipe) partyId: string,
  ): Promise<InterestPartySettingView> {
    return this.interest.removePartySetting(principal, partyId);
  }

  @Get('stock-settings')
  @RequirePermission(PERMISSIONS.INTEREST_CONFIGURE)
  listStockSettings(@CurrentUser() principal: Principal): Promise<StockInterestSettingView[]> {
    return this.interest.listStockSettings(principal);
  }

  @Put('stock-settings')
  @RequirePermission(PERMISSIONS.INTEREST_CONFIGURE)
  upsertStockSetting(
    @CurrentUser() principal: Principal,
    @Body() body: UpsertStockInterestSettingDto,
  ): Promise<StockInterestSettingView> {
    return this.interest.upsertStockSetting(principal, body);
  }

  @Delete('stock-settings/:id')
  @RequirePermission(PERMISSIONS.INTEREST_CONFIGURE)
  removeStockSetting(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StockInterestSettingView> {
    return this.interest.removeStockSetting(principal, id);
  }

  @Get('stock-report')
  @RequirePermission(PERMISSIONS.INTEREST_VIEW)
  getStockReport(
    @CurrentUser() principal: Principal,
    @Query('asOf') asOf?: string,
    @Query('category') category?: string,
    @Query('group') group?: string,
    @Query('isNonMoving') isNonMoving?: string,
    @Query('search') search?: string,
  ): Promise<StockInterestReportSummary> {
    return this.interest.getStockReport(principal, {
      asOf,
      category,
      group,
      isNonMoving: isNonMoving !== undefined ? isNonMoving === 'true' : undefined,
      search,
    });
  }

  @Post('recompute')
  @RequirePermission(PERMISSIONS.INTEREST_CONFIGURE)
  @HttpCode(HttpStatus.ACCEPTED)
  recompute(
    @CurrentUser() principal: Principal,
    @Body() body: RecomputeInterestDto,
  ): Promise<RecomputeInterestReceipt> {
    return this.interest.recompute(principal, body);
  }
}

