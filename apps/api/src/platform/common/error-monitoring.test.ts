import { describe, expect, it } from 'vitest';

import { sanitizeMonitoringEvent } from './error-monitoring.js';

describe('monitoring privacy', () => {
  it('drops request/user/breadcrumb/SQL/context data while retaining correlation and frame locations', () => {
    const safe = sanitizeMonitoringEvent({
      type: undefined,
      event_id: 'event',
      tags: { requestId: 'request-123', customSecret: 'secret' },
      user: { email: 'secret@example.test' },
      request: { url: '/portal/secret', data: 'secret' },
      extra: { sql: 'secret' },
      breadcrumbs: [{ message: 'secret' }],
      exception: { values: [{ type: 'secret', value: 'postgres://secret', stacktrace: { frames: [{
        filename: 'server.js?token=secret', lineno: 10, vars: { password: 'secret' }, context_line: 'secret',
      }] } }] },
    });
    expect(JSON.stringify(safe)).not.toContain('secret');
    expect(safe.tags?.requestId).toBe('request-123');
    expect(safe.exception?.values?.[0]?.stacktrace?.frames?.[0]).toMatchObject({ filename: 'server.js', lineno: 10 });
  });
});
