import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setAccessToken } from '@/lib/api/client';

import { openRealtimeStream } from './realtime-provider';

type FetchLike = (input: unknown, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('the realtime stream refreshes an expired bearer once', () => {
  beforeEach(() => {
    setAccessToken('expired-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('reopens the stream with the refreshed token after a 401', async () => {
    const fetchMock = vi.fn<FetchLike>();
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh-token' }))
      .mockResolvedValueOnce(
        new Response('event: ready\ndata: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await openRealtimeStream(new AbortController().signal);

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/api/v1/realtime/stream',
      '/api/v1/auth/refresh',
      '/api/v1/realtime/stream',
    ]);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer expired-token',
    );
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer fresh-token',
    );
  });

  it('does not retry the stale bearer when refresh has no authoritative answer', async () => {
    const first = new Response('', { status: 401 });
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'INTERNAL_ERROR' } }, 503));
    vi.stubGlobal('fetch', fetchMock);

    await expect(openRealtimeStream(new AbortController().signal)).resolves.toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
