import {
  createDepartmentSchema,
  createDesignationSchema,
  createLocationSchema,
  masterListQuerySchema,
  updateDepartmentSchema,
  updateDesignationSchema,
  updateLocationSchema,
} from '@vyuha/shared';
import { z } from 'zod';

import { createZodDto } from '../common/zod-validation.pipe.js';

/**
 * Nest-facing wrappers for the three org masters. The schemas live in
 * `@vyuha/shared` so the web client's forms validate against the same rules;
 * this file only makes them findable by `ZodValidationPipe`.
 *
 * The one addition of its own is the holiday calendar link (OS-3, REQ-H-02):
 * `holiday_calendar_id` is validated against an attendance-owned table the
 * shared package knows nothing about, so the field rides on top of the shared
 * schema here rather than widening the contract.
 */

export const createLocationBodySchema = createLocationSchema.extend({
  holidayCalendarId: z.uuid().nullish(),
});

export const updateLocationBodySchema = updateLocationSchema.extend({
  holidayCalendarId: z.uuid().nullable().optional(),
});

export type CreateLocationBody = z.infer<typeof createLocationBodySchema>;
export type UpdateLocationBody = z.infer<typeof updateLocationBodySchema>;

export class MasterListQueryDto extends createZodDto(masterListQuerySchema) {}

export class CreateDepartmentDto extends createZodDto(createDepartmentSchema) {}
export class UpdateDepartmentDto extends createZodDto(updateDepartmentSchema) {}

export class CreateDesignationDto extends createZodDto(createDesignationSchema) {}
export class UpdateDesignationDto extends createZodDto(updateDesignationSchema) {}

export class CreateLocationDto extends createZodDto(createLocationBodySchema) {}
export class UpdateLocationDto extends createZodDto(updateLocationBodySchema) {}
