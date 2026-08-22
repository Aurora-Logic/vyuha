import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { documentSettingsSchema, type DocumentSettings } from '@vyuha/shared';

import { z } from 'zod';

import { apiRequest } from '@/lib/api/client';
import { parseOrThrow } from '@/lib/api/parse';
import { postMultipart } from '@/lib/offline/multipart';

const KEY = ['documents', 'settings'] as const;

/** The printed page's identity and designs — every document screen reads it, the design rail writes it. */
export function useDocumentSettings(options: { enabled?: boolean } = {}): UseQueryResult<DocumentSettings, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: KEY,
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/documents/settings', { signal });
      return parseOrThrow(documentSettingsSchema, body, 'document settings');
    },
    // Comfortably inside the server's signing TTL (S3_SIGNED_URL_TTL_SECONDS,
    // 300s by default) rather than equal to it: at parity a cached URL could
    // be handed to an <img> in the last moment of its life, and a letterhead
    // that fails to load on a printed document has no error state -- the
    // paper simply goes out without the mark.
    staleTime: 4 * 60_000,
  });
}

export function useSaveDocumentSettings(): UseMutationResult<DocumentSettings, Error, DocumentSettings> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input) => {
      const response = await apiRequest<unknown>('/documents/settings', { method: 'PUT', body: input });
      return parseOrThrow(documentSettingsSchema, response, 'document settings');
    },
    onSuccess: (saved) => {
      client.setQueryData(KEY, saved);
    },
  });
}

const logoUrlSchema = z.object({ url: z.string(), expiresInSeconds: z.number() });

/** Signed URLs for the footer logos named in the profile, minted when a paper opens; they expire, so no long stale time. */
export function useFooterLogoUrls(fileIds: readonly string[]): readonly string[] {
  const key = fileIds.join(',');
  const query = useQuery({
    enabled: fileIds.length > 0,
    queryKey: ['documents', 'logo-urls', key],
    queryFn: async ({ signal }) => {
      const urls = await Promise.all(
        fileIds.map(async (fileId) => {
          const body = await apiRequest<unknown>(`/documents/logos/${fileId}/url`, { signal });
          return parseOrThrow(logoUrlSchema, body, 'logo url').url;
        }),
      );
      return urls;
    },
    staleTime: 5 * 60_000,
  });
  return query.data ?? [];
}

/** One footer logo up (multipart part "logo"); the caller adds the id to the profile and saves. */
export function useUploadFooterLogo(): UseMutationResult<{ fileId: string; url: string }, Error, Blob> {
  return useMutation({
    mutationFn: async (blob: Blob) => {
      const form = new FormData();
      form.append('logo', blob, 'logo.png');
      return postMultipart('/documents/logos', form, (body) => parseOrThrow(logoUrlSchema.extend({ fileId: z.string() }), body, 'uploaded logo'));
    },
  });
}
