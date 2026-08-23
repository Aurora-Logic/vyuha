import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  PERMISSIONS,
  assignCollectorSchema,
  assignmentListQuerySchema,
  createPromiseSchema,
  dashboardQuerySchema,
  promiseListQuerySchema,
  sendReminderSchema,
  type CollectorAssignmentView,
  type CollectorDashboard,
  type OpenBillView,
  type Paginated,
  type PromiseView,
  type ReminderNoticeView,
} from '@vyuha/shared';

import { createZodDto } from '../common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../rbac/principal.js';
import { RequirePermission } from '../rbac/route-policy.js';
import { CollectionsService } from './collections.service.js';
import { ReminderService } from './reminder.service.js';

class CreatePromiseDto extends createZodDto(createPromiseSchema) {}
class PromiseListQueryDto extends createZodDto(promiseListQuerySchema) {}
class AssignCollectorDto extends createZodDto(assignCollectorSchema) {}
class AssignmentListQueryDto extends createZodDto(assignmentListQuerySchema) {}
class DashboardQueryDto extends createZodDto(dashboardQuerySchema) {}
class SendReminderDto extends createZodDto(sendReminderSchema) {}

const VIEW = [PERMISSIONS.COLLECTIONS_VIEW_SELF, PERMISSIONS.COLLECTIONS_VIEW_ALL] as const;

/** Area AJ: promises, assignments, the collector's morning. Reading by either view key; writing by collections.manage. */
@Controller('collections')
export class CollectionsController {
  constructor(
    private readonly collections: CollectionsService,
    private readonly reminders: ReminderService,
  ) {}

  @Get('dashboard')
  @RequirePermission(...VIEW)
  dashboard(@CurrentUser() principal: Principal, @Query() query: DashboardQueryDto): Promise<CollectorDashboard> {
    return this.collections.dashboard(principal, query);
  }

  @Get('promises')
  @RequirePermission(...VIEW)
  promises(@CurrentUser() principal: Principal, @Query() query: PromiseListQueryDto): Promise<Paginated<PromiseView>> {
    return this.collections.listPromises(principal, query);
  }

  @Get('promises/:id')
  @RequirePermission(...VIEW)
  promise(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<PromiseView> {
    return this.collections.findPromise(principal, id);
  }

  /** REQ-AJ-01: a promise is taken, never kept by hand. */
  @Post('promises')
  @RequirePermission(PERMISSIONS.COLLECTIONS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  take(@CurrentUser() principal: Principal, @Body() body: CreatePromiseDto): Promise<PromiseView> {
    return this.collections.takePromise(principal, body);
  }

  @Get('assignments')
  @RequirePermission(...VIEW)
  assignments(@CurrentUser() principal: Principal, @Query() query: AssignmentListQueryDto): Promise<Paginated<CollectorAssignmentView>> {
    return this.collections.listAssignments(principal, query);
  }

  /** REQ-AJ-03: assign or replace a party's collector. */
  @Post('assignments')
  @RequirePermission(PERMISSIONS.COLLECTIONS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  assign(@CurrentUser() principal: Principal, @Body() body: AssignCollectorDto): Promise<CollectorAssignmentView> {
    return this.collections.assign(principal, body);
  }

  @Delete('assignments/:id')
  @RequirePermission(PERMISSIONS.COLLECTIONS_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  unassign(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.collections.unassign(principal, id);
  }

  /** REQ-AJ-01: the open bills a promise may name, oldest first. */
  @Get('parties/:id/bills')
  @RequirePermission(...VIEW)
  async bills(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<readonly OpenBillView[]> {
    return this.reminders.billsFor(principal, id, new Date().toISOString().slice(0, 10));
  }

  /** REQ-AJ-06: every reminder ever sent to this party, newest first. */
  @Get('parties/:id/reminders')
  @RequirePermission(...VIEW)
  partyReminders(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string): Promise<Paginated<ReminderNoticeView>> {
    return this.reminders.list(principal, id, Math.max(1, Number(page ?? '1') || 1), Math.min(100, Math.max(1, Number(pageSize ?? '25') || 25)));
  }

  /** REQ-AJ-05: compose from the open bills and send; WhatsApp waits for a person to say it went. */
  @Post('reminders')
  @RequirePermission(PERMISSIONS.COLLECTIONS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  sendReminder(@CurrentUser() principal: Principal, @Body() body: SendReminderDto): Promise<readonly ReminderNoticeView[]> {
    return this.reminders.send(principal, body);
  }

  @Post('reminders/:id/sent')
  @RequirePermission(PERMISSIONS.COLLECTIONS_MANAGE)
  @HttpCode(HttpStatus.OK)
  markReminderSent(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<ReminderNoticeView> {
    return this.reminders.markSent(principal, id);
  }
}
