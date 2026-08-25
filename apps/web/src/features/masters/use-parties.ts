import { duplicateFlagSchema } from '@/components/shared/duplicate-flag';
import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';

import { parseOrThrow } from '@/lib/api/parse';
import { apiRequest } from '@/lib/api/client';

/**
 * `GET /masters/parties` (REQ-R-01), the projection as the screen reads it.
 * Money fields stay strings end to end: they are Tally's figures, shown,
 * never computed on (D-01).
 */

export const partySchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  name: z.string(),
  alias: z.string().nullable(),
  parentGroup: z.string(),
  gstin: z.string().nullable(),
  address: z.string().nullable(),
  creditLimit: z.string().nullable(),
  creditDays: z.number().nullable(),
  openingBalance: z.string().nullable(),
  absentInTally: z.boolean(),
  lastPulledAt: z.string(),
  // 15 REQ-AO-06: set when the record sits in an open duplicate cluster.
  duplicate: duplicateFlagSchema.nullable().default(null),
});

export type Party = z.infer<typeof partySchema>;

const partiesResponseSchema = z.object({
  data: z.array(partySchema),
  // The shared envelope exactly: it carries no totalPages, and a schema that
  // demanded one refused every real answer this API sends. Pages are derived
  // where they are rendered.
  meta: z.object({
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
  }),
});

export type PartiesResponse = z.infer<typeof partiesResponseSchema>;

export interface PartiesFilters {
  page: number;
  /** A picker needs the whole list, not the list screen's page. */
  pageSize?: number;
  q?: string;
  parentGroup?: string;
  /** A term the server knows (MASTER_SORT_FIELDS), e.g. "-name" or "code". */
  sort?: string;
  connectionId?: string;
}

function partiesQuery(filters: PartiesFilters) {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize ?? 25) });
  if (filters.q) params.set('q', filters.q);
  if (filters.parentGroup) params.set('parentGroup', filters.parentGroup);
  if (filters.sort) params.set('sort', filters.sort);
  if (filters.connectionId) params.set('connectionId', filters.connectionId);
  const key = params.toString();
  return {
    queryKey: ['masters', 'parties', key] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const body = await apiRequest<unknown>(`/masters/parties?${key}`, { signal });
      return parseOrThrow(partiesResponseSchema, body, 'party list');
    },
  };
}

export function useParties(
  filters: PartiesFilters,
  options: { enabled?: boolean; prefetchNext?: boolean } = {},
): UseQueryResult<PartiesResponse, Error> {
  const enabled = options.enabled ?? true;
  const client = useQueryClient();
  const query = useQuery({
    enabled,
    ...partiesQuery(filters),
    placeholderData: keepPreviousData,
    // The projection changes when a pull lands, minutes apart at most
    // (REQ-R-07); a fresh page navigation re-reads regardless.
    staleTime: 60_000,
  });

  // A register that pages fetches the next page while this one is read, so the
  // click paints from cache rather than a spinner. Opt-in: a picker reads only
  // page one and must not spend a request pre-loading a page nobody scrolls to.
  const meta = query.data?.meta;
  const hasNext = meta !== undefined && meta.page * meta.pageSize < meta.total;
  const { page, q, parentGroup, pageSize, connectionId } = filters;
  useEffect(() => {
    if (!options.prefetchNext || !enabled || !hasNext) return;
    void client.prefetchQuery({
      ...partiesQuery({
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

/** One party, for a page that prints its address and GSTIN under the buyer's name. */
export function useParty(id: string | null): UseQueryResult<Party, Error> {
  return useQuery({
    enabled: id !== null,
    queryKey: ['masters', 'party', id],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/masters/parties/${id ?? ''}`, { signal });
      return parseOrThrow(partySchema, body, 'party');
    },
    staleTime: 60_000,
  });
}
