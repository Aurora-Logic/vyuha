import { describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { migrationPreflight } from './migration-preflight.js';

describe('read-only migration preflight', () => {
  it('allows an empty schema', async () => {
    const pool = new Pool();
    const db = drizzle(pool);
    const query = vi.spyOn(db, 'execute').mockResolvedValue({ rows: [{ present: false }], command: 'SELECT', rowCount: 1, oid: 0, fields: [] });
    await expect(migrationPreflight(db)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    await pool.end();
  });

  it('stops before migration when existing live replacements conflict', async () => {
    const pool = new Pool();
    const db = drizzle(pool);
    const query = vi.spyOn(db, 'execute')
      .mockResolvedValueOnce({ rows: [{ present: true }], command: 'SELECT', rowCount: 1, oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [{ present: true }], command: 'SELECT', rowCount: 1, oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }], command: 'SELECT', rowCount: 1, oid: 0, fields: [] });
    await expect(migrationPreflight(db)).rejects.toThrow('duplicate live replacement');
    expect(query).toHaveBeenCalledTimes(3);
    await pool.end();
  });
});
