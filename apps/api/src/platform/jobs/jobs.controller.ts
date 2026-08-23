import { Controller, Get } from '@nestjs/common';
import { PERMISSIONS } from '@vyuha/shared';

import { CurrentUser, type Principal } from '../rbac/principal.js';
import { RequirePermission } from '../rbac/route-policy.js';
import { JobMonitorService, type JobMonitorSummary } from './job-monitor.service.js';

/**
 * The read side of the job monitor (technical design §17).
 *
 * `settings.manage` is Admin-only in the PRD §2.1 matrix, which is the right
 * breadth: a failed job's reason can name a file key, an email address, or a
 * database constraint, and none of that belongs on an Operations screen.
 *
 * Read-only, deliberately. Retrying or removing a job from here would be a
 * state change against a queue, and there is no requirement for it yet -- the
 * scheduler re-runs the sweep, and every job is idempotent.
 */
@Controller('jobs')
export class JobsController {
  constructor(private readonly monitor: JobMonitorService) {}

  @Get()
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  summary(@CurrentUser() principal: Principal): Promise<JobMonitorSummary> {
    return this.monitor.summary(principal.orgId);
  }
}
