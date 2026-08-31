import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '@/lib/api/client';
import { parseOrThrow } from '@/features/attendance/api';
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  employeeDisplayName,
  type CreateEmployeeInput,
  type EmployeeStatus,
  type EmploymentType,
  type UpdateEmployeeInput,
} from '@vyuha/shared';

import type { EmployeeRecord } from './use-employee';

/**
 * REQ-A-03 … REQ-A-05: creating, editing and retiring an employee.
 *
 * There is no `DELETE /employees/:id` and there must not be one. An employee is
 * not deleted, they are retired: `status: 'INACTIVE'` plus a last working date,
 * which keeps every punch, leave request and report row they appear in
 * (REQ-A-05). The screen says "retire", not "delete", because the two are
 * different things and calling one the other would be a promise the product
 * does not keep.
 *
 * Nothing here is optimistic. The server normalises an email, refuses a
 * reporting loop and rejects a code change (REQ-A-04); painting the draft as
 * the saved row would show fields that are not what was stored.
 */

const namedRefSchema = z.object({ id: z.string(), name: z.string() });

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

export interface EmployeeFormValues {
  employeeCode: string;
  firstName: string;
  lastName: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  mobile: string | null;
  dateOfJoining: string;
  employmentType: EmploymentType;
  departmentId: string | null;
  designationId: string | null;
  locationId: string | null;
  reportingManagerId: string | null;
  isFieldStaff: boolean;
  /** REQ-H-02: this person's own calendar, overriding the location's. */
  holidayCalendarId: string | null;
}

type QueryClient = ReturnType<typeof useQueryClient>;

function invalidateEmployees(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['employees'] });
  // A department's head, a roster's candidate list and the muster all read the
  // register; a new or retired person changes what each of them may show.
  void queryClient.invalidateQueries({ queryKey: ['departments'] });
  void queryClient.invalidateQueries({ queryKey: ['rosters'] });
  void queryClient.invalidateQueries({ queryKey: ['attendance'] });
}

export function useCreateEmployee(): UseMutationResult<EmployeeRecord, Error, EmployeeFormValues> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (values: EmployeeFormValues) => {
      // Status and last working date are deliberately absent. A new record is
      // ACTIVE by the server's own default, and REQ-A-05's retirement is a
      // separate action with a date of its own -- creating somebody already
      // retired is not a thing anybody means to do from this form.
      const body: CreateEmployeeInput & { holidayCalendarId: string | null } = {
        ...values,
        employmentType: values.employmentType,
        status: 'ACTIVE',
        isFieldStaff: values.isFieldStaff,
      };
      return parseOrThrow(
        employeeDetailSchema,
        await apiRequest<unknown>('/employees', { method: 'POST', body }),
        'created employee',
      );
    },
    onSuccess: () => {
      invalidateEmployees(queryClient);
    },
  });
}

export function useUpdateEmployee(): UseMutationResult<
  EmployeeRecord,
  Error,
  { id: string; values: EmployeeFormValues }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, values }) => {
      // `employeeCode` is not sent. REQ-A-04 makes it immutable and the server
      // answers 422 EMPLOYEE_CODE_IMMUTABLE for a change -- but it answers it
      // for a *resent identical* code too on some paths, so the field the form
      // never lets anybody edit is simply not in the body.
      const body: UpdateEmployeeInput & { holidayCalendarId: string | null } = {
        firstName: values.firstName,
        lastName: values.lastName,
        workEmail: values.workEmail,
        personalEmail: values.personalEmail,
        mobile: values.mobile,
        dateOfJoining: values.dateOfJoining,
        employmentType: values.employmentType,
        departmentId: values.departmentId,
        designationId: values.designationId,
        locationId: values.locationId,
        reportingManagerId: values.reportingManagerId,
        isFieldStaff: values.isFieldStaff,
        holidayCalendarId: values.holidayCalendarId,
      };
      return parseOrThrow(
        employeeDetailSchema,
        await apiRequest<unknown>(`/employees/${id}`, { method: 'PATCH', body }),
        'saved employee',
      );
    },
    onSuccess: () => {
      invalidateEmployees(queryClient);
    },
  });
}

export interface LifecycleChange {
  id: string;
  status: EmployeeStatus;
  /**
   * `YYYY-MM-DD` when retiring or putting somebody on notice with a known last
   * day; null when reactivating. The server refuses INACTIVE without one and
   * refuses ACTIVE with one, so both halves travel together.
   */
  dateOfLeaving: string | null;
}

/**
 * REQ-A-05: "activate, place on notice, deactivate with last working date".
 *
 * One mutation for all three transitions, because the server validates them as
 * one merged row: status and `dateOfLeaving` are a pair, and sending either
 * alone is how you get a 400 that names a field the reader did not touch.
 */
export function useChangeEmployeeLifecycle(): UseMutationResult<
  EmployeeRecord,
  Error,
  LifecycleChange
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, status, dateOfLeaving }) => {
      const body: UpdateEmployeeInput = { status, dateOfLeaving };
      return parseOrThrow(
        employeeDetailSchema,
        await apiRequest<unknown>(`/employees/${id}`, { method: 'PATCH', body }),
        'employee',
      );
    },
    onSuccess: () => {
      invalidateEmployees(queryClient);
    },
  });
}

// ------------------------------------------------------------------ pickers

export interface PickerRow {
  id: string;
  name: string;
  hint?: string;
}

const masterOptionsSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string(), code: z.string() })),
});

/**
 * Designations and locations for the employee form's pickers.
 *
 * Departments already have a hook of their own beside this screen, so this
 * covers only the two that did not. A failed picker must not take the form with
 * it: a query that errors simply offers no options, and the field stays at
 * whatever it already held.
 */
function useMasterOptions(path: string, key: string): UseQueryResult<PickerRow[], Error> {
  return useQuery({
    queryKey: [key, 'options'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/${path}?pageSize=200`, { signal });
      const parsed = parseOrThrow(masterOptionsSchema, body, `${key} list`);
      return parsed.data.map((row) => ({ id: row.id, name: row.name, hint: row.code }));
    },
    staleTime: 10 * 60_000,
  });
}

export function useDesignationOptions(): UseQueryResult<PickerRow[], Error> {
  return useMasterOptions('designations', 'designations');
}

export function useLocationOptions(): UseQueryResult<PickerRow[], Error> {
  return useMasterOptions('locations', 'locations');
}

const managerOptionsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      firstName: z.string(),
      lastName: z.string().nullable(),
      employeeCode: z.string(),
    }),
  ),
});

/**
 * Who somebody may report to (REQ-A-07).
 *
 * Only active people, and never the person being edited -- the caller filters
 * themselves out. The server checks the whole chain for a cycle and is the
 * authority; this removes only the case reachable in one click.
 */
export function useManagerOptions(): UseQueryResult<PickerRow[], Error> {
  return useQuery({
    // Not ['employees', 'options']: org-masters caches an EmployeeOption[]
    // (with employeeCode) under that key while this hook caches PickerRow[]
    // (with hint) - same endpoint, different shape, so sharing the key would
    // hand one form the other's rows. Still under the 'employees' root, so
    // the employee-mutation invalidations reach it.
    queryKey: ['employees', 'manager-options'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/employees?pageSize=200&status=ACTIVE', { signal });
      const parsed = parseOrThrow(managerOptionsSchema, body, 'employee list');
      return parsed.data.map((row) => ({
        id: row.id,
        name: employeeDisplayName(row.firstName, row.lastName),
        hint: row.employeeCode,
      }));
    },
    staleTime: 5 * 60_000,
  });
}
