import { randomInt } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  DEFAULT_MFA_POLICY,
  ERROR_CODES,
  MFA_CHALLENGE_MAX_ATTEMPTS,
  MFA_CHALLENGE_TTL_MINUTES,
  MFA_POLICIES,
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TRUSTED_DEVICE_DAYS,
  mfaPolicyRequires,
  type MfaEnrolmentStart,
  type MfaPolicy,
  type MfaRecoveryCodes,
  type MfaStatus,
  type MfaSummary,
} from '@vyuha/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { z } from 'zod';

import { AuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { env } from '../common/env.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { mfaChallenges, mfaRecoveryCodes, mfaTrustedDevices, settings, users } from '../db/schema/index.js';
import { holdsEveryPermissionOf, type Principal } from '../rbac/principal.js';
import { PrincipalService } from '../rbac/principal.service.js';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  isWellFormedToken,
  TOKEN_PURPOSES,
} from './opaque-token.js';
import { openSecret, sealSecret } from './secret-box.js';
import type { SessionRequestContext } from './session.service.js';

/**
 * REQ-B-09: two-step sign-in with an authenticator app.
 *
 * The secret is the one credential here that Vyuha must read back -- a
 * TOTP is computed from it on every check -- so it is sealed at rest with
 * `secret-box` under its own purpose, the way the webhook secret is. Every
 * other token in this file (recovery codes, the trusted-browser cookie, the
 * challenge between password and code) is presented by the client and only
 * ever compared, so it is stored as a keyed hash like the refresh token.
 *
 * The password step never issues a session once an authenticator is
 * confirmed: it answers with a challenge, five minutes long, spent by a
 * correct code or by five wrong ones. The code step is the only path from
 * a challenge to a session, and it cannot be reached without the password.
 */

const SETTINGS_KEY = 'security.mfa_policy';

function getTotpIssuer(): string {
  return (env.NODE_ENV as string) === 'production' ? 'Vyuha' : 'Vyuha (Dev)';
}

/** No 0/O or 1/I: a recovery code is read aloud and typed from paper. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_HALF = 5;

const policySchema = z.enum(MFA_POLICIES);

export interface IssuedChallenge {
  readonly token: string;
  readonly expiresInSeconds: number;
}

export interface RedeemedChallenge {
  readonly userId: string;
  readonly orgId: string;
  /** Set when the person asked for this browser to be remembered. */
  readonly trustToken: string | null;
}

@Injectable()
export class MfaService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly principals: PrincipalService,
    private readonly auditContext: AuditContext,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- policy

  /** The organisation's policy row, or the owner's default when none is set. */
  async policyFor(orgId: string): Promise<MfaPolicy> {
    const rows = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.orgId, orgId), eq(settings.scope, 'ORG'), isNull(settings.scopeId), eq(settings.key, SETTINGS_KEY), isNull(settings.deletedAt)))
      .limit(1);
    const parsed = policySchema.safeParse(rows[0]?.value);
    return parsed.success ? parsed.data : DEFAULT_MFA_POLICY;
  }

  /** Whether the policy requires it of this person, by the roles they hold now. */
  async isRequired(orgId: string, userId: string, roleNames?: readonly string[]): Promise<boolean> {
    const policy = await this.policyFor(orgId);
    if (policy === 'none') return false;
    if (policy === 'everyone') return true;
    const names = roleNames ?? (await this.principals.loadGrants(userId, orgId)).roles.map((role) => role.name);
    return mfaPolicyRequires(policy, names);
  }

  async summaryFor(orgId: string, userId: string, enabled: boolean, roleNames?: readonly string[]): Promise<MfaSummary> {
    const required = await this.isRequired(orgId, userId, roleNames);
    return { enabled, required, enrolmentRequired: required && !enabled };
  }

  // ---------------------------------------------------------------- status

  async status(principal: Principal, presentedTrustToken: string | null): Promise<MfaStatus> {
    const user = await this.loadUser(principal.userId);
    const enabled = user.totpConfirmedAt !== null;
    const required = await this.isRequired(principal.orgId, principal.userId, principal.roles.map((role) => role.name));
    const now = new Date();

    const [codes, devices] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(mfaRecoveryCodes)
        .where(and(eq(mfaRecoveryCodes.userId, principal.userId), isNull(mfaRecoveryCodes.usedAt))),
      this.db
        .select({
          id: mfaTrustedDevices.id,
          tokenHash: mfaTrustedDevices.tokenHash,
          userAgent: mfaTrustedDevices.userAgent,
          createdAt: mfaTrustedDevices.createdAt,
          expiresAt: mfaTrustedDevices.expiresAt,
        })
        .from(mfaTrustedDevices)
        .where(and(eq(mfaTrustedDevices.userId, principal.userId), isNull(mfaTrustedDevices.revokedAt)))
        .orderBy(mfaTrustedDevices.createdAt),
    ]);

    const presentedHash =
      presentedTrustToken !== null && isWellFormedToken(presentedTrustToken)
        ? hashOpaqueToken(TOKEN_PURPOSES.MFA_TRUST, presentedTrustToken, env.JWT_REFRESH_SECRET)
        : null;

    return {
      enabled,
      confirmedAt: user.totpConfirmedAt?.toISOString() ?? null,
      required,
      recoveryCodesLeft: enabled ? (codes[0]?.count ?? 0) : 0,
      trustedDevices: devices
        .filter((device) => device.expiresAt > now)
        .map((device) => ({
          id: device.id,
          userAgent: device.userAgent,
          createdAt: device.createdAt.toISOString(),
          expiresAt: device.expiresAt.toISOString(),
          current: presentedHash !== null && device.tokenHash === presentedHash,
        })),
    };
  }

  // ------------------------------------------------------------- enrolment

  /**
   * A fresh secret, sealed and stored unconfirmed. Starting again replaces
   * an unconfirmed secret (a person who closed the page halfway through is
   * not locked into a secret they never scanned); a confirmed one has to be
   * disabled with a code first, so a stolen session cannot swap the
   * authenticator out from under its owner.
   */
  async startEnrolment(principal: Principal): Promise<MfaEnrolmentStart> {
    const user = await this.loadUser(principal.userId);
    if (user.totpConfirmedAt !== null) {
      throw new AppError(ERROR_CODES.MFA_ALREADY_ENROLLED, 'An authenticator is already set up. Turn it off with a code before setting up a new one.');
    }
    const secret = new Secret({ size: 20 });
    const totp = this.totpFor(secret, user.email);
    await this.db
      .update(users)
      .set({ totpSecret: sealSecret(secret.base32, env.JWT_REFRESH_SECRET, 'totp'), totpConfirmedAt: null })
      .where(eq(users.id, principal.userId));
    return { secret: secret.base32, otpauthUri: totp.toString() };
  }

  /** The first correct code proves the app holds the secret; only then is it in force. */
  async confirmEnrolment(principal: Principal, code: string): Promise<MfaRecoveryCodes> {
    const user = await this.loadUser(principal.userId);
    if (user.totpConfirmedAt !== null) {
      throw new AppError(ERROR_CODES.MFA_ALREADY_ENROLLED, 'An authenticator is already set up.');
    }
    if (user.totpSecret === null) {
      throw new AppError(ERROR_CODES.MFA_NOT_ENROLLED, 'Start the set-up first.');
    }
    if (!(await this.totpMatches(user.id, user.totpSecret, user.email, code))) {
      throw new AppError(ERROR_CODES.MFA_CODE_INVALID, 'That code did not match. Codes change every thirty seconds; try the current one.');
    }
    const now = new Date();
    const codes = await this.db.transaction(async (tx) => {
      await tx.update(users).set({ totpConfirmedAt: now }).where(eq(users.id, principal.userId));
      return this.replaceRecoveryCodes(tx, principal.orgId, principal.userId);
    });
    this.auditContext.record({
      action: 'auth.mfa_enabled',
      entityType: 'user',
      entityId: principal.userId,
      after: { email: user.email, at: now.toISOString() },
    });
    return { codes };
  }

  /** A current code or an unused recovery code; either proves the person, not just the session. */
  async disable(principal: Principal, code: string): Promise<void> {
    const user = await this.loadUser(principal.userId);
    if (user.totpConfirmedAt === null || user.totpSecret === null) {
      throw new AppError(ERROR_CODES.MFA_NOT_ENROLLED, 'No authenticator is set up.');
    }
    await this.assertCode(user, code);
    await this.clearFor(principal.userId, 'disabled');
    this.auditContext.record({
      action: 'auth.mfa_disabled',
      entityType: 'user',
      entityId: principal.userId,
      after: { email: user.email },
    });
  }

  async regenerateRecoveryCodes(principal: Principal, code: string): Promise<MfaRecoveryCodes> {
    const user = await this.loadUser(principal.userId);
    if (user.totpConfirmedAt === null || user.totpSecret === null) {
      throw new AppError(ERROR_CODES.MFA_NOT_ENROLLED, 'No authenticator is set up.');
    }
    await this.assertCode(user, code);
    const codes = await this.db.transaction((tx) => this.replaceRecoveryCodes(tx, principal.orgId, principal.userId));
    this.auditContext.record({
      action: 'auth.mfa_recovery_codes_regenerated',
      entityType: 'user',
      entityId: principal.userId,
      after: { email: user.email, count: codes.length },
    });
    return { codes };
  }

  async revokeTrustedDevice(principal: Principal, deviceId: string): Promise<void> {
    const updated = await this.db
      .update(mfaTrustedDevices)
      .set({ revokedAt: new Date() })
      .where(and(eq(mfaTrustedDevices.id, deviceId), eq(mfaTrustedDevices.userId, principal.userId), isNull(mfaTrustedDevices.revokedAt)))
      .returning({ id: mfaTrustedDevices.id });
    if (updated.length === 0) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'That remembered browser is not yours, or is already forgotten.');
    }
    this.auditContext.record({
      action: 'auth.mfa_trusted_device_revoked',
      entityType: 'user',
      entityId: principal.userId,
      after: { deviceId },
    });
  }

  /**
   * An administrator's reset for a person whose phone is gone and whose
   * recovery codes are too. Everything is cleared; the person signs in with
   * the password alone and, if the policy requires it, is made to enrol
   * again before anything else. Audited with both names.
   */
  async resetForUser(principal: Principal, userId: string): Promise<void> {
    const rows = await this.db
      .select({ id: users.id, email: users.email, orgId: users.orgId, confirmedAt: users.totpConfirmedAt })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, principal.orgId), isNull(users.deletedAt)))
      .limit(1);
    const target = rows[0];
    if (target === undefined) throw new AppError(ERROR_CODES.NOT_FOUND, 'No such account in this organisation.');
    // Clearing the second factor is the first half of taking an account; the
    // reset link is the second. Refused unless the caller already holds
    // everything the target does, or employee.manage reaches the Admin who
    // granted it (SEC-1).
    const grants = await this.principals.loadGrants(target.id, principal.orgId);
    if (!holdsEveryPermissionOf(principal, grants.permissions)) {
      throw AppError.forbidden('That account holds permissions you do not, so you cannot reset it. Ask somebody who holds them.');
    }
    await this.clearFor(target.id, 'reset by administrator');
    this.auditContext.record({
      action: 'auth.mfa_reset',
      entityType: 'user',
      entityId: target.id,
      before: { email: target.email, enabled: target.confirmedAt !== null },
      after: { email: target.email, enabled: false, by: principal.email },
    });
  }

  // ------------------------------------------------------------ sign-in

  async isTrusted(userId: string, presentedToken: string | null): Promise<boolean> {
    if (presentedToken === null || !isWellFormedToken(presentedToken)) return false;
    const hash = hashOpaqueToken(TOKEN_PURPOSES.MFA_TRUST, presentedToken, env.JWT_REFRESH_SECRET);
    const rows = await this.db
      .select({ id: mfaTrustedDevices.id, expiresAt: mfaTrustedDevices.expiresAt })
      .from(mfaTrustedDevices)
      .where(and(eq(mfaTrustedDevices.tokenHash, hash), eq(mfaTrustedDevices.userId, userId), isNull(mfaTrustedDevices.revokedAt)))
      .limit(1);
    const row = rows[0];
    return row !== undefined && row.expiresAt > new Date();
  }

  async issueChallenge(orgId: string, userId: string, ip: string | null): Promise<IssuedChallenge> {
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_MINUTES * 60 * 1000);
    await this.db.insert(mfaChallenges).values({
      orgId,
      userId,
      tokenHash: hashOpaqueToken(TOKEN_PURPOSES.MFA_CHALLENGE, token, env.JWT_REFRESH_SECRET),
      ip,
      expiresAt,
    });
    await this.audit.write({
      orgId,
      actorUserId: userId,
      action: 'auth.login_mfa_challenged',
      entityType: 'user',
      entityId: userId,
      after: { ip },
    });
    return { token, expiresInSeconds: MFA_CHALLENGE_TTL_MINUTES * 60 };
  }

  /**
   * The wrong-code count is incremented in SQL from the row's own value, the
   * way the lockout counter is, so a burst of guesses costs a guess each.
   * The challenge is consumed on success and spent at the fifth failure;
   * either way it cannot be used again.
   */
  async redeemChallenge(token: string, code: string, trustDevice: boolean, context: SessionRequestContext): Promise<RedeemedChallenge> {
    if (!isWellFormedToken(token)) {
      throw new AppError(ERROR_CODES.MFA_CHALLENGE_EXPIRED, 'Sign in again to get a fresh code step.');
    }
    const hash = hashOpaqueToken(TOKEN_PURPOSES.MFA_CHALLENGE, token, env.JWT_REFRESH_SECRET);
    const rows = await this.db
      .select({
        id: mfaChallenges.id,
        userId: mfaChallenges.userId,
        orgId: mfaChallenges.orgId,
        attempts: mfaChallenges.attempts,
        expiresAt: mfaChallenges.expiresAt,
        consumedAt: mfaChallenges.consumedAt,
      })
      .from(mfaChallenges)
      .where(eq(mfaChallenges.tokenHash, hash))
      .limit(1);
    const challenge = rows[0];
    const now = new Date();
    if (challenge === undefined || challenge.consumedAt !== null || challenge.expiresAt <= now || challenge.attempts >= MFA_CHALLENGE_MAX_ATTEMPTS) {
      throw new AppError(ERROR_CODES.MFA_CHALLENGE_EXPIRED, 'That code step has expired. Sign in again.');
    }

    const user = await this.loadUser(challenge.userId);
    if (user.totpConfirmedAt === null || user.totpSecret === null) {
      // The authenticator was reset between the password and the code.
      throw new AppError(ERROR_CODES.MFA_CHALLENGE_EXPIRED, 'Sign in again.');
    }

    const ok = await this.codeMatches(user, code);
    if (!ok) {
      const bumped = await this.db
        .update(mfaChallenges)
        .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
        .where(eq(mfaChallenges.id, challenge.id))
        .returning({ attempts: mfaChallenges.attempts });
      const attempts = bumped[0]?.attempts ?? challenge.attempts + 1;
      await this.audit.write({
        orgId: challenge.orgId,
        actorUserId: challenge.userId,
        action: 'auth.login_mfa_failed',
        entityType: 'user',
        entityId: challenge.userId,
        after: { ip: context.ip, attempts },
      });
      const left = MFA_CHALLENGE_MAX_ATTEMPTS - attempts;
      throw new AppError(
        left > 0 ? ERROR_CODES.MFA_CODE_INVALID : ERROR_CODES.MFA_CHALLENGE_EXPIRED,
        left > 0 ? `That code did not match. ${String(left)} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Sign in again.',
      );
    }

    await this.db.update(mfaChallenges).set({ consumedAt: now }).where(eq(mfaChallenges.id, challenge.id));

    let trustToken: string | null = null;
    if (trustDevice) {
      trustToken = generateOpaqueToken();
      await this.db.insert(mfaTrustedDevices).values({
        orgId: challenge.orgId,
        userId: challenge.userId,
        tokenHash: hashOpaqueToken(TOKEN_PURPOSES.MFA_TRUST, trustToken, env.JWT_REFRESH_SECRET),
        userAgent: context.userAgent,
        ip: context.ip,
        expiresAt: new Date(now.getTime() + TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000),
      });
    }

    return { userId: challenge.userId, orgId: challenge.orgId, trustToken };
  }

  // --------------------------------------------------------------- internals

  private async loadUser(userId: string): Promise<{ id: string; email: string; totpSecret: string | null; totpConfirmedAt: Date | null }> {
    const rows = await this.db
      .select({ id: users.id, email: users.email, totpSecret: users.totpSecret, totpConfirmedAt: users.totpConfirmedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new AppError(ERROR_CODES.NOT_FOUND, 'No such account.');
    return row;
  }

  private totpFor(secret: Secret, email: string): TOTP {
    return new TOTP({ issuer: getTotpIssuer(), label: email, algorithm: 'SHA1', digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS, secret });
  }

  /**
   * One step either side: a phone's clock a few seconds out is not a wrong
   * code. A match answers with the step it matched, because a correct code
   * must also be an unspent one -- the server remembers the last step it
   * accepted (users.totp_last_step) and the same six digits cannot pass
   * twice inside their window (OPEN-QUESTIONS, two-step sign-in, closed
   * 28 Aug 2026).
   */
  private totpStepOf(sealedSecret: string, email: string, code: string): number | null {
    if (!/^\d{6}$/u.test(code)) return null;
    const secret = Secret.fromBase32(openSecret(sealedSecret, env.JWT_REFRESH_SECRET, 'totp'));
    const delta = this.totpFor(secret, email).validate({ token: code, window: 1 });
    if (delta === null) return null;
    return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS) + delta;
  }

  /**
   * Check and spend in one UPDATE: the row moves forward only if the step is
   * new, so two concurrent submissions of the same code cannot both pass.
   */
  private async totpMatches(userId: string, sealedSecret: string, email: string, code: string): Promise<boolean> {
    const step = this.totpStepOf(sealedSecret, email, code);
    if (step === null) return false;
    const spent = await this.db
      .update(users)
      .set({ totpLastStep: step })
      .where(and(eq(users.id, userId), sql`(${users.totpLastStep} IS NULL OR ${users.totpLastStep} < ${step})`))
      .returning({ id: users.id });
    return spent.length > 0;
  }

  /** A current code, or an unused recovery code, which this spends. */
  private async codeMatches(user: { id: string; email: string; totpSecret: string | null }, code: string): Promise<boolean> {
    if (user.totpSecret !== null && (await this.totpMatches(user.id, user.totpSecret, user.email, code))) return true;
    const normalised = code.replace(/[^A-Za-z0-9]/gu, '').toUpperCase();
    if (normalised.length !== RECOVERY_HALF * 2) return false;
    const hash = hashOpaqueToken(TOKEN_PURPOSES.MFA_RECOVERY, normalised, env.JWT_REFRESH_SECRET);
    const spent = await this.db
      .update(mfaRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(mfaRecoveryCodes.codeHash, hash), eq(mfaRecoveryCodes.userId, user.id), isNull(mfaRecoveryCodes.usedAt)))
      .returning({ id: mfaRecoveryCodes.id });
    return spent.length > 0;
  }

  private async assertCode(user: { id: string; email: string; totpSecret: string | null }, code: string): Promise<void> {
    if (!(await this.codeMatches(user, code))) {
      throw new AppError(ERROR_CODES.MFA_CODE_INVALID, 'That code did not match.');
    }
  }

  private async replaceRecoveryCodes(tx: Pick<Database, 'delete' | 'insert'>, orgId: string, userId: string): Promise<string[]> {
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => this.recoveryCode());
    await tx.insert(mfaRecoveryCodes).values(
      codes.map((code) => ({
        orgId,
        userId,
        codeHash: hashOpaqueToken(TOKEN_PURPOSES.MFA_RECOVERY, code.replace('-', ''), env.JWT_REFRESH_SECRET),
      })),
    );
    return codes;
  }

  private recoveryCode(): string {
    const pick = () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)] ?? 'A';
    const half = () => Array.from({ length: RECOVERY_HALF }, pick).join('');
    return `${half()}-${half()}`;
  }

  private async clearFor(userId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ totpSecret: null, totpConfirmedAt: null, totpLastStep: null }).where(eq(users.id, userId));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
      await tx
        .update(mfaTrustedDevices)
        .set({ revokedAt: new Date() })
        .where(and(eq(mfaTrustedDevices.userId, userId), isNull(mfaTrustedDevices.revokedAt)));
      await tx
        .update(mfaChallenges)
        .set({ consumedAt: new Date() })
        .where(and(eq(mfaChallenges.userId, userId), isNull(mfaChallenges.consumedAt)));
    });
    void reason;
  }
}
