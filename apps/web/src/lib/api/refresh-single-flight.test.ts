import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { apiRequest, refreshAccessToken, setAccessToken } from './client';

/**
 * The refresh cookie is single-use and rotating, and the server reads a replay
 * as theft (REQ-B-05). Two refreshes started before either has landed present
 * the same cookie, so the second one revokes the session family and signs the
 * person out - with nothing wrong on the server.
 *
 * Measured in a production build before the guard: on reconnect after an
 * offline reload, `refresh 200 / sync 401 / refresh 401 / refresh 401`, family
 * revoked, the queued punch stranded. These tests hold the two properties that
 * stop it: only one exchange is ever in the air, and the slot re-opens once it
 * has landed so a genuinely expired token is still refreshable.
 */

interface Deferred {
  resolve: (value: Response) => void;
  promise: Promise<Response>;
}

function deferred(): Deferred {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Typed as returning a Promise, so a `mockImplementation` that returns one is
 * not read as an accidental floating promise.
 */
type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

let fetchMock: Mock<FetchLike>;

function requestedPaths(): string[] {
  return fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
}

beforeEach(() => {
  setAccessToken(null);
  fetchMock = vi.fn<FetchLike>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('refreshAccessToken is single-flight', () => {
  it('sends one POST /auth/refresh for concurrent callers and gives all of them its outcome', async () => {
    const inFlight = deferred();
    fetchMock.mockReturnValueOnce(inFlight.promise);

    const callers = [refreshAccessToken(), refreshAccessToken(), refreshAccessToken()];

    // Everything has asked before anything has answered - the exact window in
    // which a second request would carry the same cookie.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    inFlight.resolve(jsonResponse({ accessToken: 'token-1' }));

    expect(await Promise.all(callers)).toEqual(['refreshed', 'refreshed', 'refreshed']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens a new flight once the previous one has landed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accessToken: 'token-1' }));
    expect(await refreshAccessToken()).toBe('refreshed');

    // A token that expires fifteen minutes later must still be refreshable; a
    // guard that cached the first answer would strand the session instead.
    fetchMock.mockResolvedValueOnce(jsonResponse({ accessToken: 'token-2' }));
    expect(await refreshAccessToken()).toBe('refreshed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares the unauthenticated verdict rather than each caller re-asking', async () => {
    const inFlight = deferred();
    fetchMock.mockReturnValueOnce(inFlight.promise);

    const callers = [refreshAccessToken(), refreshAccessToken()];
    inFlight.resolve(jsonResponse({ error: { code: 'TOKEN_EXPIRED', message: 'no' } }, 401));

    expect(await Promise.all(callers)).toEqual(['unauthenticated', 'unauthenticated']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps network-error distinct from unauthenticated, for every caller', async () => {
    const inFlight = deferred();
    fetchMock.mockReturnValueOnce(
      inFlight.promise.then(() => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const callers = [refreshAccessToken(), refreshAccessToken()];
    inFlight.resolve(jsonResponse({}));

    expect(await Promise.all(callers)).toEqual(['network-error', 'network-error']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a cold document asks for a token before it asks for data', () => {
  it('refreshes once for two concurrent requests, then sends both with the token', async () => {
    const refresh = deferred();
    fetchMock.mockImplementation((input: unknown) => {
      const { pathname } = new URL(String(input));
      if (pathname.endsWith('/auth/refresh')) return refresh.promise;
      return Promise.resolve(jsonResponse({ ok: pathname }));
    });

    const calls = [apiRequest('/auth/me'), apiRequest('/me/today')];
    await Promise.resolve();

    // Neither data request has gone out yet: both are waiting on the one
    // exchange, which is what stops the reconnect race.
    expect(requestedPaths()).toEqual(['/api/v1/auth/refresh']);

    refresh.resolve(jsonResponse({ accessToken: 'token-1' }));
    await Promise.all(calls);

    const paths = requestedPaths();
    expect(paths.filter((p) => p.endsWith('/auth/refresh'))).toHaveLength(1);
    expect(paths).toContain('/api/v1/auth/me');
    expect(paths).toContain('/api/v1/me/today');
  });

  it('does not exchange the cookie a second time when the fresh token is itself refused', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const { pathname } = new URL(String(input));
      if (pathname.endsWith('/auth/refresh')) {
        return Promise.resolve(jsonResponse({ accessToken: 'token-1' }));
      }
      return Promise.resolve(jsonResponse({ error: { code: 'FORBIDDEN', message: 'no' } }, 401));
    });

    await expect(apiRequest('/me/today')).rejects.toThrow();
    expect(requestedPaths().filter((p) => p.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('still refreshes and retries when a token that was in memory has expired', async () => {
    setAccessToken('stale-token');
    let served = 0;
    fetchMock.mockImplementation((input: unknown) => {
      const { pathname } = new URL(String(input));
      if (pathname.endsWith('/auth/refresh')) {
        return Promise.resolve(jsonResponse({ accessToken: 'token-2' }));
      }
      served += 1;
      return Promise.resolve(
        served === 1
          ? jsonResponse({ error: { code: 'TOKEN_EXPIRED', message: 'expired' } }, 401)
          : jsonResponse({ ok: true }),
      );
    });

    await expect(apiRequest('/me/today', { method: 'POST', body: {}, idempotencyKey: 'retry-123' })).resolves.toEqual({ ok: true });
    for (const call of [fetchMock.mock.calls[0], fetchMock.mock.calls[2]]) {
      expect(new Headers((call?.[1] as RequestInit).headers).get('Idempotency-Key')).toBe('retry-123');
    }
    expect(requestedPaths()).toEqual([
      '/api/v1/me/today',
      '/api/v1/auth/refresh',
      '/api/v1/me/today',
    ]);
  });

  it('leaves the public auth endpoints alone, so a wrong password is not a refresh', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'INVALID_CREDENTIALS', message: 'no' } }, 401),
    );

    await expect(
      apiRequest('/auth/login', { method: 'POST', body: {}, skipRefresh: true }),
    ).rejects.toThrow();
    expect(requestedPaths()).toEqual(['/api/v1/auth/login']);
  });
});
