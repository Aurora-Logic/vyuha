import { Module } from '@nestjs/common';

import { CompanyController, ContactController } from './contacts/crm.controller.js';
import { ActivityController } from './activities/activity.controller.js';
import { ActivityService } from './activities/activity.service.js';
import { CompanyGoToSource, ContactGoToSource } from './contacts/contact-goto.source.js';
import { FileModule } from '../../platform/files/file.module.js';
import { CrmService } from './contacts/crm.service.js';
import { CrmTaskSubjects } from './contacts/crm-task-subjects.js';
import { DealGoToSource } from './deals/deal-goto.source.js';
import { DealController, PipelineController } from './deals/deal.controller.js';
import { DealService } from './deals/deal.service.js';

/**
 * The CRM module (09 §4.4, 08 §7). Contacts and companies now; pipelines,
 * deals and activities as their slices land. Tasks are deliberately absent —
 * they are platform (D-17).
 *
 * Nothing imported: the platform modules it leans on (`DbModule`,
 * `AuditModule`, `RbacModule`) are `@Global()`. ESLint holds the boundary in
 * the other direction and between siblings — `modules/crm` may not import
 * `modules/attendance` or the sales module when it exists.
 */
@Module({
  // REQ-U-05: deal attachments go through the platform file pipeline.
  imports: [FileModule],
  controllers: [ContactController, CompanyController, PipelineController, DealController, ActivityController],
  providers: [CrmService, ContactGoToSource, CompanyGoToSource, CrmTaskSubjects, DealService, DealGoToSource, ActivityService],
})
export class CrmModule {}
