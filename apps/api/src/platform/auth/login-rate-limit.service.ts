import { randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@vyuha/shared';
import type { Redis } from 'ioredis';

import { AppError, describeError } from '../common/errors.js';
import { LuaScript } from '../redis/lua-script.js';
import { InjectRedis } from '../redis/redis.provider.js';
import { RateLimitDbFallback } from './rate-limit-db-fallback.service.js';

/**
 * REQ-B-10, second half: "20 [failed logins] per IP per 15 min."
 *
 * **In Redis**, so it survives a restart and holds across instances -- the
 * previous in-process version reset on every deploy and gave each instance its
 * own budget, which meant the effective limit was 20 times the number of
 * processes (docs OPEN-QUESTIONS P0-11). The per-account limit stays in
 * Postgres and is untouched; that one is what actually protects an account,
 * and this one is what makes a spray across many accounts expensive.
 *
 * A sorted set per address, scored by timestamp, is a genuine sliding window:
 * a fixed-window counter would let an attacker spend the full budget at
 * 14:59:59 and the full budget again at 15:00:01.
 *
 * **The check and the record are one Lua script**, and the attempt claims its
 * slot on the way in rather than reporting it on the way out. The previous
 * shape -- `assertWithinBudget` at the top of `login`, `recordFailure` after
 * the password had been checked -- was a check-then-act race with a whole
 * scrypt verification sitting inside the gap, so every request in flight read
 * the same count and passed. Measured against the booted production API: a
 * burst of sixty concurrent wrong passwords from one address produced sixty
 * 401s, no 429 at all, and left the window holding sixty members against a cap
 * of twenty. Sixty free guesses is not "twenty per fifteen minutes".
 *
 * Claiming on the way in means a request that then *succeeds* holds a slot for
 * the length of one sign-in. That is deliberate, and it is the only version
 * whose cap can hold, because nothing can tell a good password from a bad one
 * before checking it. Only *failed* attempts are counted at rest -- a success
 * calls `clear`, which drops the whole window for that address -- so the
 * self-inflicted denial of service the failure-only rule exists to prevent
 * (everyone in this product signs in from one office NAT within the same few
 * minutes, ADR 0002) needs the successes to be *simultaneous*, not merely
 * close together.
 *
 * Measured against the booted production build, since the trade is only worth
 * making if the numbers say so. One sign-in takes {min 48ms, p50 60ms}, almost
 * all of it scrypt, which is how long a slot is held. Twenty good sign-ins
 * fired in the same instant from one address: twenty 200s. Fifty spread across
 * one second, which is denser than any human arrival pattern: fifty 200s. The
 * refusal appears only past twenty *concurrently in flight* -- twenty-five at
 * once gives five 429s -- which is what a cap of twenty means, and is a soft
 * refusal that clears in one request rather than a lockout.
 *
 * **When Redis is unreachable, this falls back to the same check against
 * Postgres** (`RateLimitDbFallback`, one row per attempt, an advisory-lock
 * retry loop standing in for the Lua script's atomicity) rather than
 * dropping the limit outright. `redis.status === 'end'` is checked before
 * every command so a known outage skips straight to Postgres instead of
 * paying ioredis's retry budget first; a command that still throws on an
 * apparently-ready connection falls back reactively. Only if the Postgres
 * lock itself cannot be acquired either does this truly fail open, loudly --
 * the per-account lockout (five attempts, in Postgres, with an email notice)
 * stands regardless of which path ran. Every fail-open occurrence is logged
 * at error level, so "the per-IP limit is not currently in force" is visible
 * rather than assumed.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 20;

/**
 * What is being guessed. Each scope has its own budget per address, so an
 * attacker spraying agent tokens cannot spend the office's sign-in budget and
 * vice versa. 'login' keeps the original key format byte-for-byte.
 */
export type RateLimitScope = 'login' | 'agent' | 'webhook' | 'portal';

/** Exported so test support can clear an address without guessing the format. */
export function loginRateLimitKey(ip: string, scope: RateLimitScope = 'login'): string {
  // One template for every scope; 'login' produces the pre-scope key format
  // byte for byte, so nothing stored under the old spelling is orphaned.
  return `${scope}:failures:${ip}`;
}

/**
 * The slot one attempt holds, so the caller can hand it back.
 *
 * Null when there was no address to attribute the attempt to, which is the
 * same "do nothing at all" the rest of this class applies to a null IP.
 * `backend` says which store recorded it, since `release`/`clear` must
 * target the same one.
 */
export type LoginAttemptClaim =
  | { readonly backend: 'redis'; readonly ip: string; readonly member: string; readonly scope: RateLimitScope }
  | { readonly backend: 'db'; readonly ip: string; readonly scope: RateLimitScope; readonly rowId: string };

const CLAIMED = 1;
const REFUSED = 0;

/**
 * KEYS: the address window.
 * ARGV: window cutoff score, now, the member to record, the cap, the TTL in ms.
 *
 * Returns `{1, ''}` when the slot was taken, and `{0, <oldest score>}` when the
 * window was already full -- the oldest surviving failure is when it frees up,
 * and it has to be read inside the script or the answer can be stale by the
 * time it is used.
 */
const CLAIM_ATTEMPT = new LuaScript(`
local cutoff = ARGV[1]

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, oldest[2] or ''}
end

redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
-- Expiry is the whole eviction strategy. The previous version needed a
-- tracked-address cap and a hand-written sweep to stop a rotating source
-- turning the counter into a memory leak; Redis does it.
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return {1, ''}
`);

@Injectable()
export class LoginRateLimiter {
  private readonly logger = new Logger(LoginRateLimiter.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly dbFallback: RateLimitDbFallback,
  ) {}

  /**
   * Takes one of this address's slots, or throws RATE_LIMITED when there is
   * none left. The slot stands as a recorded failure unless the caller hands
   * it back with `release`, or clears the address with `clear`.
   */
  async claimAttempt(
    ip: string | null,
    now: number = Date.now(),
    scope: RateLimitScope = 'login',
  ): Promise<LoginAttemptClaim | null> {
    if (ip === null) return null;

    /*
     * Only a connection that is genuinely finished skips Redis.
     *
     * This read `status !== 'ready'`, which is true of a client that is
     * merely `connecting` -- which every client is for the first
     * milliseconds of its life, and again after any reconnect. So at boot,
     * and after every blip, every sign-in took the Postgres path; and that
     * path serialises on one advisory lock, so a burst exhausted its retry
     * budget and returned `lockUnavailable`, which fails open. Measured
     * before this change: a hundred concurrent failures from one address,
     * a hundred allowed, none refused, and an empty window.
     *
     * `enableOfflineQueue` is on, so a command issued while connecting is
     * buffered rather than lost, and `maxRetriesPerRequest` bounds the wait
     * before it throws into the catch below and falls back properly. Only
     * `end` -- a client that has been closed and will not reconnect -- is
     * worth short-circuiting.
     */
    if (this.redis.status !== 'ready') return this.claimViaDb(ip, now, scope);

    const key = loginRateLimitKey(ip, scope);
    // Unique per attempt: a sorted set deduplicates by member, so two failures
    // in the same millisecond would otherwise count once.
    const member = `${String(now)}-${randomBytes(6).toString('hex')}`;

    let outcome: unknown;
    try {
      outcome = await CLAIM_ATTEMPT.run(
        this.redis,
        [key],
        [
          String(now - WINDOW_MS),
          String(now),
          member,
          String(MAX_FAILURES_PER_IP),
          String(WINDOW_MS),
        ],
      );
    } catch (error: unknown) {
      this.logger.warn({
        msg: 'Redis command failed while claiming a login attempt; falling back to the Postgres limiter.',
        reason: describeError(error),
      });
      return this.claimViaDb(ip, now, scope);
    }

    const [status, oldestScore] = readClaim(outcome);
    if (status === CLAIMED) return { backend: 'redis', ip, member, scope };
    if (status !== REFUSED) {
      // Unreachable unless the script above is edited. Failing open matches
      // the outage posture rather than refusing every sign-in in the company,
      // but it is a defect in this file rather than a fact about the world.
      this.logger.error({
        msg: 'Login limiter script returned an unrecognised reply; the per-IP limit is NOT in force.',
        reply: String(status),
      });
      return null;
    }

    // The score of the oldest surviving failure is when the window frees up.
    const oldest = oldestScore === '' ? now : Number(oldestScore);
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));

    this.logger.warn({ msg: 'Login rate limit reached for address', ip });

    throw new AppError(
      ERROR_CODES.RATE_LIMITED,
      'Too many failed sign-in attempts from this network. Try again shortly.',
      { details: { retryAfterSeconds } },
    );
  }

  /** The Postgres path: same cap and window, enforced against `rate_limit_fallback_attempts` instead of a Redis sorted set. */
  private async claimViaDb(ip: string, now: number, scope: RateLimitScope): Promise<LoginAttemptClaim | null> {
    const decision = await this.dbFallback.tryAcquire(
      { bucket: scope, subject: ip, windowMs: WINDOW_MS, cap: MAX_FAILURES_PER_IP },
      now,
    );

    if ('rowId' in decision) return { backend: 'db', ip, scope, rowId: decision.rowId };

    if ('lockUnavailable' in decision) {
      this.logger.error({
        msg: 'Redis is unreachable and the Postgres fallback lock could not be acquired either; the per-IP login limit is NOT in force. The per-account lockout is unaffected.',
        ip,
      });
      return null;
    }

    this.logger.warn({ msg: 'Login rate limit reached for address (Postgres fallback)', ip });
    throw new AppError(
      ERROR_CODES.RATE_LIMITED,
      'Too many failed sign-in attempts from this network. Try again shortly.',
      { details: { retryAfterSeconds: decision.retryAfterSeconds } },
    );
  }

  /**
   * Hands a claimed slot back.
   *
   * For an attempt that ended in neither a success nor a credential refusal --
   * a database blip, a bug. Without it a dependency outage would spend an
   * office's whole budget on requests that never tested a password, and lock
   * everyone out for the window after the outage cleared.
   */
  async release(claim: LoginAttemptClaim | null): Promise<void> {
    if (claim === null) return;
    if (claim.backend === 'db') {
      await this.dbFallback.release(claim.rowId);
      return;
    }
    try {
      await this.redis.zrem(loginRateLimitKey(claim.ip, claim.scope), claim.member);
    } catch (error: unknown) {
      this.failOpen('releasing an attempt for', error);
    }
  }

  /** A successful sign-in clears the address; the failures were not an attack. */
  async clear(ip: string | null, scope: RateLimitScope = 'login'): Promise<void> {
    if (ip === null) return;
    if (this.redis.status === 'ready') {
      try {
        await this.redis.del(loginRateLimitKey(ip, scope));
      } catch (error: unknown) {
        this.failOpen('clearing', error);
      }
    }
    // Unconditional: a sign-in succeeding right after a Redis flap must not
    // leave stale Postgres-fallback rows behind for this address. Cheap --
    // an indexed delete that is usually zero rows.
    await this.dbFallback.clear(scope, ip);
  }

  private failOpen(action: string, error: unknown): void {
    this.logger.error({
      msg: `Redis is unavailable while ${action} the per-IP login limit; the limit is NOT in force. The per-account lockout is unaffected.`,
      reason: describeError(error),
    });
  }
}

/** The script's `{status, oldestScore}` pair, defended against anything else. */
function readClaim(reply: unknown): [number, string] {
  if (!Array.isArray(reply)) return [-1, ''];
  const [status, oldest] = reply as unknown[];
  return [typeof status === 'number' ? status : -1, typeof oldest === 'string' ? oldest : ''];
}
