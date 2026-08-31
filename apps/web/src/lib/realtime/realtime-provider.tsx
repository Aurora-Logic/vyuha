import { useQueryClient } from '@tanstack/react-query';
import {
  PRESENCE_HEARTBEAT_MS,
  type RealtimeResource,
  type RealtimeViewer,
} from '@vyuha/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { apiRequest, ensureAccessToken, getAccessToken } from '@/lib/api/client';
import { useMe } from '@/lib/session/use-session';

import { drainFrames, invalidationsFor, presenceKey, presenceMapOf, retryDelayMs, type PresenceMap } from './realtime-store';

/**
 * One live connection for the whole app.
 *
 * One, not one per screen: a browser allows a small number of concurrent
 * connections per origin, and a stream held open by every mounted list would
 * spend them all and stall ordinary requests. The provider sits above the
 * router, so moving between screens never drops and re-opens it.
 *
 * The connection is deliberately silent about failure. A live update is an
 * improvement on the polling this app already does, never a precondition for
 * it: if the stream cannot connect, every screen still works exactly as it
 * did before, and a toast saying "live updates unavailable" would be noise
 * about something the reader cannot act on.
 */

interface RealtimeContextValue {
  /** Everyone currently in a record, keyed `resource:recordId`. */
  readonly presence: PresenceMap;
  /** "I am looking at this record." Pass null on leaving. */
  readonly announce: (resource: RealtimeResource, recordId: string | null) => void;
}

const EMPTY_PRESENCE: PresenceMap = new Map();

const RealtimeContext = createContext<RealtimeContextValue>({
  presence: EMPTY_PRESENCE,
  announce: () => undefined,
});

const BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000/api/v1';

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const { data: me } = useMe();
  const [presence, setPresence] = useState<PresenceMap>(() => new Map());
  const userId = me?.user.id ?? null;

  /**
   * What this browser currently has open, so a reconnect can say it again.
   * A ref rather than state: changing it must not re-render every screen
   * under the provider, and the heartbeat reads it on a timer.
   */
  const openRecord = useRef<{ resource: RealtimeResource; recordId: string | null }>({
    resource: 'crm.deal',
    recordId: null,
  });

  const announce = useCallback((resource: RealtimeResource, recordId: string | null) => {
    openRecord.current = { resource, recordId };
    void apiRequest('/realtime/presence', { method: 'POST', body: { resource, recordId } }).catch(() => {
      // Presence is a nicety. A failed heartbeat costs an avatar, and the
      // next one is fifteen seconds away.
    });
  }, []);

  useEffect(() => {
    // Signed out is not a state to write, it is a state to derive: the value
    // below reads empty whenever there is nobody to have a stream for.
    if (userId === null) return;

    const abort = new AbortController();
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    async function connect(): Promise<void> {
      // The token lives in memory and is gone after a reload, so the cookie
      // is exchanged first -- otherwise the very first connection after a
      // refresh is a 401 and the user waits out a retry for no reason.
      if (getAccessToken() === null) await ensureAccessToken();
      const token = getAccessToken();
      if (token === null) throw new Error('not signed in');

      const response = await fetch(`${BASE_URL}/realtime/stream`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        credentials: 'include',
        signal: abort.signal,
      });
      if (!response.ok || response.body === null) throw new Error(`stream refused: ${response.status}`);

      attempt = 0;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const { events, rest } = drainFrames(buffer);
        buffer = rest;
        for (const event of events) {
          if (event.kind === 'presence') {
            setPresence(presenceMapOf(event.records));
            continue;
          }
          if (event.kind === 'ready') {
            // A reconnect means time passed with nobody listening, so
            // everything cached may have moved on underneath.
            void client.invalidateQueries({ queryKey: ['crm'] });
            void client.invalidateQueries({ queryKey: ['tasks'] });
            if (openRecord.current.recordId !== null) {
              announce(openRecord.current.resource, openRecord.current.recordId);
            }
            continue;
          }
          // Your own writes already updated your cache the moment they
          // returned; refetching them again would flash a spinner over data
          // that is right.
          if (event.actorUserId === userId) continue;
          for (const queryKey of invalidationsFor(event.resource)) {
            void client.invalidateQueries({ queryKey: [...queryKey] });
          }
        }
      }
    }

    function schedule(): void {
      if (stopped) return;
      attempt += 1;
      retryTimer = setTimeout(() => {
        void run();
      }, retryDelayMs(attempt));
    }

    async function run(): Promise<void> {
      try {
        await connect();
      } catch {
        // Every failure is the same failure from here: try again later.
      }
      // A stream that ends cleanly is still a stream that ended -- a proxy
      // timing it out looks exactly like this - so reconnect either way.
      schedule();
    }

    void run();

    const heartbeat = setInterval(() => {
      if (openRecord.current.recordId === null) return;
      announce(openRecord.current.resource, openRecord.current.recordId);
    }, PRESENCE_HEARTBEAT_MS);

    return () => {
      stopped = true;
      clearInterval(heartbeat);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      abort.abort();
    };
  }, [userId, client, announce]);

  const value = useMemo<RealtimeContextValue>(
    () => (userId === null ? { presence: EMPTY_PRESENCE, announce } : { presence, announce }),
    [userId, presence, announce],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

/**
 * Who else is in this record, excluding you -- your own avatar beside a
 * record you are looking at tells you nothing you did not know.
 */
export function useRecordViewers(resource: RealtimeResource, recordId: string | null): readonly RealtimeViewer[] {
  const { presence } = useContext(RealtimeContext);
  const { data: me } = useMe();
  const myId = me?.user.id ?? null;
  return useMemo(() => {
    if (recordId === null) return [];
    const viewers = presence.get(presenceKey(resource, recordId)) ?? [];
    return viewers.filter((viewer) => viewer.userId !== myId);
  }, [presence, resource, recordId, myId]);
}

/**
 * Say that this screen has a record open, for as long as it is mounted.
 * Closing a sheet clears it at once rather than leaving a stale avatar on a
 * colleague's screen until the entry expires.
 */
export function usePresence(resource: RealtimeResource, recordId: string | null): void {
  const { announce } = useContext(RealtimeContext);
  useEffect(() => {
    if (recordId === null) return;
    announce(resource, recordId);
    return () => {
      announce(resource, null);
    };
  }, [announce, resource, recordId]);
}
