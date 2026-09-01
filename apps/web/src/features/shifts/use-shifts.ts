import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  isUnbuiltEndpoint,
  loadSamples,
  parseOrThrow,
  type Sampled,
} from '@/features/attendance/api';
import { apiRequest } from '@/lib/api/client';
import { employeeDisplayName, type Paginated } from '@vyuha/shared';

import {
  bulkRosterResultSchema,
  rosterCandidatesResponseSchema,
  rostersResponseSchema,
  rosterEntrySchema,
  shiftSchema,
  shiftsResponseSchema,
  weeklyOffPatternSchema,
  weeklyOffPatternsResponseSchema,
  type BulkRosterResult,
  type RosterCandidate,
  type RosterEntry,
  type Shift,
  type WeeklyOffConfig,
  type WeeklyOffPattern,
} from './types';

/**
 * The read and write sides of `/shifts`, `/weekly-off-patterns` and `/rosters`
 * (REQ-C-01 … REQ-C-05).
 *
 * Reads keep the sample fallback the rest of this module uses: when the call
 * fails *because there is no such endpoint* -- and only then -- a development
 * build serves invented rows and marks them, so the screen says out loud that
 * it is not showing real data. A 403 or a 500 is a real answer from a real
 * server and reaches the error state untouched.
 *
 * Writes have no fallback and never will. Reads may be invented and labelled;
 * pretending a roster was saved when no server heard about it is exactly the
 * lie the notice exists to prevent.
 */

// ---------------------------------------------------------------- shifts

export interface ShiftListParams {
  /** A term the server knows (SHIFT_SORT_FIELDS), e.g. "-code" or "name". */
  sort?: string;
}

export function useShifts(params: ShiftListParams = {}): UseQueryResult<Sampled<Paginated<Shift>>, Error> {
  const search = new URLSearchParams({ pageSize: '200' });
  if (params.sort) search.set('sort', params.sort);
  const key = search.toString();
  return useQuery({
    queryKey: ['shifts', 'list', key],
    queryFn: async ({ signal }) => {
      try {
        const body = await apiRequest<unknown>(`/shifts?${key}`, { signal });
        return { value: parseOrThrow(shiftsResponseSchema, body, 'shift list'), sample: false };
      } catch (error) {
        if (isUnbuiltEndpoint(error)) {
          const samples = await loadSamples();
          if (samples) return { value: samples.sampleShifts(), sample: true };
        }
        throw error;
      }
    },
  });
}

/** Everything a shift write invalidates. A shift decides every derived day. */
function invalidateAfterShiftWrite(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ['shifts'] });
  // A changed window or threshold makes every attendance day on screen stale
  // (REQ-C-06), and a new shift changes what the roster form can offer.
  void queryClient.invalidateQueries({ queryKey: ['attendance'] });
  void queryClient.invalidateQueries({ queryKey: ['rosters'] });
}

export type ShiftDraft = Omit<Shift, 'id'>;

function shiftBody(draft: ShiftDraft): Record<string, unknown> {
  return {
    name: draft.name,
    code: draft.code,
    scheduledIn: draft.scheduledIn,
    scheduledOut: draft.scheduledOut,
    breakMinutes: draft.breakMinutes,
    crossesMidnight: draft.crossesMidnight,
    policy: draft.policy,
  };
}

export function useSaveShift(): UseMutationResult<Shift, Error, Shift> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (shift: Shift) => {
      const body = await apiRequest<unknown>(`/shifts/${shift.id}`, {
        method: 'PATCH',
        body: shiftBody(shift),
      });
      return parseOrThrow(shiftSchema, body, 'saved shift');
    },
    onSuccess: () => {
      invalidateAfterShiftWrite(queryClient);
    },
  });
}

export function useCreateShift(): UseMutationResult<Shift, Error, ShiftDraft> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (draft: ShiftDraft) => {
      const body = await apiRequest<unknown>('/shifts', {
        method: 'POST',
        body: shiftBody(draft),
      });
      return parseOrThrow(shiftSchema, body, 'created shift');
    },
    onSuccess: () => {
      invalidateAfterShiftWrite(queryClient);
    },
  });
}

// ----------------------------------------------------------- weekly offs

export function useWeeklyOffPatterns(): UseQueryResult<
  Sampled<Paginated<WeeklyOffPattern>>,
  Error
> {
  return useQuery({
    queryKey: ['weekly-off-patterns', 'list'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/weekly-off-patterns?pageSize=200', { signal });
      return {
        value: parseOrThrow(weeklyOffPatternsResponseSchema, body, 'weekly off pattern list'),
        sample: false,
      };
    },
    // No sample fallback. There is nothing invented to show here: an
    // organisation with no patterns is a real and common state, and the empty
    // state below says what to do about it. Inventing two would make the
    // screen look configured when it is not.
  });
}

export interface WeeklyOffPatternDraft {
  name: string;
  config: WeeklyOffConfig;
}

export function useSaveWeeklyOffPattern(): UseMutationResult<
  WeeklyOffPattern,
  Error,
  WeeklyOffPatternDraft & { id: string | null }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (draft) => {
      const body = await apiRequest<unknown>(
        draft.id === null ? '/weekly-off-patterns' : `/weekly-off-patterns/${draft.id}`,
        {
          method: draft.id === null ? 'POST' : 'PATCH',
          body: { name: draft.name, config: draft.config },
        },
      );
      return parseOrThrow(weeklyOffPatternSchema, body, 'saved weekly off pattern');
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['weekly-off-patterns'] });
      // Which days are off changed, so every computed day on screen is stale.
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
}

// ---------------------------------------------------------------- roster

export interface RosterParams {
  from: string;
  to: string;
  departmentId?: string | null;
  q?: string;
  page: number;
  pageSize: number;
  /** A term the server knows (ROSTER_SORT_FIELDS), e.g. "-from" or "name". */
  sort?: string;
}

function toSearch(params: RosterParams): string {
  const search = new URLSearchParams();
  search.set('from', params.from);
  search.set('to', params.to);
  if (params.departmentId) search.set('departmentId', params.departmentId);
  // Absent rather than empty: `?q=` filters for the empty string as far as a
  // strict server-side schema is concerned, and that schema has a min length.
  if (params.q) search.set('q', params.q);
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  return search.toString();
}

export function useRoster(
  params: RosterParams,
): UseQueryResult<Sampled<Paginated<RosterEntry>>, Error> {
  return useQuery({
    queryKey: ['rosters', 'list', params],
    queryFn: async ({ signal }) => {
      try {
        const body = await apiRequest<unknown>(`/rosters?${toSearch(params)}`, { signal });
        return { value: parseOrThrow(rostersResponseSchema, body, 'roster'), sample: false };
      } catch (error) {
        if (isUnbuiltEndpoint(error)) {
          const samples = await loadSamples();
          if (samples) return { value: samples.sampleRoster(params), sample: true };
        }
        throw error;
      }
    },
    // Stepping the period or paging changes the key. Without this the table
    // empties to a skeleton between every step, which reads as the list
    // breaking and coming back rather than as the period moving.
    placeholderData: keepPreviousData,
  });
}

/**
 * The people the roster form can name, from the employee register (REQ-A-03).
 *
 * Typed at the server. This read 200 people once and let the combobox filter
 * them in the browser, so past 200 nobody else could be rostered or have
 * attendance recorded for them, and the field said nobody matched a colleague
 * who works here.
 */
export function useRosterCandidates(search = ''): UseQueryResult<RosterCandidate[], Error> {
  const q = search.trim();
  return useQuery({
    queryKey: ['rosters', 'candidates', q],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ pageSize: '25', status: 'ACTIVE' });
      if (q) params.set('q', q);
      const body = await apiRequest<unknown>(`/employees?${params.toString()}`, { signal });
      const parsed = parseOrThrow(rosterCandidatesResponseSchema, body, 'employee list');
      return parsed.data.map((row) => ({
        id: row.id,
        name: employeeDisplayName(row.firstName, row.lastName),
        employeeCode: row.employeeCode,
        department: row.department?.name ?? null,
      }));
    },
    // People change a few times a month, and this list is reopened every time
    // somebody rosters one more person.
    staleTime: 5 * 60_000,
  });
}

function invalidateAfterRosterWrite(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ['rosters'] });
  // REQ-C-06: the server recomputed the days this change touched, so anything
  // showing them is stale.
  void queryClient.invalidateQueries({ queryKey: ['attendance'] });
}

export interface RosterDraft {
  employeeId: string;
  shiftId: string;
  from: string;
  to: string | null;
}

export function useCreateRosterAssignment(): UseMutationResult<RosterEntry, Error, RosterDraft> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (draft: RosterDraft) => {
      const body = await apiRequest<unknown>('/rosters', { method: 'POST', body: draft });
      return parseOrThrow(rosterEntrySchema, body, 'roster assignment');
    },
    onSuccess: () => {
      invalidateAfterRosterWrite(queryClient);
    },
  });
}

export interface RosterEditDraft {
  id: string;
  shiftId: string;
  from: string;
  to: string | null;
}

/**
 * REQ-C-04, the edit side. `PATCH /rosters/:id` takes the shift and the range
 * and nothing else -- the employee is not editable, because moving an
 * assignment to a different person is two changes to two people's history and
 * the server models it as a delete and a create rather than a rename.
 *
 * `to` is sent explicitly even when null: absent means "leave it alone" in a
 * partial update, and null is what closes an open-ended assignment. Omitting it
 * would make "make this open-ended again" impossible to express.
 */
export function useUpdateRosterAssignment(): UseMutationResult<
  RosterEntry,
  Error,
  RosterEditDraft
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...draft }: RosterEditDraft) => {
      const body = await apiRequest<unknown>(`/rosters/${id}`, {
        method: 'PATCH',
        body: { shiftId: draft.shiftId, from: draft.from, to: draft.to },
      });
      return parseOrThrow(rosterEntrySchema, body, 'roster assignment');
    },
    onSuccess: () => {
      invalidateAfterRosterWrite(queryClient);
    },
  });
}

export interface BulkRosterDraft {
  shiftId: string;
  from: string;
  to: string;
  departmentId?: string | null;
  employeeIds?: string[];
  preview: boolean;
}

/**
 * REQ-C-05, both halves. The preview and the commit are one endpoint so the
 * count the reader confirmed is the count the server acts on.
 */
export function useBulkRoster(): UseMutationResult<BulkRosterResult, Error, BulkRosterDraft> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (draft: BulkRosterDraft) => {
      const body = await apiRequest<unknown>('/rosters/bulk', {
        method: 'POST',
        body: {
          shiftId: draft.shiftId,
          from: draft.from,
          to: draft.to,
          ...(draft.departmentId ? { departmentId: draft.departmentId } : {}),
          ...(draft.employeeIds && draft.employeeIds.length > 0
            ? { employeeIds: draft.employeeIds }
            : {}),
          preview: draft.preview,
        },
      });
      return parseOrThrow(bulkRosterResultSchema, body, 'bulk roster result');
    },
    onSuccess: (result) => {
      // A preview wrote nothing, so invalidating would refetch the whole
      // roster for no reason every time somebody adjusted a date.
      if (!result.preview) invalidateAfterRosterWrite(queryClient);
    },
  });
}
