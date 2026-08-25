import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';

import { parseOrThrow } from '@/lib/api/parse';
import { apiRequest } from '@/lib/api/client';

/**
 * `GET /masters/vouchers`, `/masters/vouchers/:id` and `/masters/voucher-types`
 * (Phase 6c). Amounts are strings end to end: Tally's figures, shown, never
 * computed on (D-01).
 *
 * Filtering and ordering are the server's, not this hook's. The register pages
 * at twenty-five, so a sort applied to the rows in hand would reorder a
 * twenty-fifth of the register and read as wrong.
 */

export const voucherSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  date: z.string(),
  voucherType: z.string(),
  voucherNumber: z.string(),
  partyName: z.string(),
  partyId: z.string().nullable(),
  narration: z.string(),
  isCancelled: z.boolean(),
  amount: z.string(),
  lastPulledAt: z.string(),
  reference: z.string().nullish(),
  referenceDate: z.string().nullish(),
  orderRef: z.string().nullish(),
  buyerOrderNumber: z.string().nullish(),
  buyerOrderDate: z.string().nullish(),
  paymentTerms: z.string().nullish(),
  deliveryTerms: z.string().nullish(),
  dispatchedThrough: z.string().nullish(),
  dispatchDocNo: z.string().nullish(),
  vehicleNumber: z.string().nullish(),
  destination: z.string().nullish(),
  buyerName: z.string().nullish(),
  buyerAddress: z.string().nullish(),
  partyGstin: z.string().nullish(),
  partyState: z.string().nullish(),
  placeOfSupply: z.string().nullish(),
  consigneeName: z.string().nullish(),
  consigneeState: z.string().nullish(),
  consigneePincode: z.string().nullish(),
  consigneeGstin: z.string().nullish(),
});

export type Voucher = z.infer<typeof voucherSchema>;

const voucherLineSchema = z.object({
  lineNo: z.number(),
  kind: z.enum(['ledger', 'inventory']),
  ledgerName: z.string().nullable(),
  isDeemedPositive: z.boolean().nullable(),
  stockItemName: z.string().nullable(),
  stockItemId: z.string().nullable(),
  actualQty: z.string().nullable(),
  billedQty: z.string().nullable(),
  rate: z.string().nullable(),
  amount: z.string(),
});

export type VoucherLine = z.infer<typeof voucherLineSchema>;

const voucherDetailSchema = voucherSchema.extend({ lines: z.array(voucherLineSchema) });

export type VoucherDetail = z.infer<typeof voucherDetailSchema>;

const vouchersResponseSchema = z.object({
  data: z.array(voucherSchema),
  meta: z.object({ page: z.number(), pageSize: z.number(), total: z.number() }),
});

export type VouchersResponse = z.infer<typeof vouchersResponseSchema>;

export interface VoucherFilters {
  page: number;
  q?: string;
  voucherType?: string;
  partyId?: string;
  from?: string;
  to?: string;
  includeCancelled?: boolean;
  /** `field` or `-field` from VOUCHER_SORT_FIELDS; omitted means newest first. */
  sort?: string;
  connectionId?: string;
}

function vouchersQuery(filters: VoucherFilters) {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: '25' });
  if (filters.q) params.set('q', filters.q);
  if (filters.voucherType) params.set('voucherType', filters.voucherType);
  if (filters.partyId) params.set('partyId', filters.partyId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.includeCancelled) params.set('includeCancelled', 'true');
  if (filters.sort) params.set('sort', filters.sort);
  if (filters.connectionId) params.set('connectionId', filters.connectionId);
  const key = params.toString();
  return {
    queryKey: ['masters', 'vouchers', key] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const body = await apiRequest<unknown>(`/masters/vouchers?${key}`, { signal });
      return parseOrThrow(vouchersResponseSchema, body, 'voucher list');
    },
  };
}

export function useVouchers(
  filters: VoucherFilters,
  options: { enabled?: boolean; prefetchNext?: boolean } = {},
): UseQueryResult<VouchersResponse, Error> {
  const enabled = options.enabled ?? true;
  const client = useQueryClient();
  const query = useQuery({
    enabled,
    ...vouchersQuery(filters),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  // See useParties: the register pre-loads the next page so paging is instant.
  const meta = query.data?.meta;
  const hasNext = meta !== undefined && meta.page * meta.pageSize < meta.total;
  const { page, q, voucherType, partyId, from, to, includeCancelled, sort, connectionId } = filters;
  useEffect(() => {
    if (!options.prefetchNext || !enabled || !hasNext) return;
    void client.prefetchQuery({
      ...vouchersQuery({
        page: page + 1,
        ...(q ? { q } : {}),
        ...(voucherType ? { voucherType } : {}),
        ...(partyId ? { partyId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(includeCancelled ? { includeCancelled } : {}),
        ...(sort ? { sort } : {}),
        ...(connectionId ? { connectionId } : {}),
      }),
      staleTime: 60_000,
    });
  }, [client, options.prefetchNext, enabled, hasNext, page, q, voucherType, partyId, from, to, includeCancelled, sort, connectionId]);

  return query;
}

export function useVoucher(
  id: string | null,
  options: { enabled?: boolean } = {},
): UseQueryResult<VoucherDetail, Error> {
  return useQuery({
    enabled: (options.enabled ?? true) && id !== null,
    queryKey: ['masters', 'vouchers', 'detail', id],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/masters/vouchers/${id ?? ''}`, { signal });
      return parseOrThrow(voucherDetailSchema, body, 'voucher');
    },
    staleTime: 60_000,
  });
}

const voucherTypeFacetSchema = z.object({ voucherType: z.string(), count: z.number() });

export type VoucherTypeFacet = z.infer<typeof voucherTypeFacetSchema>;

/**
 * The options for the register's type filter.
 *
 * Held for an hour rather than a minute: Tally's voucher types change when an
 * accountant configures a new one, which is a thing that happens a few times a
 * year, not a few times a session.
 */
export function useVoucherTypes(options: { enabled?: boolean } = {}): UseQueryResult<VoucherTypeFacet[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['masters', 'voucher-types'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/masters/voucher-types', { signal });
      return parseOrThrow(z.array(voucherTypeFacetSchema), body, 'voucher types');
    },
    staleTime: 60 * 60_000,
  });
}
