import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  getAccessToken,
  refreshOutcomeForFailure,
  setAccessToken,
} from '../api/client';

import {
  currentIdentity,
  resolveSession,
  shouldForgetSession,
  subscribeToSessionIdentity,
  type Me,
} from './use-session';

/**
 * H-14. Only the server's own "not signed in" ends a session. Everything
 * else -- an outage, the rate limiter, a body that would not parse -- keeps
 * the last known identity, because rendering sign-in for a 502 is how a
 * person on a train loses the screen they were working in.
 */
describe('what ends a session', () => {
  const api = (status: number, code: 'NETWORK_ERROR' | 'INTERNAL_ERROR' | 'TOKEN_INVALID' | 'ACCOUNT_INACTIVE') =>
    new ApiError({ code, status, message: 'x' });

  it('forgets on the server saying so, and only then', () => {
    expect(shouldForgetSession(api(401, 'TOKEN_INVALID'))).toBe(true);
    expect(shouldForgetSession(api(403, 'ACCOUNT_INACTIVE'))).toBe(true);
    expect(shouldForgetSession(api(500, 'INTERNAL_ERROR'))).toBe(false);
    expect(shouldForgetSession(api(429, 'INTERNAL_ERROR'))).toBe(false);
    expect(shouldForgetSession(api(0, 'NETWORK_ERROR'))).toBe(false);
    // A body that would not parse arrives as a SyntaxError, not an ApiError.
    expect(shouldForgetSession(new SyntaxError('Unexpected token <'))).toBe(false);
  });

  it('reads a failed refresh the same way', () => {
    expect(refreshOutcomeForFailure(401)).toBe('unauthenticated');
    expect(refreshOutcomeForFailure(403)).toBe('unauthenticated');
    expect(refreshOutcomeForFailure(500)).toBe('network-error');
    expect(refreshOutcomeForFailure(502)).toBe('network-error');
    expect(refreshOutcomeForFailure(429)).toBe('network-error');
  });
});

describe('integrated session recovery after an expired access token', () => {
  const remembered: Me = {
    user: {
      id: '01900000-0000-7000-8000-000000000001',
      email: 'remembered@example.test',
      status: 'ACTIVE',
      employeeId: null,
    },
    employee: null,
    roles: [],
    permissions: [],
  };

  beforeEach(() => {
    localStorage.setItem('vyuha.session.me', JSON.stringify(remembered));
    setAccessToken('expired-access-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    setAccessToken(null);
  });

  it('keeps the remembered identity when refresh receives a transient 503', async () => {
    const fetchMock = vi.fn<(input: unknown) => Promise<Response>>((input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/auth/me')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'TOKEN_EXPIRED', message: 'expired' } }), {
            status: 401,
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'later' } }), {
          status: 503,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveSession()).resolves.toEqual(remembered);
    expect(localStorage.getItem('vyuha.session.me')).not.toBeNull();
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/api/v1/auth/me',
      '/api/v1/auth/refresh',
    ]);
  });

  it.each([
    ['malformed JSON', new Response('<html>bad gateway</html>', { status: 200 })],
    ['a missing token', new Response(JSON.stringify({}), { status: 200 })],
  ])('keeps the remembered identity when refresh returns %s', async (_label, response) => {
    setAccessToken(null);
    const fetchMock = vi.fn<(input: unknown) => Promise<Response>>().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveSession()).resolves.toEqual(remembered);
    expect(localStorage.getItem('vyuha.session.me')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('locks identity instead of adopting another tab\'s account before revalidation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(remembered))));
    await expect(resolveSession()).resolves.toEqual(remembered);
    expect(currentIdentity()?.userId).toBe(remembered.user.id);

    const identities: (string | null)[] = [];
    const unsubscribe = subscribeToSessionIdentity((identity) => {
      identities.push(identity?.userId ?? null);
    });
    const other: Me = {
      ...remembered,
      user: {
        ...remembered.user,
        id: '01900000-0000-7000-8000-000000000002',
        email: 'other@example.test',
      },
    };

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'vyuha.session.me',
        newValue: JSON.stringify(other),
      }),
    );

    expect(getAccessToken()).toBeNull();
    expect(currentIdentity()).toBeNull();
    expect(identities).toEqual([null]);
    unsubscribe();
  });
});
