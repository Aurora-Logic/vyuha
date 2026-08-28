import { z } from 'zod';

import type {
  DepartmentSummary,
  DesignationSummary,
  LocationSummary as SharedLocationSummary,
  NamedRef,
  Paginated,
} from '@vyuha/shared';

/**
 * The parsers for `/departments`, `/designations` and `/locations` (REQ-A-01,
 * REQ-A-02).
 *
 * Parsed at the boundary for the reason the employee list gives: these three
 * lists feed the employee form's pickers as well as their own screen, so a
 * shape that moved would fail inside a `SelectItem` three components deep and
 * name the picker rather than the field the server changed.
 *
 * Each schema is annotated against the shared interface, so a field added to
 * the contract and forgotten here is a compile error rather than a value that
 * silently never reaches the screen.
 */

const namedRefSchema: z.ZodType<NamedRef> = z.object({ id: z.string(), name: z.string() });

export const departmentSchema: z.ZodType<DepartmentSummary> = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  parent: namedRefSchema.nullable(),
  head: namedRefSchema.nullable(),
});

export const designationSchema: z.ZodType<DesignationSummary> = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  grade: z.string().nullable(),
});

/**
 * The shared summary plus the holiday calendar link (OS-3, REQ-H-02). Widened
 * here rather than in the contract because the API declares the link beside
 * its endpoint for the same reason -- the id belongs to an attendance-owned
 * table the shared package does not describe.
 */
export interface LocationSummary extends SharedLocationSummary {
  readonly holidayCalendarId: string | null;
}

export const locationSchema: z.ZodType<LocationSummary> = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  address: z.string().nullable(),
  timezone: z.string().nullable(),
  geofenceLat: z.number().nullable(),
  geofenceLng: z.number().nullable(),
  geofenceRadiusM: z.number(),
  ipAllowlist: z.array(z.string()),
  holidayCalendarId: z.string().nullable(),
});

const pageMetaSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

function listSchema<T>(item: z.ZodType<T>): z.ZodType<Paginated<T>> {
  return z.object({ data: z.array(item), meta: pageMetaSchema });
}

export const departmentListSchema = listSchema(departmentSchema);
export const designationListSchema = listSchema(designationSchema);
export const locationListSchema = listSchema(locationSchema);

export type { DepartmentSummary, DesignationSummary };
