import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { describeError } from '../common/errors.js';
import { InjectDatabase, type Database, type Transaction } from '../db/db.provider.js';

/**
 * Postgres fallback for the Redis sorted-set rate limiters
 * (`LoginRateLimiter`, `PasswordResetRateLimiter`), used when
 * `redis.status === 'end'` or a Redis command itself throws.
 *
 * Replicates the Lua scripts' prune-then-check-then-record shape one row per
 * attempt (not a single counter+window-start row, which only approximates a
 * sliding window) so the fallback enforces the same cap the Redis path does,
 * not a looser one.
 *
 * Atomicity: `pg_try_advisory_xact_lock` + a bounded retry loop, exactly
 * `PunchRepository.withPunchOrderingLock`'s pattern
 * (`apps/api/src/modules/attendance/punch/punch.repository.ts`) — not the
 * blocking `pg_advisory_xact_lock` this could have started as. A blocking
 * lock held inside an open transaction parks one of the pool's ten
 * connections for as long as the other side takes; that pattern already
 * caused a real production outage here once (see that file's comment). The
 * try-lock-and-retry keeps every wait outside any open transaction.
 */

/** Must not collide with `PUNCH_ORDERING_LOCK_NAMESPACE` (4001) or any future namespace. */
export const RATE_LIMIT_FALLBACK_LOCK_NAMESPACE = 4002;

/**
 * Wider than `withPunchOrderingLock`'s 12x25ms: that lock's realistic
 * contention is two people punching the same employee at once, while this
 * one's realistic contention is exactly what it exists to survive -- a
 * credential-stuffing burst hammering one IP, dozens of requests deep. Forty
 * attempts is a one-second ceiling, worth paying only while Redis is *also*
 * down, to actually enforce the cap under a real burst instead of exhausting
 * a short retry budget and falling all the way open.
 */
const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_MS = 25;

/** How long a spent attempt is kept around before the hourly sweep clears it. */
const CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface RateLimitSpec {
  readonly bucket: string;
  readonly subject: string;
  readonly windowMs: number;
  readonly cap: number;
}

export type SingleDecision =
  | { readonly acquired: true; readonly rowId: string }
  | { readonly acquired: false; readonly retryAfterSeconds: number }
  | { readonly acquired: false; readonly lockUnavailable: true };

export type PairDecision =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly which: 'a' | 'b' }
  | { readonly acquired: false; readonly lockUnavailable: true };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class RateLimitDbFallback implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RateLimitDbFallback.name);
  private cleanupTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(@InjectDatabase() private readonly db: Database) {}

  onApplicationBootstrap(): void {
    this.scheduleCleanup();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.cleanupTimer !== undefined) clearTimeout(this.cleanupTimer);
  }

  /** Single-subject check-and-record, for `LoginRateLimiter`. */
  async tryAcquire(spec: RateLimitSpec, now: number = Date.now()): Promise<SingleDecision> {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(LOCK_RETRY_MS);

      const outcome = await this.db.transaction(async (tx) => {
        if (!(await this.tryLock(tx, spec.bucket, spec.subject))) return { locked: false as const };

        const { count, oldest } = await this.pruneAndCount(tx, spec.bucket, spec.subject, now - spec.windowMs);
        if (count >= spec.cap) {
          const retryAfterSeconds = Math.max(1, Math.ceil(((oldest?.getTime() ?? now) + spec.windowMs - now) / 1000));
          return { locked: true as const, decision: { acquired: false, retryAfterSeconds } as SingleDecision };
        }

        const rowId = await this.insertAttempt(tx, spec.bucket, spec.subject, now);
        return { locked: true as const, decision: { acquired: true, rowId } as SingleDecision };
      });

      if (outcome.locked) return outcome.decision;
    }

    return { acquired: false, lockUnavailable: true };
  }

  /**
   * Two independent subjects checked in one transaction before either is
   * written, matching `PasswordResetRateLimiter`'s Lua script (a refusal on
   * one budget must leave no mark on the other).
   */
  async tryAcquirePair(a: RateLimitSpec, b: RateLimitSpec | null, now: number = Date.now()): Promise<PairDecision> {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(LOCK_RETRY_MS);

      const outcome = await this.db.transaction(async (tx) => {
        if (!(await this.tryLock(tx, a.bucket, a.subject))) return { locked: false as const };
        if (b !== null && !(await this.tryLock(tx, b.bucket, b.subject))) return { locked: false as const };

        const stateA = await this.pruneAndCount(tx, a.bucket, a.subject, now - a.windowMs);
        if (stateA.count >= a.cap) {
          return { locked: true as const, decision: { acquired: false, which: 'a' } as PairDecision };
        }

        if (b !== null) {
          const stateB = await this.pruneAndCount(tx, b.bucket, b.subject, now - b.windowMs);
          if (stateB.count >= b.cap) {
            return { locked: true as const, decision: { acquired: false, which: 'b' } as PairDecision };
          }
        }

        await this.insertAttempt(tx, a.bucket, a.subject, now);
        if (b !== null) await this.insertAttempt(tx, b.bucket, b.subject, now);
        return { locked: true as const, decision: { acquired: true } as PairDecision };
      });

      if (outcome.locked) return outcome.decision;
    }

    return { acquired: false, lockUnavailable: true };
  }

  /** Hands a claimed slot back. No lock needed — a bare delete can't corrupt the check-then-insert decision above. */
  async release(rowId: string): Promise<void> {
    try {
      await this.db.execute(sql`DELETE FROM rate_limit_fallback_attempts WHERE id = ${rowId}`);
    } catch (error: unknown) {
      this.logger.error({ msg: 'Could not release a DB-fallback rate-limit attempt.', reason: describeError(error) });
    }
  }

  /** A successful attempt clears its bucket, regardless of which backend (Redis or DB) recorded it. */
  async clear(bucket: string, subject: string): Promise<void> {
    try {
      await this.db.execute(
        sql`DELETE FROM rate_limit_fallback_attempts WHERE bucket = ${bucket} AND subject = ${subject}`,
      );
    } catch (error: unknown) {
      this.logger.error({ msg: 'Could not clear a DB-fallback rate-limit bucket.', reason: describeError(error) });
    }
  }

  private async tryLock(tx: Transaction, bucket: string, subject: string): Promise<boolean> {
    const rows = await tx.execute<{ taken: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${RATE_LIMIT_FALLBACK_LOCK_NAMESPACE}, hashtext(${`${bucket}:${subject}`})) AS taken`,
    );
    return rows.rows[0]?.taken === true;
  }

  private async pruneAndCount(
    tx: Transaction,
    bucket: string,
    subject: string,
    cutoffMs: number,
  ): Promise<{ count: number; oldest: Date | null }> {
    await tx.execute(
      sql`DELETE FROM rate_limit_fallback_attempts WHERE bucket = ${bucket} AND subject = ${subject} AND attempted_at < ${new Date(cutoffMs)}`,
    );
    // Raw `execute()` rows are the driver's own values, not schema-typed --
    // `oldest` can arrive as a string rather than a Date depending on the
    // driver's type parsing, so it is normalized here rather than trusted.
    const rows = await tx.execute<{ count: number; oldest: string | Date | null }>(
      sql`SELECT count(*)::int AS count, min(attempted_at) AS oldest FROM rate_limit_fallback_attempts WHERE bucket = ${bucket} AND subject = ${subject}`,
    );
    const row = rows.rows[0];
    if (row === undefined) return { count: 0, oldest: null };
    return { count: row.count, oldest: row.oldest === null ? null : new Date(row.oldest) };
  }

  private async insertAttempt(tx: Transaction, bucket: string, subject: string, nowMs: number): Promise<string> {
    const rows = await tx.execute<{ id: string }>(
      sql`INSERT INTO rate_limit_fallback_attempts (bucket, subject, attempted_at) VALUES (${bucket}, ${subject}, ${new Date(nowMs)}) RETURNING id`,
    );
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error('Rate-limit fallback insert returned no row.');
    return id;
  }

  /**
   * Abandoned rows (a subject rate-limited once and never seen again) are
   * never cleaned by prune-on-read alone. A BullMQ-scheduled purge job isn't
   * available here — that would be circular, since this exists because
   * Redis/BullMQ is down — so a self-rescheduling timer does it instead.
   */
  private scheduleCleanup(): void {
    const tick = async (): Promise<void> => {
      try {
        await this.db.execute(
          sql`DELETE FROM rate_limit_fallback_attempts WHERE attempted_at < ${new Date(Date.now() - CLEANUP_MAX_AGE_MS)}`,
        );
      } catch (error: unknown) {
        this.logger.warn({ msg: 'Rate-limit fallback cleanup sweep failed.', reason: describeError(error) });
      }
      if (!this.stopped) this.cleanupTimer = setTimeout(() => void tick(), CLEANUP_INTERVAL_MS);
    };
    this.cleanupTimer = setTimeout(() => void tick(), CLEANUP_INTERVAL_MS);
  }
}
