import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@vyuha/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { DEFAULT_SECURITY_POLICY, SECURITY_SETTINGS, securityPolicySchema } from '../settings/settings.catalogue.js';
import { WorkspacePolicyReader } from '../settings/workspace-policy.reader.js';
import { env } from '../common/env.js';
import { AppError, describeError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { sessions } from '../db/schema/index.js';
import { InjectRedis } from '../redis/redis.provider.js';
import { generateOpaqueToken, hashOpaqueToken, TOKEN_PURPOSES } from './opaque-token.js';
import { openSecret, sealSecret } from './secret-box.js';

/**
 * REQ-B-05: "Sessions: short-lived access token + rotating refresh token.
 * Refresh token reuse detection revokes the family and forces re-login."
 *
 * The model, restated because the whole file depends on getting it right:
 *
 * - One row per *issued token*, not per login. `family_id` groups every token
 *   descended from one login.
 * - Rotation marks the presented row `used_at` and inserts a child in the same
 *   family. A token is therefore valid exactly once.
 * - Presenting a token that already has `used_at` means two parties hold it.
 *   Only one of them is the legitimate client and there is no way to tell
 *   which, so the whole family dies and both must log in again.
 *
 * That last consequence is the design working, not a rough edge. A stolen
 * refresh token is otherwise silently useful for a month; this turns it into a
 * detectable event with a bounded blast radius.
 */

const REVOCATION_REASONS = {
  REUSE: 'refresh token reuse detected',
  LOGOUT: 'logout',
  PASSWORD_CHANGED: 'password changed',
} as const;

export interface IssuedSession {
  /** The refresh cookie's life; null means the browser session (end on close). */
  readonly cookieMaxAgeMs: number | null;
  readonly sessionId: string;
  readonly familyId: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
}

export interface SessionRequestContext {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface RotatedSession extends IssuedSession {
  readonly userId: string;
  readonly orgId: string;
  /** The row that was just consumed, for audit attribution. */
  readonly previousSessionId: string;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The outcome of looking at a presented token, decided inside the transaction
 * and acted on outside it.
 *
 * Reuse detection has to *commit* the revocation. Throwing from inside the
 * transaction would roll back the very revocation the throw exists to
 * announce, leaving the family alive and the attacker's token working -- with
 * a 401 on the response making it look as though the control had fired.
 */
type RotationOutcome =
  | { readonly kind: 'rotated'; readonly session: RotatedSession }
  | { readonly kind: 'reused'; readonly familyId: string; readonly userId: string; readonly orgId: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'expired' };

/**
 * What the replay window stores, validated on the way out.
 *
 * Redis is a boundary like any other, and an entry written by a different
 * build of this file must be treated as absent rather than trusted -- it is
 * about to be handed back as a live credential.
 */
const replayEntrySchema = z.object({
  sessionId: z.uuid(),
  familyId: z.uuid(),
  refreshToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
  cookieMaxAgeMs: z.number().nullable().default(env.JWT_REFRESH_TTL_SECONDS * 1000),
  userId: z.uuid(),
  orgId: z.uuid(),
  previousSessionId: z.uuid(),
});

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    @InjectRedis() private readonly redis: Redis,
    private readonly audit: AuditService,
    private readonly policies: WorkspacePolicyReader,
  ) {}

  /**
   * Where a just-issued replacement is remembered, keyed by the token that
   * produced it.
   *
   * The presented token's *hash*, never the token: this key is the same value
   * already stored in `sessions.refresh_token_hash`, so a reader of Redis
   * learns nothing they could not read from the database.
   */
  private replayKey(presentedToken: string): string {
    return `auth:refresh:replay:${this.hash(presentedToken)}`;
  }

  /**
   * The same key, for a test that needs to put itself outside the window.
   *
   * Exposed rather than letting the harness rebuild it: a test that hashed the
   * token itself would keep passing if this service changed how it keys the
   * window, and would then be asserting reuse detection against an entry
   * nothing reads.
   */
  replayKeyForTest(presentedToken: string): string {
    return this.replayKey(presentedToken);
  }

  private hash(token: string): string {
    return hashOpaqueToken(TOKEN_PURPOSES.REFRESH, token, env.JWT_REFRESH_SECRET);
  }

  /**
   * Owner, 22 Aug 2026: the window is the organisation's setting, read at
   * sign-in and at every rotation so a change takes effect from the next
   * request; the env value is the ceiling. The cookie lasts the window, or
   * the browser session when the organisation ends sign-ins on close.
   */
  private async window(orgId: string): Promise<{ ttlMs: number; cookieMaxAgeMs: number | null }> {
    const policy = await this.policies.read(orgId, securityPolicySchema, SECURITY_SETTINGS, DEFAULT_SECURITY_POLICY);
    const ttlMs = Math.min(policy.sessionHours * 60 * 60, env.JWT_REFRESH_TTL_SECONDS) * 1000;
    return { ttlMs, cookieMaxAgeMs: policy.endSessionOnClose ? null : ttlMs };
  }

  /** A fresh family. Called on login and nowhere else. */
  async startFamily(
    orgId: string,
    userId: string,
    context: SessionRequestContext,
  ): Promise<IssuedSession> {
    const token = generateOpaqueToken();
    const now = new Date();
    const window = await this.window(orgId);
    const rows = await this.db
      .insert(sessions)
      .values({
        orgId,
        userId,
        refreshTokenHash: this.hash(token),
        // The first row's own id is the family id, so a family is traceable to
        // the login that started it without a second table.
        familyId: sql`uuid_generate_v7()`,
        ip: context.ip,
        userAgent: context.userAgent,
        expiresAt: new Date(now.getTime() + window.ttlMs),
      })
      .returning({ id: sessions.id, familyId: sessions.familyId, expiresAt: sessions.expiresAt });

    const row = rows[0];
    if (row === undefined) throw new Error('Session insert returned no row.');

    return {
      sessionId: row.id,
      familyId: row.familyId,
      refreshToken: token,
      expiresAt: row.expiresAt,
      cookieMaxAgeMs: window.cookieMaxAgeMs,
    };
  }

  async rotate(presentedToken: string, context: SessionRequestContext): Promise<RotatedSession> {
    /*
     * The tolerance window, checked before anything else.
     *
     * Deliberately ahead of the transaction rather than inside `decide`: the
     * rotation and reuse logic below is a security control and this must not
     * change how it behaves. A cache entry exists only for a token that was
     * successfully rotated within the last few seconds, so a hit means "this
     * exact token was exchanged a moment ago, and here is what it produced" --
     * not "trust this token". Outside the window there is no entry and every
     * path below runs exactly as it did.
     *
     * Returning the *same* replacement is the point. Minting a second one
     * would leave two tabs holding two different tokens and simply move the
     * race; this way both converge on one.
     */
    const replayed = await this.replayOf(presentedToken);
    if (replayed !== null) return replayed;

    const outcome = await this.db.transaction((tx) => this.decide(tx, presentedToken, context));

    switch (outcome.kind) {
      case 'rotated':
        await this.rememberForReplay(presentedToken, outcome.session);
        return outcome.session;

      case 'reused':
        this.logger.warn({
          msg: 'Refresh token reuse detected; the session family has been revoked.',
          familyId: outcome.familyId,
          userId: outcome.userId,
          orgId: outcome.orgId,
          ip: context.ip,
        });
        // Written directly rather than through `AuditContext`, because the
        // interceptor only audits successful requests and this one is about
        // to answer 401. It is also the single most important row this
        // subsystem can produce: it is the evidence that a refresh token was
        // held by two parties.
        await this.audit.write({
          orgId: outcome.orgId,
          actorUserId: outcome.userId,
          action: 'session.reuse_detected',
          entityType: 'session',
          after: {
            familyId: outcome.familyId,
            ip: context.ip,
            userAgent: context.userAgent,
            outcome: 'family revoked',
          },
          ip: context.ip,
          userAgent: context.userAgent,
        });
        throw new AppError(
          ERROR_CODES.REFRESH_TOKEN_REUSED,
          'This session was already refreshed elsewhere. All sessions from that sign-in have been ended; sign in again.',
        );

      case 'revoked':
        throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This session has been ended.');

      case 'expired':
        throw new AppError(ERROR_CODES.TOKEN_EXPIRED, 'This session has expired; sign in again.');

      case 'unknown':
        throw new AppError(ERROR_CODES.TOKEN_INVALID, 'Refresh token is not recognised.');
    }
  }

  /**
   * `FOR UPDATE` on the presented row is what makes reuse detection sound
   * under concurrency. Two requests arriving with the same token serialise
   * here; the first marks it used, the second then reads `used_at` set and
   * reports reuse. Without the lock both would read null and both would
   * succeed, which is precisely the situation the feature exists to notice.
   */
  private async decide(
    tx: Transaction,
    presentedToken: string,
    context: SessionRequestContext,
  ): Promise<RotationOutcome> {
    const rows = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, this.hash(presentedToken)))
      .for('update')
      .limit(1);

    const row = rows[0];
    if (row === undefined) return { kind: 'unknown' };

    if (row.usedAt !== null) {
      await this.revokeFamilyWithin(tx, row.familyId, REVOCATION_REASONS.REUSE);
      return { kind: 'reused', familyId: row.familyId, userId: row.userId, orgId: row.orgId };
    }

    if (row.revokedAt !== null) return { kind: 'revoked' };

    const now = new Date();
    if (row.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };

    await tx.update(sessions).set({ usedAt: now }).where(eq(sessions.id, row.id));

    const token = generateOpaqueToken();
    const window = await this.window(row.orgId);
    const inserted = await tx
      .insert(sessions)
      .values({
        orgId: row.orgId,
        userId: row.userId,
        refreshTokenHash: this.hash(token),
        familyId: row.familyId,
        deviceFingerprint: row.deviceFingerprint,
        ip: context.ip,
        userAgent: context.userAgent,
        // Rolling, not fixed to the family's original expiry: an active user
        // is not signed out mid-shift thirty days after they first logged in.
        expiresAt: new Date(now.getTime() + window.ttlMs),
      })
      .returning({ id: sessions.id, expiresAt: sessions.expiresAt });

    const child = inserted[0];
    if (child === undefined) throw new Error('Session rotation returned no row.');

    return {
      kind: 'rotated',
      session: {
        sessionId: child.id,
        familyId: row.familyId,
        refreshToken: token,
        expiresAt: child.expiresAt,
        cookieMaxAgeMs: window.cookieMaxAgeMs,
        userId: row.userId,
        orgId: row.orgId,
        previousSessionId: row.id,
      },
    };
  }

  /**
   * The replacement this token already produced, if it did so a moment ago.
   *
   * Null on a miss, and null whenever Redis is unreachable -- the caller then
   * falls through to strict rotation, which refuses. A cache that cannot be
   * read must not become a way to skip reuse detection, so the failure
   * direction is the safe one: an outage costs a person a re-login, it does
   * not cost the control.
   */
  private async replayOf(presentedToken: string): Promise<RotatedSession | null> {
    if (env.AUTH_REFRESH_REPLAY_TOLERANCE_SECONDS <= 0) return null;

    let raw: string | null;
    try {
      raw = await this.redis.get(this.replayKey(presentedToken));
    } catch (error: unknown) {
      this.logger.warn({
        msg: 'The refresh replay window could not be read; falling back to strict rotation.',
        reason: describeError(error),
      });
      return null;
    }
    if (raw === null) return null;

    try {
      // Bind ciphertext to the presented token's keyed hash: Redis read
      // exposure yields no live token, and swapping cache entries cannot
      // substitute another account's replacement. No plaintext fallback.
      const plain = openSecret(raw, env.JWT_REFRESH_SECRET, this.replayKey(presentedToken));
      const parsed = replayEntrySchema.safeParse(JSON.parse(plain));
      if (!parsed.success) return null;
      return { ...parsed.data, expiresAt: new Date(parsed.data.expiresAt) };
    } catch {
      this.logger.warn({ msg: 'Unreadable or legacy refresh replay entry ignored; strict rotation applies.' });
      return null;
    }
  }

  /**
   * Remembers a replacement for the length of the window.
   *
   * `PX` rather than a sweep: the entry has to disappear on its own, because
   * the whole security argument is that the window is short and closes without
   * anybody's help. A write failure is logged and swallowed -- the rotation
   * already committed, and refusing the caller now would sign out the very
   * person this feature exists to keep signed in.
   */
  private async rememberForReplay(
    presentedToken: string,
    session: RotatedSession,
  ): Promise<void> {
    const seconds = env.AUTH_REFRESH_REPLAY_TOLERANCE_SECONDS;
    if (seconds <= 0) return;

    try {
      await this.redis.set(
        this.replayKey(presentedToken),
        sealSecret(
          JSON.stringify({ ...session, expiresAt: session.expiresAt.toISOString() }),
          env.JWT_REFRESH_SECRET,
          this.replayKey(presentedToken),
        ),
        'PX',
        seconds * 1000,
      );
    } catch (error: unknown) {
      this.logger.warn({
        msg: 'The refresh replay window could not be written; a concurrent tab may be signed out.',
        reason: describeError(error),
      });
    }
  }

  /** REQ-B-06 / logout. Returns how many live rows were ended. */
  async revokeFamily(familyId: string, reason: string): Promise<number> {
    return this.revokeFamilyWithin(this.db, familyId, reason);
  }

  private async revokeFamilyWithin(
    executor: Database | Transaction,
    familyId: string,
    reason: string,
  ): Promise<number> {
    const rows = await executor
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.length;
  }

  /**
   * REQ-B-04: "Password change invalidates all other sessions." `exceptFamily`
   * is for the case where the change was made from a live session that should
   * survive it; a reset completed from an emailed link passes nothing, and
   * every session dies.
   */
  async revokeAllForUser(
    userId: string,
    reason: string,
    exceptFamilyId?: string,
  ): Promise<number> {
    const predicate =
      exceptFamilyId === undefined
        ? and(eq(sessions.userId, userId), isNull(sessions.revokedAt))
        : and(
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            sql`${sessions.familyId} <> ${exceptFamilyId}`,
          );

    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(predicate)
      .returning({ id: sessions.id });
    return rows.length;
  }

  /** Looks up the family a presented refresh token belongs to, without rotating. */
  async familyOf(presentedToken: string): Promise<{ familyId: string; userId: string; orgId: string } | null> {
    const rows = await this.db
      .select({ familyId: sessions.familyId, userId: sessions.userId, orgId: sessions.orgId })
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, this.hash(presentedToken)))
      .limit(1);
    return rows[0] ?? null;
  }

  static get reasons(): typeof REVOCATION_REASONS {
    return REVOCATION_REASONS;
  }
}
