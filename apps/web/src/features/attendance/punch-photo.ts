import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '@/lib/api/client';
import { parseOrThrow } from '@/lib/api/parse';

/**
 * REQ-D-03a and NFR-09: a punch photo is reached through a short-lived
 * signed URL, and a list loads the thumbnail. `variant: 'full'` is a
 * separate hook call the viewer makes only when the reader asks for the
 * full image, so the expensive object is never fetched by a table. Owned by
 * attendance since the reports module's removal -- the punch feed is where
 * the photo is read.
 */

const signedPhotoSchema = z.object({
  url: z.url(),
  expiresInSeconds: z.number(),
});

/** Under the 5-minute URL TTL, so a cached URL is never a dead one. */
const SIGNED_URL_STALE_MS = 4 * 60_000;

export function usePunchPhoto(
  punchId: string | null,
  variant: 'thumbnail' | 'full',
  enabled: boolean,
): UseQueryResult<string, Error> {
  return useQuery({
    enabled: enabled && punchId !== null,
    queryKey: ['punches', 'photo', punchId ?? 'none', variant],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/punches/${punchId ?? ''}/photo?variant=${variant}`, {
        signal,
      });
      return parseOrThrow(signedPhotoSchema, body, 'punch photo').url;
    },
    staleTime: SIGNED_URL_STALE_MS,
    gcTime: SIGNED_URL_STALE_MS,
    retry: false,
  });
}
