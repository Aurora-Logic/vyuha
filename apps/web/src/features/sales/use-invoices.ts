import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import type { CreateInvoiceInput, DocumentSyncState, SalesOrderStatus } from '@vyuha/shared';

import { apiRequest } from '@/lib/api/client';
import { parseOrThrow } from '@/lib/api/parse';

import { estimateSchema, estimatesResponseSchema, type Estimate, type EstimatesResponse } from './types';

/**
 * Vyuha-raised invoices (D-38): the same document shape as an order, raised
 * against one for its packed-and-uninvoiced balance. Confirming advances the
 * order's invoiced quantities and queues a Sales voucher, so every mutation
 * invalidates the whole sales tree.
 */

export interface InvoiceFilters {
  page: number;
  q?: string;
  status?: SalesOrderStatus;
  syncState?: DocumentSyncState;
  partyId?: string;
  sourceDocumentId?: string;
  /** A term the server knows (ESTIMATE_SORT_FIELDS), e.g. "-date" or "grandTotal". */
  sort?: string;
}

export function useInvoices(filters: InvoiceFilters, options: { enabled?: boolean } = {}): UseQueryResult<EstimatesResponse, Error> {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: '25' });
  if (filters.q) params.set('q', filters.q);
  if (filters.status) params.set('status', filters.status);
  if (filters.syncState) params.set('syncState', filters.syncState);
  if (filters.partyId) params.set('partyId', filters.partyId);
  if (filters.sourceDocumentId) params.set('sourceDocumentId', filters.sourceDocumentId);
  if (filters.sort) params.set('sort', filters.sort);
  const key = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['sales', 'invoices', key],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/sales/invoices?${key}`, { signal });
      return parseOrThrow(estimatesResponseSchema, body, 'invoice list');
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export function useInvoice(id: string | null): UseQueryResult<Estimate, Error> {
  return useQuery({
    enabled: id !== null,
    queryKey: ['sales', 'invoice', id],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/sales/invoices/${id ?? ''}`, { signal });
      return parseOrThrow(estimateSchema, body, 'invoice');
    },
    refetchInterval: (query) => (query.state.data?.syncState === 'QUEUED' ? 10_000 : false),
  });
}

function useInvalidateSales(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['sales'] });
}

/** From the order's packed-and-uninvoiced balance, or the named lines' share of it, as a draft. */
export function useCreateInvoice(): UseMutationResult<Estimate, Error, { documentId: string; input: CreateInvoiceInput }> {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: async ({ documentId, input }) => {
      const response = await apiRequest<unknown>(`/sales/orders/${documentId}/invoices`, { method: 'POST', body: input });
      return parseOrThrow(estimateSchema, response, 'invoice');
    },
    onSuccess: invalidate,
  });
}

/** Confirm, push, cancel: one mutation, the action named. */
export function useInvoiceAction(): UseMutationResult<Estimate, Error, { id: string; action: 'confirm' | 'push' | 'cancel' }> {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: async ({ id, action }) => {
      const response = await apiRequest<unknown>(`/sales/invoices/${id}/${action}`, { method: 'POST' });
      return parseOrThrow(estimateSchema, response, 'invoice');
    },
    onSuccess: invalidate,
  });
}
