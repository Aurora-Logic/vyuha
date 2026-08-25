import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { ApiError, apiRequest } from '@/lib/api/client';
import type {
  ExportJobSummary,
  ExportRequest,
  ReportSchedule,
  ReportScheduleInput,
  Paginated,
  ReportDefinition,
  ReportFilters,
  ReportKey,
  SavedView,
  SavedViewInput,
} from '@vyuha/shared';

import {
  exportDownloadSchema,
  exportJobListSchema,
  exportJobSchema,
  reportCatalogueSchema,
  reportPageEnvelopeSchema,
  reportScheduleListSchema,
  reportScheduleSchema,
  savedViewListSchema,
  savedViewSchema,
  signedPhotoSchema,
  toRowViews,
  type ReportRowView,
} from './types';

/**
 * Every call the report shell and the downloads tray make.
 *
 * No sample-data fallback here, unlike the attendance screens. Those were built
 * before their endpoint existed; these were built against a running one, and a
 * report that quietly renders invented rows is the exact failure REQ-J-06
 * exists to prevent -- somebody would export it.
 */

function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw new ApiError({
    code: 'INTERNAL_ERROR',
    message: `The ${what} came back in a shape this screen cannot read.`,
    status: 0,
    details: { issues: z.treeifyError(result.error) },
  });
}

export const reportKeys = {
  catalogue: ['reports', 'catalogue'] as const,
  recent: ['reports', 'usage', 'recent'] as const,
  rows: (reportKey: string, query: string) => ['reports', 'rows', reportKey, query] as const,
  views: (reportKey: string) => ['reports', 'views', reportKey] as const,
  exports: ['reports', 'exports'] as const,
  schedules: ['reports', 'schedules'] as const,
  photo: (punchId: string, variant: string) => ['punches', 'photo', punchId, variant] as const,
};

export function useReportCatalogue(): UseQueryResult<ReportDefinition[], Error> {
  return useQuery({
    queryKey: reportKeys.catalogue,
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/reports', { signal });
      return parse(reportCatalogueSchema, body, 'report catalogue').data;
    },
    // The catalogue changes when the server is redeployed, not while a reader
    // is looking at it.
    staleTime: 10 * 60_000,
  });
}

/**
 * Plain strings, not `z.enum(REPORT_KEYS)`: a server one release ahead may
 * name a report this client has never heard of, and that must not take the
 * whole hub down. The catalogue the hub renders from is the authority on what
 * a key means here, so unknown ones simply find no definition and vanish.
 */
const recentReportsSchema = z.object({ data: z.array(z.string()) });

export function useRecentReports(): UseQueryResult<string[], Error> {
  return useQuery({
    queryKey: reportKeys.recent,
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/reports/usage/recent', { signal });
      return parse(recentReportsSchema, body, 'recently used reports').data;
    },
    // Fresh enough to move a chip after a report is opened, without refetching
    // on every focus of a screen whose answer changes a few times a day.
    staleTime: 60_000,
  });
}

export interface ReportRowsParams extends ReportFilters {
  readonly page: number;
  readonly pageSize: number;
  readonly sort?: string | undefined;
}

export function reportRowsSearch(params: ReportRowsParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

/**
 * One page of whichever report is open.
 *
 * One hook for every report, not one per report: the row shape is chosen by
 * `toRowViews` from the report key, and the cells come out of the same
 * extractors the exporter uses. A new report is a definition and a row source
 * on the API and nothing here -- which is the claim the shell was built on, and
 * was worth making true rather than nearly true.
 */
export function useReportRows(
  reportKey: ReportKey,
  params: ReportRowsParams,
  options: { enabled?: boolean } = {},
): UseQueryResult<Paginated<ReportRowView>, Error> {
  const query = reportRowsSearch(params);
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: reportKeys.rows(reportKey, query),
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/reports/${reportKey}/rows?${query}`, { signal });
      const page = parse(reportPageEnvelopeSchema, body, 'report');
      try {
        return { data: toRowViews(reportKey, page.data), meta: page.meta };
      } catch (error: unknown) {
        // A row that does not match its report's contract is the same failure
        // as a malformed envelope, and has to reach the error state rather than
        // draw a table of empty cells that reads as a quiet period.
        throw new ApiError({
          code: 'INTERNAL_ERROR',
          message: 'This report came back in a shape this screen cannot read.',
          status: 0,
          details: { reportKey, cause: error instanceof Error ? error.message : String(error) },
        });
      }
    },
    // Paging or changing a filter changes the key. Without this the table
    // empties to a skeleton between every step, which reads as the report
    // breaking and coming back rather than as the page moving.
    placeholderData: keepPreviousData,
  });
}

// --------------------------------------------------------------- saved views

export function useSavedViews(reportKey: ReportKey): UseQueryResult<SavedView[], Error> {
  return useQuery({
    queryKey: reportKeys.views(reportKey),
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/reports/views?reportKey=${reportKey}`, { signal });
      return parse(savedViewListSchema, body, 'saved views');
    },
  });
}

export function useSaveView(): UseMutationResult<SavedView, Error, SavedViewInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: SavedViewInput) => {
      const body = await apiRequest<unknown>('/reports/views', { method: 'POST', body: input });
      return parse(savedViewSchema, body, 'saved view');
    },
    onSuccess: async (view) => {
      await client.invalidateQueries({ queryKey: reportKeys.views(view.reportKey) });
    },
  });
}

export function useDeleteView(
  reportKey: ReportKey,
): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest<void>(`/reports/views/${id}`, { method: 'DELETE' });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: reportKeys.views(reportKey) });
    },
  });
}

// ------------------------------------------------------------------- exports

/** How often the tray asks again while something is still being produced. */
const EXPORT_POLL_MS = 1_500;

export function useExportJobs(enabled = true): UseQueryResult<ExportJobSummary[], Error> {
  return useQuery({
    enabled,
    queryKey: reportKeys.exports,
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/reports/exports?limit=25', { signal });
      return parse(exportJobListSchema, body, 'downloads').data;
    },
    // Polling only while something is unfinished. A tray of completed files
    // that refetched every second would be a request per second, forever, on
    // a screen nobody is watching.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return false;
      return data.some((job) => job.status === 'QUEUED' || job.status === 'RUNNING')
        ? EXPORT_POLL_MS
        : false;
    },
  });
}

export function useRequestExport(): UseMutationResult<ExportJobSummary, Error, ExportRequest> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: ExportRequest) => {
      const body = await apiRequest<unknown>('/reports/exports', { method: 'POST', body: input });
      return parse(exportJobSchema, body, 'export');
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: reportKeys.exports });
    },
  });
}

/**
 * Fetches the signed URL and opens it.
 *
 * A mutation rather than a query: asking for a link is an action with a
 * five-minute consequence, and it should happen when the reader clicks rather
 * than when the row renders.
 */
export function useDownloadExport(): UseMutationResult<
  { url: string; filename: string },
  Error,
  string
> {
  return useMutation({
    mutationFn: async (id: string) => {
      const body = await apiRequest<unknown>(`/reports/exports/${id}/download`);
      const link = parse(exportDownloadSchema, body, 'download link');
      return { url: link.url, filename: link.filename };
    },
  });
}

// -------------------------------------------------------------------- photos

/**
 * REQ-D-03a and NFR-09: a punch photo is reached through a short-lived signed
 * URL, and a list loads the thumbnail. `variant: 'full'` is a separate hook
 * call the viewer makes only when the reader asks for the full image, so the
 * expensive object is never fetched by a table.
 *
 * `staleTime` is under the five-minute signing window, so a cached URL cannot
 * be handed to an `img` after it has expired.
 */
const SIGNED_URL_STALE_MS = 4 * 60_000;

export function usePunchPhoto(
  punchId: string | null,
  variant: 'thumbnail' | 'full',
  enabled: boolean,
): UseQueryResult<string, Error> {
  return useQuery({
    enabled: enabled && punchId !== null,
    queryKey: reportKeys.photo(punchId ?? 'none', variant),
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/punches/${punchId ?? ''}/photo?variant=${variant}`, {
        signal,
      });
      return parse(signedPhotoSchema, body, 'punch photo').url;
    },
    staleTime: SIGNED_URL_STALE_MS,
    gcTime: SIGNED_URL_STALE_MS,
    retry: false,
  });
}

// -------------------------------------------------------------- filter options

const departmentsSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string(), code: z.string() })),
});

export function useDepartmentOptions(): UseQueryResult<{ id: string; name: string }[], Error> {
  return useQuery({
    queryKey: ['departments', 'report-options'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/departments?pageSize=200', { signal });
      return parse(departmentsSchema, body, 'department list').data;
    },
    staleTime: 5 * 60_000,
  });
}

const locationsSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string(), code: z.string() })),
});

export function useLocationOptions(): UseQueryResult<{ id: string; name: string }[], Error> {
  return useQuery({
    queryKey: ['locations', 'report-options'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/locations?pageSize=200', { signal });
      return parse(locationsSchema, body, 'location list').data;
    },
    staleTime: 5 * 60_000,
    // A missing masters endpoint must not take the whole report down: the
    // filter simply offers no options, which the control says out loud.
    retry: false,
  });
}

// ------------------------------------------------------------------ schedules

/**
 * REQ-J-05. The list is not polled: a schedule changes when somebody changes
 * it, and the file it produces shows up in the tray beside it, which is polled
 * already while anything is running.
 */
export function useReportSchedules(enabled = true): UseQueryResult<ReportSchedule[], Error> {
  return useQuery({
    enabled,
    queryKey: reportKeys.schedules,
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/reports/schedules', { signal });
      return parse(reportScheduleListSchema, body, 'schedules');
    },
  });
}

export function useCreateSchedule(): UseMutationResult<
  ReportSchedule,
  Error,
  ReportScheduleInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReportScheduleInput) => {
      const body = await apiRequest<unknown>('/reports/schedules', { method: 'POST', body: input });
      return parse(reportScheduleSchema, body, 'schedule');
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: reportKeys.schedules });
    },
  });
}

export function useSetScheduleActive(): UseMutationResult<
  ReportSchedule,
  Error,
  { id: string; isActive: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isActive }) => {
      const body = await apiRequest<unknown>(`/reports/schedules/${id}/active`, {
        method: 'POST',
        body: { isActive },
      });
      return parse(reportScheduleSchema, body, 'schedule');
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: reportKeys.schedules });
    },
  });
}

export function useDeleteSchedule(): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest<unknown>(`/reports/schedules/${id}`, { method: 'DELETE' });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: reportKeys.schedules });
    },
  });
}
