import { Module } from '@nestjs/common';

import { CustomReportsService } from './custom-reports.service.js';
import { InsightsController } from './insights.controller.js';
import { InsightsService } from './insights.service.js';

// AuditModule is @Global, so AuditService arrives without an import here.
@Module({
  controllers: [InsightsController],
  providers: [InsightsService, CustomReportsService],
})
export class InsightsModule {}
