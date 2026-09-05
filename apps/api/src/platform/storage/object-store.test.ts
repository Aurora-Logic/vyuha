import { describe, expect, it, vi } from 'vitest';

vi.mock('../common/env.js', () => ({
  env: { STORAGE_DRIVER: 'disk', STORAGE_DISK_PATH: '/tmp/vyuha-storage-boundary-test' },
}));

import { ObjectStore } from './object-store.js';

describe('disk bucket isolation', () => {
  it.each(['../exports/private.pdf', '../../vyuha-storage-boundary-test-other/private', '..', '.']) (
    'refuses a key outside the requested bucket: %s', async (key) => {
      const store = new ObjectStore();
      await expect(store.exists('photos', key)).rejects.toThrow('Path traversal');
      await expect(store.delete('photos', key)).rejects.toThrow('Path traversal');
    },
  );
});
