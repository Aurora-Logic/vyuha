import { describe, expect, it } from 'vitest';

import { configSchema } from './config.js';

const base = { serverUrl: 'https://vyuha.example', agentToken: 'vyagt_abc' };

describe('agent config', () => {
  it('requires https except on the machine itself (H-11)', () => {
    expect(configSchema.safeParse(base).success).toBe(true);
    expect(configSchema.safeParse({ ...base, serverUrl: 'http://localhost:3000' }).success).toBe(true);
    expect(configSchema.safeParse({ ...base, serverUrl: 'http://127.0.0.1:3000' }).success).toBe(true);
    expect(configSchema.safeParse({ ...base, serverUrl: 'http://vyuha.example' }).success).toBe(false);
  });

  it('takes the fixture path as a setting, with no default (C-02)', () => {
    expect(configSchema.safeParse({ ...base, fixture: 'C:\\vyuha\\demo.json' }).success).toBe(true);
    expect(configSchema.safeParse({ ...base, fixture: '' }).success).toBe(false);
    expect(configSchema.safeParse(base).data?.fixture).toBeUndefined();
  });
});
