import { duplicateFlagSchema } from '@/components/shared/duplicate-flag';
import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';

import { parseOrThrow } from '@/lib/api/parse';
import { apiRequest } from '@/lib/api/client';

/**
 * `GET /masters/items` (REQ-R-02). The GST rate stays a string end to end:
 * Tally's figure, shown, never computed on (D-01).
 */

export const stockItemSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  name: z.string(),
  alias: z.string().nullable(),
  unit: z.string(),
  parentGroup: z.string(),
  gstRate: z.string().nullable(),
  // Held figures (D-01), exact text; absent on rows the server has not yet
  // been asked for them, so optional rather than nullable-required.
  closingQty: z.string().nullable().optional(),
  salePrice: z.string().nullable().optional(),
  costPrice: z.string().nullable().optional(),
  absentInTally: z.boolean(),
  lastPulledAt: z.string(),
  // 15 REQ-AO-06: set when the record sits in an open duplicate cluster.
  duplicate: duplicateFlagSchema.nullable().default(null),
});

export type StockItem = z.infer<typeof stockItemSchema>;

const stockItemsResponseSchema = z.object({
  data: z.array(stockItemSchema),
  meta: z.object({
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
  }),
});

export type StockItemsResponse = z.infer<typeof stockItemsResponseSchema>;

export interface StockItemFilters {
  page: number;
  /** A picker needs the whole list, not the list screen's page. */
  pageSize?: number;
  q?: string;
  parentGroup?: string;
  connectionId?: string;
}

function stockItemsQuery(filters: StockItemFilters) {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize ?? 25) });
  if (filters.q) params.set('q', filters.q);
  if (filters.parentGroup) params.set('parentGroup', filters.parentGroup);
  if (filters.connectionId) params.set('connectionId', filters.connectionId);
  const key = params.toString();
  return {
    queryKey: ['masters', 'stock-items', key] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const body = await apiRequest<unknown>(`/masters/items?${key}`, { signal });
      return parseOrThrow(stockItemsResponseSchema, body, 'stock item list');
    },
  };
}

export function useStockItems(
  filters: StockItemFilters,
  options: { enabled?: boolean; prefetchNext?: boolean } = {},
): UseQueryResult<StockItemsResponse, Error> {
  const enabled = options.enabled ?? true;
  const client = useQueryClient();
  const query = useQuery({
    enabled,
    ...stockItemsQuery(filters),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  // See useParties: a register pages, so it pre-loads the next page; a picker
  // reads page one only and opts out.
  const meta = query.data?.meta;
  const hasNext = meta !== undefined && meta.page * meta.pageSize < meta.total;
  const { page, q, parentGroup, pageSize, connectionId } = filters;
  useEffect(() => {
    if (!options.prefetchNext || !enabled || !hasNext) return;
    void client.prefetchQuery({
      ...stockItemsQuery({
        page: page + 1,
        ...(q ? { q } : {}),
        ...(parentGroup ? { parentGroup } : {}),
        ...(pageSize ? { pageSize } : {}),
        ...(connectionId ? { connectionId } : {}),
      }),
      staleTime: 60_000,
    });
  }, [client, options.prefetchNext, enabled, hasNext, page, q, parentGroup, pageSize, connectionId]);

  return query;
}
