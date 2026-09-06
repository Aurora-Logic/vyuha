import { Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  INVITATION_TTL_HOURS,
  PASSWORD_RESET_TTL_MINUTES,
  PERMISSIONS,
  type InvitationResult,
  type PasswordResetLink,
  type SignInAccount,
} from '@vyuha/shared';
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { env } from '../common/env.js';
import { AppError, describeError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { uniqueViolationConstraint } from '../db/pg-error.js';
import { JobRunner } from '../jobs/job-runner.service.js';
import {
  employees,
  invitations,
  passwordResets,
  roles,
  userRoles,
  users,
} from '../db/schema/index.js';
import { Mailer, type OutboundMail } from '../mail/mailer.js';
import { holdsEveryPermissionOf, type Principal } from '../rbac/principal.js';
import { PrincipalService } from '../rbac/principal.service.js';
import type {
  CreateInvitationDto,
  LoginDto,
  LoginOutcome,
  LoginResponse,
  MeResponse,
} from './auth.dto.js';
import { AccessWindowService } from './access-window.service.js';
import { signAccessToken } from './jwt.js';
import { LoginRateLimiter } from './login-rate-limit.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordResetRateLimiter } from './password-reset-rate-limit.service.js';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  isWellFormedToken,
  TOKEN_PURPOSES,
} from './opaque-token.js';
import { hashPassword, needsRehash, verifyPassword } from './password.js';
import { assertPasswordAcceptable } from './password-policy.js';
import { INVITATION_PATH, PASSWORD_RESET_PATH, tokenLink } from './web-links.js';
import { SessionService, type SessionRequestContext } from './session.service.js';

/**
 * The auth surface (REQ-B-01 … REQ-B-10).
 *
 * There is no signup method here and no route that could reach one. ADR 0002:
 * "Account creation happens one way only: Admin or HR issues an invitation
 * against an existing employee record ... Absence of a route is the access
 * control."
 */

/** REQ-B-10: five failures per account per fifteen minutes, then fifteen locked. */
const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * The refusals that are a failed sign-in attempt and must cost the address a
 * slot in the per-IP window. Everything else `login` can throw is a fault
 * rather than an attempt, and gives its slot back.
 */
const COUNTED_AGAINST_THE_ADDRESS: ReadonlySet<string> = new Set([
  ERROR_CODES.INVALID_CREDENTIALS,
  ERROR_CODES.ACCOUNT_LOCKED,
  ERROR_CODES.ACCOUNT_INACTIVE,
]);

/**
 * REQ-B-03: single-use, 72 hours. REQ-B-04: single-use, 30 minutes.
 *
 * Derived from the shared constants rather than restated, so the sentence the
 * invite dialog prints and the deadline the row carries cannot drift apart.
 */
const INVITATION_TTL_MS = INVITATION_TTL_HOURS * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60 * 1000;

/**
 * A correct password ends in a session, or -- once an authenticator is
 * confirmed and this browser is not remembered -- in a challenge that
 * carries no session at all (REQ-B-09). The controller sets the refresh
 * cookie only when there is a token to set.
 */
export interface LoginResult {
  readonly response: LoginOutcome;
  readonly refreshToken: string | null;
  /** The refresh cookie's life; null is a session cookie. */
  readonly cookieMaxAgeMs?: number | null;
  /** Set when the code step asked for this browser to be remembered. */
  readonly trustToken?: string | null;
}

export interface RefreshResult {
  readonly response: LoginResponse;
  readonly refreshToken: string;
  readonly cookieMaxAgeMs: number | null;
}

/**
 * `InvitationResult`, `PasswordResetLink` and `SignInAccount` are declared in
 * `@vyuha/shared` and re-exported here, so the controller keeps importing its
 * return types from the service it calls while the web client parses the same
 * shape.
 */
export type { InvitationResult, PasswordResetLink, SignInAccount };

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly sessions: SessionService,
    private readonly principals: PrincipalService,
    private readonly rateLimiter: LoginRateLimiter,
    private readonly resetLimiter: PasswordResetRateLimiter,
    private readonly mailer: Mailer,
    private readonly auditContext: AuditContext,
    private readonly audit: AuditService,
    private readonly jobs: JobRunner,
    private readonly accessWindow: AccessWindowService,
    private readonly mfa: MfaService,
  ) {}

  // ---------------------------------------------------------------- login

  /**
   * The per-IP slot is claimed *before* the attempt rather than recorded after
   * it, because the password check sits between the two and every request in
   * flight during that gap used to read the same count (see
   * `LoginRateLimiter`). The claim is what makes the attempt cost budget, so
   * the failure branches below no longer record anything of their own.
   */
  async login(input: LoginDto, context: SessionRequestContext, trustToken: string | null = null): Promise<LoginResult> {
    const claim = await this.rateLimiter.claimAttempt(context.ip);

    try {
      return await this.attemptLogin(input, context, trustToken);
    } catch (error: unknown) {
      // A refusal this limiter exists to count keeps its slot. Anything else --
      // a database blip, a bug -- hands it back, so an outage cannot spend an
      // office's whole budget on requests that never tested a password.
      if (!(error instanceof AppError) || !COUNTED_AGAINST_THE_ADDRESS.has(error.code)) {
        await this.rateLimiter.release(claim);
      }
      throw error;
    }
  }

  private async attemptLogin(
    input: LoginDto,
    context: SessionRequestContext,
    trustToken: string | null,
  ): Promise<LoginResult> {
    const user = await this.findByEmail(input.email);
    const now = new Date();

    // REQ-B-10: a lockout holds even for the correct password. Checked before
    // the hash so a locked account costs nothing to refuse -- and so that a
    // brute-force run cannot use the lockout window to keep testing passwords.
    if (user !== null && user.lockedUntil !== null && user.lockedUntil > now) {
      throw new AppError(ERROR_CODES.ACCOUNT_LOCKED, 'This account is temporarily locked.', {
        details: { lockedUntil: user.lockedUntil.toISOString() },
      });
    }

    // Runs against a decoy hash when there is no user, so the response takes
    // the same time either way and login cannot be used to discover which
    // addresses have accounts.
    const correct = await verifyPassword(input.password, user?.passwordHash ?? null);

    if (!correct || user === null) {
      if (user !== null) await this.recordFailedAttempt(user, now);
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'Email or password is incorrect.');
    }

    // Only after the password is proven. Telling an unauthenticated caller
    // that an account exists but is suspended is the same leak as telling them
    // it exists at all.
    if (user.status !== 'ACTIVE') {
      throw new AppError(
        ERROR_CODES.ACCOUNT_INACTIVE,
        user.status === 'INVITED'
          ? 'This account has not accepted its invitation yet.'
          : 'This account is suspended.',
      );
    }

    await this.rateLimiter.clear(context.ip);

    // 12 REQ-AB-01/AB-03/AB-08: outside the window only an exempt account
    // signs in; every refusal is audited with the account and the time.
    const verdict = await this.accessWindow.verdict(user.orgId);
    if (verdict.closed) {
      // No session exists yet, so the principal cannot be resolved; the one
      // key that matters is read straight from the role grants.
      const exempt = await this.accessWindow.holdsExemption(user.id);
      if (!exempt) {
        // Direct, as the lockout is: the request answers 403 and the
        // interceptor only audits successes (REQ-AB-08).
        await this.audit.write({
          orgId: user.orgId,
          actorUserId: user.id,
          action: 'auth.login_refused_window',
          entityType: 'user',
          entityId: user.id,
          after: { email: user.email, reopensAt: verdict.reopensAt, at: now.toISOString() },
        });
        throw this.accessWindow.refusal(verdict);
      }
    }

    // REQ-B-09: the password was right. With an authenticator confirmed and
    // no remembered browser, what follows is the code step, not a session.
    // The failure counters are not reset here: the account is not signed in
    // until the code is, and a guessed password must not clear them.
    if (user.totpConfirmedAt !== null && !(await this.mfa.isTrusted(user.id, trustToken))) {
      const challenge = await this.mfa.issueChallenge(user.orgId, user.id, context.ip);
      return {
        refreshToken: null,
        response: { mfaRequired: true, challengeToken: challenge.token, expiresInSeconds: challenge.expiresInSeconds },
      };
    }

    return this.openSession(user, context, input.password);
  }

  /**
   * REQ-B-09: the code step. The challenge names the account and proves the
   * password was already right; a correct code is the second factor, and
   * only then does a session exist.
   */
  async completeMfa(challengeToken: string, code: string, trustDevice: boolean, context: SessionRequestContext): Promise<LoginResult> {
    const redeemed = await this.mfa.redeemChallenge(challengeToken, code, trustDevice, context);
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, redeemed.userId), isNull(users.deletedAt)))
      .limit(1);
    const user = rows[0];
    if (user === undefined || user.status !== 'ACTIVE') {
      throw new AppError(ERROR_CODES.ACCOUNT_INACTIVE, 'This account is not active.');
    }
    const result = await this.openSession(user, context, null);
    return { ...result, trustToken: redeemed.trustToken };
  }

  /** What a proven sign-in does: the session family, the counters, the trail. */
  private async openSession(
    user: { id: string; orgId: string; email: string; passwordHash: string | null },
    context: SessionRequestContext,
    plaintextPassword: string | null,
  ): Promise<LoginResult> {
    const now = new Date();
    const session = await this.sessions.startFamily(user.orgId, user.id, context);

    await this.db
      .update(users)
      .set({
        lastLoginAt: now,
        failedAttempts: 0,
        failedAttemptsSince: null,
        lockedUntil: null,
        // ADR 0002: "password hashes carry their parameters so old hashes stay
        // verifiable after a change". A successful login is the only moment
        // the plaintext is available to upgrade one.
        ...(plaintextPassword !== null && needsRehash(user.passwordHash)
          ? { passwordHash: await hashPassword(plaintextPassword) }
          : {}),
      })
      .where(eq(users.id, user.id));

    this.auditContext.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      after: { sessionId: session.sessionId, ip: context.ip },
    });

    return {
      refreshToken: session.refreshToken,
      cookieMaxAgeMs: session.cookieMaxAgeMs,
      response: await this.accessResponse(user.orgId, user.id, user.email, session.sessionId),
    };
  }

  /**
   * REQ-B-10. The window is what makes this "five per fifteen minutes" rather
   * than "five ever": a run of failures older than the window is a different
   * run, and starts the count again.
   *
   * The count is incremented **in SQL, from the row's own value**, not read in
   * Node and written back. The read-modify-write it replaces was a check-then-
   * act race with a scrypt verification inside the gap: measured against the
   * booted production build, twenty-five concurrent wrong passwords all read
   * `failed_attempts = 0` and collapsed into a single increment, leaving the
   * account at 2 and unlocked -- twenty-five guesses for two of a five-attempt
   * budget. Postgres takes a row lock for an UPDATE and re-evaluates the SET
   * expressions against the version the previous writer committed, so N
   * concurrent failures now cost N of the budget.
   *
   * The notice and the trail entry are written by whichever attempt saw the
   * count reach the cap *exactly*, not by every attempt at or past it. Each
   * statement adds one, so exactly one attempt sees the crossing however many
   * ran together -- otherwise a concurrent burst would send one lockout email
   * per guess to somebody whose only involvement is owning the address.
   *
   * What this does not do, because it cannot: stop a burst that is already in
   * flight. Every request in a concurrent burst reads `locked_until` before
   * any of them has failed, so all of them get their password tested. The cap
   * that bounds a burst is the per-IP one in `LoginRateLimiter`, which refuses
   * past twenty; this one guarantees the account's own budget is spent
   * honestly and that the lock is standing by the time the burst is over.
   */
  private async recordFailedAttempt(
    user: { id: string; orgId: string; email: string },
    now: Date,
  ): Promise<void> {
    const windowStart = new Date(now.getTime() - ATTEMPT_WINDOW_MS);

    // Every branch reads the row as it stands at the moment the update runs.
    const windowOpen = sql`${users.failedAttemptsSince} IS NOT NULL AND ${users.failedAttemptsSince} > ${windowStart}`;
    const nextAttempts = sql`CASE WHEN ${windowOpen} THEN ${users.failedAttempts} + 1 ELSE 1 END`;

    const rows = await this.db
      .update(users)
      .set({
        failedAttempts: nextAttempts,
        failedAttemptsSince: sql`CASE WHEN ${windowOpen} THEN ${users.failedAttemptsSince} ELSE ${now} END`,
        lockedUntil: sql`CASE WHEN (${nextAttempts}) >= ${MAX_FAILED_ATTEMPTS} THEN ${new Date(now.getTime() + LOCKOUT_MS)}::timestamptz ELSE NULL END`,
      })
      .where(eq(users.id, user.id))
      .returning({ attempts: users.failedAttempts });

    // The account was deleted between the lookup and here. Nothing to lock.
    const attempts = rows[0]?.attempts;
    if (attempts === undefined) return;

    if (attempts !== MAX_FAILED_ATTEMPTS) return;

    this.logger.warn({ msg: 'Account locked after repeated failures', userId: user.id, attempts });

    // Direct rather than through `AuditContext`: the request this happened on
    // is about to answer 401, and the interceptor only audits successes. A
    // lockout is a state change on the account and belongs in the trail --
    // individual failed attempts do not, or an attacker could fill the table.
    await this.audit.write({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'auth.account_locked',
      entityType: 'user',
      entityId: user.id,
      after: { failedAttempts: attempts, lockedForMinutes: LOCKOUT_MS / 60_000 },
    });

    // REQ-B-10 asks for an email notice. This is also the only signal a real
    // user gets that someone is trying their address.
    await this.sendWithoutRevealingTheAccount({
      to: user.email,
      subject: 'Your account has been temporarily locked',
      body:
        `There have been ${String(attempts)} failed sign-in attempts for your account. ` +
        'For your protection it is locked for 15 minutes. If this was not you, ' +
        'change your password once the lock expires.',
    });
  }

  /**
   * Sends, and absorbs a transport failure into the log.
   *
   * Only for the lockout notice, which is sent from inside a request that is
   * about to answer 401 and *only* when the account exists. Letting a dead SMTP
   * server turn that into a 500 would say "this address is real" --
   * reintroducing, through the mail transport, exactly the enumeration oracle
   * the login path was shaped to avoid. The message is lost and the failure is
   * loud; the alternative leaks.
   *
   * The password reset used to need this too. It no longer does: its send moved
   * off the request path onto a queue, where a transport failure can fail the
   * job and be retried instead of being swallowed. That is the better answer,
   * and it is available to this path only once nobody is waiting on it.
   *
   * Everywhere else a failed send is a failed request. An administrator who is
   * told an invitation was sent must not have to guess.
   */
  private async sendWithoutRevealingTheAccount(mail: OutboundMail): Promise<void> {
    try {
      await this.mailer.send(mail);
    } catch (error: unknown) {
      this.logger.error({
        msg: 'Mail delivery failed on an enumeration-sensitive path; not surfaced to the caller.',
        subject: mail.subject,
        reason: describeError(error),
      });
    }
  }

  // -------------------------------------------------------------- refresh

  async refresh(presentedToken: string, context: SessionRequestContext): Promise<RefreshResult> {
    if (!isWellFormedToken(presentedToken)) {
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'Refresh token is not recognised.');
    }

    // A rotation every fifteen minutes per signed-in user would be the single
    // largest producer of audit rows in the product and would bury everything
    // worth reading. Reuse detection is not suppressed: SessionService records
    // that case explicitly.
    this.auditContext.suppress();

    // 12 REQ-AB-05: after the cutoff a refresh is refused, so a session ends
    // when its access token expires — nobody is thrown out mid-form. Decided
    // before rotating: a refusal that had already burnt the cookie would sign
    // the person out on the spot, which is the hard termination AB-05 forbids.
    const family = await this.sessions.familyOf(presentedToken);
    if (family !== null) {
      const verdict = await this.accessWindow.verdict(family.orgId);
      if (verdict.closed && !(await this.accessWindow.holdsExemption(family.userId))) {
        throw this.accessWindow.refusal(verdict);
      }
    }

    const rotated = await this.sessions.rotate(presentedToken, context);

    // The account may have been suspended or deleted since the token was
    // issued. Resolving the principal applies every one of those checks in one
    // place rather than repeating them here.
    const principal = await this.principals.resolve({
      userId: rotated.userId,
      orgId: rotated.orgId,
      sessionId: rotated.sessionId,
      issuedAtSeconds: Math.floor(Date.now() / 1000),
    });

    return {
      refreshToken: rotated.refreshToken,
      cookieMaxAgeMs: rotated.cookieMaxAgeMs,
      response: await this.accessResponse(
        principal.orgId,
        principal.userId,
        principal.email,
        rotated.sessionId,
      ),
    };
  }

  // --------------------------------------------------------------- logout

  /**
   * Revokes the family the presented refresh token belongs to.
   *
   * Idempotent, and silent when the cookie is missing or already dead: there
   * is nothing useful to tell a caller who asked to end a session that has
   * already ended, and answering differently would say whether a given token
   * was ever real.
   */
  async logout(presentedToken: string | null): Promise<void> {
    if (presentedToken === null || !isWellFormedToken(presentedToken)) return;

    const family = await this.sessions.familyOf(presentedToken);
    if (family === null) return;

    const revoked = await this.sessions.revokeFamily(
      family.familyId,
      SessionService.reasons.LOGOUT,
    );

    this.auditContext.record({
      orgId: family.orgId,
      actorUserId: family.userId,
      action: 'auth.logout',
      entityType: 'session',
      after: { familyId: family.familyId, sessionsRevoked: revoked },
    });
  }

  // ---------------------------------------------------------- invitations

  /**
   * Whether this employee already has a login, for the screen that decides
   * whether to offer them one.
   *
   * Under `employee.manage`, the permission that governs inviting, rather than
   * under `roles.manage`, which governs `GET /employees/:id/access`. The two
   * questions look alike and are not: "can this person sign in" is what an
   * inviter needs, and "which roles do they hold" is a map of what one named
   * person can do in the organisation. Answering the first does not require
   * answering the second, and requiring the second key to ask the first would
   * lock HR out of the only screen that creates accounts.
   */
  async readSignInAccount(principal: Principal, employeeId: string): Promise<SignInAccount> {
    const rows = await this.db
      .select({ email: users.email, status: users.status, totpConfirmedAt: users.totpConfirmedAt })
      .from(users)
      .innerJoin(employees, eq(employees.id, users.employeeId))
      .where(
        and(
          eq(users.employeeId, employeeId),
          eq(users.orgId, principal.orgId),
          eq(employees.orgId, principal.orgId),
          isNull(users.deletedAt),
          isNull(employees.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    // No row is the ordinary answer, not an error: REQ-A-06 imports create
    // employees with no login at all, and that is exactly who gets invited.
    return { employeeId, account: row === undefined ? null : { email: row.email, status: row.status, mfaEnabled: row.totpConfirmedAt !== null } };
  }

  /**
   * REQ-B-03. Returns the invitation **and the link that accepts it**.
   *
   * The token used to leave only by email, which was correct while a mail
   * server was assumed. There is none: `MAIL_TRANSPORT` defaults to `log`, so
   * the send below is a no-op unless a deployment turns SMTP on, and an
   * invitation nobody can read is an account nobody can ever sign into.
   *
   * This is not a new exposure. The caller holds `employee.manage` -- the
   * permission that let them create the account in the first place -- and would
   * have been the person forwarding the email anyway. What changes is the
   * channel: they copy the link and pass it on themselves. Every property
   * REQ-B-03 gives the token is untouched: single use, 72 hours, only the hash
   * stored, and any previous live link revoked by this one.
   *
   * The send stays because REQ-K-02 keeps the channel interface alive and
   * because an organisation that configures SMTP should get both.
   */
  async createInvitation(
    principal: Principal,
    input: CreateInvitationDto,
  ): Promise<InvitationResult> {
    const existing = await this.findByEmail(input.email);

    if (existing !== null && existing.orgId !== principal.orgId) {
      // The unique index on lower(email) is global. Saying "already exists"
      // would confirm an address in another organisation, so this reads as an
      // ordinary conflict.
      throw AppError.conflict('That email address cannot be invited.');
    }
    if (existing !== null && existing.status === 'ACTIVE') {
      throw AppError.conflict('That email address already has an account.');
    }
    if (existing !== null && existing.status === 'SUSPENDED') {
      throw AppError.conflict('That account is suspended; reactivate it instead of inviting it.');
    }

    if (input.roleIds.length > 0) await this.assertRolesBelongTo(principal.orgId, input.roleIds);

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const result = await this.db.transaction(async (tx) => {
      const userId = await this.upsertInvitedUser(tx, principal, input, existing);

      if (input.roleIds.length > 0) {
        await tx
          .insert(userRoles)
          .values(input.roleIds.map((roleId) => ({ userId, roleId, createdBy: principal.userId })))
          .onConflictDoNothing({ target: [userRoles.userId, userRoles.roleId] });
      }

      // A resend must not leave the previous link working: REQ-B-03 allows
      // resend and revoke, and two live tokens for one account is one more
      // than the requirement permits.
      await tx
        .update(invitations)
        .set({ revokedAt: new Date(), updatedBy: principal.userId })
        .where(
          and(
            eq(invitations.orgId, principal.orgId),
            sql`lower(${invitations.email}) = ${input.email}`,
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            isNull(invitations.deletedAt),
          ),
        );

      const rows = await tx
        .insert(invitations)
        .values({
          orgId: principal.orgId,
          email: input.email,
          employeeId: input.employeeId ?? null,
          tokenHash: this.hashInvitationToken(token),
          expiresAt,
          invitedBy: principal.userId,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning({ id: invitations.id });

      const row = rows[0];
      if (row === undefined) throw new Error('Invitation insert returned no row.');
      return { invitationId: row.id, userId };
    });

    const acceptUrl = this.acceptUrlFor(token);

    await this.sendKeepingTheLink({
      to: input.email,
      subject: 'You have been invited to Vyuha',
      body:
        'An administrator has created an account for you. Follow the link to set a password. ' +
        `The link can be used once and expires in ${String(INVITATION_TTL_HOURS)} hours.`,
      actionUrl: acceptUrl,
    });

    this.auditContext.record({
      action: 'invitation.created',
      entityType: 'invitation',
      entityId: result.invitationId,
      // Deliberately no link and no token. The trail records that access was
      // granted and by whom; a live credential in a table half the
      // organisation can read is a different thing entirely.
      after: { email: input.email, userId: result.userId, expiresAt: expiresAt.toISOString() },
    });

    return {
      id: result.invitationId,
      userId: result.userId,
      email: input.email,
      expiresAt: expiresAt.toISOString(),
      acceptUrl,
    };
  }

  private async upsertInvitedUser(
    tx: Transaction,
    principal: Principal,
    input: CreateInvitationDto,
    existing: { id: string } | null,
  ): Promise<string> {
    try {
      return await this.writeInvitedUser(tx, principal, input, existing);
    } catch (error: unknown) {
      // REQ-B-02 allows one living login per employee, and `users_employee_uq`
      // is what enforces it. The index held; nothing read what it said, so an
      // ordinary HR mistake -- inviting somebody who already has an account --
      // arrived as a 500 INTERNAL_ERROR with the failing INSERT and its
      // parameter values in the error log. Every other collision this endpoint
      // can hit is already a clean 409, so this one reads like one too.
      //
      // Matched by constraint name rather than by "some unique index refused
      // it": `users` also has the unique index on lower(email), and reporting
      // that as a duplicate employee would send an administrator to the wrong
      // field. Anything else keeps the generic conflict the email checks use,
      // which deliberately says nothing about what already exists.
      if (uniqueViolationConstraint(error) === 'users_employee_uq') {
        throw new AppError(
          ERROR_CODES.EMPLOYEE_ALREADY_LINKED,
          'That employee already has a login. Reset or reactivate it instead of inviting a second one.',
          {
            details: { employeeId: input.employeeId ?? null },
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  private async writeInvitedUser(
    tx: Transaction,
    principal: Principal,
    input: CreateInvitationDto,
    existing: { id: string } | null,
  ): Promise<string> {
    if (existing !== null) {
      await tx
        .update(users)
        .set({
          employeeId: input.employeeId ?? null,
          updatedAt: new Date(),
          updatedBy: principal.userId,
        })
        .where(eq(users.id, existing.id));
      return existing.id;
    }

    const rows = await tx
      .insert(users)
      .values({
        orgId: principal.orgId,
        email: input.email,
        employeeId: input.employeeId ?? null,
        // No password until the invitation is accepted. `passwordHash` stays
        // null and `verifyPassword` treats null as "does not verify", so an
        // unaccepted account cannot be logged into by any password.
        status: 'INVITED',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning({ id: users.id });

    const row = rows[0];
    if (row === undefined) throw new Error('User insert returned no row.');
    return row.id;
  }

  /** REQ-B-03: single use. Sets the password and activates the account. */
  async acceptInvitation(token: string, password: string): Promise<{ userId: string; email: string }> {
    if (!isWellFormedToken(token)) {
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This invitation link is not valid.');
    }

    const rows = await this.db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, this.hashInvitationToken(token)))
      .limit(1);

    const invitation = rows[0];
    if (invitation === undefined) {
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This invitation link is not valid.');
    }
    if (invitation.acceptedAt !== null) {
      throw new AppError(
        ERROR_CODES.INVITATION_ALREADY_ACCEPTED,
        'This invitation has already been used.',
      );
    }
    if (invitation.revokedAt !== null) {
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This invitation has been withdrawn.');
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new AppError(
        ERROR_CODES.INVITATION_EXPIRED,
        'This invitation has expired. Ask for a new one.',
      );
    }

    assertPasswordAcceptable(password, invitation.email);
    const passwordHash = await hashPassword(password);

    const user = await this.findByEmail(invitation.email);
    if (user === null || user.orgId !== invitation.orgId) {
      // The invitation exists but its account does not, which can only happen
      // if the user row was deleted after the invitation was issued.
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This invitation is no longer valid.');
    }

    const accepted = await this.db.transaction(async (tx) => {
      // Conditional, so two clicks on the same link cannot both succeed. The
      // row count is the single-use enforcement, not the read above it.
      const claimed = await tx
        .update(invitations)
        .set({ acceptedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(invitations.id, invitation.id), isNull(invitations.acceptedAt)))
        .returning({ id: invitations.id });

      if (claimed.length === 0) return false;

      const now = new Date();
      await tx
        .update(users)
        .set({
          passwordHash,
          status: 'ACTIVE',
          passwordChangedAt: now,
          failedAttempts: 0,
          failedAttemptsSince: null,
          lockedUntil: null,
          updatedAt: now,
          updatedBy: user.id,
        })
        .where(eq(users.id, user.id));

      return true;
    });

    if (!accepted) {
      throw new AppError(
        ERROR_CODES.INVITATION_ALREADY_ACCEPTED,
        'This invitation has already been used.',
      );
    }

    this.auditContext.record({
      orgId: invitation.orgId,
      actorUserId: user.id,
      action: 'invitation.accepted',
      entityType: 'user',
      entityId: user.id,
      before: { status: 'INVITED' },
      after: { status: 'ACTIVE' },
    });

    return { userId: user.id, email: user.email };
  }

  // ------------------------------------------------------- password reset

  /**
   * REQ-B-04. Always succeeds from the caller's point of view: answering
   * differently for an unknown address turns this endpoint into a way to
   * enumerate every account in the organisation.
   *
   * That same property made the endpoint a free mailbox-bombing primitive
   * (proven live: sixty rapid requests, sixty 202s, forty-odd emails), so a
   * sliding-window cap runs first -- per lower-cased address and per IP,
   * before the account lookup so known and unknown addresses spend budget
   * identically. Over budget, the work is silently skipped and the caller
   * still gets its 202; the limiter fails open if Redis is down, and the
   * per-account login lockout is untouched either way.
   *
   * "Answers the same" has to include *how long it takes to answer*, and for a
   * long time it did not. This method used to do the whole reset inline, so a
   * known address paid for a sweep, an insert, an audit write and an SMTP
   * round trip that an unknown address did not. The pre-launch gate measured
   * the result against the real relay: known {min 8.51ms, p50 9.84ms} against
   * unknown {min 3.50ms, p50 3.97ms}, with every one of thirty known samples
   * slower than every one of thirty unknown ones. The known *minimum* sat
   * above the unknown *median*, which makes a single request enough to
   * classify an address -- and a classified address is a targeted lockout
   * under REQ-B-10. `auth.password-reset-timing.test.ts` is the regression.
   */
  async requestPasswordReset(email: string, ip: string | null): Promise<void> {
    if (!(await this.resetLimiter.tryAcquire(email, ip))) return;

    // Nothing past this line reads the account, so nothing past this line can
    // take longer for an address that has one. The lookup, the row, the trail
    // and the mail all happen in `deliverPasswordReset`, on the notification
    // queue. See `queue.registry.ts` for why the payload carries the typed
    // address and nothing else.
    //
    // A failed enqueue is absorbed for `sendWithoutRevealingTheAccount`'s
    // reason: this endpoint answers 202 whatever happens, and turning a Redis
    // outage into a 500 would say "this address is real" only if the enqueue
    // were conditional on the account -- it is not, but the 202 is the
    // contract regardless, and a caller cannot act on the difference. The
    // request is lost and the failure is loud.
    //
    // That was true of the intent and false of the behaviour until `enqueue`
    // grew a deadline. BullMQ's connection retries a command for ever, so with
    // Redis unreachable this `await` never settled and the catch below never
    // ran: measured on the production build, 40s with no answer at all where
    // the contract promises 202 in 32ms. The catch is what makes the promise
    // real, so it can only be kept by an enqueue that is allowed to fail.
    try {
      await this.jobs.enqueue('deliver-password-reset', {
        email,
        ip,
        requestedAt: new Date().toISOString(),
      });
    } catch (error: unknown) {
      // "Probably not" rather than "not": the abandoned `add` is not
      // cancellable, so a Redis that comes back inside its own retry window
      // may still accept the job and send the mail. Claiming otherwise would
      // send whoever reads this line looking for a bug in the mailer.
      this.logger.error({
        msg: 'Could not queue a password reset within the deadline; this request will probably send no mail. The caller still received 202.',
        reason: describeError(error),
      });
    }
  }

  /**
   * The other half of REQ-B-04, off the request path.
   *
   * Runs as the `deliver-password-reset` job, so it may take as long as it
   * likes and may fail: a caller is no longer waiting, and there is no response
   * whose timing could be compared against another. That is also why the send
   * is a plain `mailer.send` rather than
   * `sendWithoutRevealingTheAccount` -- there is nobody left to reveal
   * anything to, so a dead SMTP server is allowed to fail the job and be
   * retried with backoff instead of quietly dropping the message.
   *
   * A retry re-runs the whole method, which mints a fresh token and writes a
   * fresh row and trail entry. Bounded by the job's five attempts, and every
   * token is single-use and dead in thirty minutes; the alternative -- holding
   * a token across attempts -- would mean carrying a live reset link in the
   * job payload.
   */
  async deliverPasswordReset(email: string, ip: string | null): Promise<'sent' | 'no-account'> {
    const user = await this.findByEmail(email);

    if (user === null || user.status !== 'ACTIVE') {
      this.logger.log({ msg: 'Password reset requested for an address with no active account' });
      return 'no-account';
    }

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await this.sweepSpentResets(user.id);

    await this.db.insert(passwordResets).values({
      orgId: user.orgId,
      userId: user.id,
      tokenHash: this.hashResetToken(token),
      expiresAt,
      requestedIp: ip,
    });

    // Direct rather than through `AuditContext`, and before the send: there is
    // no request in flight for the interceptor to flush, and the trail should
    // record that a reset was issued even if delivery then fails and retries.
    await this.audit.write({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'password_reset.requested',
      entityType: 'user',
      entityId: user.id,
      after: { expiresAt: expiresAt.toISOString() },
    });

    await this.mailer.send({
      to: user.email,
      subject: 'Reset your Vyuha password',
      body: `Follow the link to choose a new password. It can be used once and expires in ${String(PASSWORD_RESET_TTL_MINUTES)} minutes.`,
      actionUrl: this.resetUrlFor(token),
    });

    return 'sent';
  }

  /**
   * REQ-B-04 as an administrator performs it, and deliberately a *second* route
   * rather than a change to `POST /auth/password-resets`.
   *
   * The public one must keep answering 202 and nothing else. It is
   * unauthenticated by necessity -- somebody locked out of their account cannot
   * present a token -- so returning a link there would let any stranger who
   * knows an address take the account over, and returning it only for real
   * addresses would rebuild the enumeration oracle that endpoint is shaped to
   * avoid. Neither is recoverable by rate limiting.
   *
   * This route is the opposite in every respect: authenticated,
   * `employee.manage`, keyed on an employee record rather than on a typed-in
   * address, and audited against the administrator who asked. It exists because
   * with `MAIL_TRANSPORT=log` the public path mints a token that reaches
   * nobody, which leaves an organisation with no mail server unable to help
   * somebody who has forgotten their password.
   *
   * Keyed on `employeeId`, not on an email: an endpoint taking an arbitrary
   * address would issue reset links for accounts outside the caller's
   * organisation, and the employee row is what the caller was looking at.
   */
  async issuePasswordResetLink(
    principal: Principal,
    employeeId: string,
  ): Promise<PasswordResetLink> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        orgId: users.orgId,
        status: users.status,
      })
      .from(users)
      .innerJoin(employees, eq(employees.id, users.employeeId))
      .where(
        and(
          eq(users.employeeId, employeeId),
          eq(users.orgId, principal.orgId),
          eq(employees.orgId, principal.orgId),
          isNull(users.deletedAt),
          isNull(employees.deletedAt),
        ),
      )
      .limit(1);

    const user = rows[0];
    if (user === undefined) {
      // Written out rather than `AppError.notFound`, whose message is built as
      // "<entity> not found" -- true of the account and misleading about the
      // employee, who may exist perfectly well with no login (REQ-B-02).
      throw new AppError(
        ERROR_CODES.NOT_FOUND,
        'That employee has no login account, so there is no password to reset.',
        { details: { employeeId } },
      );
    }
    if (user.status !== 'ACTIVE') {
      // An invitation that has not been accepted has no password to reset, and
      // a suspended account must not be handed a way back in. Both are told
      // apart because the caller is an administrator looking at the record --
      // there is no address to enumerate here.
      throw AppError.conflict(
        user.status === 'INVITED'
          ? 'That account has not accepted its invitation yet. Send a new invitation link instead.'
          : 'That account is suspended. Reactivate it before resetting its password.',
      );
    }
    // Same rule as the second-factor reset, for the same reason: a reset
    // link for an account that outranks the caller is that account, handed
    // over (SEC-1).
    const grants = await this.principals.loadGrants(user.id, principal.orgId);
    if (!holdsEveryPermissionOf(principal, grants.permissions)) {
      throw AppError.forbidden('That account holds permissions you do not, so you cannot reset its password. Ask somebody who holds them.');
    }

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await this.sweepSpentResets(user.id);
    await this.db.insert(passwordResets).values({
      orgId: user.orgId,
      userId: user.id,
      tokenHash: this.hashResetToken(token),
      expiresAt,
      requestedIp: null,
    });

    const resetUrl = this.resetUrlFor(token);

    // A copy still goes out when a transport is configured, so somebody who
    // asked for the reset themselves gets it the usual way too.
    await this.sendKeepingTheLink({
      to: user.email,
      subject: 'Reset your Vyuha password',
      body: `An administrator issued a password reset for your account. It can be used once and expires in ${String(PASSWORD_RESET_TTL_MINUTES)} minutes.`,
      actionUrl: resetUrl,
    });

    this.auditContext.record({
      action: 'password_reset.issued',
      entityType: 'user',
      entityId: user.id,
      // The actor is the administrator, which the interceptor fills in. That is
      // the difference worth recording against `password_reset.requested`,
      // where the subject asked for it themselves.
      after: { email: user.email, employeeId, expiresAt: expiresAt.toISOString() },
    });

    return {
      userId: user.id,
      email: user.email,
      expiresAt: expiresAt.toISOString(),
      resetUrl,
    };
  }

  /** REQ-B-04: single use, and it invalidates every other session. */
  async confirmPasswordReset(token: string, password: string): Promise<{ userId: string }> {
    if (!isWellFormedToken(token)) {
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This reset link is not valid.');
    }

    const rows = await this.db
      .select()
      .from(passwordResets)
      .where(eq(passwordResets.tokenHash, this.hashResetToken(token)))
      .limit(1);

    const reset = rows[0];
    if (reset === undefined) {
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This reset link is not valid.');
    }
    if (reset.usedAt !== null) {
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This reset link has already been used.');
    }
    if (reset.expiresAt.getTime() <= Date.now()) {
      throw new AppError(ERROR_CODES.TOKEN_EXPIRED, 'This reset link has expired.');
    }

    const userRows = await this.db
      .select({ id: users.id, email: users.email, orgId: users.orgId })
      .from(users)
      .where(and(eq(users.id, reset.userId), isNull(users.deletedAt)))
      .limit(1);

    const user = userRows[0];
    if (user === undefined) {
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This reset link is no longer valid.');
    }

    assertPasswordAcceptable(password, user.email);
    const passwordHash = await hashPassword(password);

    const claimed = await this.db.transaction(async (tx) => {
      const marked = await tx
        .update(passwordResets)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResets.id, reset.id), isNull(passwordResets.usedAt)))
        .returning({ id: passwordResets.id });

      if (marked.length === 0) return false;

      const now = new Date();
      await tx
        .update(users)
        .set({
          passwordHash,
          passwordChangedAt: now,
          failedAttempts: 0,
          failedAttemptsSince: null,
          lockedUntil: null,
          updatedAt: now,
          updatedBy: user.id,
        })
        .where(eq(users.id, user.id));

      // Any other outstanding reset link is now stale. Leaving them live would
      // mean a stolen link still works after the theft was noticed and undone.
      await tx
        .update(passwordResets)
        .set({ usedAt: now })
        .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));

      return true;
    });

    if (!claimed) {
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This reset link has already been used.');
    }

    // REQ-B-04: "Password change invalidates all other sessions." Access
    // tokens already in flight are handled separately, by PrincipalService
    // comparing their `iat` against `password_changed_at`.
    const revoked = await this.sessions.revokeAllForUser(
      user.id,
      SessionService.reasons.PASSWORD_CHANGED,
    );

    this.auditContext.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'password_reset.completed',
      entityType: 'user',
      entityId: user.id,
      after: { sessionsRevoked: revoked },
    });

    return { userId: user.id };
  }

  // ------------------------------------------------------------------- me

  async me(principal: Principal): Promise<MeResponse> {
    const [employee, verdict, enrolledRows] = await Promise.all([
      this.loadEmployee(principal),
      this.accessWindow.verdict(principal.orgId),
      this.db.select({ confirmedAt: users.totpConfirmedAt }).from(users).where(eq(users.id, principal.userId)).limit(1),
    ]);
    const enrolled = enrolledRows[0]?.confirmedAt != null;

    return {
      user: {
        id: principal.userId,
        email: principal.email,
        status: principal.status,
        employeeId: principal.employeeId,
      },
      employee,
      roles: principal.roles,
      permissions: [...principal.permissions].sort(),
      accessWindow: {
        closesInMinutes: verdict.closesInMinutes,
        exempt: principal.permissions.has(PERMISSIONS.ACCESS_OUTSIDE_WINDOW),
      },
      mfa: await this.mfa.summaryFor(principal.orgId, principal.userId, enrolled, principal.roles.map((role) => role.name)),
    };
  }

  private async loadEmployee(principal: Principal): Promise<MeResponse['employee']> {
    if (principal.employeeId === null) return null;

    const rows = await this.db
      .select({
        id: employees.id,
        employeeCode: employees.employeeCode,
        firstName: employees.firstName,
        lastName: employees.lastName,
        departmentId: employees.departmentId,
        locationId: employees.locationId,
        reportingManagerId: employees.reportingManagerId,
      })
      .from(employees)
      .where(
        and(
          eq(employees.id, principal.employeeId),
          eq(employees.orgId, principal.orgId),
          isNull(employees.deletedAt),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  // -------------------------------------------------------------- helpers

  /**
   * REQ-B-01 matches on the work email. The unique index is on
   * `lower(email) WHERE deleted_at IS NULL`, so the predicate is written to
   * match it exactly -- `ilike` or a Node-side lower-case would not use it.
   */
  private async findByEmail(email: string) {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(sql`lower(${users.email}) = ${email.toLowerCase()}`, isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async assertRolesBelongTo(orgId: string, roleIds: readonly string[]): Promise<void> {
    const found = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), inArray(roles.id, [...roleIds]), isNull(roles.deletedAt)));

    if (found.length === roleIds.length) return;

    const known = new Set(found.map((row) => row.id));
    throw AppError.validation('One or more roles do not exist in this organisation.', {
      roleIds: roleIds.filter((id) => !known.has(id)),
    });
  }

  private hashInvitationToken(token: string): string {
    return hashOpaqueToken(TOKEN_PURPOSES.INVITATION, token, env.JWT_REFRESH_SECRET);
  }

  private hashResetToken(token: string): string {
    return hashOpaqueToken(TOKEN_PURPOSES.PASSWORD_RESET, token, env.JWT_REFRESH_SECRET);
  }

  /**
   * The two links, built in one place each.
   *
   * They used to be string literals at the single site that mailed them. Now
   * that the same URL is both mailed and returned to the caller, a second copy
   * of the format is a second thing to get wrong -- and a link whose path does
   * not match the web route is an invitation that 404s. `web-links.ts` owns the
   * join, and says there why a trailing slash is the case that matters.
   */
  private acceptUrlFor(token: string): string {
    return tokenLink(env.WEB_BASE_URL, INVITATION_PATH, token);
  }

  private resetUrlFor(token: string): string {
    return tokenLink(env.WEB_BASE_URL, PASSWORD_RESET_PATH, token);
  }

  /**
   * Each new reset sweeps the user's spent rows -- expired, or superseded by a
   * completed reset -- so the table cannot grow without bound under exactly the
   * traffic the request cap exists for. The audit trail, not this table, is the
   * record that resets happened.
   */
  private async sweepSpentResets(userId: string): Promise<void> {
    await this.db
      .delete(passwordResets)
      .where(
        and(
          eq(passwordResets.userId, userId),
          or(lte(passwordResets.expiresAt, new Date()), isNotNull(passwordResets.usedAt)),
        ),
      );
  }

  /**
   * Sends, and absorbs a transport failure into the log, for the two paths
   * whose *response* carries the link.
   *
   * This is not the swallow `sendWithoutRevealingTheAccount` performs, and the
   * reason is different: nothing is being concealed here. The caller already
   * holds a working link, so failing the request over a mail server that is by
   * default not even configured would throw away the delivery mechanism in
   * order to report the failure of the optional one -- and would leave the
   * invitation row committed with no way for anybody to read its link. The
   * message is lost, the failure is loud, and "does our SMTP work" is answered
   * by the test send on the Settings screen (REQ-L-04).
   */
  private async sendKeepingTheLink(mail: OutboundMail): Promise<void> {
    try {
      await this.mailer.send(mail);
    } catch (error: unknown) {
      this.logger.error({
        msg: 'Mail delivery failed. The caller was given the link in the response, so the request still succeeded.',
        subject: mail.subject,
        reason: describeError(error),
      });
    }
  }

  private async accessResponse(
    orgId: string,
    userId: string,
    email: string,
    sessionId: string,
  ): Promise<LoginResponse> {
    return {
      accessToken: await signAccessToken({
        userId,
        orgId,
        sessionId,
        ttlSeconds: env.JWT_ACCESS_TTL_SECONDS,
        secret: env.JWT_ACCESS_SECRET,
      }),
      tokenType: 'Bearer',
      expiresInSeconds: env.JWT_ACCESS_TTL_SECONDS,
      user: { id: userId, email },
    };
  }
}
