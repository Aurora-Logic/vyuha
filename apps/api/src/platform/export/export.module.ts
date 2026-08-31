import { Module } from '@nestjs/common';

import { DownloadsController } from './downloads.controller.js';
import { DownloadsService } from './downloads.service.js';

/**
 * What remains of the export framework after the reports module's removal
 * (owner, 26 Aug 2026): the Downloads tray. The report shell, its sources,
 * saved views, schedules and dashboards are gone; the employee data export
 * (REQ-M-05) still writes `export_jobs` rows through its own module and its
 * files land here. No longer `@Global()` -- there is no registry for other
 * modules to fill any more.
 */
@Module({
  controllers: [DownloadsController],
  providers: [DownloadsService],
  exports: [DownloadsService],
})
export class ExportModule {}
