import { describe, expect, it } from 'vitest';

import { pinoParams } from './logging.js';
import { redactUrl } from './redact-url.js';

describe('redactUrl', () => {
  it('masks the portal key and keeps the rest of the route', () => {
    expect(redactUrl('/api/v1/portal/prtl_9f3a2c')).toBe('/api/v1/portal/[redacted]');
    expect(redactUrl('/api/v1/portal/prtl_9f3a2c/media/0190-file')).toBe('/api/v1/portal/[redacted]/media/0190-file');
  });

  it('masks invitation and reset tokens, but not the employee id on the for-employee routes', () => {
    expect(redactUrl('/api/v1/auth/invitations/inv_tok_77/accept')).toBe('/api/v1/auth/invitations/[redacted]/accept');
    expect(redactUrl('/api/v1/auth/password-resets/rst_tok_88/confirm')).toBe('/api/v1/auth/password-resets/[redacted]/confirm');
    expect(redactUrl('/api/v1/auth/invitations/for-employee/0190-emp')).toBe('/api/v1/auth/invitations/for-employee/0190-emp');
    expect(redactUrl('/api/v1/auth/password-resets/for-employee')).toBe('/api/v1/auth/password-resets/for-employee');
  });

  it('drops the query string, which is where the file signature rides', () => {
    expect(redactUrl('/api/v1/files/raw/punch-photos/2026/a.jpg?expires=1757000000&signature=deadbeef')).toBe(
      '/api/v1/files/raw/punch-photos/2026/a.jpg',
    );
    expect(redactUrl('/api/v1/punches?from=2026-09-01')).toBe('/api/v1/punches');
  });

  it('leaves an ordinary route alone', () => {
    expect(redactUrl('/api/v1/punches')).toBe('/api/v1/punches');
    expect(redactUrl('/api/v1/health')).toBe('/api/v1/health');
  });

  it('is what the request logger actually serialises', () => {
    const params = pinoParams() as { pinoHttp: { serializers: { req: (r: unknown) => { url: string } } } };
    const line = params.pinoHttp.serializers.req({ id: 'r1', method: 'GET', url: '/api/v1/portal/prtl_9f3a2c?x=1' });
    expect(line.url).toBe('/api/v1/portal/[redacted]');
  });
});
