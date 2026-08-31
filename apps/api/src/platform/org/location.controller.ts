import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PERMISSIONS, type Paginated } from '@vyuha/shared';

import { CurrentUser, type Principal } from '../rbac/principal.js';
import { RequirePermission } from '../rbac/route-policy.js';
import { LocationService, type LocationView } from './location.service.js';
import { CreateLocationDto, MasterListQueryDto, UpdateLocationDto } from './org.dto.js';

/**
 * REQ-A-01 at `/api/v1/locations`.
 *
 * Reading takes `employee.view`, like the other two masters -- the employee
 * filter bar needs the names. Writing takes `settings.manage`, which is
 * Admin-only, and that is the one place these three controllers differ: a
 * location row carries the geofence centre and the IP allowlist (REQ-D-08,
 * REQ-D-09), so whoever can edit one decides from where a punch is accepted.
 * That is not an HR control. Recorded in docs/OPEN-QUESTIONS P1-1.
 */
@Controller('locations')
export class LocationController {
  constructor(private readonly locations: LocationService) {}

  @Get()
  @RequirePermission(PERMISSIONS.EMPLOYEE_VIEW)
  list(
    @CurrentUser() principal: Principal,
    @Query() query: MasterListQueryDto,
  ): Promise<Paginated<LocationView>> {
    return this.locations.list(principal, query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() principal: Principal,
    @Body() body: CreateLocationDto,
  ): Promise<LocationView> {
    return this.locations.create(principal, body);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  update(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLocationDto,
  ): Promise<LocationView> {
    return this.locations.update(principal, id, body);
  }
}
