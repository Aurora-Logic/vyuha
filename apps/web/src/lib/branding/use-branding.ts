import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { appearanceSchema, localeSchema } from '@vyuha/shared';
import { z } from 'zod';

import { parseOrThrow } from '@/features/attendance/api';
import { apiRequest } from '@/lib/api/client';
import { postMultipart } from '@/lib/offline/multipart';

/**
 * The organisation's name and logo, from the server (REQ-L-01, P0-7).
 *
 * This replaced a zustand store persisted to localStorage. The store worked,
 * and it was per-browser: the administrator who uploaded a logo was the only
 * person in the organisation who ever saw it. `GET /settings/branding` is
 * readable by anybody signed in, which is what makes the mark actually
 * organisation-wide.
 *
 * There is no sample fallback and no cached copy. A logo that failed to load is
 * a monogram, which is a perfectly good answer and the same one a brand-new
 * organisation gets.
 */

const brandingSchema = z.object({
  name: z.string(),
  logoUrl: z.string().nullable(),
  logoUrlExpiresInSeconds: z.number().nullable(),
  /** Absent on a server from before it existed; the shell then keeps the shipped theme. */
  appearance: appearanceSchema.optional(),
  /** Absent on a server from before it existed; figures then group the Indian way. */
  locale: localeSchema.optional(),
  /** Absent on a server from before it existed; dates then keep the shipped dd-MM-yyyy. */
  dateFormat: z.string().optional(),
});

export type Branding = z.infer<typeof brandingSchema>;

const BRANDING_KEY = ['branding'] as const;

/**
 * The signed URL expires -- five minutes by default -- so this refetches well
 * inside that window rather than caching a link that will 403 while the tab is
 * still open. The endpoint is one indexed row and one presign, so the cost is
 * nothing next to a sidebar with a broken image in it.
 */
const REFETCH_MS = 4 * 60_000;

export function useBranding(options: { enabled?: boolean } = {}): UseQueryResult<Branding, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: BRANDING_KEY,
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/settings/branding', { signal });
      return parseOrThrow(brandingSchema, body, 'organisation branding');
    },
    staleTime: REFETCH_MS,
    refetchInterval: REFETCH_MS,
    // A failed branding read must never take a screen with it: the shell
    // renders the monogram and everything else on the page still works.
    retry: 1,
  });
}

export function useUploadLogo(): UseMutationResult<Branding, Error, Blob> {
  return useBrandingMutation((blob: Blob) => {
    const form = new FormData();
    // The filename is cosmetic -- the server decides the type from the bytes --
    // but multer wants one, and a name that matches the content is less
    // confusing in a log than "blob".
    form.append('logo', blob, 'logo.png');
    return postMultipart('/settings/logo', form, (body) =>
      parseOrThrow(brandingSchema, body, 'organisation branding'),
    );
  });
}

export function useRemoveLogo(): UseMutationResult<Branding, Error, void> {
  return useBrandingMutation(async () => {
    const body = await apiRequest<unknown>('/settings/logo', { method: 'DELETE' });
    return parseOrThrow(brandingSchema, body, 'organisation branding');
  });
}

function useBrandingMutation<TInput>(
  mutationFn: (input: TInput) => Promise<Branding>,
): UseMutationResult<Branding, Error, TInput> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: (branding) => {
      // The response is the authoritative post-write state, so it is written
      // in rather than refetched -- otherwise the sidebar shows the old mark
      // for one more round trip after the toast has said it changed.
      queryClient.setQueryData<Branding>(BRANDING_KEY, branding);
      // The settings screen reads `logoKey` off the org profile, which has
      // just moved.
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['audit-logs'] });
    },
  });
}
