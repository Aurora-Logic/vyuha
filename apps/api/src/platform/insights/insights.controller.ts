import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  customReportWriteSchema,
  INSIGHT_AREAS,
  insightsQuerySchema,
  PERMISSIONS,
  type AreaInsights,
  type CustomReportView,
  type InsightArea,
} from '@vyuha/shared';

import { AppError } from '../common/errors.js';
import { createZodDto } from '../common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../rbac/principal.js';
import { RequirePermission } from '../rbac/route-policy.js';
import { CustomReportsService } from './custom-reports.service.js';
import { InsightsService } from './insights.service.js';

class InsightsQueryDto extends createZodDto(insightsQuerySchema) {}
class CustomReportWriteDto extends createZodDto(customReportWriteSchema) {}

/**
 * The reports module's API (owner, 26 Aug 2026). report.view opens the
 * module; each area then applies its own gate inside the service, so this
 * module is a window onto data someone may already see, never a side door.
 */
@Controller('insights')
export class InsightsController {
  constructor(
    private readonly insights: InsightsService,
    private readonly customReports: CustomReportsService,
  ) {}

  /** Declared before the area route so the literal path wins the match. */
  @Get('custom-reports')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  listCustomReports(@CurrentUser() principal: Principal): Promise<CustomReportView[]> {
    return this.customReports.list(principal);
  }

  @Post('custom-reports')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  createCustomReport(
    @CurrentUser() principal: Principal,
    @Body() body: CustomReportWriteDto,
  ): Promise<CustomReportView> {
    return this.customReports.create(principal, body);
  }

  @Get('custom-reports/:id')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  findCustomReport(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomReportView> {
    return this.customReports.find(principal, id);
  }

  @Put('custom-reports/:id')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  updateCustomReport(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CustomReportWriteDto,
  ): Promise<CustomReportView> {
    return this.customReports.update(principal, id, body);
  }

  @Delete('custom-reports/:id')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @HttpCode(204)
  async removeCustomReport(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.customReports.remove(principal, id);
  }

  @Get(':area')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  area(
    @CurrentUser() principal: Principal,
    @Param('area') area: string,
    @Query() query: InsightsQueryDto,
  ): Promise<AreaInsights> {
    if (!(INSIGHT_AREAS as readonly string[]).includes(area)) {
      throw AppError.notFound('Report area', area);
    }
    return this.insights.area(principal, area as InsightArea, query);
  }
}
