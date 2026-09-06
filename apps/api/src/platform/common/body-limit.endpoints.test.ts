import { describe, expect, it, afterAll, beforeAll } from 'vitest';

import { ApiHarness } from '../../test-support/api-harness.js';

/**
 * H-02. The 15 MB JSON limit was global and ran before any guard, so an
 * unauthenticated POST to any route could make the process buffer and parse
 * 15 MB. Now only /sync takes that; everything else stops at 1 MB.
 */
const ORG_ID = '01900000-0000-7000-8000-0000000000b0';
let harness: ApiHarness;

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Body Limit Org');
});

afterAll(async () => {
  await harness.close();
});

describe('the JSON body limit', () => {
  const twoMegabytes = { email: 'x@example.test', password: 'x', pad: 'x'.repeat(2 * 1024 * 1024) };

  it('refuses a 2 MB body on an ordinary route before anything reads it', async () => {
    const response = await harness.post('/auth/login', { body: twoMegabytes });
    expect(response.status).toBe(413);
  });

  it('still lets a 2 MB chunk through the sync door', async () => {
    // Refused for want of a token, not for its size: the parser let it in.
    const response = await harness.post('/sync/agent/results', { body: twoMegabytes });
    expect(response.status, JSON.stringify(response.body).slice(0, 300)).not.toBe(413);
  });

  it('does not grant the large limit to unknown sync routes', async () => {
    const response = await harness.post('/sync/not-a-route', { body: twoMegabytes });
    expect(response.status).toBe(413);
  });
});
