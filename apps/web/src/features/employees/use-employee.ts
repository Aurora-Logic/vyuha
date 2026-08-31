import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { ApiError, apiRequest } from '@/lib/api/client';
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  type EmployeeDetail,
} from '@vyuha/shared';

/**
 * REQ-A-03 / PRD §5 screen 10: one employee, read side.
 *
 * Separate from `useEmployees` because the two answer different questions and
 * cache under different keys — the register's rows are a page of a filtered
 * list and go stale when the filter moves, while a person's record does not
 * change because somebody typed in a search box.
 *
 * The `z.ZodType<EmployeeDetail>` annotation is the half that keeps this
 * honest over time: it fails to compile the moment the schema and the shared
 * contract stop describing the same thing, so a field added to the contract
 * cannot be silently dropped here.
 */

const namedRefSchema = z.object({ id: z.string(), name: z.string() });

/**
 * The shared detail plus the holiday calendar override (OS-3, REQ-H-02).
 * Widened here rather than in the contract for the reason the API gives: the
 * id belongs to an attendance-owned table the shared package does not
 * describe.
 */
export interface EmployeeRecord extends EmployeeDetail {
  readonly holidayCalendarId: string | null;
}

const employeeDetailSchema: z.ZodType<EmployeeRecord> = z.object({
  id: z.string(),
  employeeCode: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  workEmail: z.string().nullable(),
  mobile: z.string().nullable(),
  dateOfJoining: z.string(),
  dateOfLeaving: z.string().nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  status: z.enum(EMPLOYEE_STATUSES),
  department: namedRefSchema.nullable(),
  designation: namedRefSchema.nullable(),
  location: namedRefSchema.nullable(),
  reportingManager: namedRefSchema.nullable(),
  personalEmail: z.string().nullable(),
  isFieldStaff: z.boolean(),
  holidayCalendarId: z.string().nullable(),
  tallyRef: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function useEmployee(id: string | undefined): UseQueryResult<EmployeeRecord, Error> {
  return useQuery({
    // Not `enabled: false` with a fabricated key: an absent id means the route
    // matched without one, which cannot happen for `/employees/:id`, so the
    // guard exists only to keep the type honest.
    enabled: id !== undefined && id.length > 0,
    queryKey: ['employees', 'detail', id],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/employees/${encodeURIComponent(id ?? '')}`, {
        signal,
      });
      const parsed = employeeDetailSchema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError({
          code: 'INTERNAL_ERROR',
          message: 'The employee record came back in a shape this screen cannot read.',
          status: 0,
          details: { issues: z.treeifyError(parsed.error) },
        });
      }
      return parsed.data;
    },
    // A 404 or a 403 here is the answer, not a hiccup. The server returns 404
    // both for an id that does not exist and for one outside the reader's
    // scope, and 403 when the route policy refused the caller outright.
    // Neither changes on a second attempt, so retrying only costs a round trip
    // and a slower error state — and puts a second red line in the console
    // that reads as a fault rather than as a decision.
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return false;
      return failureCount < 1;
    },
  });
}
