import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { createZodDto } from '../common/zod-validation.pipe.js';
import {
  PERMISSIONS,
  backfillDates,
  markAbsentBackfillSchema,
  type MarkAbsentBackfillResult,
} from '@vyuha/shared';

import { AuditContext } from '../audit/audit-context.js';
import { CurrentUser, type Principal } from '../rbac/principal.js';
import { RequirePermission } from '../rbac/route-policy.js';
import { JobMonitorService, type JobMonitorSummary } from './job-monitor.service.js';
import { JobRunner } from './job-runner.service.js';

class MarkAbsentBackfillDto extends createZodDto(markAbsentBackfillSchema) {}

/**
 * The job monitor (technical design §17).
 *
 * `settings.manage` is Admin-only in the PRD §2.1 matrix, which is the right
 * breadth: a failed job's reason can name a file key, an email address, or a
 * database constraint, and none of that belongs on an Operations screen.
 *
 * It was read-only, on the reasoning that a state change against a queue had
 * no requirement behind it. The absent backfill is that requirement (owner,
 * 1 Sep 2026): the nightly sweep marks yesterday, so every day before it
 * shipped -- and every night the worker was down -- is blank rather than
 * ABSENT, and there was no way to run it over history.
 */
@Controller('jobs')
export class JobsController {
  constructor(
    private readonly monitor: JobMonitorService,
    private readonly jobs: JobRunner,
    private readonly auditContext: AuditContext,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  summary(@CurrentUser() principal: Principal): Promise<JobMonitorSummary> {
    return this.monitor.summary(principal.orgId);
  }

  /**
   * REQ-E-02: run the nightly absent sweep across a past date range.
   *
   * One job per date rather than one job for the range, for two reasons: the
   * sweep already takes a date and already knows how to do exactly one day,
   * and a range that fails halfway leaves the days it finished done rather
   * than the whole thing to redo.
   *
   * Safe to run twice. The sweep only writes a day that has no row at all, so
   * nothing already recorded, corrected, regularised or manually overridden is
   * touched, and a locked period is refused by the engine itself (REQ-E-09).
   * That is also why this needs no confirmation beyond the permission: it adds
   * the days nobody recorded and cannot overwrite the ones somebody did.
   *
   * `202`, not `200`: the days are queued, and what each one becomes is the
   * day engine's decision made later.
   */
  @Post('mark-absent/backfill')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.ACCEPTED)
  async backfillAbsent(
    @CurrentUser() principal: Principal,
    @Body() body: MarkAbsentBackfillDto,
  ): Promise<MarkAbsentBackfillResult> {
    const dates = backfillDates(body.from, body.to);

    for (const date of dates) {
      // Keyed by date so a second request for an overlapping range does not
      // queue the same day twice. Hyphens, not a colon: BullMQ refuses a
      // custom job id containing one, and the refusal is a 500 rather than
      // anything that names the cause.
      await this.jobs.enqueue('mark-absent', { date }, { jobId: `absent-backfill-${date}` });
    }

    this.auditContext.record({
      action: 'attendance.absent.backfilled',
      entityType: 'attendance_day',
      entityId: null,
      before: null,
      after: { from: body.from, to: body.to, dates: dates.length, requestedBy: principal.userId },
    });

    return { dates: dates.length, from: body.from, to: body.to };
  }
}
