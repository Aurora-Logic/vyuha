import {
  DASHBOARD_KEYS,
  dashboardLayoutSchema,
  exportRequestSchema,
  reportRowQuerySchema,
  reportScheduleInputSchema,
  savedViewInputSchema,
  savedViewQuerySchema,
} from '@vyuha/shared';
import { z } from 'zod';

import { createZodDto } from '../common/zod-validation.pipe.js';

/**
 * The Nest-facing wrappers. Every schema lives in `@vyuha/shared` so the report
 * shell validates the same shapes before it asks for anything, and a filter the
 * screen can express is a filter the server understands.
 */

/** The tray. Bounded, because it is polled while a job runs. */
export const exportListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export class ReportRowQueryDto extends createZodDto(reportRowQuerySchema) {}
export class ExportRequestDto extends createZodDto(exportRequestSchema) {}
export class ExportListQueryDto extends createZodDto(exportListQuerySchema) {}
export class SavedViewInputDto extends createZodDto(savedViewInputSchema) {}
export class SavedViewQueryDto extends createZodDto(savedViewQuerySchema) {}

/** REQ-J-05. Pausing and resuming is the only edit a schedule takes. */
export const schedulePauseSchema = z.object({ isActive: z.boolean() });

export class ReportScheduleInputDto extends createZodDto(reportScheduleInputSchema) {}
export class SchedulePauseDto extends createZodDto(schedulePauseSchema) {}

/**
 * Customisable dashboards. The board name is validated as a param DTO so an
 * unknown board is a 400 from the schema, not a stored row nothing will read.
 */
export const dashboardParamSchema = z.object({ dashboard: z.enum(DASHBOARD_KEYS) });

export class DashboardLayoutInputDto extends createZodDto(dashboardLayoutSchema) {}
export class DashboardParamDto extends createZodDto(dashboardParamSchema) {}
