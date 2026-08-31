import { FileInterceptor } from '@nestjs/platform-express';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  type DealAttachmentView,
  PERMISSIONS,
  createDealSchema,
  crmAnalyticsQuerySchema,
  createPipelineSchema,
  createPipelineStageSchema,
  dealBoardQuerySchema,
  dealListQuerySchema,
  reorderPipelineStagesSchema,
  updateDealSchema,
  updatePipelineSchema,
  updatePipelineStageSchema,
  type CrmAnalyticsView,
  type DealBoardView,
  type DealView,
  type Paginated,
  type PipelineStageView,
  type PipelineView,
} from '@vyuha/shared';

import { createZodDto } from '../../../platform/common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../../../platform/rbac/principal.js';
import { AppError } from '../../../platform/common/errors.js';
import { RequirePermission } from '../../../platform/rbac/route-policy.js';
import { DealService } from './deal.service.js';

/** 3 MB, the platform's upload ceiling; the service refuses anything larger too. */
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

class CrmAnalyticsQueryDto extends createZodDto(crmAnalyticsQuerySchema) {}
class DealListQueryDto extends createZodDto(dealListQuerySchema) {}
class DealBoardQueryDto extends createZodDto(dealBoardQuerySchema) {}
class CreateDealDto extends createZodDto(createDealSchema) {}
class UpdateDealDto extends createZodDto(updateDealSchema) {}
class CreatePipelineDto extends createZodDto(createPipelineSchema) {}
class UpdatePipelineDto extends createZodDto(updatePipelineSchema) {}
class CreatePipelineStageDto extends createZodDto(createPipelineStageSchema) {}
class UpdatePipelineStageDto extends createZodDto(updatePipelineStageSchema) {}
class ReorderPipelineStagesDto extends createZodDto(reorderPipelineStagesSchema) {}

const DEAL_VIEW_KEYS = [PERMISSIONS.CRM_DEAL_VIEW_SELF, PERMISSIONS.CRM_DEAL_VIEW_ALL] as const;

/** `/api/v1/crm/pipelines` (09 §5). Reading is a deal viewer's right; shaping is `crm.pipeline.manage`. */
@Controller('crm/pipelines')
export class PipelineController {
  constructor(private readonly deals: DealService) {}

  @Get()
  @RequirePermission(...DEAL_VIEW_KEYS)
  list(@CurrentUser() principal: Principal): Promise<PipelineView[]> {
    return this.deals.listPipelines(principal);
  }

  @Post()
  @RequirePermission(PERMISSIONS.CRM_PIPELINE_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() principal: Principal, @Body() body: CreatePipelineDto): Promise<PipelineView> {
    return this.deals.createPipeline(principal, body);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CRM_PIPELINE_MANAGE)
  update(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePipelineDto,
  ): Promise<PipelineView> {
    return this.deals.updatePipeline(principal, id, body);
  }

  @Post(':id/stages')
  @RequirePermission(PERMISSIONS.CRM_PIPELINE_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  addStage(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreatePipelineStageDto,
  ): Promise<PipelineStageView> {
    return this.deals.addStage(principal, id, body);
  }

  @Put(':id/stages/order')
  @RequirePermission(PERMISSIONS.CRM_PIPELINE_MANAGE)
  reorderStages(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReorderPipelineStagesDto,
  ): Promise<PipelineView> {
    return this.deals.reorderStages(principal, id, body);
  }

  @Patch(':id/stages/:stageId')
  @RequirePermission(PERMISSIONS.CRM_PIPELINE_MANAGE)
  updateStage(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() body: UpdatePipelineStageDto,
  ): Promise<PipelineStageView> {
    return this.deals.updateStage(principal, id, stageId, body);
  }

  @Delete(':id/stages/:stageId')
  @RequirePermission(PERMISSIONS.CRM_PIPELINE_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteStage(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
  ): Promise<void> {
    return this.deals.deleteStage(principal, id, stageId);
  }
}

/** `/api/v1/crm/deals` (09 §5). `board` before `:id`. */
@Controller('crm/deals')
export class DealController {
  constructor(private readonly deals: DealService) {}

  @Get()
  @RequirePermission(...DEAL_VIEW_KEYS)
  list(@CurrentUser() principal: Principal, @Query() query: DealListQueryDto): Promise<Paginated<DealView>> {
    return this.deals.listDeals(principal, query);
  }

  @Get('board')
  @RequirePermission(...DEAL_VIEW_KEYS)
  board(@CurrentUser() principal: Principal, @Query() query: DealBoardQueryDto): Promise<DealBoardView> {
    return this.deals.board(principal, query);
  }

  /**
   * REQ-U-11. Declared above `:id`, or Nest would read "analytics" as a deal
   * id and answer 400 for a route that exists.
   */
  @Get('analytics')
  @RequirePermission(...DEAL_VIEW_KEYS)
  analytics(
    @CurrentUser() principal: Principal,
    @Query() query: CrmAnalyticsQueryDto,
  ): Promise<CrmAnalyticsView> {
    return this.deals.analytics(principal, query);
  }

  @Get(':id')
  @RequirePermission(...DEAL_VIEW_KEYS)
  find(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<DealView> {
    return this.deals.findDeal(principal, id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.CRM_DEAL_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() principal: Principal, @Body() body: CreateDealDto): Promise<DealView> {
    return this.deals.createDeal(principal, body);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CRM_DEAL_MANAGE)
  update(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDealDto,
  ): Promise<DealView> {
    return this.deals.updateDeal(principal, id, body);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.CRM_DEAL_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.deals.deleteDeal(principal, id);
  }

  // ------------------------------------------------------------ attachments

  /**
   * REQ-U-05 (owner, 31 Aug 2026). Attaching is a change to the deal, so it
   * takes `crm.deal.manage`; reading one takes what reading the deal takes.
   * The bytes are sniffed in the service -- a name is never the evidence.
   */
  @Post(':id/attachments')
  @RequirePermission(PERMISSIONS.CRM_DEAL_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 2 } }))
  addAttachment(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
  ): Promise<DealAttachmentView> {
    if (file?.buffer === undefined) throw AppError.validation('No file was uploaded.');
    return this.deals.addAttachment(principal, id, { bytes: file.buffer, filename: file.originalname ?? 'attachment' });
  }

  @Get(':id/attachments')
  @RequirePermission(...DEAL_VIEW_KEYS)
  listAttachments(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<DealAttachmentView[]> {
    return this.deals.listAttachments(principal, id);
  }

  /** A short-lived link rather than the bytes: the same rule every file here follows. */
  @Get(':id/attachments/:attachmentId/url')
  @RequirePermission(...DEAL_VIEW_KEYS)
  attachmentUrl(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.deals.attachmentUrl(principal, id, attachmentId);
  }

  @Delete(':id/attachments/:attachmentId')
  @RequirePermission(PERMISSIONS.CRM_DEAL_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAttachment(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ): Promise<void> {
    await this.deals.removeAttachment(principal, id, attachmentId);
  }

}
