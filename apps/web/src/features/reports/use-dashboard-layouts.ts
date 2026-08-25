import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { ApiError, apiRequest } from '@/lib/api/client';
import {
  DASHBOARD_KEYS,
  dashboardLayoutSchema,
  type DashboardKey,
  type DashboardLayout,
  type DashboardLayoutView,
} from '@vyuha/shared';

/**
 * The dashboard layout calls (owner, 25 Aug 2026): a person's own tile
 * arrangement per board. Its own module rather than a corner of api.ts
 * because api.ts is the report shell's vocabulary, and a board layout is the
 * dashboard's -- the shell never reads one.
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

const dashboardLayoutViewSchema = z.object({
  dashboard: z.enum(DASHBOARD_KEYS),
  config: dashboardLayoutSchema,
  updatedAt: z.string(),
}) satisfies z.ZodType<DashboardLayoutView>;

const dashboardLayoutListSchema = z.object({
  data: z.array(dashboardLayoutViewSchema),
});

export const dashboardLayoutKeys = {
  list: ['reports', 'dashboards'] as const,
};

export function useDashboardLayouts(enabled = true): UseQueryResult<DashboardLayoutView[], Error> {
  return useQuery({
    enabled,
    queryKey: dashboardLayoutKeys.list,
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/reports/dashboards', { signal });
      return parse(dashboardLayoutListSchema, body, 'dashboard layouts').data;
    },
  });
}

export function useSaveDashboardLayout(): UseMutationResult<
  DashboardLayoutView,
  Error,
  { dashboard: DashboardKey; config: DashboardLayout }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ dashboard, config }) => {
      const body = await apiRequest<unknown>(`/reports/dashboards/${dashboard}`, {
        method: 'PUT',
        body: config,
      });
      return parse(dashboardLayoutViewSchema, body, 'dashboard layout');
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: dashboardLayoutKeys.list });
    },
  });
}

/** A reset is a delete: no stored layout means the shipped preset renders. */
export function useResetDashboardLayout(): UseMutationResult<void, Error, DashboardKey> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (dashboard: DashboardKey) => {
      await apiRequest<void>(`/reports/dashboards/${dashboard}`, { method: 'DELETE' });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: dashboardLayoutKeys.list });
    },
  });
}
