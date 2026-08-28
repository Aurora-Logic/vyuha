import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import type {
  CreateHolidayCalendarInput,
  CreateHolidayInput,
  HolidayImportReport,
  HolidayImportRow,
  Paginated,
  UpdateHolidayCalendarInput,
  UpdateHolidayInput,
} from '@vyuha/shared';

import { withDevFixture, type Sampled } from '@/features/leave/dev-fixture-fallback';
import { paginatedSchema } from '@/features/leave/types';
import { ApiError, apiRequest } from '@/lib/api/client';

import {
  holidayCalendarRecordSchema,
  holidayRecordSchema,
  type Holiday,
  type HolidayCalendar,
} from './types';

/**
 * REQ-H-01 … REQ-H-04, the client side of `/holiday-calendars`.
 *
 * The leave application form reads the calendars too -- REQ-G-07 skips
 * holidays rather than consuming them -- which is why the read hook lives here
 * rather than inside the holidays screen: the calendar is the source, and
 * leave is a reader.
 *
 * Reads keep the development fixture fallback; writes deliberately do not. A
 * read may be invented and labelled as invented. A write may not: pretending a
 * holiday was saved when no server heard about it is exactly the lie the
 * sample notice exists to prevent, so a failed save reports the failure and
 * the sheet stays open with the edits intact.
 */

const CALENDARS_KEY = 'holiday-calendars';

const calendarListSchema: z.ZodType<Paginated<HolidayCalendar>> = paginatedSchema(
  holidayCalendarRecordSchema,
);

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new ApiError({
    code: 'INTERNAL_ERROR',
    message: `The ${what} came back in a shape this screen cannot read.`,
    status: 0,
    details: { issues: z.treeifyError(parsed.error) },
  });
}

export function useHolidayCalendars(
  year: number,
): UseQueryResult<Sampled<Paginated<HolidayCalendar>>, Error> {
  return useQuery({
    queryKey: [CALENDARS_KEY, year],
    queryFn: ({ signal }) =>
      withDevFixture(
        async () => {
          const body = await apiRequest<unknown>(`/holiday-calendars?year=${String(year)}`, {
            signal,
          });
          return parseOrThrow(calendarListSchema, body, 'holiday calendars');
        },
        (fixtures) => fixtures.holidayCalendarsFixture(year),
      ),
    // A holiday list moves once a year. Refetching it on every mount would be
    // traffic for nothing, and the leave form mounts it on every visit.
    staleTime: 10 * 60_000,
  });
}

export interface HolidayCalendarOption {
  id: string;
  name: string;
  year: number;
}

const calendarOptionsSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string(), year: z.number().int() })),
});

/**
 * Every calendar, every year, for the pickers that link one to a location or
 * an employee (OS-3, REQ-H-02).
 *
 * Not `useHolidayCalendars`: that hook is a screen's view of one year with a
 * sample fallback, and a picker fed an invented calendar would offer an id the
 * server then refuses. A failed query here simply offers no options.
 */
export function useHolidayCalendarOptions(): UseQueryResult<HolidayCalendarOption[], Error> {
  return useQuery({
    queryKey: [CALENDARS_KEY, 'options'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/holiday-calendars?pageSize=100', { signal });
      return parseOrThrow(calendarOptionsSchema, body, 'holiday calendars').data;
    },
    staleTime: 10 * 60_000,
  });
}

/**
 * Everything a holiday change invalidates.
 *
 * `attendance` is on the list because REQ-H-04 recomputes the affected days
 * server-side: a muster left on screen beside this one is stale the moment a
 * date moves, and nothing else would tell it so.
 */
function useInvalidateHolidays(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: [CALENDARS_KEY] });
    void queryClient.invalidateQueries({ queryKey: ['attendance'] });
  };
}

export interface SaveCalendarInput {
  /** Absent for a new calendar. */
  id?: string;
  name: string;
  year: number;
  restrictedAllowance: number;
}

export function useSaveCalendar(): UseMutationResult<HolidayCalendar, Error, SaveCalendarInput> {
  const invalidate = useInvalidateHolidays();

  return useMutation({
    mutationFn: async (input: SaveCalendarInput) => {
      // The year is not in the PATCH body: it is half the calendar's identity
      // and the server refuses to move it (see `updateHolidayCalendarSchema`).
      const body: CreateHolidayCalendarInput | UpdateHolidayCalendarInput =
        input.id === undefined
          ? { name: input.name, year: input.year, restrictedAllowance: input.restrictedAllowance }
          : { name: input.name, restrictedAllowance: input.restrictedAllowance };

      const response = await apiRequest<unknown>(
        input.id === undefined ? '/holiday-calendars' : `/holiday-calendars/${input.id}`,
        { method: input.id === undefined ? 'POST' : 'PATCH', body },
      );
      return parseOrThrow(holidayCalendarRecordSchema, response, 'saved calendar');
    },
    onSuccess: invalidate,
  });
}

export interface SaveHolidayInput {
  calendarId: string;
  /** Absent for a new holiday. */
  id?: string;
  date: string;
  name: string;
  restricted: boolean;
}

export function useSaveHoliday(): UseMutationResult<Holiday, Error, SaveHolidayInput> {
  const invalidate = useInvalidateHolidays();

  return useMutation({
    mutationFn: async (input: SaveHolidayInput) => {
      const body: CreateHolidayInput | UpdateHolidayInput = {
        date: input.date,
        name: input.name,
        restricted: input.restricted,
      };
      const response = await apiRequest<unknown>(
        input.id === undefined
          ? `/holiday-calendars/${input.calendarId}/holidays`
          : `/holidays/${input.id}`,
        { method: input.id === undefined ? 'POST' : 'PATCH', body },
      );
      return parseOrThrow(holidayRecordSchema, response, 'saved holiday');
    },
    onSuccess: invalidate,
  });
}

export function useDeleteHoliday(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateHolidays();

  return useMutation({
    mutationFn: async (holidayId: string) => {
      await apiRequest<void>(`/holidays/${holidayId}`, { method: 'DELETE' });
    },
    onSuccess: invalidate,
  });
}

export interface ImportRequest {
  calendarId: string;
  rows: HolidayImportRow[];
  overwriteExisting: boolean;
  /** `validate` writes nothing; `commit` writes and recomputes (REQ-H-04). */
  mode: 'validate' | 'commit';
}

/**
 * One mutation for both halves of the import, because they take the same body
 * and the reader moves between them: preview, adjust the overwrite switch,
 * preview again, commit. Two hooks would keep two copies of the last result
 * and the screen would have to decide which one it was showing.
 */
export function useImportHolidays(): UseMutationResult<HolidayImportReport, Error, ImportRequest> {
  const invalidate = useInvalidateHolidays();

  return useMutation({
    mutationFn: async (request: ImportRequest) => {
      const body = await apiRequest<HolidayImportReport>(
        `/holiday-calendars/${request.calendarId}/holidays/import/${request.mode}`,
        {
          method: 'POST',
          body: { rows: request.rows, overwriteExisting: request.overwriteExisting },
        },
      );
      return body;
    },
    onSuccess: (_report, request) => {
      if (request.mode === 'commit') invalidate();
    },
  });
}
