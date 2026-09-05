import { SYSTEM_ROLES } from '@vyuha/shared';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, CookieJar, scopedEmail } from '../../test-support/api-harness.js';
import { sessions } from '../db/schema/index.js';
import { REFRESH_COOKIE_NAME } from './refresh-cookie.js';
import { SessionService } from './session.service.js';
import { REDIS_CLIENT } from '../redis/redis.provider.js';

/**
 * REQ-B-05: "Refresh token reuse detection revokes the family and forces
 * re-login."
 *
 * This is the most important test in the suite, and it is written the way the
 * requirement reads: log in, refresh once, then replay the *first* token. The
 * assertions are deliberately not limited to the status code of the replay --
 * a control that answers 401 while quietly leaving the family alive would pass
 * a status-code-only test and would be worse than having no control at all,
 * because the 401 makes it look as though something fired.
 *
 * So three separate things are proven after the replay:
 *   1. the replay is refused with REFRESH_TOKEN_REUSED;
 *   2. the legitimate second token, which the real client holds, is dead too;
 *   3. every row in the family carries a revocation reason in the database.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000a4';

let harness: ApiHarness;
let email: string;
let password: string;

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

async function familyRows(userId: string): Promise<
  { id: string; familyId: string; usedAt: Date | null; revokedAt: Date | null; revokedReason: string | null }[]
> {
  return harness.db
    .select({
      id: sessions.id,
      familyId: sessions.familyId,
      usedAt: sessions.usedAt,
      revokedAt: sessions.revokedAt,
      revokedReason: sessions.revokedReason,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(sessions.createdAt);
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Refresh Reuse Fixture Org');
  const roleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);
  const user = await harness.createUser({ email: scopedEmail('rotator'), roleIds: [roleId] });
  email = user.email;
  password = user.password;
}, 30_000);

afterAll(async () => {
  await harness.close();
});

describe('REQ-B-05: rotating refresh tokens', () => {
  it('seals replay credentials in Redis and refuses a corrupted entry without a 500', async () => {
    const jar = new CookieJar();
    await harness.post('/auth/login', { body: { email, password }, withCookies: true }, jar);
    const original = jar.get(REFRESH_COOKIE_NAME) ?? '';
    expect((await harness.post('/auth/refresh', { withCookies: true }, jar)).status).toBe(200);
    const replacement = jar.get(REFRESH_COOKIE_NAME) ?? '';
    expect(replacement).not.toBe('');
    const redis = harness.resolve<Redis>(REDIS_CLIENT);
    const key = harness.resolve(SessionService).replayKeyForTest(original);
    const stored = await redis.get(key);
    expect(stored).toMatch(/^v1\./u);
    expect(stored).not.toContain(replacement);
    await redis.set(key, 'corrupted replay entry', 'EX', 10);
    const refused = await harness.post('/auth/refresh', { cookieOverride: `${REFRESH_COOKIE_NAME}=${original}` });
    expect(refused.status).toBe(401);
  });

  it('issues a new refresh token on every use and refuses the old one', async () => {
    const jar = new CookieJar();
    const login = await harness.post('/auth/login', { body: { email, password }, withCookies: true }, jar);
    expect(login.status).toBe(200);

    const first = jar.get(REFRESH_COOKIE_NAME);
    expect(first).not.toBeNull();

    const refreshed = await harness.post('/auth/refresh', { withCookies: true }, jar);
    expect(refreshed.status).toBe(200);

    const second = jar.get(REFRESH_COOKIE_NAME);
    expect(second).not.toBeNull();
    // Rotation, not reissue of the same string. Without this the two calls
    // below would be testing the same token twice.
    expect(second).not.toBe(first);
  });

  /**
   * The requirement, verbatim: login, refresh, replay the FIRST token.
   */
  it('revokes the whole family when a used token is presented again', async () => {
    const jar = new CookieJar();
    await harness.post('/auth/login', { body: { email, password }, withCookies: true }, jar);

    const firstToken = jar.get(REFRESH_COOKIE_NAME);
    expect(firstToken).not.toBeNull();

    const rotate = await harness.post('/auth/refresh', { withCookies: true }, jar);
    expect(rotate.status).toBe(200);
    const secondToken = jar.get(REFRESH_COOKIE_NAME);
    expect(secondToken).not.toBe(firstToken);

    const userRows = await harness.db.execute<{ id: string }>(
      sql`SELECT id FROM users WHERE lower(email) = ${email}`,
    );
    const userId = userRows.rows[0]?.id ?? '';
    expect(userId).not.toBe('');

    const beforeReplay = await familyRows(userId);
    const liveBefore = beforeReplay.filter((row) => row.revokedAt === null);
    // Control: at this point the family genuinely has a live member. If it did
    // not, "the second token stops working" below would be true for the wrong
    // reason.
    expect(liveBefore.length).toBeGreaterThan(0);

    /*
     * ---- the attack: replay the token that was already exchanged ----
     *
     * Outside the rotation tolerance window first. Within it, a repeat of the
     * same token is a booting second tab and is answered with the same
     * replacement -- see "a second tab" below. Theft is what this test is
     * about, and theft arrives minutes later, not milliseconds.
     */
    await harness.expireRefreshReplayWindow(firstToken ?? '');
    const replay = await harness.post<ErrorBody>('/auth/refresh', {
      cookieOverride: `${REFRESH_COOKIE_NAME}=${firstToken ?? ''}`,
    });

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // ---- 1. the legitimate client's token is dead too ----
    const afterReuse = await harness.post<ErrorBody>('/auth/refresh', {
      cookieOverride: `${REFRESH_COOKIE_NAME}=${secondToken ?? ''}`,
    });
    expect(afterReuse.status).toBe(401);
    expect(afterReuse.body.error.code).toBe('TOKEN_INVALID');

    // ---- 2. the family is dead in the database, with a reason ----
    const rows = await familyRows(userId);
    const familyId = beforeReplay[beforeReplay.length - 1]?.familyId;
    const family = rows.filter((row) => row.familyId === familyId);
    expect(family.length).toBeGreaterThanOrEqual(2);
    expect(family.every((row) => row.revokedAt !== null)).toBe(true);
    expect(family.every((row) => row.revokedReason === 'refresh token reuse detected')).toBe(true);

    // ---- 3. the incident is in the audit trail ----
    expect(await harness.waitForAuditAction('session.reuse_detected')).toBe(true);
  });

  /**
   * P1-6: two tabs must not sign the person out of everything.
   *
   * The access token is held in memory only, so every cold document load calls
   * `/auth/refresh`. Two documents booting at once send the same cookie twice,
   * and under strict rotation the second was theft: the family was revoked and
   * the tab that *succeeded* died at its next refresh. Verified against the
   * running API before this window existed.
   *
   * The fix returns the *same* replacement rather than minting a second one.
   * That distinction is the test: two different tokens would leave the tabs
   * diverged and simply move the race somewhere harder to see.
   */
  it('answers a second tab with the same replacement, not a revocation', async () => {
    const jar = new CookieJar();
    await harness.post('/auth/login', { body: { email, password }, withCookies: true }, jar);
    const shared = jar.get(REFRESH_COOKIE_NAME) ?? '';

    // Both tabs present the cookie they booted with. Sequential rather than
    // concurrent on purpose: `FOR UPDATE` already serialises them, so this is
    // the same situation with the timing removed.
    const first = await harness.post<{ expiresAt: string }>('/auth/refresh', {
      cookieOverride: `${REFRESH_COOKIE_NAME}=${shared}`,
    });
    const second = await harness.post<{ expiresAt: string }>('/auth/refresh', {
      cookieOverride: `${REFRESH_COOKIE_NAME}=${shared}`,
    });

    expect(first.status).toBe(200);
    expect(second.status, second.text).toBe(200);

    // The same token, byte for byte -- not merely two that both work.
    const tokenOf = (r: typeof first): string => {
      const header = r.headers.getSetCookie().find((h) => h.startsWith(`${REFRESH_COOKIE_NAME}=`));
      return header?.split(';')[0]?.split('=')[1] ?? '';
    };
    expect(tokenOf(second)).toBe(tokenOf(first));
    expect(tokenOf(first)).not.toBe('');

    // And it works: the replacement both tabs now hold is live.
    const next = await harness.post('/auth/refresh', {
      cookieOverride: `${REFRESH_COOKIE_NAME}=${tokenOf(first)}`,
    });
    expect(next.status).toBe(200);

    // Nothing was revoked. This is the half that made the old behaviour so
    // bad: it was not that a request failed, it was that the family died.
    const userRows = await harness.db.execute<{ id: string }>(
      sql`SELECT id FROM users WHERE lower(email) = ${email}`,
    );
    const rows = await familyRows(userRows.rows[0]?.id ?? '');
    /*
     * This sign-in's family only. Earlier tests in this file revoke families
     * for the same user on purpose, so asking "has anything of theirs ever
     * been revoked for reuse" answers yes for the wrong reason -- which is
     * exactly what it did on the first run of this test.
     */
    const familyId = rows[rows.length - 1]?.familyId;
    const family = rows.filter((row) => row.familyId === familyId);
    expect(family.length).toBeGreaterThan(0);
    expect(family.some((row) => row.revokedReason === 'refresh token reuse detected')).toBe(false);
    expect(family.every((row) => row.revokedAt === null)).toBe(true);

    // Two rotations across three requests: the shared token once, then the
    // replacement once. The second tab consumed nothing, which is the point --
    // the window returns what already exists rather than minting beside it.
    expect(family.filter((row) => row.usedAt !== null).length).toBe(2);
    expect(family.length).toBe(3);
  });

  it('leaves other families alone when one is revoked for reuse', async () => {
    // Two independent sign-ins: a phone and a laptop. One being compromised
    // must not sign the other out, or the control becomes a denial of service
    // that any attacker can trigger against any user at will.
    const phone = new CookieJar();
    const laptop = new CookieJar();
    await harness.post('/auth/login', { body: { email, password }, withCookies: true }, phone);
    await harness.post('/auth/login', { body: { email, password }, withCookies: true }, laptop);

    const stolen = phone.get(REFRESH_COOKIE_NAME);
    await harness.post('/auth/refresh', { withCookies: true }, phone);
    await harness.expireRefreshReplayWindow(stolen ?? '');
    const replay = await harness.post<ErrorBody>('/auth/refresh', {
      cookieOverride: `${REFRESH_COOKIE_NAME}=${stolen ?? ''}`,
    });
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    const laptopStillWorks = await harness.post('/auth/refresh', { withCookies: true }, laptop);
    expect(laptopStillWorks.status).toBe(200);
  });

  it('clears the cookie when a refresh fails, so the client cannot loop', async () => {
    const jar = new CookieJar();
    await harness.post('/auth/login', { body: { email, password }, withCookies: true }, jar);
    const token = jar.get(REFRESH_COOKIE_NAME);
    await harness.post('/auth/refresh', { withCookies: true }, jar);
    await harness.expireRefreshReplayWindow(token ?? '');

    const replay = await harness.post('/auth/refresh', {
      cookieOverride: `${REFRESH_COOKIE_NAME}=${token ?? ''}`,
    });
    const cleared = replay.headers.getSetCookie();
    expect(cleared.some((header) => header.startsWith(`${REFRESH_COOKIE_NAME}=;`))).toBe(true);
  });

  it('refuses a refresh with no cookie, a malformed cookie, and an unknown token', async () => {
    const none = await harness.post<ErrorBody>('/auth/refresh');
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('TOKEN_INVALID');

    const malformed = await harness.post<ErrorBody>('/auth/refresh', {
      cookieOverride: `${REFRESH_COOKIE_NAME}=not a token at all`,
    });
    expect(malformed.status).toBe(401);

    const unknown = await harness.post<ErrorBody>('/auth/refresh', {
      cookieOverride: `${REFRESH_COOKIE_NAME}=${'z'.repeat(43)}`,
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('TOKEN_INVALID');
  });

  it('sets the refresh cookie httpOnly, SameSite=Strict, and scoped to the auth path', async () => {
    const jar = new CookieJar();
    const login = await harness.post('/auth/login', { body: { email, password }, withCookies: true }, jar);
    const header = login.headers.getSetCookie().find((value) => value.startsWith(REFRESH_COOKIE_NAME));

    expect(header).toBeDefined();
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/api/v1/auth');
  });

  it('ends the family on logout', async () => {
    const jar = new CookieJar();
    await harness.post('/auth/login', { body: { email, password }, withCookies: true }, jar);
    const token = jar.get(REFRESH_COOKIE_NAME);

    const loggedOut = await harness.post('/auth/logout', { withCookies: true }, jar);
    expect(loggedOut.status).toBe(204);

    const afterLogout = await harness.post<ErrorBody>('/auth/refresh', {
      cookieOverride: `${REFRESH_COOKIE_NAME}=${token ?? ''}`,
    });
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body.error.code).toBe('TOKEN_INVALID');

    // Logout is idempotent: a second call must not error.
    expect((await harness.post('/auth/logout', { withCookies: true }, jar)).status).toBe(204);
  });
});
