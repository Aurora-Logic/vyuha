import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '@/lib/api/client';
import { parseOrThrow } from '@/lib/api/parse';

/**
 * A short-lived link to one attachment.
 *
 * Its own module rather than living beside the panel that first needed it: the
 * task gallery leads its cards with the same picture and must reach it the
 * same way. Two implementations would be two caches and two chances to hold a
 * URL past its lifetime.
 */

const signedUrlSchema = z.object({ url: z.url(), expiresInSeconds: z.number() });

/**
 * Under the five-minute URL TTL, so a cached link is never a dead one — the
 * same bound `punch-photo.ts` keeps, for the same reason.
 */
const SIGNED_URL_STALE_MS = 4 * 60_000;

export function useAttachmentUrl(
  basePath: string,
  attachmentId: string,
  enabled: boolean,
): UseQueryResult<string, Error> {
  return useQuery({
    enabled,
    queryKey: ['attachment-url', basePath, attachmentId],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`${basePath}/${attachmentId}/url`, { signal });
      return parseOrThrow(signedUrlSchema, body, 'attachment link').url;
    },
    staleTime: SIGNED_URL_STALE_MS,
    gcTime: SIGNED_URL_STALE_MS,
    retry: false,
  });
}

/** The same link, fetched once for a click rather than held in a cache. */
export async function attachmentUrlOnce(basePath: string, attachmentId: string): Promise<string> {
  const body = await apiRequest<unknown>(`${basePath}/${attachmentId}/url`);
  return parseOrThrow(signedUrlSchema, body, 'attachment link').url;
}
