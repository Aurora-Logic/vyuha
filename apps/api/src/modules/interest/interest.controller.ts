import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import {
  PERMISSIONS,
  recomputeInterestSchema,
  upsertInterestPartySettingSchema,
  type InterestPartySettingView,
  type RecomputeInterestReceipt,
} from '@vyuha/shared';

import { createZodDto } from '../../platform/common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../../platform/rbac/principal.js';
import { RequirePermission } from '../../platform/rbac/route-policy.js';
import { InterestService } from './interest.service.js';

/**
 * The interest module's configuration surface (D-22). The three reports go
 * through the report shell like every other report; what lives here is the
 * per-party overrides and the recompute, all behind the configure key —
 * whoever can read the figures through `interest_cost.view` still cannot
 * quietly change the rate they are computed at.
 */
class UpsertInterestPartySettingDto extends createZodDto(upsertInterestPartySettingSchema) {}
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
