import { Global, Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';

import { DashboardLayoutService } from './dashboard-layout.service.js';
import { ExportService } from './export.service.js';
import { ReportController } from './report.controller.js';
import { ReportExportHandler } from './report-export.handler.js';
import { ReportSourceRegistry } from './report-source.registry.js';
import { SavedViewService } from './saved-view.service.js';
import { ScheduleSweepHandler } from './schedule-sweep.handler.js';
import { ScheduleService } from './schedule.service.js';

/**
 * The export framework (REQ-P-02): the report shell endpoints, the export
 * job, saved views, schedules and the Downloads tray. Content-agnostic — what
 * a report *is* comes from whichever module registered a `ReportSource`.
 *
 * `@Global()` for the same reason `JobsModule` and `SearchModule` are: the
 * registry is filled by modules during their own `onModuleInit`, and a
 * registry every module can reach without an import edge is what keeps the
 * arrow pointing one way.
 */
@Global()
@Module({
  imports: [SettingsModule],
  controllers: [ReportController],
  providers: [
    ReportSourceRegistry,
    ExportService,
    SavedViewService,
    DashboardLayoutService,
    ScheduleService,
    ReportExportHandler,
    ScheduleSweepHandler,
  ],
  exports: [ReportSourceRegistry, ExportService],
})
export class ExportModule {}
