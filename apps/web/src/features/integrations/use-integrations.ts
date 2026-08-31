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

import {
  integrationsResponseSchema,
  syncExceptionsResponseSchema,
  type IntegrationsResponse,
  type SyncException,
} from './types';

/**
 * `GET /integrations` and its two writes (technical design §14, Phase 6b).
 *
 * The sample-data fallback that stood here is gone, and its removal is the
 * point. There was no controller behind this path at all, so the screen showed
 * an invented Tally connection in development and an error in production — and
 * the invented one was the more dangerous of the two, because it looked like an
 * answer.
 *
 * The mutation hooks exist now because the credential machinery finally does:
 * Phase 6b built minting, so a button can stand behind a real endpoint.
 */
export function useIntegrations(
  options: { enabled?: boolean } = {},
): UseQueryResult<IntegrationsResponse, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['integrations', 'list'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/integrations', { signal });
      return parseOrThrow(integrationsResponseSchema, body, 'integration list');
    },
    // A heartbeat lands every few minutes; nothing here needs a live poll, and
    // the reader can refresh when they are actually watching for one.
    staleTime: 60_000,
  });
}

export interface CreateConnectionVariables {
  name: string;
  companyName?: string;
  companyGuid?: string;
}

export function useCreateConnection(): UseMutationResult<
  unknown,
  Error,
  CreateConnectionVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateConnectionVariables) =>
      apiRequest<unknown>('/integrations', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}

const issuedTokenSchema = z.object({
  connectionId: z.string(),
  token: z.string(),
});

export type IssuedToken = z.infer<typeof issuedTokenSchema>;

export function useIssueToken(): UseMutationResult<IssuedToken, Error, { connectionId: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ connectionId }) => {
      const body = await apiRequest<unknown>(`/integrations/${connectionId}/token`, {
        method: 'POST',
      });
      return parseOrThrow(issuedTokenSchema, body, 'issued agent token');
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}

const queuedPullSchema = z.object({
  jobId: z.string(),
  /** True when the press found an open job rather than creating one. */
  alreadyQueued: z.boolean(),
});

export type QueuedPull = z.infer<typeof queuedPullSchema>;

const FULL_PULL_TYPES = ['party', 'stock_item', 'price_list', 'bill_allocation'] as const;

/**
 * REQ-R-07's manual half. The server holds the one-open-job invariant, so a
 * second press answers the existing job instead of erroring — the screen's
 * only duty is to say which of the two happened.
 */
export function usePullNow(): UseMutationResult<
  { queued: number; alreadyQueued: number },
  Error,
  { connectionId: string }
> {
  return useMutation({
    mutationFn: async ({ connectionId }) => {
      // Every writable type, in dependency order (items before their prices);
      // a press that queued only parties left stock and prices to the sweep.
      let queued = 0;
      let alreadyQueued = 0;
      for (const entityType of FULL_PULL_TYPES) {
        const body = await apiRequest<unknown>(`/integrations/${connectionId}/pull`, {
          method: 'POST',
          body: { entityType },
        });
        const ack = parseOrThrow(queuedPullSchema, body, 'queued pull');
        if (ack.alreadyQueued) alreadyQueued += 1;
        else queued += 1;
      }
      return { queued, alreadyQueued };
    },
  });
}

const webhookSecretSetSchema = z.object({
  connectionId: z.string(),
  /** The URL to paste into OpsTally's settings — the other half of the handshake. */
  webhookUrl: z.string(),
});

export type WebhookSecretSet = z.infer<typeof webhookSecretSetSchema>;

/**
 * The OpsTally handshake, Vyuha's half: store the whsec_ secret the Agent
 * generated; the answer is the URL the Agent needs. Replacing it later
 * re-binds the connection to whichever install signs with the new one.
 */
export function useSetWebhookSecret(): UseMutationResult<
  WebhookSecretSet,
  Error,
  { connectionId: string; secret: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ connectionId, secret }) => {
      const body = await apiRequest<unknown>(`/integrations/${connectionId}/webhook-secret`, {
        method: 'PUT',
        body: { secret },
      });
      return parseOrThrow(webhookSecretSetSchema, body, 'webhook secret');
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}

/**
 * REQ-R-05: the explicit administrative re-pull — every master entity type,
 * from the beginning, with cursors reset server-side and REQ-R-06's absence
 * marking licensed. Sequential rather than parallel so items still land
 * before the prices that reference them.
 */
export function useFullRePull(): UseMutationResult<
  { queued: number },
  Error,
  { connectionId: string }
> {
  return useMutation({
    mutationFn: async ({ connectionId }) => {
      let queued = 0;
      for (const entityType of FULL_PULL_TYPES) {
        await apiRequest<unknown>(`/integrations/${connectionId}/pull`, {
          method: 'POST',
          body: { entityType, full: true },
        });
        queued += 1;
      }
      return { queued };
    },
  });
}

/** REQ-T-01: what still owes a person a look. */
export function useSyncExceptions(
  options: { enabled?: boolean } = {},
): UseQueryResult<{ data: SyncException[] }, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['integrations', 'exceptions'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/integrations/exceptions', { signal });
      return parseOrThrow(syncExceptionsResponseSchema, body, 'sync exceptions');
    },
    staleTime: 60_000,
  });
}

export function useResolveException(): UseMutationResult<
  unknown,
  Error,
  { exceptionId: string; note: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ exceptionId, note }) =>
      apiRequest<unknown>(`/integrations/exceptions/${exceptionId}/resolve`, {
        method: 'POST',
        body: { note },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['integrations', 'exceptions'] });
    },
  });
}
