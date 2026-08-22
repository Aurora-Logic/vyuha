import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

/** Read as text, the way the repo's other source-level guards do. */
const SOURCE = import.meta.glob<string>('/src/lib/session/use-session.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * Signing out has to sign you out even when the server does not answer.
 *
 * `useLogout` cleared the access token in a `finally` but did the rest —
 * `forgetMe()`, the cached session, the query cache — in `onSuccess`, which
 * TanStack does not run on a rejected mutation. A logout that met a 502 left
 * the identity snapshot, the cached session and the still-valid httpOnly
 * refresh cookie in place, and the next request signed the user back in.
 *
 * The hook needs a React tree to run, so this pins the mutation's own
 * contract: the teardown belongs to `onSettled`, which fires on both paths.
 */
describe('the logout teardown runs whether or not the server answers', () => {
  function buildMutation(failing: boolean) {
    const cleared: string[] = [];
    const queryClient = new QueryClient();
    const options = {
      mutationFn: async () => {
        if (failing) throw new Error('502');
        await Promise.resolve();
      },
      onSettled: () => {
        cleared.push('accessToken', 'forgetMe', 'sessionQuery', 'queryCache');
        queryClient.clear();
      },
    };
    return { options, cleared };
  }

  it('tears down after a successful call', async () => {
    const { options, cleared } = buildMutation(false);
    await options.mutationFn();
    options.onSettled();
    expect(cleared).toEqual(['accessToken', 'forgetMe', 'sessionQuery', 'queryCache']);
  });

  it('tears down after a failed call — this is the case that was broken', async () => {
    const { options, cleared } = buildMutation(true);
    await expect(options.mutationFn()).rejects.toThrow('502');
    // onSettled fires on rejection; onSuccess would not have.
    options.onSettled();
    expect(cleared).toContain('forgetMe');
    expect(cleared).toContain('queryCache');
  });

  it('the hook wires the teardown to onSettled, not onSuccess', () => {
    // The regression this file exists for: if somebody moves the teardown
    // back to onSuccess, a failed logout stops clearing anything again.
    const source = SOURCE['/src/lib/session/use-session.ts'] ?? '';
    expect(source).not.toBe('');
    const logout = source.slice(source.indexOf('export function useLogout'));
    // The property, not the prose: the comment above it names `onSuccess` to
    // explain what was wrong, and that must not fail this.
    const code = logout.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
    expect(code).toContain('onSettled:');
    expect(code).not.toContain('onSuccess:');
    const settled = code.indexOf('onSettled:');
    for (const teardown of ['forgetMe()', 'queryClient.clear()', 'setAccessToken(null)']) {
      expect(code.slice(settled)).toContain(teardown);
    }
  });
});
