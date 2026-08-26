import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS, type ExportJobSummary } from '@vyuha/shared';

import { CurrentUser, type Principal } from '../rbac/principal.js';
import { RequirePermission } from '../rbac/route-policy.js';
import { EmployeeDataExportService } from './employee-data-export.service.js';

/**
 * REQ-M-05, at `/api/v1/employees/:employeeId/data-export`.
 *
 * `employee.manage` and nothing else, because that is the key the requirement
 * names. Note that it is a *stronger* gate than `employee.view`: reading a
 * record on screen and walking out with every punch, photo reference, leave
 * decision and audit entry about a person are different risks, and the PRD
 * separates them the same way `report.view` and `report.export` are separated.
 *
 * POST rather than GET even though nothing about the employee changes. Two
 * reasons, and both are load-bearing: it creates a job row, and `AuditInterceptor`
 * only writes a trail for mutating methods -- an export of somebody's entire
 * record that left no audit entry would defeat the point of REQ-M-05 sitting in
 * the compliance section.
 *
 * There is no download route here. The file lands in the Downloads tray with
 * every other export (`GET /exports`), and `FileService` issues the
 * signed URL after its own check. A second delivery route would be a second
 * place for that check to drift.
 */
@Controller('employees/:employeeId/data-export')
export class EmployeeDataExportController {
  constructor(private readonly exports: EmployeeDataExportService) {}

  /**
   * 202 rather than 201: the job row exists, but the thing the caller asked for
   * -- the file -- does not yet, and a 201 is a claim a client could act on.
   */
  @Post()
  @RequirePermission(PERMISSIONS.EMPLOYEE_MANAGE)
  @HttpCode(HttpStatus.ACCEPTED)
  request(
    @CurrentUser() principal: Principal,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ): Promise<ExportJobSummary> {
    return this.exports.request(principal, employeeId);
  }

  /**
   * Progress for one request, so a caller can poll without loading the whole
   * tray. Another person's export answers as missing, not forbidden.
   */
  @Get(':jobId')
  @RequirePermission(PERMISSIONS.EMPLOYEE_MANAGE)
  findOne(
    @CurrentUser() principal: Principal,
    @Param('employeeId', ParseUUIDPipe) _employeeId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Promise<ExportJobSummary> {
    return this.exports.findOne(principal, jobId);
  }
}
