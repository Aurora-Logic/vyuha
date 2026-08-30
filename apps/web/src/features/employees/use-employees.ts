import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  type EmployeeListItem,
  type EmployeeStatus,
  type Paginated,
} from '@vyuha/shared';

import { ApiError, apiRequest } from '@/lib/api/client';

/**
 * REQ-A-03: the employee register, read side.
 *
 * The query lives with the screen rather than in `lib/`, because the shape of
 * the parameters is the shape of that screen's filter bar. What is shared —
 * the row contract and the page envelope — comes from `@vyuha/shared`, so the
 * client cannot drift from the server by redefining either.
 */

export interface EmployeeListParams {
  page: number;
  pageSize: number;
  /** Free text over employee code and name. Empty means unfiltered. */
  q?: string;
  status?: EmployeeStatus | null;
  /** Department id, or null for every department. */
  departmentId?: string | null;
  /** A term the server knows (EMPLOYEE_SORT_FIELDS), e.g. "-dateOfJoining" or "status". */
  sort?: string;
}

const namedRefSchema = z.object({ id: z.string(), name: z.string() });

/**
 * The row, validated at the boundary.
 *
 * This is deliberately not "the API is ours, so trust it". The endpoint is
 * built and deployed separately from this screen, and the failure mode of an
 * unvalidated response is a crash three components deep in a cell renderer,
 * with a stack trace that names `RecordTable` and says nothing about the
 * server having changed `department` from an object to a string. Parsing here
 * turns that into the error state this screen already has.
 *
 * The `z.ZodType<EmployeeListItem>` annotation is the other half: it fails to
 * compile if the schema and the shared contract stop describing the same
 * thing, so a field added to the contract cannot be silently stripped here.
 */
const employeeListItemSchema: z.ZodType<EmployeeListItem> = z.object({
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
});

const employeeListResponseSchema: z.ZodType<Paginated<EmployeeListItem>> = z.object({
  data: z.array(employeeListItemSchema),
  meta: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  }),
});

/** Technical design §6: `?page=&pageSize=&q=&departmentId=&locationId=&status=`. */
function toSearch(params: EmployeeListParams): string {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  // Absent rather than empty: `?q=` is a filter for the empty string as far as
  // a strict server-side schema is concerned, and this one has a min length.
  if (params.q) search.set('q', params.q);
  if (params.status) search.set('status', params.status);
  if (params.departmentId) search.set('departmentId', params.departmentId);
  if (params.sort) search.set('sort', params.sort);
  return search.toString();
}

export function useEmployees(
  params: EmployeeListParams,
  options: { enabled?: boolean } = {},
): UseQueryResult<Paginated<EmployeeListItem>, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['employees', 'list', params],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/employees?${toSearch(params)}`, { signal });
      const parsed = employeeListResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError({
          code: 'INTERNAL_ERROR',
          message: 'The employee list came back in a shape this screen cannot read.',
          status: 0,
          details: { issues: z.treeifyError(parsed.error) },
        });
      }
      return parsed.data;
    },
    // Paging and typing in the search box both change the key. Without this
    // the table empties to a skeleton between every keystroke, which reads as
    // the list breaking and coming back rather than as a filter narrowing.
    placeholderData: keepPreviousData,
  });
}
