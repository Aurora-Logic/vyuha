import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentApiClient } from './api-client.js';

/**
 * H-11. The client used fetch with no limit and cast whatever came back to
 * the type. A server that never answered hung the tick -- and SIGTERM waits
 * for the tick -- and a proxy's error page answered 200 as a claim.
 */
describe('AgentApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives up on a request the server never answers', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('Request aborted', { cause: reason }));
          });
        }),
    );
    const client = new AgentApiClient('https://vyuha.example', 'vyagt_x', 20);
    await expect(client.claim({ agentInstanceId: 'inst' })).rejects.toThrow(/did not answer within 20ms/);
  }, 1000);

  it('refuses a 200 whose body is not the contract', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ nope: true }), { status: 200 })));
    const client = new AgentApiClient('https://vyuha.example', 'vyagt_x');
    await expect(client.claim({ agentInstanceId: 'inst' })).rejects.toThrow(/does not match the contract/);
  });

  it('returns the answer when it is the contract', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ job: null }), { status: 200 })));
    const client = new AgentApiClient('https://vyuha.example', 'vyagt_x');
    await expect(client.claim({ agentInstanceId: 'inst' })).resolves.toEqual({ job: null });
  });
});
