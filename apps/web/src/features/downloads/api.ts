import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { EXPORT_FORMATS, EXPORT_STATUSES, reportFilterSchema, type ExportJobSummary } from '@vyuha/shared';
import { z } from 'zod';

import { apiRequest } from '@/lib/api/client';
import { parseOrThrow as parse } from '@/lib/api/parse';

/**
 * The Downloads tray's reads, owned by the tray since the reports module's
 * removal (owner, 26 Aug 2026). One producer fills it now -- the employee
 * data export (REQ-M-05) -- and the API serves it at `/exports`, no longer
 * under a `/reports` prefix that names nothing.
 */

export const exportJobSchema = z.object({
  id: z.string(),
  reportKey: z.string(),
  reportLabel: z.string(),
  status: z.enum(EXPORT_STATUSES),
  format: z.enum(EXPORT_FORMATS),
  filename: z.string(),
  progress: z.number(),
  rowCount: z.number().nullable(),
  error: z.string().nullable(),
  filters: reportFilterSchema,
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  downloadable: z.boolean(),
}) satisfies z.ZodType<ExportJobSummary>;

const exportJobListSchema = z.object({ data: z.array(exportJobSchema) });

const exportDownloadSchema = z.object({
  url: z.url(),
  expiresInSeconds: z.number(),
  filename: z.string(),
});

export const downloadKeys = {
  exports: ['downloads', 'exports'] as const,
};

const EXPORT_POLL_MS = 1_500;

export function useExportJobs(enabled = true): UseQueryResult<ExportJobSummary[], Error> {
  return useQuery({
    enabled,
    queryKey: downloadKeys.exports,
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/exports?limit=25', { signal });
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

export function useDownloadExport(): UseMutationResult<
  { url: string; filename: string },
  Error,
  string
> {
  return useMutation({
    mutationFn: async (id: string) => {
      const body = await apiRequest<unknown>(`/exports/${id}/download`);
      const link = parse(exportDownloadSchema, body, 'download link');
      return { url: link.url, filename: link.filename };
    },
  });
}
