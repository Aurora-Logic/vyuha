import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { isUnbuiltEndpoint, parseOrThrow, type Sampled } from '@/features/attendance/api';
import { apiRequest } from '@/lib/api/client';

import {
  orgSettingsSchema,
  testEmailResultSchema,
  type OrgSettings,
  type SettingsPatch,
  type TestEmailResult,
} from './types';

/**
 * `GET/PUT /settings` and the test send (REQ-L-01 to REQ-L-05).
 *
 * The read falls back to a sample payload in development when the endpoint is
 * not deployed, and says so on the page. The two writes do not: pretending a
 * policy was saved when no server heard about it is exactly the lie the notice
 * exists to prevent, so a failed save reports the failure and the form keeps
 * the edits.
 */

export const SETTINGS_QUERY_KEY = ['settings'] as const;

async function loadSample(): Promise<OrgSettings | null> {
  if (!import.meta.env.DEV) return null;
  const module = await import('./sample');
  return module.sampleSettings();
}

export function useSettings(
  options: { enabled?: boolean } = {},
): UseQueryResult<Sampled<OrgSettings>, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      try {
        const body = await apiRequest<unknown>('/settings', { signal });
        return { value: parseOrThrow(orgSettingsSchema, body, 'settings'), sample: false };
      } catch (error) {
        // The whole fallback is these four lines. Delete them when the
        // endpoint is deployed; nothing above or below changes.
        if (isUnbuiltEndpoint(error)) {
          const sample = await loadSample();
          if (sample) return { value: sample, sample: true };
        }
        throw error;
      }
    },
    // Settings change a few times a year and every screen derives its date
    // format from them, so refetching on every mount is noise.
    staleTime: 5 * 60_000,
  });
}

export function useSaveSettings(): UseMutationResult<OrgSettings, Error, SettingsPatch> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (patch: SettingsPatch) => {
      const body = await apiRequest<unknown>('/settings', { method: 'PATCH', body: patch });
      return parseOrThrow(orgSettingsSchema, body, 'saved settings');
    },
    onSuccess: (saved) => {
      // Written straight into the cache rather than only invalidated: the
      // response is the authoritative post-write state, and refetching would
      // briefly render the pre-save values again.
      queryClient.setQueryData<Sampled<OrgSettings>>(SETTINGS_QUERY_KEY, {
        value: saved,
        sample: false,
      });
      // This screen writes ten policy groups, and they are read back through
      // caches that have nothing to do with each other: derived attendance
      // days, the shell's branding (the number format and currency symbol are
      // module-level state), the return-reason list. Naming them was a list
      // that rotted -- branding was the third key to be forgotten. A save
      // happens a few times a year and an unfiltered invalidation refetches
      // only what is actually mounted, which is the cheaper mistake.
      void queryClient.invalidateQueries();
    },
  });
}

export function useTestEmail(): UseMutationResult<TestEmailResult, Error, void> {
  return useMutation({
    mutationFn: async () => {
      const body = await apiRequest<unknown>('/settings/email/test', { method: 'POST' });
      return parseOrThrow(testEmailResultSchema, body, 'test message result');
    },
  });
}
