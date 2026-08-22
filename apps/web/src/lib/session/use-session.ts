import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { ALL_PERMISSIONS, isMfaChallenge, type MfaChallengeResponse, type MfaSummary, type PermissionKey } from '@vyuha/shared';

import {
  ApiError,
  apiRequest,
  getAccessToken,
  refreshAccessToken,
  setAccessToken,
} from '@/lib/api/client';

/**
 * Mirrors MeResponse in apps/api/src/platform/auth/auth.dto.ts. Technical
 * design §10: "`/me` returns the effective permission set", and the client
 * decides what to render from it and nothing else.
 */
export interface Me {
  user: { id: string; email: string; status: string; employeeId: string | null };
  employee: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string | null;
    departmentId: string | null;
    locationId: string | null;
    reportingManagerId: string | null;
  } | null;
  roles: { id: string; name: string }[];
  permissions: PermissionKey[];
  /** 12 REQ-AB-05: when today's sign-in window closes, so the shell can warn fifteen minutes ahead. Absent on a snapshot from before it existed. */
  accessWindow?: { closesInMinutes: number | null; exempt: boolean };
  /** REQ-B-09: absent on a snapshot from before it existed; treated as not required. */
  mfa?: MfaSummary;
}

interface LoginResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
  user: { id: string; email: string };
}

export const SESSION_QUERY_KEY = ['session', 'me'] as const;

/**
 * The last `Me` the server actually returned, so an offline reload can keep
 * rendering the shell instead of a sign-in form - the moment that matters is
 * a punch queued on a dead connection, which must stay visible (REQ-D-10).
 *
 * No token is stored here, ever - the rules in client.ts stand. This is the
 * server's own last answer about what to render, it grants nothing (every
 * endpoint enforces for itself), and it is cleared the moment the server says
 * the session is over, or on sign-out.
 */
const LAST_ME_KEY = 'vyuha.session.me';

const meSnapshotSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    status: z.string(),
    employeeId: z.string().nullable(),
  }),
  employee: z
    .object({
      id: z.string(),
      employeeCode: z.string(),
      firstName: z.string(),
      lastName: z.string().nullable(),
      departmentId: z.string().nullable(),
      locationId: z.string().nullable(),
      reportingManagerId: z.string().nullable(),
    })
    .nullable(),
  roles: z.array(z.object({ id: z.string(), name: z.string() })),
  // Unknown keys are dropped rather than failing the parse: the set is
  // cosmetic, and a snapshot written before a permission was renamed must not
  // un-render the shell.
  permissions: z
    .array(z.string())
    .transform((values) =>
      values.filter((value): value is PermissionKey =>
        (ALL_PERMISSIONS as readonly string[]).includes(value),
      ),
    ),
  accessWindow: z.object({ closesInMinutes: z.number().nullable(), exempt: z.boolean() }).optional(),
});

// localStorage can be denied outright (privacy modes). Each helper treats
// that as "no snapshot": the offline shell is then unavailable, which is the
// pre-existing behaviour, not an error worth surfacing.
function rememberMe(me: Me): void {
  try {
    localStorage.setItem(LAST_ME_KEY, JSON.stringify(me));
  } catch {
    // Handled: without storage there is simply nothing to restore offline.
  }
}

function forgetMe(): void {
  try {
    localStorage.removeItem(LAST_ME_KEY);
  } catch {
    // Handled: if storage is denied, nothing was remembered either.
  }
}

function lastKnownMe(): Me | null {
  try {
    const raw = localStorage.getItem(LAST_ME_KEY);
    if (raw === null) return null;
    const parsed = meSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // Corrupt JSON or denied storage both mean the same thing: no snapshot.
    return null;
  }
}

/**
 * Resolves the current session.
 *
 * On a cold load there is no access token in memory - it deliberately does not
 * survive the tab - but the refresh cookie may still be valid, so this tries
 * to exchange it before deciding the visitor is anonymous. Without that step a
 * page refresh would look identical to signing out.
 *
 * `null` means anonymous and is a normal answer, not an error, so a 401 here
 * must not be retried or surfaced as a failure.
 *
 * "The server said no" and "the server never answered" are different answers.
 * On a network failure the last known session is restored from its snapshot,
 * so an offline reload keeps the shell - and the punch queue behind it -
 * on screen; the next request that reaches the server reconciles truthfully.
 * A real 401 still signs out, and also deletes the snapshot.
 */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => {
      // Refresh first when there is no token in memory, rather than calling
      // /auth/me and letting it fail. On a cold load that call cannot succeed
      // - there is nothing to authenticate with - so making it anyway put a
      // guaranteed 401 in the console on every single page load, which is both
      // noise and a real request the server has to answer.
      if (!getAccessToken()) {
        const outcome = await refreshAccessToken();
        if (outcome === 'network-error') return lastKnownMe();
        if (outcome !== 'refreshed') {
          forgetMe();
          return null;
        }
      }

      try {
        const me = await apiRequest<Me>('/auth/me');
        rememberMe(me);
        return me;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'NETWORK_ERROR') return lastKnownMe();
        forgetMe();
        return null;
      }
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
    // Kept for the ordinary case - a tab that was open when the connection
    // dropped. It is not what makes the guarantee, though; see
    // `useRevalidateSessionOnReconnect` below for the case it cannot cover.
    refetchOnReconnect: 'always',
  });
}

/**
 * Re-asks the server who this is the moment the connection returns.
 *
 * An offline restore must not be the final word. A document loaded from the
 * service worker renders the shell from the `Me` snapshot, and until something
 * reaches the server that shell is a memory, not a fact: the session behind it
 * may have been revoked - a sign-out elsewhere, an administrator ending it, a
 * password change - and a revoked session that keeps showing a working app is
 * a security problem, not a cosmetic one.
 *
 * `refetchOnReconnect: 'always'` above promises exactly this and does not
 * deliver it on the one document that needs it most. TanStack Query decides
 * "reconnected" from `onlineManager`, whose state starts at `true` and is
 * never seeded from `navigator.onLine` (query-core 5.101.4,
 * `onlineManager.ts`: `#online = true`). A document that *loads* offline sees
 * no `offline` event - there was no transition, it was already offline - so
 * the manager still reads online, and the later `online` event moves nothing
 * and notifies nobody. Measured on a document restored from the snapshot after
 * an offline reload: zero requests of any kind in the ten seconds after the
 * connection came back, while every session in the database was revoked and
 * the tab kept the whole app shell.
 *
 * So the rule is bound to the browser's own event rather than to a derived
 * one. `refetchQueries` and not `invalidateQueries`: the restored answer still
 * looks fresh, and invalidation only marks it stale - nothing would be
 * fetched until something happened to observe it again.
 */
export function useRevalidateSessionOnReconnect(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const revalidate = (): void => {
      void queryClient.refetchQueries({ queryKey: SESSION_QUERY_KEY });
    };
    window.addEventListener('online', revalidate);
    return () => {
      window.removeEventListener('online', revalidate);
    };
  }, [queryClient]);
}

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { email: string; password: string }) => {
      const result = await apiRequest<LoginResponse | MfaChallengeResponse>('/auth/login', {
        method: 'POST',
        body: input,
        // A 401 from this endpoint is the verdict on the typed password, not a
        // stale token. Without this, the client's refresh-and-retry replayed
        // the same wrong password - observed as login 401, refresh 200, login
        // 401 - burning two of REQ-B-10's five lockout attempts per typo.
        skipRefresh: true,
      });
      // REQ-B-09: a challenge carries no token; the code step does.
      if (!isMfaChallenge(result)) setAccessToken(result.accessToken);
      return result;
    },
    onSuccess: async (result) => {
      if (isMfaChallenge(result)) return;
      // Refetch rather than write a guess into the cache: the permission set
      // is the server's answer, and inventing it here is how a client ends up
      // rendering controls the API will refuse.
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await apiRequest<void>('/auth/logout', { method: 'POST' });
    },
    /*
     * `onSettled`, not `onSuccess`. The intent was always that local state
     * goes whether or not the server answered -- a logout that leaves the
     * session on screen because the network blipped is worse than one whose
     * revocation has to be retried -- but only the access token was in the
     * `finally`. `forgetMe`, the cached session and the query cache all sat
     * in `onSuccess`, which does not run when the mutation rejects. So a
     * logout that met a 502, or a dropped connection, cleared the one thing
     * held in memory and left the identity snapshot, the cached session and
     * the httpOnly refresh cookie exactly where they were: the next request
     * exchanged the cookie and the user was signed straight back in, on a
     * shared machine, having watched themselves sign out.
     *
     * The refresh cookie is the server's to revoke and cannot be cleared from
     * here, so the local teardown is what has to be unconditional.
     */
    onSettled: () => {
      setAccessToken(null);
      forgetMe();
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      queryClient.clear();
    },
  });
}
