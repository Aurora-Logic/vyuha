import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

import type { Paginated, PriceListDetail, PriceListDiff, PriceListDraftInput, PriceListsQuery, PriceListSummary, RateSimulation, RateSimulationQuery } from '@vyuha/shared';

import { apiRequest } from '@/lib/api/client';

/** Area AN: Vyuha's price lists, their versions and approval, and the rate they resolve. */

const PRICING_KEY = ['pricing'] as const;

function useInvalidatePricing(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: PRICING_KEY });
}

export function usePriceLists(query: PriceListsQuery, options: { enabled?: boolean } = {}): UseQueryResult<Paginated<PriceListSummary>, Error> {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  if (query.state) params.set('state', query.state);
  if (query.q) params.set('q', query.q);
  const key = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [...PRICING_KEY, 'lists', key],
    queryFn: ({ signal }) => apiRequest<Paginated<PriceListSummary>>(`/pricing/lists?${key}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function usePriceList(id: string | null): UseQueryResult<PriceListDetail, Error> {
  return useQuery({
    enabled: id !== null,
    queryKey: [...PRICING_KEY, 'list', id ?? ''],
    queryFn: ({ signal }) => apiRequest<PriceListDetail>(`/pricing/lists/${id ?? ''}`, { signal }),
  });
}

export function usePriceListDiff(id: string | null): UseQueryResult<PriceListDiff, Error> {
  return useQuery({
    enabled: id !== null,
    queryKey: [...PRICING_KEY, 'list', id ?? '', 'diff'],
    queryFn: ({ signal }) => apiRequest<PriceListDiff>(`/pricing/lists/${id ?? ''}/diff`, { signal }),
  });
}

export function useCreatePriceList(): UseMutationResult<PriceListDetail, Error, PriceListDraftInput> {
  const invalidate = useInvalidatePricing();
  return useMutation({ mutationFn: (input) => apiRequest<PriceListDetail>('/pricing/lists', { method: 'POST', body: input }), onSuccess: invalidate });
}

export function useUpdatePriceList(): UseMutationResult<PriceListDetail, Error, { id: string; input: PriceListDraftInput }> {
  const invalidate = useInvalidatePricing();
  return useMutation({ mutationFn: ({ id, input }) => apiRequest<PriceListDetail>(`/pricing/lists/${id}`, { method: 'PUT', body: input }), onSuccess: invalidate });
}

export function useNewPriceListVersion(): UseMutationResult<PriceListDetail, Error, string> {
  const invalidate = useInvalidatePricing();
  return useMutation({ mutationFn: (id) => apiRequest<PriceListDetail>(`/pricing/lists/${id}/versions`, { method: 'POST' }), onSuccess: invalidate });
}

export function useSubmitPriceList(): UseMutationResult<PriceListDetail, Error, string> {
  const invalidate = useInvalidatePricing();
  return useMutation({ mutationFn: (id) => apiRequest<PriceListDetail>(`/pricing/lists/${id}/submit`, { method: 'POST' }), onSuccess: invalidate });
}

/** REQ-AN-17/18: what resolves for a party and an item, and why. Keyed on every input, so a changed quantity re-asks. */
export function useRateSimulation(query: Omit<Partial<RateSimulationQuery>, 'stockItemId'> & { stockItemId: string | null }, options: { enabled?: boolean } = {}): UseQueryResult<RateSimulation, Error> {
  const params = new URLSearchParams({ stockItemId: query.stockItemId ?? '' });
  if (query.partyId) params.set('partyId', query.partyId);
  if (query.quantity) params.set('quantity', query.quantity);
  if (query.date) params.set('date', query.date);
  const key = params.toString();
  return useQuery({
    enabled: (options.enabled ?? true) && query.stockItemId !== null && query.stockItemId !== '',
    queryKey: [...PRICING_KEY, 'simulate', key],
    queryFn: ({ signal }) => apiRequest<RateSimulation>(`/pricing/simulate?${key}`, { signal }),
    staleTime: 30_000,
  });
}
