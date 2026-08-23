import { randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { describeError } from '../common/errors.js';
import { LuaScript } from '../redis/lua-script.js';
import { InjectRedis } from '../redis/redis.provider.js';
import { RateLimitDbFallback } from './rate-limit-db-fallback.service.js';

/**
 * REQ-B-04's missing half, found live by the pre-deploy gate: sixty rapid
 * requests to `POST /auth/password-resets` produced sixty 202s and forty-odd
 * real emails. The endpoint's enumeration-resistant design -- always 202,
 * never a hint -- made it a free mailbox-bombing primitive.
 *
 * Same shape as `LoginRateLimiter`, deliberately: Redis sorted sets as a
 * genuine sliding window, one key per subject, expiry as the whole eviction
 * strategy. Two subjects rather than one, because they stop different abuse:
 * the per-address cap is what protects a mailbox from being flooded, and the
 * per-IP budget is what makes spraying many addresses from one place
 * expensive. The address is keyed lower-cased, matching the unique index the
 * account lookup uses, so `User@` and `user@` spend one budget.
 *
 * The crucial difference from the login limiter: a throttled request must
 * never *say* it was throttled. A 429 for one address and a 202 for another
 * would reintroduce, through the limiter, exactly the enumeration oracle the
 * endpoint was shaped to avoid -- so the caller asks `tryAcquire` and, when
 * refused, silently skips the insert and the send while still answering 202.
 *
 * **When Redis is unreachable this falls back to Postgres** (`RateLimitDbFallback`,
 * same pair-of-independent-budgets check run inside one advisory-locked
 * transaction), for the login limiter's reason: a dead cache must not stop a
 * genuine "I forgot my password" from working. Only if the Postgres lock
 * itself cannot be acquired either does this truly fail open, loudly, and
 * every occurrence is logged at error level so "the cap is not currently in
 * force" is visible rather than assumed.
 *
 * The decision and the record it is based on are **one Lua script**, and that
 * is the whole control rather than a detail of it. The first version probed
 * with ZREMRANGEBYSCORE + ZCARD, decided in Node, and only then ZADDed on a
 * second round trip -- so every request in flight during that gap read a count
 * of zero and passed. Measured against the booted production API: a sequential
 * burst of twenty-five to one address gave three emails, and a *concurrent*
 * burst of twenty-five gave eight, a hundred gave fifty-nine, with the sorted
 * set left holding fifty-nine members -- it recorded them all after letting
 * them through. Adding `&` to the attacker's loop reopened the exact
 * mailbox-bombing primitive this class was added to close. Redis evaluates a
 * script to completion before serving another command, which is also the only
 * version whose cap holds across more than one API instance.
 */

const WINDOW_MS = 60 * 60 * 1000;
/** Three real emails per mailbox per hour is plenty for a person at a login screen. */
const MAX_PER_EMAIL = 3;
/** Matches the login limiter's per-IP number: one office NAT, many people. */
const MAX_PER_IP = 20;

const EMAIL_PREFIX = 'pwreset:email:';
const IP_PREFIX = 'pwreset:ip:';

/** Exported so test support can clear a subject without guessing the format. */
export function passwordResetEmailKey(email: string): string {
  return `${EMAIL_PREFIX}${email.toLowerCase()}`;
}

export function passwordResetIpKey(ip: string): string {
  return `${IP_PREFIX}${ip}`;
}

/** What the script returns, so the caller can still name the spent subject. */
const OVER_EMAIL_BUDGET = 0;
const OVER_IP_BUDGET = -1;
const ACQUIRED = 1;

/**
 * KEYS: the address window, then the IP window when there is one.
 * ARGV: window cutoff score, now, the member to record, the key TTL in ms,
 *       the per-address cap, the per-IP cap.
 *
 * Both windows are pruned and read before either is written, so a request that
 * is refused on the IP budget leaves no mark on the address budget -- the two
 * caps stay independent instead of one spending the other.
 */
const TRY_ACQUIRE = new LuaScript(`
local cutoff = ARGV[1]
local now = ARGV[2]
local member = ARGV[3]
local ttl = ARGV[4]

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) then return 0 end

if KEYS[2] then
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
  if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[6]) then return -1 end
end

redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], ttl)
if KEYS[2] then
  redis.call('ZADD', KEYS[2], now, member)
  redis.call('PEXPIRE', KEYS[2], ttl)
end
return 1
`);

@Injectable()
export class PasswordResetRateLimiter {
  private readonly logger = new Logger(PasswordResetRateLimiter.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly dbFallback: RateLimitDbFallback,
  ) {}

  /**
   * True when this request may insert a reset row and send the email; false
   * when either window is spent. An allowed request is recorded against both
   * windows in the same call -- every request counts, known address or not,
   * so the limiter's behaviour cannot be used to tell the two apart.
   */
  async tryAcquire(email: string, ip: string | null, now: number = Date.now()): Promise<boolean> {
    // `end`, not `!== 'ready'`: a client that is merely connecting -- which
    // every client is at boot and after any reconnect -- would otherwise send
    // every reset request down the Postgres path. See the note in
    // login-rate-limit.service.ts.
    if (this.redis.status === 'end') return this.tryAcquireViaDb(email, ip, now);

    const emailKey = passwordResetEmailKey(email);
    const ipKey = ip === null ? null : passwordResetIpKey(ip);

    // Unique per attempt: a sorted set deduplicates by member, so a burst
    // within one millisecond would otherwise count once.
    const member = `${String(now)}-${randomBytes(6).toString('hex')}`;

    let outcome: unknown;
    try {
      outcome = await TRY_ACQUIRE.run(
        this.redis,
        ipKey === null ? [emailKey] : [emailKey, ipKey],
        [
          String(now - WINDOW_MS),
          String(now),
          member,
          String(WINDOW_MS),
          String(MAX_PER_EMAIL),
          String(MAX_PER_IP),
        ],
      );
    } catch (error: unknown) {
      this.logger.warn({
        msg: 'Redis command failed for the password-reset limit; falling back to the Postgres limiter.',
        reason: describeError(error),
      });
      return this.tryAcquireViaDb(email, ip, now);
    }

    if (outcome === ACQUIRED) return true;

    if (outcome === OVER_EMAIL_BUDGET || outcome === OVER_IP_BUDGET) {
      // The address itself stays out of the log, as everywhere on this path.
      this.logger.warn({
        msg: 'Password reset request over budget; answering 202 and sending nothing.',
        subject: outcome === OVER_EMAIL_BUDGET ? 'email' : 'ip',
        ip,
      });
      return false;
    }

    // Unreachable unless the script above is edited into something that
    // returns another value. Failing open matches the outage posture rather
    // than turning an always-202 endpoint into a 500, but it is a defect in
    // this file rather than a fact about the world, so it says so.
    this.logger.error({
      msg: 'Password reset limiter script returned an unrecognised reply; the cap is NOT in force.',
      reply: String(outcome),
    });
    return true;
  }

  /** The Postgres path: same two independent budgets, checked in one advisory-locked transaction. */
  private async tryAcquireViaDb(email: string, ip: string | null, now: number): Promise<boolean> {
    const decision = await this.dbFallback.tryAcquirePair(
      { bucket: 'pwreset:email', subject: email.toLowerCase(), windowMs: WINDOW_MS, cap: MAX_PER_EMAIL },
      ip === null ? null : { bucket: 'pwreset:ip', subject: ip, windowMs: WINDOW_MS, cap: MAX_PER_IP },
      now,
    );

    if (decision.acquired) return true;

    if ('lockUnavailable' in decision) {
      this.logger.error({
        msg: 'Redis is unreachable and the Postgres fallback lock could not be acquired either; the password-reset cap is NOT in force.',
      });
      return true;
    }

    this.logger.warn({
      msg: 'Password reset request over budget (Postgres fallback); answering 202 and sending nothing.',
      subject: decision.which === 'a' ? 'email' : 'ip',
      ip,
    });
    return false;
  }
}
