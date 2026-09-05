import { uuidv7 } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../common/env.js';
import { describeError } from '../common/errors.js';
import type { Database } from '../db/db.provider.js';
import { organizations } from '../db/schema/index.js';
import { AuditService, diffJson, redact } from './audit.service.js';

/**
 * REQ-M-01 and REQ-B-09a: the audit log is append-only, and that is enforced
 * by a database trigger rather than by convention. The point of the trigger is
 * that it binds every connection, so these tests go at the table directly --
 * bypassing every application layer -- and expect to be refused.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000a3';

it('redacts credential aliases across casing and separators in nested audit data', () => {
  for (const key of ['PASSWORD', 'Refresh_Token', 'access-token', 'API_KEY', 'Set-Cookie', 'ClientSecret', 'recovery_codes', 'BackupCodes']) {
    expect(redact({ nested: [{ [key]: 'sensitive-value', label: 'retained' }] }))
      .toEqual({ nested: [{ [key]: '[redacted]', label: 'retained' }] });
  }
});

let pool: Pool;
let db: Database;
let audit: AuditService;

beforeAll(async () => {
  expect(new URL(env.DATABASE_URL).port).toBe('55432');
  pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
  db = drizzle(pool);
  audit = new AuditService(db);

  await db
    .insert(organizations)
    .values({ id: ORG_ID, name: 'Audit Fixture Org' })
    .onConflictDoUpdate({ target: organizations.id, set: { deletedAt: null } });
});

afterAll(async () => {
  await pool.end();
});

/**
 * `describeError` rather than `.message`: Drizzle wraps a driver failure in an
 * error whose message is the SQL and puts the database's own message in
 * `cause`, so reading `.message` here would report "Failed query: DELETE FROM
 * audit_logs" and the assertion would be measuring the wrong string.
 */
async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    return describeError(error);
  }
  throw new Error('Expected the statement to be refused.');
}

describe('audit_logs is append-only (REQ-M-01)', () => {
  it('accepts an insert', async () => {
    const written = await audit.write({
      orgId: ORG_ID,
      actorUserId: null,
      action: 'test.appended',
      entityType: 'probe',
      entityId: uuidv7(),
      after: { value: 1 },
      requestId: 'append-only-probe',
    });
    expect(written).toBe(true);

    const rows = await db.execute<{ count: string }>(
      sql`SELECT count(*) AS count FROM audit_logs WHERE org_id = ${ORG_ID} AND action = 'test.appended'`,
    );
    expect(Number(rows.rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it('refuses an UPDATE', async () => {
    const message = await failureOf(() =>
      db.execute(sql`UPDATE audit_logs SET action = 'tampered' WHERE org_id = ${ORG_ID}`),
    );
    expect(message).toContain('append-only');
    expect(message).toContain('UPDATE');
  });

  it('refuses an UPDATE that would match no rows', async () => {
    // Statement-level, not row-level. A DELETE that silently succeeds because
    // the table happened to be empty teaches the wrong lesson.
    const message = await failureOf(() =>
      db.execute(
        sql`UPDATE audit_logs SET action = 'tampered' WHERE id = '00000000-0000-0000-0000-000000000000'`,
      ),
    );
    expect(message).toContain('append-only');
  });

  it('refuses a DELETE', async () => {
    const message = await failureOf(() =>
      db.execute(sql`DELETE FROM audit_logs WHERE org_id = ${ORG_ID}`),
    );
    expect(message).toContain('append-only');
    expect(message).toContain('DELETE');
  });

  it('refuses a TRUNCATE, which bypasses UPDATE and DELETE triggers', async () => {
    const message = await failureOf(() => db.execute(sql`TRUNCATE audit_logs`));
    expect(message).toContain('append-only');
  });

  it('reports a failed write instead of throwing into the caller', async () => {
    // A NOT NULL violation on org_id. An audit failure must never be the
    // reason a punch is rejected, so `write` returns false and logs.
    const ok = await audit.write({
      orgId: '00000000-0000-0000-0000-000000000000',
      actorUserId: null,
      action: 'test.unwritable',
      entityType: 'probe',
    });
    expect(ok).toBe(false);
  });
});

describe('audit payload shaping', () => {
  it('stores only the fields that changed', () => {
    const diff = diffJson(
      { name: 'Anita', shift: 'General', location: 'HO' },
      { name: 'Anita', shift: 'Night', location: 'HO' },
    );
    expect(diff.before).toEqual({ shift: 'General' });
    expect(diff.after).toEqual({ shift: 'Night' });
  });

  it('keeps everything when there is no prior state', () => {
    const diff = diffJson(undefined, { name: 'Anita', shift: 'General' });
    expect(diff.after).toEqual({ name: 'Anita', shift: 'General' });
  });

  it('never writes a credential into the trail', () => {
    const shaped = redact({
      email: 'asha@vyuha.test',
      password: 'the-real-password',
      passwordHash: '$scrypt$...',
      nested: { refreshToken: 'secret-token', totpSecret: 'ABC', keep: 'visible' },
      list: [{ token: 'another-secret' }],
    });

    expect(JSON.stringify(shaped)).not.toContain('the-real-password');
    expect(JSON.stringify(shaped)).not.toContain('secret-token');
    expect(JSON.stringify(shaped)).not.toContain('another-secret');
    expect(shaped).toMatchObject({
      email: 'asha@vyuha.test',
      nested: { keep: 'visible' },
    });
  });

  it('redacts credentials that only appear in a diff', () => {
    const diff = diffJson({ passwordHash: 'old' }, { passwordHash: 'new' });
    expect(JSON.stringify(diff)).not.toContain('old');
    expect(JSON.stringify(diff)).not.toContain('new');
  });

  it('survives a deeply nested payload rather than recursing forever', () => {
    interface Nest {
      next?: Nest;
    }
    const deep: Nest = {};
    let cursor = deep;
    for (let i = 0; i < 40; i += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    expect(() => JSON.stringify(redact(deep))).not.toThrow();
  });
});
