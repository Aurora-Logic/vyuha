import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  PERMISSIONS,
  type OnDutyRequest,
  type Paginated,
  type RegularizationPolicyView,
  type RegularizationRequest,
} from '@vyuha/shared';

import { CurrentUser, type Principal } from '../../../platform/rbac/principal.js';
import { RequirePermission } from '../../../platform/rbac/route-policy.js';
import {
  OnDutyInputDto,
  OnDutyQueryDto,
  RegularizationCompleteDto,
  RegularizationDecisionDto,
  RegularizationInputDto,
  RegularizationPolicyQueryDto,
  RegularizationQueryDto,
  RegularizationRejectionDto,
} from './regularization.dto.js';
import { RegularizationService } from './regularization.service.js';

/**
 * `/api/v1/regularizations` and `/api/v1/on-duty-requests` (technical design
 * §6, which lists `POST` for both). REQ-F-01 … REQ-F-05.
 *
 * Controllers validate and delegate; every decision below the decorator is the
 * service's. The permissions read as a table:
 *
 *   reading           -- either key, narrowed to self or team by `ScopeService`
 *   raising           -- `punch.self`, which every Employee holds
 *   deciding          -- `attendance.edit`
 *
 * Owner, 21 Aug 2026 (docs/05-decisions.md, PENDING A-01): corrections are no
 * longer an employee-raised feature and `regularization.raise` /
 * `regularization.approve` are gone from the catalogue. These routes stand on
 * the keys `packages/shared/src/approval-keys.ts` has named for this subject
 * all along, so a request already open is still decided by whoever may edit
 * attendance, and an employee still sees their own.
 *
 * `RequirePermission` only keeps out an account holding neither key. Whose
 * requests the holder actually sees is `ScopeService`'s answer, and the two
 * rules a guard cannot express -- that an approver is not deciding their own
 * request (REQ-I-05), and that raising for somebody else needs the approver
 * key -- are re-checked in the service.
 */
const VIEW_KEYS = [PERMISSIONS.PUNCH_SELF, PERMISSIONS.ATTENDANCE_EDIT] as const;

@Controller('regularizations')
export class RegularizationController {
  constructor(private readonly regularization: RegularizationService) {}

  /**
   * REQ-F-02's limits, so the form can bound its own calendar.
   *
   * A GET rather than numbers baked into the client: both are org settings,
   * and a form printing 7 and 3 from a constant would go on printing them
   * after an administrator moved the setting.
   */
  @Get('policy')
  @RequirePermission(...VIEW_KEYS)
  policy(
    @CurrentUser() principal: Principal,
    @Query() query: RegularizationPolicyQueryDto,
  ): Promise<RegularizationPolicyView> {
    return this.regularization.policy(principal, query.employeeId);
  }

  @Get()
  @RequirePermission(...VIEW_KEYS)
  list(
    @CurrentUser() principal: Principal,
    @Query() query: RegularizationQueryDto,
  ): Promise<Paginated<RegularizationRequest>> {
    return this.regularization.list(principal, query);
  }

  /** REQ-F-01. */
  @Post()
  @RequirePermission(PERMISSIONS.PUNCH_SELF)
  raise(
    @CurrentUser() principal: Principal,
    @Body() body: RegularizationInputDto,
  ): Promise<RegularizationRequest> {
    return this.regularization.raise(principal, body);
  }

  @Get(':id')
  @RequirePermission(...VIEW_KEYS)
  findOne(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RegularizationRequest> {
    return this.regularization.get(principal, id);
  }

  /**
   * `attendance.regularization_auto_file`'s draft, finished: the employee's
   * reason turns it into a real request an approver can decide. Same
   * permission as raising one from scratch -- this is that, just prefilled.
   */
  @Patch(':id/complete')
  @RequirePermission(PERMISSIONS.PUNCH_SELF)
  complete(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RegularizationCompleteDto,
  ): Promise<RegularizationRequest> {
    return this.regularization.completeDraft(principal, id, body);
  }

  /** REQ-F-03: writes the adjustment and recomputes the day. */
  @Post(':id/approve')
  @RequirePermission(PERMISSIONS.ATTENDANCE_EDIT)
  approve(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RegularizationDecisionDto,
  ): Promise<RegularizationRequest> {
    return this.regularization.approve(principal, id, body.reason);
  }

  /** REQ-F-05: the reason is required by the schema, not by a check in here. */
  @Post(':id/reject')
  @RequirePermission(PERMISSIONS.ATTENDANCE_EDIT)
  reject(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RegularizationRejectionDto,
  ): Promise<RegularizationRequest> {
    return this.regularization.reject(principal, id, body.reason);
  }
}

@Controller('on-duty-requests')
export class OnDutyController {
  constructor(private readonly regularization: RegularizationService) {}

  @Get()
  @RequirePermission(...VIEW_KEYS)
  list(
    @CurrentUser() principal: Principal,
    @Query() query: OnDutyQueryDto,
  ): Promise<Paginated<OnDutyRequest>> {
    return this.regularization.listOnDuty(principal, query);
  }

  /** REQ-F-04. */
  @Post()
  @RequirePermission(PERMISSIONS.PUNCH_SELF)
  raise(
    @CurrentUser() principal: Principal,
    @Body() body: OnDutyInputDto,
  ): Promise<OnDutyRequest> {
    return this.regularization.raiseOnDuty(principal, body);
  }

  @Get(':id')
  @RequirePermission(...VIEW_KEYS)
  findOne(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OnDutyRequest> {
    return this.regularization.getOnDuty(principal, id);
  }

  /** REQ-F-04: "those days become ON_DUTY and count as present". */
  @Post(':id/approve')
  @RequirePermission(PERMISSIONS.ATTENDANCE_EDIT)
  approve(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RegularizationDecisionDto,
  ): Promise<OnDutyRequest> {
    return this.regularization.approveOnDuty(principal, id, body.reason);
  }

  @Post(':id/reject')
  @RequirePermission(PERMISSIONS.ATTENDANCE_EDIT)
  reject(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RegularizationRejectionDto,
  ): Promise<OnDutyRequest> {
    return this.regularization.rejectOnDuty(principal, id, body.reason);
  }
}
