import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';
import type { CustomReportWrite, InsightArea } from '@vyuha/shared';

import { apiRequest } from '@/lib/api/client';
import { parseOrThrow } from '@/lib/api/parse';

/**
 * `GET /insights/:area` and the custom-report CRUD (Phase 6+, owner 26 Aug
 * 2026). Money arrives as text and stays text (D-01); the charts read numbers
 * out of the points with Number() at the last moment, for geometry only --
 * every printed figure goes through the format helpers instead.
 */

const metricPointSchema = z
  .object({ t: z.string() })
  .catchall(z.union([z.string(), z.number()]));

const metricSchema = z.object({
  key: z.string(),
  label: z.string(),
  hint: z.string(),
  unit: z.enum(['count', 'money', 'minutes', 'percent']),
  headline: z.string(),
  series: z.array(z.object({ key: z.string(), label: z.string() })),
  points: z.array(metricPointSchema),
  breakdown: z
    .object({
      columns: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          numeric: z.boolean().optional(),
          unit: z.enum(['count', 'money', 'minutes', 'percent']).optional(),
        }),
      ),
      rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
    })
    .optional(),
});

const areaInsightsSchema = z.object({
  area: z.enum(['attendance', 'receivables', 'sales', 'sync']),
  from: z.string(),
  to: z.string(),
  metrics: z.array(metricSchema),
});

export type Metric = z.infer<typeof metricSchema>;
export type AreaInsightsData = z.infer<typeof areaInsightsSchema>;

const customWidgetSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['bar', 'line', 'donut', 'number']),
  size: z.enum(['1x1', '2x1', '2x2']),
  area: z.enum(['attendance', 'receivables', 'sales', 'sync']),
  metric: z.string(),
  options: z.object({ legend: z.boolean(), dataLabels: z.boolean(), showTotal: z.boolean() }),
});

const customReportSchema = z.object({
  id: z.string(),
  name: z.string(),
  shared: z.boolean(),
  ownerUserId: z.string(),
  ownerName: z.string(),
  editable: z.boolean(),
  widgets: z.array(customWidgetSchema),
  updatedAt: z.string(),
});

export type CustomReport = z.infer<typeof customReportSchema>;

export function useAreaInsights(
  area: InsightArea,
  range: { from: string; to: string },
  options: { enabled?: boolean } = {},
): UseQueryResult<AreaInsightsData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['insights', area, range.from, range.to],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(
        `/insights/${area}?from=${range.from}&to=${range.to}`,
        { signal },
      );
      return parseOrThrow(areaInsightsSchema, body, 'report area');
    },
    staleTime: 60_000,
  });
}

export function useCustomReports(options: { enabled?: boolean } = {}): UseQueryResult<CustomReport[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['insights', 'custom-reports'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/insights/custom-reports', { signal });
      return parseOrThrow(z.array(customReportSchema), body, 'custom reports');
    },
    staleTime: 60_000,
  });
}

export function useCustomReport(id: string | null): UseQueryResult<CustomReport, Error> {
  return useQuery({
    enabled: id !== null,
    queryKey: ['insights', 'custom-reports', id],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/insights/custom-reports/${id ?? ''}`, { signal });
      return parseOrThrow(customReportSchema, body, 'custom report');
    },
    staleTime: 60_000,
  });
}

export function useCustomReportMutations() {
  const client = useQueryClient();
  const invalidate = () => client.invalidateQueries({ queryKey: ['insights', 'custom-reports'] });

  const create = useMutation({
    mutationFn: async (body: CustomReportWrite) => {
      const created = await apiRequest<unknown>('/insights/custom-reports', { method: 'POST', body });
      return parseOrThrow(customReportSchema, created, 'custom report');
    },
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: async (input: { id: string; body: CustomReportWrite }) => {
      const updated = await apiRequest<unknown>(`/insights/custom-reports/${input.id}`, {
        method: 'PUT',
        body: input.body,
      });
      return parseOrThrow(customReportSchema, updated, 'custom report');
    },
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest<unknown>(`/insights/custom-reports/${id}`, { method: 'DELETE' });
    },
    onSuccess: invalidate,
  });

  return { create, update, remove };
}
