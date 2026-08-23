import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

import type { DuplicateClusterView, DuplicateClustersQuery, DuplicateDetectionResult, DuplicateEntityType, Paginated } from '@vyuha/shared';

import { apiRequest } from '@/lib/api/client';

/** Area AO: the clusters the detector keeps, and the three things a person may say about one. */

const DUPLICATES_KEY = ['masters', 'duplicates'] as const;

function useInvalidate(): () => Promise<void> {
  const client = useQueryClient();
  // The flags ride on the party and item lists, so those refresh too. The
  // item register's key is `['masters','stock-items']` (use-stock-items.ts);
  // this said `['masters','items']`, which nothing registers under, so
  // dismissing a duplicate left its badge on the register until a reload.
  return async () => {
    await Promise.all([client.invalidateQueries({ queryKey: DUPLICATES_KEY }), client.invalidateQueries({ queryKey: ['masters', 'parties'] }), client.invalidateQueries({ queryKey: ['masters', 'stock-items'] })]);
  };
}

export function useDuplicateClusters(query: DuplicateClustersQuery, options: { enabled?: boolean } = {}): UseQueryResult<Paginated<DuplicateClusterView>, Error> {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  if (query.entityType) params.set('entityType', query.entityType);
  if (query.state) params.set('state', query.state);
  const key = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [...DUPLICATES_KEY, key],
    queryFn: ({ signal }) => apiRequest<Paginated<DuplicateClusterView>>(`/masters/duplicates?${key}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useDetectDuplicates(): UseMutationResult<DuplicateDetectionResult[], Error, { entityType?: DuplicateEntityType }> {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input) => apiRequest<DuplicateDetectionResult[]>('/masters/duplicates/detect', { method: 'POST', body: input }), onSuccess: invalidate });
}

export function useDismissDuplicate(): UseMutationResult<DuplicateClusterView, Error, { id: string; reason: string }> {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: ({ id, reason }) => apiRequest<DuplicateClusterView>(`/masters/duplicates/${id}/dismiss`, { method: 'POST', body: { reason } }), onSuccess: invalidate });
}

export function useSendDuplicateToTally(): UseMutationResult<DuplicateClusterView, Error, string> {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id) => apiRequest<DuplicateClusterView>(`/masters/duplicates/${id}/sent-to-tally`, { method: 'POST' }), onSuccess: invalidate });
}

export function useReopenDuplicate(): UseMutationResult<DuplicateClusterView, Error, string> {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id) => apiRequest<DuplicateClusterView>(`/masters/duplicates/${id}/reopen`, { method: 'POST' }), onSuccess: invalidate });
}
