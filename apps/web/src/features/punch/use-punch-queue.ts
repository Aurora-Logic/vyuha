import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import {
  dismissRefused,
  drainOutbox,
  getOutboxSnapshot,
  queuePunch,
  refreshOutbox,
  subscribeToOutbox,
  type OutboxSnapshot,
} from '@/lib/offline/outbox';
import type { NewQueuedPunch, QueuedPunch } from '@/lib/offline/punch-queue';

import { useOnline } from './use-online';

/**
 * The punch screen's binding to the offline queue (REQ-D-10).
 *
 * Thin on purpose. Every rule about what happens to a queued punch lives in
 * `lib/offline`, where it can be tested without a browser; this file decides
 * only *when* to ask, and what to refetch afterwards.
 *
 * `useSyncExternalStore` rather than state plus an effect: the queue is mutated
 * by a drain that outlives any one render, and polling it into React state
 * would be a second copy of the truth that can disagree with the first.
 */

export interface PunchQueueView extends OutboxSnapshot {
  /** Sends now. Safe to press twice; drains are serialised. */
  retry: () => void;
  /** Forgets a punch the server refused, after the person has read why. */
  dismiss: (idempotencyKey: string) => void;
  /** Stores a punch that could not be sent. Resolves once it is durable. */
  queue: (draft: Omit<NewQueuedPunch, 'owner'>) => Promise<QueuedPunch>;
}

export function usePunchQueue(): PunchQueueView {
  const online = useOnline();
  const queryClient = useQueryClient();
  const snapshot = useSyncExternalStore(subscribeToOutbox, getOutboxSnapshot, getOutboxSnapshot);

  useEffect(() => {
    void refreshOutbox();
  }, []);

  const drain = useCallback(async (): Promise<void> => {
    const result = await drainOutbox();
    if (result && result.accepted > 0) {
      // A punch that has landed changes what the next one may be and changes
      // today's derived day, so both are refetched from the server rather than
      // patched from the sync report. The report is a receipt, not a read model.
      await queryClient.invalidateQueries({ queryKey: ['me', 'today'] });
      await queryClient.invalidateQueries({ queryKey: ['attendance'] });
    }
  }, [queryClient]);

  const waitingCount = snapshot.waiting.length;

  /**
   * Drains on open and whenever the connection returns.
   *
   * Keyed on the count rather than on the array, so a failed drain — which
   * changes the snapshot but not the count — does not re-trigger this and spin
   * against a server that is down. The next `online` event or the Sync now
   * button is what tries again.
   */
  useEffect(() => {
    if (!online || waitingCount === 0) return;
    void drain();
  }, [online, waitingCount, drain]);

  return {
    ...snapshot,
    retry: () => {
      void drain();
    },
    dismiss: (idempotencyKey: string) => {
      void dismissRefused(idempotencyKey);
    },
    queue: queuePunch,
  };
}
