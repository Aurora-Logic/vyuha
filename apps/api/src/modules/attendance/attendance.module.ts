import { Module } from '@nestjs/common';

import { ConsentModule } from '../../platform/consent/consent.module.js';
import { ApprovalModule } from '../../platform/approvals/approvals.module.js';
import { HolidayModule } from './holidays/holidays.module.js';
import { LeaveModule } from './leave/leave.module.js';
import { RegularizationModule } from './regularization/regularization.module.js';
import { ShiftModule } from './shifts/shifts.module.js';

import { AttendanceSoftDeletes } from './attendance-soft-deletes.js';
import { DayEngineService } from './day-engine/day-engine.service.js';
import { AttendanceDayController } from './days/attendance-day.controller.js';
import { AttendanceDayService } from './days/attendance-day.service.js';
import { AttendanceOverrideService } from './days/attendance-override.service.js';
import { PeriodLockController } from './days/period-lock.controller.js';
import { PeriodLockService } from './days/period-lock.service.js';
import {
  MissingOutSweepHandler,
  PunchReminderHandler,
} from './punch/punch-notification-jobs.handler.js';
import { PunchContextController, PunchController } from './punch/punch.controller.js';
import { PunchFlagApprovalHandler, PunchFlagReviewService } from './punch/punch-flag-review.service.js';
import { PunchService } from './punch/punch.service.js';

/**
 * The attendance module (technical design §3). Phase 1 puts the day engine and
 * the punch slice in it; roster, leave, holiday, regularization, approval and
 * report services join it as their slices land.
 *
 * `DbModule`, `AuditModule`, `FileModule`, `RbacModule`, `JobsModule` and
 * `NotificationsModule` are all `@Global()`, so nothing is imported here -- the
 * boundary this module has to respect is the other direction, and ESLint
 * enforces it: `modules/attendance` may reach into `platform/`, and `platform/`
 * may never reach back.
 */
@Module({
  // One import line per slice, added up front so five parallel builds
  // never contend for this file. ConsentModule is the exception to "nothing
  // is imported here": it is platform but not @Global(), and the punch
  // context needs its service to say whether the REQ-M-03 notice still gates.
  imports: [
    ConsentModule,
    ShiftModule,
    HolidayModule,
    ApprovalModule,
    LeaveModule,
    RegularizationModule,
  ],
  controllers: [
    PunchController,
    PunchContextController,
    AttendanceDayController,
    PeriodLockController,
  ],
  providers: [
    DayEngineService,
    PunchService,
    PunchFlagReviewService,
    PunchFlagApprovalHandler,
    AttendanceDayService,
    AttendanceOverrideService,
    PeriodLockService,
    AttendanceSoftDeletes,
    // REQ-K-03 / REQ-E-07. Both register themselves with the global
    // `JobRegistry` on init, so nothing in `platform/jobs` names them.
    PunchReminderHandler,
    MissingOutSweepHandler,
  ],
  exports: [DayEngineService],
})
export class AttendanceModule {}
