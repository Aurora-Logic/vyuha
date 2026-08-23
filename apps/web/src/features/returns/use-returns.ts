import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import type {
  CreateReturnInput,
  DecideReplacementInput,
  Paginated,
  ReturnReasonsPolicy,
  ReturnState,
  SalesReturnSummary,
  SalesReturnView,
  SetDispositionInput,
  UnlinkedCreditNote,
} from '@vyuha/shared';

import { apiRequest } from '@/lib/api/client';
import { postMultipart } from '@/lib/offline/multipart';

/**
 * Area AK. Receiving a return is the module's second multipart POST, for
 * the same reason the first is: REQ-AK-04 wants the photographs to arrive
 * with the words, not after them.
 */

const RETURNS_KEY = ['returns'] as const;

function useInvalidateReturns(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await client.invalidateQueries({ queryKey: RETURNS_KEY });
    // A replacement is a sales order; the orders list must learn of it too.
    await client.invalidateQueries({ queryKey: ['sales'] });
  };
}

export interface ReturnFilters {
  page: number;
  pageSize?: number;
  state?: ReturnState;
  partyId?: string;
  stockItemId?: string;
  reason?: string;
  from?: string;
  to?: string;
  q?: string;
}

export function useReturns(filters: ReturnFilters, options: { enabled?: boolean } = {}): UseQueryResult<Paginated<SalesReturnSummary>, Error> {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize ?? 25) });
  for (const [name, value] of [['state', filters.state], ['partyId', filters.partyId], ['stockItemId', filters.stockItemId], ['reason', filters.reason], ['from', filters.from], ['to', filters.to], ['q', filters.q]] as const) {
    if (value) params.set(name, value);
  }
  const key = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [...RETURNS_KEY, 'list', key],
    queryFn: ({ signal }) => apiRequest<Paginated<SalesReturnSummary>>(`/sales/returns?${key}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useReturn(id: string | null, options: { enabled?: boolean } = {}): UseQueryResult<SalesReturnView, Error> {
  return useQuery({
    enabled: (options.enabled ?? true) && id !== null,
    queryKey: [...RETURNS_KEY, 'one', id ?? ''],
    queryFn: ({ signal }) => apiRequest<SalesReturnView>(`/sales/returns/${id ?? ''}`, { signal }),
  });
}

/** REQ-AK-02: the organisation's list, which Settings edits. */
export function useReturnReasons(options: { enabled?: boolean } = {}): UseQueryResult<ReturnReasonsPolicy, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [...RETURNS_KEY, 'reasons'],
    queryFn: ({ signal }) => apiRequest<ReturnReasonsPolicy>('/sales/returns/reasons', { signal }),
    staleTime: 5 * 60 * 1000,
  });
}

/** REQ-AK-06: credit notes with no return behind them. Reading it runs the narration pass. */
export function useUnlinkedCreditNotes(options: { enabled?: boolean } = {}): UseQueryResult<readonly UnlinkedCreditNote[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [...RETURNS_KEY, 'unlinked'],
    queryFn: ({ signal }) => apiRequest<readonly UnlinkedCreditNote[]>('/sales/returns/unlinked-credit-notes', { signal }),
  });
}

export interface CreateReturnArgs {
  input: CreateReturnInput;
  goods: readonly File[];
  packaging: readonly File[];
  document: readonly File[];
}

export function useCreateReturn(): UseMutationResult<SalesReturnView, Error, CreateReturnArgs> {
  const invalidate = useInvalidateReturns();
  return useMutation({
    mutationFn: async ({ input, goods, packaging, document }) => {
      const form = new FormData();
      form.append('payload', JSON.stringify(input));
      for (const file of goods) form.append('goods', file, file.name);
      for (const file of packaging) form.append('packaging', file, file.name);
      for (const file of document) form.append('document', file, file.name);
      return postMultipart(`/sales/returns`, form, (body) => body as SalesReturnView);
    },
    onSuccess: invalidate,
  });
}

export function useSetDisposition(): UseMutationResult<SalesReturnView, Error, { returnId: string; input: SetDispositionInput }> {
  const invalidate = useInvalidateReturns();
  return useMutation({
    mutationFn: ({ returnId, input }) => apiRequest<SalesReturnView>(`/sales/returns/${returnId}/disposition`, { method: 'POST', body: input }),
    onSuccess: invalidate,
  });
}

export function useLinkCreditNote(): UseMutationResult<SalesReturnView, Error, { returnId: string; voucherId: string }> {
  const invalidate = useInvalidateReturns();
  return useMutation({
    mutationFn: ({ returnId, voucherId }) => apiRequest<SalesReturnView>(`/sales/returns/${returnId}/credit-note`, { method: 'POST', body: { voucherId } }),
    onSuccess: invalidate,
  });
}

export function useDecideReplacement(): UseMutationResult<SalesReturnView, Error, { returnId: string; input: DecideReplacementInput }> {
  const invalidate = useInvalidateReturns();
  return useMutation({
    mutationFn: ({ returnId, input }) => apiRequest<SalesReturnView>(`/sales/returns/${returnId}/replacement`, { method: 'POST', body: input }),
    onSuccess: invalidate,
  });
}

export function useCancelReturn(): UseMutationResult<SalesReturnView, Error, { returnId: string; reason: string }> {
  const invalidate = useInvalidateReturns();
  return useMutation({
    mutationFn: ({ returnId, reason }) => apiRequest<SalesReturnView>(`/sales/returns/${returnId}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: invalidate,
  });
}
