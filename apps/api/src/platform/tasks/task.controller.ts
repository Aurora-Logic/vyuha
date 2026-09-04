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
  PERMISSIONS,
  createBoardColumnSchema,
  createTaskSchema,
  reorderBoardColumnsSchema,
  taskBoardQuerySchema,
  taskAnalyticsQuerySchema,
  taskListQuerySchema,
  updateBoardColumnSchema,
  updateTaskSchema,
  type Paginated,
  type TaskBoardColumnView,
  type TaskBoardView,
  type TaskAnalyticsView,
  type TaskAttachmentView,
  type TaskView,
} from '@vyuha/shared';

import { FileInterceptor } from '@nestjs/platform-express';

import { AppError } from '../common/errors.js';
import { createZodDto } from '../common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../rbac/principal.js';
import { RequirePermission } from '../rbac/route-policy.js';
import { TaskService } from './task.service.js';

/** 3 MB, the platform's upload ceiling; the service refuses anything larger too. */
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

class TaskAnalyticsQueryDto extends createZodDto(taskAnalyticsQuerySchema) {}
class TaskListQueryDto extends createZodDto(taskListQuerySchema) {}
class TaskBoardQueryDto extends createZodDto(taskBoardQuerySchema) {}
class CreateTaskDto extends createZodDto(createTaskSchema) {}
class UpdateTaskDto extends createZodDto(updateTaskSchema) {}
class CreateBoardColumnDto extends createZodDto(createBoardColumnSchema) {}
class UpdateBoardColumnDto extends createZodDto(updateBoardColumnSchema) {}
class ReorderBoardColumnsDto extends createZodDto(reorderBoardColumnsSchema) {}

const VIEW_KEYS = [
  PERMISSIONS.CRM_TASK_VIEW_SELF,
  PERMISSIONS.CRM_TASK_VIEW_TEAM,
  PERMISSIONS.CRM_TASK_VIEW_ALL,
] as const;

/**
 * `/api/v1/tasks` (09 §5, platform-level). `board` and `columns` are
 * declared before `:id` so the literal segments are never read as an id.
 *
 * Column configuration sits under `settings.manage`: 08 §2.2 has no key for
 * it, the board is organisation-wide configuration (REQ-V-03), and the
 * settings key is what already gates the rest of that.
 */
@Controller('tasks')
export class TaskController {
  constructor(private readonly tasksService: TaskService) {}

  @Get()
  @RequirePermission(...VIEW_KEYS)
  list(@CurrentUser() principal: Principal, @Query() query: TaskListQueryDto): Promise<Paginated<TaskView>> {
    return this.tasksService.list(principal, query);
  }

  @Get('board')
  @RequirePermission(...VIEW_KEYS)
  board(@CurrentUser() principal: Principal, @Query() query: TaskBoardQueryDto): Promise<TaskBoardView> {
    return this.tasksService.board(principal, query);
  }

  @Get('columns')
  @RequirePermission(...VIEW_KEYS)
  columns(@CurrentUser() principal: Principal): Promise<TaskBoardColumnView[]> {
    return this.tasksService.listColumns(principal);
  }

  @Post('columns')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  createColumn(@CurrentUser() principal: Principal, @Body() body: CreateBoardColumnDto): Promise<TaskBoardColumnView> {
    return this.tasksService.createColumn(principal, body);
  }

  @Put('columns/order')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  reorderColumns(
    @CurrentUser() principal: Principal,
    @Body() body: ReorderBoardColumnsDto,
  ): Promise<TaskBoardColumnView[]> {
    return this.tasksService.reorderColumns(principal, body);
  }

  @Patch('columns/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  updateColumn(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBoardColumnDto,
  ): Promise<TaskBoardColumnView> {
    return this.tasksService.updateColumn(principal, id, body);
  }

  @Delete('columns/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteColumn(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.tasksService.deleteColumn(principal, id);
  }

  // ------------------------------------------------------------ attachments

  /**
   * REQ-V-12 (owner, 31 Aug 2026). Attaching is a change to the task, so it
   * takes `crm.task.manage`; reading one takes what reading the task takes.
   * The bytes are sniffed in the service -- a filename is never the evidence.
   */
  @Post(':id/attachments')
  @RequirePermission(PERMISSIONS.CRM_TASK_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 2 } }))
  addAttachment(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
  ): Promise<TaskAttachmentView> {
    if (file?.buffer === undefined) throw AppError.validation('No file was uploaded.');
    return this.tasksService.addAttachment(principal, id, {
      bytes: file.buffer,
      filename: file.originalname ?? 'attachment',
    });
  }

  @Get(':id/attachments')
  @RequirePermission(...VIEW_KEYS)
  listAttachments(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TaskAttachmentView[]> {
    return this.tasksService.listAttachments(principal, id);
  }

  /** A short-lived link rather than the bytes: the same rule every file here follows. */
  @Get(':id/attachments/:attachmentId/url')
  @RequirePermission(...VIEW_KEYS)
  attachmentUrl(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.tasksService.attachmentUrl(principal, id, attachmentId);
  }

  @Delete(':id/attachments/:attachmentId')
  @RequirePermission(PERMISSIONS.CRM_TASK_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAttachment(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ): Promise<void> {
    return this.tasksService.removeAttachment(principal, id, attachmentId);
  }

  /**
   * REQ-V-11. Declared above `:id`, or Nest reads "analytics" as a task id
   * and answers 400 for a route that exists.
   */
  @Get('analytics')
  @RequirePermission(...VIEW_KEYS)
  analytics(
    @CurrentUser() principal: Principal,
    @Query() query: TaskAnalyticsQueryDto,
  ): Promise<TaskAnalyticsView> {
    return this.tasksService.analytics(principal, query);
  }

  @Get(':id')
  @RequirePermission(...VIEW_KEYS)
  find(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<TaskView> {
    return this.tasksService.find(principal, id);
  }

  /** Any viewer may raise a task for themselves; assigning it to another needs `manage` (checked in the service). */
  @Post()
  @RequirePermission(...VIEW_KEYS)
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() principal: Principal, @Body() body: CreateTaskDto): Promise<TaskView> {
    return this.tasksService.create(principal, body);
  }

  @Patch(':id')
  @RequirePermission(...VIEW_KEYS)
  update(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTaskDto,
  ): Promise<TaskView> {
    return this.tasksService.update(principal, id, body);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.CRM_TASK_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.tasksService.remove(principal, id);
  }
}
