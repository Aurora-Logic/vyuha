import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { IssuePortalKeyInput, IssuedPortalKey, PortalKeyView, PortalView } from '@vyuha/shared';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { apiRequest, publicApiRequest } from '@/lib/api/client';

/** Area AL. The customer's side asks without a token; the staff side is ordinary. */

const PORTAL_KEY = ['portal'] as const;

export function usePortal(key: string): UseQueryResult<PortalView, Error> {
  return useQuery({
    queryKey: [...PORTAL_KEY, 'view', key],
    queryFn: ({ signal }) => publicApiRequest<PortalView>(`/portal/${encodeURIComponent(key)}`, { signal }),
    // A customer opening a link twice in a minute is reading, not polling.
    staleTime: 60_000,
    retry: false,
  });
}

export function usePortalMedia(key: string, fileId: string | null): UseQueryResult<{ url: string; expiresInSeconds: number }, Error> {
  return useQuery({
    enabled: fileId !== null,
    queryKey: [...PORTAL_KEY, 'media', key, fileId ?? ''],
    queryFn: ({ signal }) => publicApiRequest<{ url: string; expiresInSeconds: number }>(`/portal/${encodeURIComponent(key)}/media/${fileId ?? ''}`, { signal }),
    retry: false,
  });
}

export function usePortalKeys(partyId: string | null, options: { enabled?: boolean } = {}): UseQueryResult<readonly PortalKeyView[], Error> {
  const query = partyId === null ? '' : `?partyId=${partyId}`;
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [...PORTAL_KEY, 'keys', partyId ?? 'all'],
    queryFn: ({ signal }) => apiRequest<readonly PortalKeyView[]>(`/portal-links${query}`, { signal }),
  });
}

export function useIssuePortalKey(): UseMutationResult<IssuedPortalKey, Error, IssuePortalKeyInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input) => apiRequest<IssuedPortalKey>('/portal-links', { method: 'POST', body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: PORTAL_KEY }),
  });
}

export function useRevokePortalKey(): UseMutationResult<PortalKeyView, Error, { id: string; reason: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }) => apiRequest<PortalKeyView>(`/portal-links/${id}/revoke`, { method: 'POST', body: { reason } }),
    onSuccess: () => client.invalidateQueries({ queryKey: PORTAL_KEY }),
  });
}
