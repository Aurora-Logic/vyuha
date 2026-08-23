import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { salesSettingsSchema, type ConfirmSalesOrderInput, type CreateEstimateInput, type DocumentDetails, type EstimateStatus, type SalesLineInput, type SalesOrderStatus, type SalesSettings, type ShipTo, type UpdateEstimateInput } from '@vyuha/shared';

import { apiRequest } from '@/lib/api/client';
import { parseOrThrow } from '@/lib/api/parse';

import { estimateSchema, estimatesResponseSchema, itemHistorySchema, type Estimate, type EstimateDraft, type EstimatesResponse, type ItemHistory } from './types';

export interface EstimateFilters {
  page: number;
  q?: string;
  status?: EstimateStatus;
  dealId?: string;
  companyId?: string;
  partyId?: string;
}

export function useEstimates(filters: EstimateFilters, options: { enabled?: boolean } = {}): UseQueryResult<EstimatesResponse, Error> {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: '25' });
  if (filters.q) params.set('q', filters.q);
  if (filters.status) params.set('status', filters.status);
  if (filters.dealId) params.set('dealId', filters.dealId);
  if (filters.companyId) params.set('companyId', filters.companyId);
  if (filters.partyId) params.set('partyId', filters.partyId);
  const key = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['sales', 'estimates', key],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/sales/estimates?${key}`, { signal });
      return parseOrThrow(estimatesResponseSchema, body, 'estimate list');
    },
    placeholderData: keepPreviousData,
  });
}

export function useEstimate(id: string | null): UseQueryResult<Estimate, Error> {
  return useQuery({
    enabled: id !== null,
    queryKey: ['sales', 'estimate', id],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/sales/estimates/${id ?? ''}`, { signal });
      return parseOrThrow(estimateSchema, body, 'estimate');
    },
  });
}

/** REQ-W-02, asked when the affordance opens, not on every keystroke. */
export function useItemHistory(input: { stockItemId: string | null; partyId: string | null; companyId: string | null; enabled: boolean }): UseQueryResult<ItemHistory, Error> {
  const params = new URLSearchParams({ stockItemId: input.stockItemId ?? '' });
  if (input.partyId) params.set('partyId', input.partyId);
  if (input.companyId) params.set('companyId', input.companyId);
  const key = params.toString();
  return useQuery({
    enabled: input.enabled && input.stockItemId !== null,
    queryKey: ['sales', 'item-history', key],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/sales/item-history?${key}`, { signal });
      return parseOrThrow(itemHistorySchema, body, 'item history');
    },
    staleTime: 60_000,
  });
}

function useInvalidateSales(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['sales'] });
}

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim());

function toLineInputs(draft: EstimateDraft): SalesLineInput[] {
  return draft.lines
    .filter((line) => line.stockItemId !== null || line.description.trim() !== '' || line.rate.trim() !== '')
    .map((line) => ({
      stockItemId: line.stockItemId,
      description: line.description.trim(),
      quantity: line.quantity.trim() === '' ? '1' : line.quantity.trim(),
      unit: blank(line.unit),
      // 15 REQ-AN-13: a blank rate is the price lists' to resolve; a typed one stands.
      ...(line.rate.trim() === '' ? {} : { rate: line.rate.trim().replace(/,/gu, '') }),
      rateOverrideReason: blank(line.rateOverrideReason),
      discountPct: line.discountPct.trim() === '' ? '0' : line.discountPct.trim(),
      taxPct: line.taxPct.trim() === '' ? '0' : line.taxPct.trim(),
      hsnCode: blank(line.hsnCode),
    }));
}

/** The GST header as the API takes it: empty boxes are absent, an empty consignee is null. */
function toGstHeader(draft: EstimateDraft): { placeOfSupply: string | null; shipTo: ShipTo | null; details: DocumentDetails | null } {
  const details = Object.fromEntries(Object.entries(draft.details).filter(([, v]) => typeof v === 'string' && v.trim() !== '')) as DocumentDetails;
  const shipTo = Object.fromEntries(Object.entries(draft.shipTo).filter(([, v]) => typeof v === 'string' && v.trim() !== '')) as ShipTo;
  return {
    placeOfSupply: blank(draft.placeOfSupply),
    shipTo: Object.keys(shipTo).length === 0 ? null : shipTo,
    details: Object.keys(details).length === 0 ? null : details,
  };
}

export function useSaveEstimate(): UseMutationResult<Estimate, Error, EstimateDraft> {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: async (draft: EstimateDraft) => {
      const common = {
        partyId: draft.partyId,
        companyId: draft.companyId,
        date: draft.date,
        validUntil: draft.validUntil,
        dealId: draft.dealId,
        ownerId: draft.ownerId,
        notes: blank(draft.notes),
        terms: blank(draft.terms),
        ...toGstHeader(draft),
        lines: toLineInputs(draft),
      };
      const body: CreateEstimateInput | UpdateEstimateInput =
        draft.id === undefined
          ? { ...common, customerName: blank(draft.customerName) }
          : { ...common, ...(draft.customerName.trim() === '' ? {} : { customerName: draft.customerName.trim() }) };
      const response = await apiRequest<unknown>(draft.id === undefined ? '/sales/estimates' : `/sales/estimates/${draft.id}`, {
        method: draft.id === undefined ? 'POST' : 'PATCH',
        body,
      });
      return parseOrThrow(estimateSchema, response, 'saved estimate');
    },
    onSuccess: invalidate,
  });
}

export function useSetEstimateStatus(): UseMutationResult<Estimate, Error, { id: string; status: EstimateStatus }> {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: async ({ id, status }) => {
      const response = await apiRequest<unknown>(`/sales/estimates/${id}/status`, { method: 'POST', body: { status } });
      return parseOrThrow(estimateSchema, response, 'estimate');
    },
    onSuccess: invalidate,
  });
}

export function useDeleteEstimate(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest<void>(`/sales/estimates/${id}`, { method: 'DELETE' });
    },
    onSuccess: invalidate,
  });
}

// ------------------------------------------------------------ sales orders

export interface SalesOrderFilters {
  page: number;
  /** The list screen's page is 25; the fulfilment board asks for more at once. */
  pageSize?: number;
  q?: string;
  status?: SalesOrderStatus;
  syncState?: 'NOT_PUSHED' | 'QUEUED' | 'PUSHED' | 'FAILED';
  dealId?: string;
  partyId?: string;
}

export function useSalesOrders(filters: SalesOrderFilters, options: { enabled?: boolean } = {}): UseQueryResult<EstimatesResponse, Error> {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize ?? 25) });
  if (filters.q) params.set('q', filters.q);
  if (filters.status) params.set('status', filters.status);
  if (filters.syncState) params.set('syncState', filters.syncState);
  if (filters.dealId) params.set('dealId', filters.dealId);
  if (filters.partyId) params.set('partyId', filters.partyId);
  const key = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['sales', 'orders', key],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/sales/orders?${key}`, { signal });
      return parseOrThrow(estimatesResponseSchema, body, 'sales order list');
    },
    placeholderData: keepPreviousData,
    // REQ-W-06: the state changes when the agent reports; a minute is the
    // most a queued badge should lie by.
    refetchInterval: 60_000,
  });
}

export function useSalesOrder(id: string | null): UseQueryResult<Estimate, Error> {
  return useQuery({
    enabled: id !== null,
    queryKey: ['sales', 'order', id],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/sales/orders/${id ?? ''}`, { signal });
      return parseOrThrow(estimateSchema, body, 'sales order');
    },
    refetchInterval: (query) => (query.state.data?.syncState === 'QUEUED' ? 10_000 : false),
  });
}

/** Create or edit a draft; the estimate draft shape serves, minus its estimate-only fields. */
export function useSaveSalesOrder(): UseMutationResult<Estimate, Error, EstimateDraft> {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: async (draft: EstimateDraft) => {
      if (draft.partyId === null) throw new Error('A sales order needs a Tally party.');
      const common = {
        partyId: draft.partyId,
        date: draft.date,
        dealId: draft.dealId,
        ownerId: draft.ownerId,
        notes: blank(draft.notes),
        terms: blank(draft.terms),
        // REQ-AA-28: null on create falls back to the party master; null on
        // a draft clears the override the way the person cleared the box.
        customerEmail: blank(draft.customerEmail),
        customerWhatsapp: blank(draft.customerWhatsapp),
        ...toGstHeader(draft),
        lines: toLineInputs(draft),
      };
      const response = await apiRequest<unknown>(draft.id === undefined ? '/sales/orders' : `/sales/orders/${draft.id}`, {
        method: draft.id === undefined ? 'POST' : 'PATCH',
        body: common,
      });
      return parseOrThrow(estimateSchema, response, 'saved sales order');
    },
    onSuccess: invalidate,
  });
}

/** Confirm, approve, push, cancel: one mutation, the action named. Confirm may carry the credit override (REQ-W-09); approve decides the discount request (REQ-W-08). */
export function useSalesOrderAction(): UseMutationResult<Estimate, Error, { id: string; action: 'confirm' | 'approve' | 'push' | 'cancel'; body?: ConfirmSalesOrderInput }> {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: async ({ id, action, body }) => {
      const response = await apiRequest<unknown>(`/sales/orders/${id}/${action}`, { method: 'POST', ...(body === undefined ? {} : { body }) });
      return parseOrThrow(estimateSchema, response, 'sales order');
    },
    onSuccess: invalidate,
  });
}

/** REQ-W-07: the edit and the re-push, together. */
export function useAlterSalesOrder(): UseMutationResult<Estimate, Error, EstimateDraft> {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: async (draft: EstimateDraft) => {
      if (draft.id === undefined) throw new Error('Only a saved order can be altered.');
      const response = await apiRequest<unknown>(`/sales/orders/${draft.id}/alter`, {
        method: 'POST',
        body: { notes: blank(draft.notes), terms: blank(draft.terms), lines: toLineInputs(draft), ...(draft.partyId === null ? {} : { partyId: draft.partyId }) },
      });
      return parseOrThrow(estimateSchema, response, 'altered sales order');
    },
    onSuccess: invalidate,
  });
}

/** REQ-W-03: an accepted estimate becomes a draft order. */
export function useConvertEstimate(): UseMutationResult<Estimate, Error, { estimateId: string; partyId?: string }> {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: async ({ estimateId, partyId }) => {
      const response = await apiRequest<unknown>(`/sales/estimates/${estimateId}/convert`, { method: 'POST', body: partyId === undefined ? {} : { partyId } });
      return parseOrThrow(estimateSchema, response, 'sales order');
    },
    onSuccess: invalidate,
  });
}

/** REQ-W-08: the discount threshold, read beside the orders it decides. */
export function useSalesSettings(options: { enabled?: boolean } = {}): UseQueryResult<SalesSettings, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['sales', 'settings'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/sales/settings', { signal });
      return parseOrThrow(salesSettingsSchema, body, 'sales settings');
    },
    staleTime: 5 * 60_000,
  });
}

export function useSaveSalesSettings(): UseMutationResult<SalesSettings, Error, SalesSettings> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input) => {
      const response = await apiRequest<unknown>('/sales/settings', { method: 'PUT', body: input });
      return parseOrThrow(salesSettingsSchema, response, 'sales settings');
    },
    onSuccess: (saved) => {
      client.setQueryData(['sales', 'settings'], saved);
    },
  });
}
