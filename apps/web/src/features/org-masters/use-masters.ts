import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { parseOrThrow } from '@/features/attendance/api';
import { apiRequest } from '@/lib/api/client';
import { employeeDisplayName, type Paginated } from '@vyuha/shared';
import { z } from 'zod';

import {
  departmentListSchema,
  departmentSchema,
  designationListSchema,
  designationSchema,
  locationListSchema,
  locationSchema,
  type DepartmentSummary,
  type DesignationSummary,
  type LocationSummary,
} from './types';

/**
 * The read and write sides of the three org masters (REQ-A-01, REQ-A-02).
 *
 * No sample fallback anywhere in this file, unlike the attendance screens.
 * These lists are what an employee record points at, so an invented department
 * would be offered in a picker and then rejected by the server the moment
 * somebody saved against it — an empty list and an unreachable list are
 * different states and the screen says which.
 *
 * Writes go one page at a time and are followed by a refetch, never by a
 * hand-patched cache. The server normalises a code, resolves a head to a name
 * and can refuse a parent that would close a loop; painting the draft as the
 * saved row would show three fields that are not what was stored.
 */

const PAGE_SIZE = 50;

export interface MasterListParams {
  q: string;
  page: number;
  /** A term the server knows (MASTER_SORT_FIELDS), e.g. "-name" or "code". */
  sort?: string;
}

function toSearch(params: MasterListParams): string {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(PAGE_SIZE));
  // Absent rather than empty: `?q=` filters for the empty string as far as the
  // server's schema is concerned, and that schema has a minimum length.
  if (params.q) search.set('q', params.q);
  if (params.sort) search.set('sort', params.sort);
  return search.toString();
}

export function useDepartmentList(
  params: MasterListParams,
): UseQueryResult<Paginated<DepartmentSummary>, Error> {
  return useQuery({
    queryKey: ['departments', 'list', params],
    queryFn: async ({ signal }) =>
      parseOrThrow(
        departmentListSchema,
        await apiRequest<unknown>(`/departments?${toSearch(params)}`, { signal }),
        'department list',
      ),
    placeholderData: keepPreviousData,
  });
}

export function useDesignationList(
  params: MasterListParams,
): UseQueryResult<Paginated<DesignationSummary>, Error> {
  return useQuery({
    queryKey: ['designations', 'list', params],
    queryFn: async ({ signal }) =>
      parseOrThrow(
        designationListSchema,
        await apiRequest<unknown>(`/designations?${toSearch(params)}`, { signal }),
        'designation list',
      ),
    placeholderData: keepPreviousData,
  });
}

export function useLocationList(
  params: MasterListParams,
): UseQueryResult<Paginated<LocationSummary>, Error> {
  return useQuery({
    queryKey: ['locations', 'list', params],
    queryFn: async ({ signal }) =>
      parseOrThrow(
        locationListSchema,
        await apiRequest<unknown>(`/locations?${toSearch(params)}`, { signal }),
        'location list',
      ),
    placeholderData: keepPreviousData,
  });
}

// ------------------------------------------------------------------ pickers

export interface EmployeeOption {
  id: string;
  name: string;
  employeeCode: string;
}

const employeeOptionsSchema = z.object({
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
 * Active employees, for the "head of department" and "reports to" pickers.
 *
 * Only active people are offered. A department headed by somebody who left is
 * a data-entry accident rather than a state anyone wants, and REQ-A-05 keeps
 * the leaver's history without keeping them selectable.
 */
export function useEmployeeOptions(
  options: { enabled?: boolean } = {},
): UseQueryResult<EmployeeOption[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['employees', 'options'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/employees?pageSize=200&status=ACTIVE', { signal });
      const parsed = parseOrThrow(employeeOptionsSchema, body, 'employee list');
      return parsed.data.map((row) => ({
        id: row.id,
        name: employeeDisplayName(row.firstName, row.lastName),
        employeeCode: row.employeeCode,
      }));
    },
    // People change a few times a month, and three forms open this list.
    staleTime: 5 * 60_000,
  });
}

// ------------------------------------------------------------------- writes

type QueryClient = ReturnType<typeof useQueryClient>;

function invalidateMasters(queryClient: QueryClient, key: string): void {
  void queryClient.invalidateQueries({ queryKey: [key] });
  // An employee row prints the department, designation and location name, so a
  // rename that did not reach the register would leave two screens disagreeing.
  void queryClient.invalidateQueries({ queryKey: ['employees'] });
}

export interface DepartmentDraft {
  /** Null when creating. */
  id: string | null;
  name: string;
  code: string;
  headEmployeeId: string | null;
  parentId: string | null;
}

export function useSaveDepartment(): UseMutationResult<DepartmentSummary, Error, DepartmentDraft> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...draft }: DepartmentDraft) => {
      const body = await apiRequest<unknown>(
        id === null ? '/departments' : `/departments/${id}`,
        {
          method: id === null ? 'POST' : 'PATCH',
          body: {
            name: draft.name,
            code: draft.code,
            headEmployeeId: draft.headEmployeeId,
            parentId: draft.parentId,
          },
        },
      );
      return parseOrThrow(departmentSchema, body, 'saved department');
    },
    onSuccess: () => {
      invalidateMasters(queryClient, 'departments');
    },
  });
}

export interface DesignationDraft {
  id: string | null;
  name: string;
  code: string;
  grade: string | null;
}

export function useSaveDesignation(): UseMutationResult<
  DesignationSummary,
  Error,
  DesignationDraft
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...draft }: DesignationDraft) => {
      const body = await apiRequest<unknown>(
        id === null ? '/designations' : `/designations/${id}`,
        {
          method: id === null ? 'POST' : 'PATCH',
          body: { name: draft.name, code: draft.code, grade: draft.grade },
        },
      );
      return parseOrThrow(designationSchema, body, 'saved designation');
    },
    onSuccess: () => {
      invalidateMasters(queryClient, 'designations');
    },
  });
}

export interface LocationDraft {
  id: string | null;
  name: string;
  code: string;
  address: string | null;
  timezone: string | null;
  geofenceLat: number | null;
  geofenceLng: number | null;
  geofenceRadiusM: number;
  ipAllowlist: string[];
}

export function useSaveLocation(): UseMutationResult<LocationSummary, Error, LocationDraft> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...draft }: LocationDraft) => {
      const body = await apiRequest<unknown>(id === null ? '/locations' : `/locations/${id}`, {
        method: id === null ? 'POST' : 'PATCH',
        body: {
          name: draft.name,
          code: draft.code,
          address: draft.address,
          timezone: draft.timezone,
          geofenceLat: draft.geofenceLat,
          geofenceLng: draft.geofenceLng,
          geofenceRadiusM: draft.geofenceRadiusM,
          ipAllowlist: draft.ipAllowlist,
        },
      });
      return parseOrThrow(locationSchema, body, 'saved location');
    },
    onSuccess: () => {
      invalidateMasters(queryClient, 'locations');
    },
  });
}
