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
