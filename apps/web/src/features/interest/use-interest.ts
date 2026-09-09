import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { parseOrThrow } from '@/lib/api/parse';
import { apiRequest } from '@/lib/api/client';

/**
 * `GET/PUT/DELETE /interest/party-settings` (D-22).
 *
 * The overrides exist because `parties` is a Tally projection with no
 * application write path: Tally's credit_days is read where present, a
 * Vyuha-side row here beats it, and a party with neither is flagged rather
 * than silently given 30. No sample fallback: an invented override would
 * show a rate nobody is being charged.
 */

export const interestPartySettingSchema = z.object({
  partyId: z.string(),
  partyName: z.string(),
  parentGroup: z.string(),
  tallyCreditDays: z.number().nullable(),
  creditDaysOverride: z.number().nullable(),
  /** Percent per annum to two decimals, or null for the org rate. */
  interestRateOverride: z.string().nullable(),
  creditTermsMissing: z.boolean(),
});

export type InterestPartySetting = z.infer<typeof interestPartySettingSchema>;

const listSchema = z.array(interestPartySettingSchema);

const PARTY_SETTINGS_KEY = ['interest', 'party-settings'] as const;

export function useInterestPartySettings(
  options: { enabled?: boolean } = {},
): UseQueryResult<InterestPartySetting[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: PARTY_SETTINGS_KEY,
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/interest/party-settings', { signal });
      return parseOrThrow(listSchema, body, 'interest party settings');
    },
  });
}

export interface UpsertPartySettingInput {
  partyId: string;
  /** Null clears the override back to the org rate; both keys always travel. */
  interestRateOverride: number | null;
  creditDaysOverride: number | null;
}

export function useUpsertPartySetting(): UseMutationResult<
  InterestPartySetting,
  Error,
  UpsertPartySettingInput
> {
  return useInvalidating(async ({ partyId, ...input }: UpsertPartySettingInput) => {
    const body = await apiRequest<unknown>(`/interest/party-settings/${partyId}`, {
      method: 'PUT',
      body: input,
    });
    return parseOrThrow(interestPartySettingSchema, body, 'saved override');
  });
}

export function useRemovePartySetting(): UseMutationResult<InterestPartySetting, Error, string> {
  return useInvalidating(async (partyId: string) => {
    const body = await apiRequest<unknown>(`/interest/party-settings/${partyId}`, {
      method: 'DELETE',
    });
    return parseOrThrow(interestPartySettingSchema, body, 'removed override');
  });
}

/**
 * Both writes invalidate the report rows too: the party interest report
 * prices at read time from these very rows, so a figure already on screen is
 * answering a question the server would now answer differently.
 */
function useInvalidating<TInput>(
  mutationFn: (input: TInput) => Promise<InterestPartySetting>,
): UseMutationResult<InterestPartySetting, Error, TInput> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PARTY_SETTINGS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'rows'] });
    },
  });
}

// ------------------------------------------------------------- stock settings

export const stockInterestSettingSchema = z.object({
  id: z.string(),
  targetType: z.enum(['item', 'category', 'group']),
  targetId: z.string().nullable(),
  targetName: z.string(),
  interestRateOverride: z.string().nullable(),
  holdingPeriodDaysOverride: z.number().nullable(),
});

export type StockInterestSetting = z.infer<typeof stockInterestSettingSchema>;

const stockListSchema = z.array(stockInterestSettingSchema);

export const STOCK_SETTINGS_KEY = ['interest', 'stock-settings'] as const;

export function useStockInterestSettings(
  options: { enabled?: boolean } = {},
): UseQueryResult<StockInterestSetting[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: STOCK_SETTINGS_KEY,
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/interest/stock-settings', { signal });
      return parseOrThrow(stockListSchema, body, 'stock interest settings');
    },
  });
}

export interface UpsertStockSettingInput {
  targetType: 'item' | 'category' | 'group';
  targetId?: string | null;
  targetName: string;
  interestRateOverride?: number | null;
  holdingPeriodDaysOverride?: number | null;
}

export function useUpsertStockSetting(): UseMutationResult<
  StockInterestSetting,
  Error,
  UpsertStockSettingInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpsertStockSettingInput) => {
      const body = await apiRequest<unknown>('/interest/stock-settings', {
        method: 'PUT',
        body: input,
      });
      return parseOrThrow(stockInterestSettingSchema, body, 'saved stock override');
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STOCK_SETTINGS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['interest', 'stock-report'] });
    },
  });
}

export function useRemoveStockSetting(): UseMutationResult<StockInterestSetting, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const body = await apiRequest<unknown>(`/interest/stock-settings/${id}`, {
        method: 'DELETE',
      });
      return parseOrThrow(stockInterestSettingSchema, body, 'removed stock override');
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STOCK_SETTINGS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['interest', 'stock-report'] });
    },
  });
}

// ------------------------------------------------------------- stock report

export const stockInterestReportItemSchema = z.object({
  stockItemId: z.string(),
  stockItemName: z.string(),
  category: z.string().nullable(),
  parentGroup: z.string().nullable(),
  inwardDate: z.string(),
  quantity: z.number(),
  unit: z.string(),
  purchaseRate: z.string(),
  closingValue: z.string(),
  advanceAmount: z.string(),
  advanceTransitDays: z.number(),
  transitInterestAmount: z.string(),
  shelfDays: z.number(),
  holdingPeriodDays: z.number(),
  holdingInterestAmount: z.string(),
  totalInterestAmount: z.string(),
  isNonMoving: z.boolean(),
});

export type StockInterestReportItem = z.infer<typeof stockInterestReportItemSchema>;

export const stockInterestReportSummarySchema = z.object({
  totalStockValue: z.string(),
  fundedStockValue: z.string(),
  totalTransitInterest: z.string(),
  totalHoldingInterest: z.string(),
  totalAccumulatedInterest: z.string(),
  nonMovingItemsCount: z.number(),
  items: z.array(stockInterestReportItemSchema),
});

export type StockInterestReportSummary = z.infer<typeof stockInterestReportSummarySchema>;

export interface StockReportFilterParams {
  asOf?: string;
  category?: string;
  group?: string;
  isNonMoving?: boolean;
  search?: string;
}

export const STOCK_REPORT_KEY = ['interest', 'stock-report'] as const;

export function useStockInterestReport(
  params: StockReportFilterParams = {},
  options: { enabled?: boolean } = {},
): UseQueryResult<StockInterestReportSummary, Error> {
  const queryParams = new URLSearchParams();
  if (params.asOf) queryParams.set('asOf', params.asOf);
  if (params.category) queryParams.set('category', params.category);
  if (params.group) queryParams.set('group', params.group);
  if (params.isNonMoving !== undefined) queryParams.set('isNonMoving', String(params.isNonMoving));
  if (params.search) queryParams.set('search', params.search);

  const qs = queryParams.toString();
  const url = `/interest/stock-report${qs ? `?${qs}` : ''}`;

  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [...STOCK_REPORT_KEY, params],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(url, { signal });
      return parseOrThrow(stockInterestReportSummarySchema, body, 'stock interest report');
    },
  });
}

