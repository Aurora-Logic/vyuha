import { describe, expect, it } from 'vitest';

import { ApiError, refreshOutcomeForFailure } from '../api/client';

import { shouldForgetSession } from './use-session';

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
