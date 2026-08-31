import {
  createEmployeeSchema,
  employeeListQuerySchema,
  employeeImportSchema,
  updateEmployeeSchema,
} from '@vyuha/shared';
import { z } from 'zod';

import { createZodDto } from '../common/zod-validation.pipe.js';

/**
 * The Nest-facing wrappers. The schemas themselves live in `@vyuha/shared` so
 * the web client validates the same shapes before it posts them; this file is
 * only the adapter that lets `ZodValidationPipe` find them from a parameter's
 * declared type.
 *
 * The holiday calendar link is the one field added on top (OS-3, REQ-H-02):
 * an employee's own calendar, overriding the location's. It is validated
 * against an attendance-owned table the shared package knows nothing about,
 * so it rides on the shared schema here rather than widening the contract.
 */

export const createEmployeeBodySchema = createEmployeeSchema.extend({
  holidayCalendarId: z.uuid().nullish(),
});

export const updateEmployeeBodySchema = updateEmployeeSchema.extend({
  holidayCalendarId: z.uuid().nullable().optional(),
});

export type CreateEmployeeBody = z.infer<typeof createEmployeeBodySchema>;
export type UpdateEmployeeBody = z.infer<typeof updateEmployeeBodySchema>;

export class EmployeeListQueryDto extends createZodDto(employeeListQuerySchema) {}
export class CreateEmployeeDto extends createZodDto(createEmployeeBodySchema) {}
export class UpdateEmployeeDto extends createZodDto(updateEmployeeBodySchema) {}
export class EmployeeImportDto extends createZodDto(employeeImportSchema) {}
