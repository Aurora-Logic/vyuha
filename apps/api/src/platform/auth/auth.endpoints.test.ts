import { PERMISSIONS, SYSTEM_ROLES } from '@vyuha/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, CookieJar, scopedEmail } from '../../test-support/api-harness.js';
import { invitations, passwordResets, users } from '../db/schema/index.js';
import { JobRunner } from '../jobs/job-runner.service.js';
import { LogMailer, Mailer } from '../mail/mailer.js';
import { hashOpaqueToken, TOKEN_PURPOSES } from './opaque-token.js';
import { env } from '../common/env.js';
import { parseEnv } from '../common/env.schema.js';

/**
 * The endpoint surface of REQ-B-01 … REQ-B-10, over real HTTP against the real
 * application.
 *
 * Technical design §10: "A test asserts that each protected endpoint returns
 * 403 for an under-privileged token." That is the `PROTECTED_ENDPOINTS` table
 * at the bottom -- a table rather than a test per endpoint, so adding a
 * protected route without adding its 403 case is a visible omission in one
 * place.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000a5';

let harness: ApiHarness;
let adminRoleId: string;
let employeeRoleId: string;
let admin: { email: string; password: string; id: string };
let employee: { email: string; password: string; id: string };
/** The employee record `employee`'s login already occupies (`users_employee_uq`). */
let linkedEmployeeRecordId: string;
/** An employee record with no login, so an invitation naming it must succeed. */
let unlinkedEmployeeRecordId: string;
let adminToken: string;
let employeeToken: string;

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface MeBody {
  user: { id: string; email: string; status: string; employeeId: string | null };
  employee: { employeeCode: string } | null;
  roles: { id: string; name: string }[];
  permissions: string[];
}

/** REQ-B-03's response, which now carries the link as well as the row. */
interface InvitationBody {
  id: string;
  userId: string;
  email: string;
  expiresAt: string;
  acceptUrl: string;
}

interface PasswordResetLinkBody {
  userId: string;
  email: string;
  expiresAt: string;
  resetUrl: string;
}

/** `WEB_BASE_URL` is configuration, so it reaches a pattern as data, not source. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}


/**
 * The audit count once it has stopped moving. See the note in the rotation
 * test: audit writes are intentionally off the response path, so a count taken
 * the instant a request returns can still be one behind.
 */
async function settledAuditCount(): Promise<number> {
  let previous = -1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*) AS count FROM audit_logs WHERE org_id = ${ORG_ID}`,
    );
    const current = Number(rows.rows[0]?.count ?? 0);
    if (current === previous) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return previous;
}

/**
 * REQ-B-04 delivery is a job now, so a 202 means "queued", not "sent". Waits
 * for the message and returns its single-use token.
 *
 * Asserting on the wait rather than letting `tokenFor` return null keeps the
 * failure honest: "no reset mail arrived" is a different bug from "the reset
 * link did not work", and the two used to be reported identically.
 */
async function resetTokenFor(email: string): Promise<string> {
  const mail = await harness.waitForMailTo(email);
  expect(mail, `no password-reset mail arrived for ${email}`).not.toBeNull();
  const token = harness.mail.tokenFor(email) ?? '';
  expect(token).toBeTruthy();
  return token;
}

/**
 * The user's reset rows once the count has stopped moving -- `settledAuditCount`
 * applied to the table the delivery job writes. A count read the instant a 202
 * returns is a count of the jobs that happen to have run already.
 */
async function settledResetRows(userId: string): Promise<{ expiresAt: Date }[]> {
  let previous = -1;
  let rows: { expiresAt: Date }[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    rows = await harness.db
      .select({ expiresAt: passwordResets.expiresAt })
      .from(passwordResets)
      .where(eq(passwordResets.userId, userId));
    if (rows.length === previous) return rows;
    previous = rows.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return rows;
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Auth Endpoints Fixture Org');

  // `POST /auth/password-resets` no longer does the reset on the request path:
  // it queues `deliver-password-reset` and returns, so that a known and an
  // unknown address cannot be told apart by how long the answer takes. Nothing
  // here would ever receive a reset mail without a worker to drain that queue,
  // and `vitest.config.mts` starts the suite with workers off. Same call the
  // bootstrap hook makes, as in `notifications.test.ts`.
  harness.resolve(JobRunner).startWorkers();

  adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN);
  employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);

  const employeeRecordId = await harness.createEmployee({ code: 'AE-001', firstName: 'Asha' });
  linkedEmployeeRecordId = employeeRecordId;
  unlinkedEmployeeRecordId = await harness.createEmployee({ code: 'AE-002', firstName: 'Bhavna' });

  const adminUser = await harness.createUser({
    email: scopedEmail('endpoints-admin'),
    roleIds: [adminRoleId],
  });
  const employeeUser = await harness.createUser({
    email: scopedEmail('endpoints-employee'),
    roleIds: [employeeRoleId],
    employeeId: employeeRecordId,
  });

  admin = { email: adminUser.email, password: adminUser.password, id: adminUser.id };
  employee = { email: employeeUser.email, password: employeeUser.password, id: employeeUser.id };

  adminToken = (await harness.login(admin.email, admin.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;
  expect(adminToken).not.toBe('');
  expect(employeeToken).not.toBe('');
}, 30_000);

afterAll(async () => {
  await harness.close();
});

describe('POST /auth/login (REQ-B-01)', () => {
  it('matches the email case-insensitively', async () => {
    const upper = admin.email.toUpperCase();
    expect(upper).not.toBe(admin.email);

    const result = await harness.post<{ accessToken: string }>('/auth/login', {
      body: { email: upper, password: admin.password },
    });
    expect(result.status).toBe(200);
    expect(result.body.accessToken).toBeTruthy();
  });

  it('rejects a wrong password and an unknown address with the same code', async () => {
    const wrong = await harness.post<ErrorBody>('/auth/login', {
      body: { email: admin.email, password: 'definitely-not-the-password' },
    });
    const unknown = await harness.post<ErrorBody>('/auth/login', {
      body: { email: 'nobody-at-all@vyuha.test', password: 'definitely-not-the-password' },
    });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    // Byte-identical, not merely the same status: a different message is an
    // enumeration oracle just as surely as a different code would be.
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('rejects an invited account that has not set a password yet', async () => {
    const pending = await harness.createUser({
      email: scopedEmail('never-accepted'),
      status: 'INVITED',
    });
    const result = await harness.post<ErrorBody>('/auth/login', {
      body: { email: pending.email, password: 'anything-at-all-here' },
    });
    // Not ACCOUNT_INACTIVE: the caller has not proved the password, so they
    // learn nothing about whether the account exists.
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('validates the body', async () => {
    const noEmail = await harness.post<ErrorBody>('/auth/login', { body: { password: 'x' } });
    expect(noEmail.status).toBe(400);
    expect(noEmail.body.error.code).toBe('VALIDATION_FAILED');

    const notAnEmail = await harness.post<ErrorBody>('/auth/login', {
      body: { email: 'not-an-email', password: 'x' },
    });
    expect(notAnEmail.status).toBe(400);
  });

  it('writes an audit row for a successful sign-in', async () => {
    await harness.login(admin.email, admin.password);
    expect(await harness.waitForAuditAction('auth.login')).toBe(true);
  });
});

describe('REQ-B-10: account lockout', () => {
  it('locks after five failures and refuses even the correct password', async () => {
    const victim = await harness.createUser({ email: scopedEmail('lockout-target') });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await harness.post<ErrorBody>('/auth/login', {
        body: { email: victim.email, password: `wrong-${String(attempt)}` },
      });
      expect(result.status).toBe(401);
      expect(result.body.error.code).toBe('INVALID_CREDENTIALS');
    }

    // Control: four failures must NOT lock. Without this the test would pass
    // for an implementation that locks on the first mistake.
    const stillOpen = await harness.post('/auth/login', {
      body: { email: victim.email, password: victim.password },
    });
    expect(stillOpen.status).toBe(200);

    // The counter resets on success, so lock it from scratch.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await harness.post('/auth/login', {
        body: { email: victim.email, password: `wrong-again-${String(attempt)}` },
      });
    }

    const lockedOut = await harness.post<ErrorBody>('/auth/login', {
      body: { email: victim.email, password: victim.password },
    });
    expect(lockedOut.status).toBe(423);
    expect(lockedOut.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(lockedOut.body.error.details).toHaveProperty('lockedUntil');

    const row = await harness.db
      .select({ failedAttempts: users.failedAttempts, lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, victim.id));
    expect(row[0]?.failedAttempts).toBe(5);
    expect(row[0]?.lockedUntil).toBeInstanceOf(Date);

    // REQ-B-10 asks for an email notice, and the lockout is a state change so
    // it belongs in the trail.
    expect(harness.mail.lastTo(victim.email)?.subject).toContain('locked');
    expect(await harness.waitForAuditAction('auth.account_locked')).toBe(true);
  });

  it('lets the account back in once the lock expires', async () => {
    const victim = await harness.createUser({ email: scopedEmail('lockout-expiry') });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await harness.post('/auth/login', {
        body: { email: victim.email, password: `no-${String(attempt)}` },
      });
    }
    expect(
      (await harness.post('/auth/login', { body: { email: victim.email, password: victim.password } }))
        .status,
    ).toBe(423);

    // Winding the clock back in the row rather than waiting fifteen minutes.
    await harness.db
      .update(users)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.id, victim.id));

    const allowed = await harness.post('/auth/login', {
      body: { email: victim.email, password: victim.password },
    });
    expect(allowed.status).toBe(200);

    const after = await harness.db
      .select({ failedAttempts: users.failedAttempts, lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, victim.id));
    expect(after[0]?.failedAttempts).toBe(0);
    expect(after[0]?.lockedUntil).toBeNull();
  });

  it('restarts the count when the fifteen-minute window has passed', async () => {
    const victim = await harness.createUser({ email: scopedEmail('lockout-window') });

    await harness.post('/auth/login', { body: { email: victim.email, password: 'no-1' } });
    await harness.post('/auth/login', { body: { email: victim.email, password: 'no-2' } });

    // Push the window's start into the past: these two failures are now an
    // old run, and the next one starts a new count.
    await harness.db
      .update(users)
      .set({ failedAttemptsSince: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(users.id, victim.id));

    await harness.post('/auth/login', { body: { email: victim.email, password: 'no-3' } });

    const row = await harness.db
      .select({ failedAttempts: users.failedAttempts })
      .from(users)
      .where(eq(users.id, victim.id));
    expect(row[0]?.failedAttempts).toBe(1);
  });
});

describe('GET /auth/me', () => {
  it('returns the profile, the roles, and the effective permission set', async () => {
    const result = await harness.get<MeBody>('/auth/me', { token: employeeToken });

    expect(result.status).toBe(200);
    expect(result.body.user.email).toBe(employee.email);
    expect(result.body.user.status).toBe('ACTIVE');
    expect(result.body.roles.map((role) => role.name)).toEqual([SYSTEM_ROLES.EMPLOYEE]);
    expect(result.body.employee?.employeeCode).toBe('AE-001');

    // PRD §2.1 for the Employee role, plus the two task keys P7-2 added
    // (owner, 28 Aug 2026) so anyone can be handed a task and work it.
    expect(result.body.permissions).toEqual([
      PERMISSIONS.ATTENDANCE_VIEW_SELF,
      PERMISSIONS.CRM_TASK_MANAGE,
      PERMISSIONS.CRM_TASK_VIEW_SELF,
      PERMISSIONS.LEAVE_APPLY_SELF,
      PERMISSIONS.PUNCH_SELF,
    ]);
  });

  it('returns a null employee for an account with no employee record', async () => {
    const result = await harness.get<MeBody>('/auth/me', { token: adminToken });
    expect(result.status).toBe(200);
    expect(result.body.employee).toBeNull();
    expect(result.body.permissions).toContain(PERMISSIONS.ROLES_MANAGE);
  });

  it('refuses without a token, and with a forged one', async () => {
    expect((await harness.get('/auth/me')).status).toBe(401);
    expect((await harness.get('/auth/me', { token: 'not.a.token' })).status).toBe(401);

    // Same token, one character of the signature flipped.
    //
    // Flipped in the *middle*, not at the end, and the reason is worth
    // recording: a 32-byte HMAC is 43 base64url characters, and the last one
    // carries two bits that decoding discards. For the one signature in
    // sixteen that ends in "A", changing it to "B" decodes to identical bytes,
    // the signature verifies, and this test failed with a 200 -- about 6% of
    // runs, which is exactly often enough to be dismissed as flaky.
    const [header, payload, signature] = adminToken.split('.');
    const original = signature ?? '';
    const tampered = `${original.slice(0, 5)}${original[5] === 'A' ? 'B' : 'A'}${original.slice(6)}`;

    // The probe checks itself: if the "tampered" signature decodes to the same
    // bytes, this test proves nothing whatever the endpoint answers.
    expect(
      Buffer.from(tampered, 'base64url').equals(Buffer.from(original, 'base64url')),
    ).toBe(false);

    const flipped = `${header ?? ''}.${payload ?? ''}.${tampered}`;
    const result = await harness.get<ErrorBody>('/auth/me', { token: flipped });
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('TOKEN_INVALID');
  });

  it('stops working the moment the account is suspended', async () => {
    const target = await harness.createUser({
      email: scopedEmail('to-be-suspended'),
      roleIds: [employeeRoleId],
    });
    const { token } = await harness.login(target.email, target.password);
    expect((await harness.get('/auth/me', { token })).status).toBe(200);

    await harness.db.update(users).set({ status: 'SUSPENDED' }).where(eq(users.id, target.id));

    // The token is still cryptographically valid and nowhere near expiry.
    // Loading the principal from the database on every request is what makes
    // this immediate rather than up to fifteen minutes late.
    const after = await harness.get<ErrorBody>('/auth/me', { token });
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('ACCOUNT_INACTIVE');
  });
});

describe('POST /auth/invitations (REQ-B-03)', () => {
  it('creates an invited account, stores only the token hash, and expires in 72 hours', async () => {
    const invited = scopedEmail('invitee');
    const before = Date.now();

    const result = await harness.post<InvitationBody>('/auth/invitations', {
      token: adminToken,
      body: { email: invited, roleIds: [employeeRoleId] },
    });

    expect(result.status).toBe(201);

    const expiresIn = new Date(result.body.expiresAt).getTime() - before;
    expect(expiresIn).toBeGreaterThan(71 * 60 * 60 * 1000);
    expect(expiresIn).toBeLessThan(73 * 60 * 60 * 1000);

    const token = harness.mail.tokenFor(invited);
    expect(token).toBeTruthy();

    const rows = await harness.db
      .select({ tokenHash: invitations.tokenHash })
      .from(invitations)
      .where(eq(invitations.id, result.body.id));

    // REQ-B-03: "hash stored not the token".
    expect(rows[0]?.tokenHash).not.toBe(token);
    expect(rows[0]?.tokenHash).toBe(
      hashOpaqueToken(TOKEN_PURPOSES.INVITATION, token ?? '', env.JWT_REFRESH_SECRET),
    );
    // And the hash never travels: the response carries the link, which carries
    // the token, and nothing that would let a reader of the response recognise
    // a row in this table.
    expect(result.text).not.toContain(rows[0]?.tokenHash ?? 'no-hash');

    const account = await harness.db
      .select({ status: users.status, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, result.body.userId));
    expect(account[0]?.status).toBe('INVITED');
    expect(account[0]?.passwordHash).toBeNull();
  });

  /**
   * The deployment has no mail server, so the response *is* the delivery.
   *
   * This used to assert the opposite -- `expect(result.text).not.toContain('token')`
   * -- and that was right while an email was the only way the link could
   * reach anybody. It is not any more: `MAIL_TRANSPORT` defaults to `log`, and
   * an invitation whose link exists only inside a message nobody sends is an
   * account nobody can ever sign into. The administrator holds
   * `employee.manage`; they are the person who would have forwarded that email.
   */
  it('returns a working accept link to the administrator who created it', async () => {
    const invited = scopedEmail('link-invitee');

    const created = await harness.post<InvitationBody>('/auth/invitations', {
      token: adminToken,
      body: { email: invited, roleIds: [employeeRoleId] },
    });

    expect(created.status).toBe(201);
    expect(created.body.acceptUrl).toMatch(
      new RegExp(`^${escapeForRegExp(env.WEB_BASE_URL)}/accept-invitation/`, 'u'),
    );

    // The token in the link is the token that was minted -- proven against the
    // stored hash rather than against the mail, so this still means something
    // in a deployment where no message is sent at all.
    const token = created.body.acceptUrl.split('/').pop() ?? '';
    const rows = await harness.db
      .select({ tokenHash: invitations.tokenHash })
      .from(invitations)
      .where(eq(invitations.id, created.body.id));
    expect(rows[0]?.tokenHash).toBe(
      hashOpaqueToken(TOKEN_PURPOSES.INVITATION, token, env.JWT_REFRESH_SECRET),
    );

    // Exactly one slash between the origin and the path. `WEB_BASE_URL` is
    // validated for its protocol and nothing else, so a configured trailing
    // slash is legal -- and `//accept-invitation/<token>` matches no route the
    // web app declares, which would be an invitation that 404s for everybody.
    expect(created.body.acceptUrl).not.toContain('//accept-invitation');
    expect(new URL(created.body.acceptUrl).pathname.startsWith('/accept-invitation/')).toBe(true);

    // And it works: a person holding only this URL reaches an account.
    const accepted = await harness.post(`/auth/invitations/${token}/accept`, {
      body: { password: 'the-link-i-was-handed' },
    });
    expect(accepted.status).toBe(200);
    expect((await harness.login(invited, 'the-link-i-was-handed')).status).toBe(200);

    // Still single use, still 72 hours: the channel changed, the token did not.
    const replay = await harness.post<ErrorBody>(`/auth/invitations/${token}/accept`, {
      body: { password: 'a-second-go-at-it-x' },
    });
    expect(replay.status).toBe(409);
  });

  /**
   * The proof that the change actually removes the dependency.
   *
   * `RecordingMailer` never throws, so a suite that only watched for a 201
   * would pass just as happily against a build that still needed a mail server.
   * This one boots a second application with `MAIL_TRANSPORT=log` and no SMTP
   * credentials whatsoever -- which is the shipped default and the shape of the
   * deployment -- and drives an invitation through to a sign-in on it.
   */
  it('serves invitations on a boot with MAIL_TRANSPORT=log and no SMTP settings', async () => {
    // Part one: the configuration itself. Every SMTP variable removed, and the
    // schema accepts it -- the process this describes is one that starts on a
    // machine with no mail server anywhere near it.
    const withoutMail = { ...process.env };
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM', 'MAIL_TRANSPORT']) {
      delete withoutMail[key];
    }
    expect(parseEnv(withoutMail).MAIL_TRANSPORT).toBe('log');

    // Part two: the running application, with its own mailer rather than the
    // recorder every other test installs.
    const bare = await ApiHarness.startWithRealMailer(
      '01900000-0000-7000-8000-0000000000a6',
      'No Mail Server Org',
    );

    try {
      expect(bare.resolve(Mailer)).toBeInstanceOf(LogMailer);
      expect(env.SMTP_USER).toBeUndefined();
      expect(env.SMTP_PASSWORD).toBeUndefined();

      const roleId = await bare.createSystemRole(SYSTEM_ROLES.ADMIN);
      const inviter = await bare.createUser({ email: scopedEmail('no-smtp-admin'), roleIds: [roleId] });
      const token = (await bare.login(inviter.email, inviter.password)).token;
      expect(token).not.toBe('');

      const invited = scopedEmail('no-smtp-invitee');
      const created = await bare.post<InvitationBody>('/auth/invitations', {
        token,
        body: { email: invited },
      });

      expect(created.status).toBe(201);
      expect(created.body.acceptUrl).toContain('/accept-invitation/');

      const accepted = await bare.post(
        `/auth/invitations/${created.body.acceptUrl.split('/').pop() ?? ''}/accept`,
        { body: { password: 'no-mail-server-needed' } },
      );
      expect(accepted.status).toBe(200);
      expect((await bare.login(invited, 'no-mail-server-needed')).status).toBe(200);
    } finally {
      await bare.close();
    }
  }, 60_000);

  it('accepting sets the password, activates the account, and is single use', async () => {
    const invited = scopedEmail('accepter');
    const created = await harness.post<{ userId: string }>('/auth/invitations', {
      token: adminToken,
      body: { email: invited, roleIds: [employeeRoleId] },
    });
    const token = harness.mail.tokenFor(invited) ?? '';

    const weak = await harness.post<ErrorBody>(`/auth/invitations/${token}/accept`, {
      body: { password: 'short' },
    });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('PASSWORD_TOO_WEAK');

    const accepted = await harness.post(`/auth/invitations/${token}/accept`, {
      body: { password: 'a-decent-invitation-passphrase' },
    });
    expect(accepted.status).toBe(200);

    const account = await harness.db
      .select({ status: users.status, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, created.body.userId));
    expect(account[0]?.status).toBe('ACTIVE');
    expect(account[0]?.passwordHash).toMatch(/^\$scrypt\$/u);

    const login = await harness.login(invited, 'a-decent-invitation-passphrase');
    expect(login.status).toBe(200);

    const replay = await harness.post<ErrorBody>(`/auth/invitations/${token}/accept`, {
      body: { password: 'a-different-passphrase-here' },
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
  });

  it('reports an expired invitation distinctly', async () => {
    const invited = scopedEmail('expired-invitee');
    const created = await harness.post<{ id: string }>('/auth/invitations', {
      token: adminToken,
      body: { email: invited },
    });
    const token = harness.mail.tokenFor(invited) ?? '';

    await harness.db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, created.body.id));

    const result = await harness.post<ErrorBody>(`/auth/invitations/${token}/accept`, {
      body: { password: 'a-perfectly-fine-passphrase' },
    });
    expect(result.status).toBe(410);
    expect(result.body.error.code).toBe('INVITATION_EXPIRED');
  });

  it('revokes the previous link when an invitation is resent', async () => {
    const invited = scopedEmail('resent-invitee');
    await harness.post('/auth/invitations', { token: adminToken, body: { email: invited } });
    const firstToken = harness.mail.tokenFor(invited) ?? '';

    await harness.post('/auth/invitations', { token: adminToken, body: { email: invited } });
    const secondToken = harness.mail.tokenFor(invited) ?? '';
    expect(secondToken).not.toBe(firstToken);

    const stale = await harness.post<ErrorBody>(`/auth/invitations/${firstToken}/accept`, {
      body: { password: 'the-old-link-passphrase' },
    });
    expect(stale.status).toBe(401);

    const fresh = await harness.post(`/auth/invitations/${secondToken}/accept`, {
      body: { password: 'the-new-link-passphrase' },
    });
    expect(fresh.status).toBe(200);
  });

  it('refuses to invite an address that already has an active account', async () => {
    const result = await harness.post<ErrorBody>('/auth/invitations', {
      token: adminToken,
      body: { email: employee.email },
    });
    expect(result.status).toBe(409);
  });

  it('refuses to invite a second login for an employee who already has one', async () => {
    // `users_employee_uq` allows one living login per employee, and it held --
    // but nothing caught the violation, so an ordinary HR mistake came back as
    // a 500 INTERNAL_ERROR and put the failing statement, parameter values and
    // all, in the error log. Every other collision this endpoint can hit --
    // the address belongs to another organisation, the account is already
    // active, the account is suspended -- was already a clean 409.
    const result = await harness.post<ErrorBody>('/auth/invitations', {
      token: adminToken,
      body: { email: scopedEmail('second-login'), employeeId: linkedEmployeeRecordId },
    });

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('EMPLOYEE_ALREADY_LINKED');
    expect(result.body.error.details?.employeeId).toBe(linkedEmployeeRecordId);
    // The refusal must not carry the SQL or the row it collided with.
    expect(result.text).not.toContain('users_employee_uq');
    expect(result.text).not.toContain('insert into');
  });

  it('still invites an employee who has no login yet', async () => {
    // The guard above must refuse the collision and nothing else: an employee
    // record with no account is the ordinary case this endpoint exists for.
    const result = await harness.post<{ userId: string }>('/auth/invitations', {
      token: adminToken,
      body: { email: scopedEmail('first-login'), employeeId: unlinkedEmployeeRecordId },
    });

    expect(result.status).toBe(201);

    const rows = await harness.db
      .select({ employeeId: users.employeeId })
      .from(users)
      .where(eq(users.id, result.body.userId));
    expect(rows[0]?.employeeId).toBe(unlinkedEmployeeRecordId);
  });

  it('refuses an unknown or forged invitation token', async () => {
    for (const token of ['x', 'a'.repeat(43), 'not/a/token', '../../etc/passwd']) {
      const result = await harness.post(`/auth/invitations/${encodeURIComponent(token)}/accept`, {
        body: { password: 'a-perfectly-fine-passphrase' },
      });
      expect(result.status).toBe(401);
    }
  });

  it('refuses a role from another organisation', async () => {
    const result = await harness.post<ErrorBody>('/auth/invitations', {
      token: adminToken,
      body: { email: scopedEmail('bad-role'), roleIds: ['01900000-0000-7000-8000-00000000eeee'] },
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /auth/password-resets (REQ-B-04)', () => {
  it('answers identically for a known and an unknown address', async () => {
    const known = await harness.post('/auth/password-resets', { body: { email: employee.email } });
    const unknown = await harness.post('/auth/password-resets', {
      body: { email: 'no-such-person@vyuha.test' },
    });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.text).toBe(unknown.text);

    // Waiting for the known address's mail first is what makes the negative
    // below mean anything: it proves the queue has run past both jobs, so
    // "nothing was sent to the unknown address" is a decision the handler made
    // rather than a job that had not started yet.
    await resetTokenFor(employee.email);
    expect(harness.mail.lastTo('no-such-person@vyuha.test')).toBeNull();
  });

  it('expires in 30 minutes, is single use, and stores only the hash', async () => {
    const target = await harness.createUser({
      email: scopedEmail('resetter'),
      roleIds: [employeeRoleId],
    });
    const before = Date.now();

    await harness.post('/auth/password-resets', { body: { email: target.email } });
    const token = await resetTokenFor(target.email);

    const rows = await harness.db
      .select({ tokenHash: passwordResets.tokenHash, expiresAt: passwordResets.expiresAt })
      .from(passwordResets)
      .where(eq(passwordResets.userId, target.id));

    expect(rows[0]?.tokenHash).not.toBe(token);
    expect(rows[0]?.tokenHash).toBe(
      hashOpaqueToken(TOKEN_PURPOSES.PASSWORD_RESET, token, env.JWT_REFRESH_SECRET),
    );

    const ttl = (rows[0]?.expiresAt.getTime() ?? 0) - before;
    expect(ttl).toBeGreaterThan(29 * 60 * 1000);
    expect(ttl).toBeLessThan(31 * 60 * 1000);

    const confirmed = await harness.post(`/auth/password-resets/${token}/confirm`, {
      body: { password: 'the-replacement-passphrase' },
    });
    expect(confirmed.status).toBe(200);

    const replay = await harness.post<ErrorBody>(`/auth/password-resets/${token}/confirm`, {
      body: { password: 'yet-another-passphrase-x' },
    });
    expect(replay.status).toBe(401);

    expect((await harness.login(target.email, 'the-replacement-passphrase')).status).toBe(200);
    expect((await harness.login(target.email, target.password)).status).toBe(401);
  });

  it('invalidates every other session, including access tokens already issued', async () => {
    const target = await harness.createUser({
      email: scopedEmail('session-killer'),
      roleIds: [employeeRoleId],
    });

    const jar = new CookieJar();
    const login = await harness.post<{ accessToken: string }>(
      '/auth/login',
      { body: { email: target.email, password: target.password }, withCookies: true },
      jar,
    );
    const liveToken = login.body.accessToken;
    expect((await harness.get('/auth/me', { token: liveToken })).status).toBe(200);

    await harness.post('/auth/password-resets', { body: { email: target.email } });
    const token = await resetTokenFor(target.email);
    await harness.post(`/auth/password-resets/${token}/confirm`, {
      body: { password: 'password-was-just-reset' },
    });

    // The refresh token is revoked by row...
    const refresh = await harness.post<ErrorBody>('/auth/refresh', { withCookies: true }, jar);
    expect(refresh.status).toBe(401);

    // ...and the access token issued before the change is rejected too,
    // because the session it names was revoked. Without that check it would
    // stay usable for the rest of its fifteen minutes.
    const stale = await harness.get<ErrorBody>('/auth/me', { token: liveToken });
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('TOKEN_INVALID');
  });

  it('reports an expired reset link distinctly', async () => {
    const target = await harness.createUser({ email: scopedEmail('stale-reset') });
    await harness.post('/auth/password-resets', { body: { email: target.email } });
    const token = await resetTokenFor(target.email);

    await harness.db
      .update(passwordResets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResets.userId, target.id));

    const result = await harness.post<ErrorBody>(`/auth/password-resets/${token}/confirm`, {
      body: { password: 'too-late-for-this-one' },
    });
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('caps sends per address while every response stays 202', async () => {
    // The pre-deploy gate proved the gap live: sixty rapid requests, sixty
    // 202s, forty-odd delivered emails. The cap is three per address per
    // hour, and -- the half that preserves enumeration resistance -- a
    // throttled request is indistinguishable from an allowed one.
    const target = await harness.createUser({
      email: scopedEmail('burst-reset'),
      roleIds: [employeeRoleId],
    });

    const responses = [];
    for (let i = 0; i < 6; i += 1) {
      responses.push(await harness.post('/auth/password-resets', { body: { email: target.email } }));
    }

    expect(responses.map((response) => response.status)).toEqual([202, 202, 202, 202, 202, 202]);

    // The throttled requests queued nothing, so the count settles at three
    // rather than climbing to six.
    const rows = await settledResetRows(target.id);
    expect(rows).toHaveLength(3);

    const delivered = harness.mail.sent.filter(
      (mail) => mail.to.toLowerCase() === target.email.toLowerCase(),
    );
    expect(delivered).toHaveLength(3);
  });

  it('sweeps the user`s spent reset rows on each new request', async () => {
    const target = await harness.createUser({
      email: scopedEmail('swept-reset'),
      roleIds: [employeeRoleId],
    });

    await harness.post('/auth/password-resets', { body: { email: target.email } });
    await resetTokenFor(target.email);

    // Age the first row past its TTL, as an abandoned link would be.
    await harness.db
      .update(passwordResets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResets.userId, target.id));

    await harness.post('/auth/password-resets', { body: { email: target.email } });

    // Only the live link remains: the expired one was deleted by the new
    // request rather than accumulating for ever (the audit trail, not this
    // table, records that requests happened).
    const rows = await settledResetRows(target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

/**
 * What the invite screen reads before it offers anything.
 *
 * Its whole reason for existing is the permission it sits behind. The screen
 * first used `GET /employees/:id/access`, which answers the same question and
 * is gated on `roles.manage` -- so HR, who hold `employee.manage` and are the
 * people the screen is for, would have opened it and been refused by an
 * endpoint they should never call.
 */
describe('GET /auth/invitations/for-employee/:employeeId (REQ-B-02)', () => {
  it('says whether an employee already has a login', async () => {
    const linked = await harness.get<{ employeeId: string; account: { email: string; status: string } | null }>(
      `/auth/invitations/for-employee/${linkedEmployeeRecordId}`,
      { token: adminToken },
    );
    expect(linked.status).toBe(200);
    expect(linked.body.account?.email).toBe(employee.email);
    expect(linked.body.account?.status).toBe('ACTIVE');

    // The role list is what `roles.manage` protects, and it is not here.
    expect(linked.text).not.toContain('roles');
    expect(linked.text).not.toContain('permissions');
  });

  it('answers null, not 404, for an employee with no login', async () => {
    // REQ-A-06 imports create employees with no account at all. That is the
    // ordinary case this endpoint exists to report, not an error.
    const fresh = await harness.createEmployee({ code: 'AE-005', firstName: 'Esha' });
    const result = await harness.get<{ account: unknown }>(
      `/auth/invitations/for-employee/${fresh}`,
      { token: adminToken },
    );
    expect(result.status).toBe(200);
    expect(result.body.account).toBeNull();
  });

  it('is answerable with employee.manage and without roles.manage', async () => {
    // The regression this endpoint was created for. A role holding
    // `employee.manage` and nothing about roles must be able to read it.
    const hrRoleId = await harness.createRole('Invite Only', [PERMISSIONS.EMPLOYEE_MANAGE]);
    const hr = await harness.createUser({ email: scopedEmail('invite-only'), roleIds: [hrRoleId] });
    const hrToken = (await harness.login(hr.email, hr.password)).token;
    expect(hrToken).not.toBe('');

    const allowed = await harness.get(`/auth/invitations/for-employee/${linkedEmployeeRecordId}`, {
      token: hrToken,
    });
    expect(allowed.status).toBe(200);

    // The control: the same caller must still be refused the roles read this
    // endpoint exists to avoid needing.
    const refused = await harness.get(`/employees/${linkedEmployeeRecordId}/access`, {
      token: hrToken,
    });
    expect(refused.status).toBe(403);
  });

  it('refuses a malformed id', async () => {
    const result = await harness.get<ErrorBody>('/auth/invitations/for-employee/not-a-uuid', {
      token: adminToken,
    });
    expect(result.status).toBe(400);
  });
});

/**
 * REQ-B-04 as an administrator performs it: a second route, because the public
 * one must never hand a link to an unauthenticated caller.
 */
describe('POST /auth/password-resets/for-employee (REQ-B-04)', () => {
  it('returns a working reset link for an employee who has an account', async () => {
    const before = Date.now();
    const result = await harness.post<PasswordResetLinkBody>(
      '/auth/password-resets/for-employee',
      { token: adminToken, body: { employeeId: linkedEmployeeRecordId } },
    );

    expect(result.status).toBe(201);
    expect(result.body.email).toBe(employee.email);
    expect(result.body.resetUrl).toMatch(
      new RegExp(`^${escapeForRegExp(env.WEB_BASE_URL)}/reset-password/`, 'u'),
    );

    // REQ-B-04's thirty minutes, unchanged by who asked for it.
    const ttl = new Date(result.body.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(29 * 60 * 1000);
    expect(ttl).toBeLessThan(31 * 60 * 1000);

    const token = result.body.resetUrl.split('/').pop() ?? '';
    const rows = await harness.db
      .select({ tokenHash: passwordResets.tokenHash })
      .from(passwordResets)
      .where(eq(passwordResets.userId, employee.id));
    expect(rows.map((row) => row.tokenHash)).toContain(
      hashOpaqueToken(TOKEN_PURPOSES.PASSWORD_RESET, token, env.JWT_REFRESH_SECRET),
    );

    // It is a real reset: the password changes and the old one stops working.
    const confirmed = await harness.post(`/auth/password-resets/${token}/confirm`, {
      body: { password: 'issued-by-an-administrator' },
    });
    expect(confirmed.status).toBe(200);
    expect((await harness.login(employee.email, 'issued-by-an-administrator')).status).toBe(200);
    expect((await harness.login(employee.email, employee.password)).status).toBe(401);

    // The rest of this file signs in as `employee`, so put it back and refresh
    // the token every later test uses.
    employee.password = 'issued-by-an-administrator';
    employeeToken = (await harness.login(employee.email, employee.password)).token;
    expect(employeeToken).not.toBe('');

    expect(await harness.waitForAuditAction('password_reset.issued')).toBe(true);
  });

  it('refuses an employee with no login account', async () => {
    const withoutLogin = await harness.createEmployee({ code: 'AE-003', firstName: 'Chetan' });
    const result = await harness.post<ErrorBody>('/auth/password-resets/for-employee', {
      token: adminToken,
      body: { employeeId: withoutLogin },
    });

    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('NOT_FOUND');
  });

  it('refuses an account that has not accepted its invitation', async () => {
    // Resetting a password that does not exist yet would activate an account
    // nobody has ever proved they own. The invitation is the way in.
    const pendingEmployee = await harness.createEmployee({ code: 'AE-004', firstName: 'Deepa' });
    const created = await harness.post<InvitationBody>('/auth/invitations', {
      token: adminToken,
      body: { email: scopedEmail('never-accepted-reset'), employeeId: pendingEmployee },
    });
    expect(created.status).toBe(201);

    const result = await harness.post<ErrorBody>('/auth/password-resets/for-employee', {
      token: adminToken,
      body: { employeeId: pendingEmployee },
    });
    expect(result.status).toBe(409);
    expect(result.body.error.message).toContain('invitation');
  });

  it('validates the body', async () => {
    const result = await harness.post<ErrorBody>('/auth/password-resets/for-employee', {
      token: adminToken,
      body: { employeeId: 'not-a-uuid' },
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('does not answer for an employee in another organisation', async () => {
    // The id is well formed and names nobody here. A 404 rather than a 403:
    // the caller learns nothing about whether the row exists elsewhere.
    const result = await harness.post<ErrorBody>('/auth/password-resets/for-employee', {
      token: adminToken,
      body: { employeeId: '01900000-0000-7000-8000-00000000dddd' },
    });
    expect(result.status).toBe(404);
  });

  it('leaves the public endpoint answering 202 with no link in it', async () => {
    // The pair is the point. If this ever starts returning a URL, anybody who
    // knows an address owns the account.
    const result = await harness.post('/auth/password-resets', {
      body: { email: employee.email },
    });

    expect(result.status).toBe(202);
    expect(result.text).not.toContain('/reset-password/');
    expect(result.text).toBe(JSON.stringify({ status: 'accepted' }));
  });
});

/**
 * Technical design §10: "Every endpoint enforces independently. A test asserts
 * that each protected endpoint returns 403 for an under-privileged token."
 *
 * One row per protected route. `/auth/invitations` is the only one this phase
 * adds; the shape is here so the next one is a line rather than a new file.
 */
const PROTECTED_ENDPOINTS: readonly {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  /**
   * A body the endpoint would accept, built when the control case runs. A
   * literal would not do: the two rows take different shapes, and the row that
   * invites needs an address no earlier run has used.
   */
  controlBody: () => unknown;
  requires: string;
}[] = [
  {
    name: 'POST /auth/invitations',
    method: 'POST',
    path: '/auth/invitations',
    body: { email: 'blocked@vyuha.test' },
    controlBody: () => ({ email: scopedEmail('control') }),
    requires: PERMISSIONS.EMPLOYEE_MANAGE,
  },
  {
    name: 'POST /auth/password-resets/for-employee',
    method: 'POST',
    path: '/auth/password-resets/for-employee',
    body: { employeeId: '01900000-0000-7000-8000-00000000cccc' },
    controlBody: () => ({ employeeId: linkedEmployeeRecordId }),
    requires: PERMISSIONS.EMPLOYEE_MANAGE,
  },
  {
    name: 'GET /auth/invitations/for-employee/:employeeId',
    method: 'GET',
    // A read, and still protected: whether a named person can sign in is not
    // public information.
    path: `/auth/invitations/for-employee/01900000-0000-7000-8000-00000000cccc`,
    controlBody: () => undefined,
    requires: PERMISSIONS.EMPLOYEE_MANAGE,
  },
];

describe('403 for an under-privileged token (technical design §10)', () => {
  for (const endpoint of PROTECTED_ENDPOINTS) {
    it(`${endpoint.name} refuses a token without ${endpoint.requires}`, async () => {
      const result = await harness.request<ErrorBody>(endpoint.method, endpoint.path, {
        token: employeeToken,
        body: endpoint.body,
      });

      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe('FORBIDDEN');
      expect(result.body.error.details).toEqual({ requiredAnyOf: [endpoint.requires] });
    });

    it(`${endpoint.name} refuses an anonymous caller with 401, not 403`, async () => {
      const result = await harness.request<ErrorBody>(endpoint.method, endpoint.path, {
        body: endpoint.body,
      });
      expect(result.status).toBe(401);
    });

    it(`${endpoint.name} allows a token that holds ${endpoint.requires}`, async () => {
      // The control. Without it, a route that returned 403 to everyone --
      // including the admin -- would pass the two cases above.
      const result = await harness.request(endpoint.method, endpoint.path, {
        token: adminToken,
        body: endpoint.controlBody(),
      });
      expect(result.status).toBeLessThan(400);
    });
  }

  it('has no route that answers without declaring a policy', async () => {
    // RoutePolicyAudit fails the boot if one exists, so reaching this line at
    // all is part of the assertion. The unmatched route below confirms the
    // application is answering and that a 404 is a 404, not a silent allow.
    const missing = await harness.get<ErrorBody>('/auth/not-a-real-route');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('has no signup route (ADR 0002)', async () => {
    // "Absence of a route is the access control." Asserting the absence keeps
    // it that way after someone reaches for a quick self-service form.
    for (const path of ['/auth/signup', '/auth/register', '/auth/users', '/users']) {
      const result = await harness.post(path, { body: { email: 'x@y.test', password: 'z' } });
      expect([401, 403, 404]).toContain(result.status);
    }
  });
});

describe('audit trail is written without call sites asking (REQ-M-01)', () => {
  it('records the mutation, the actor, the ip, and the request id', async () => {
    const invited = scopedEmail('audited-invitee');
    const created = await harness.post<{ id: string }>('/auth/invitations', {
      token: adminToken,
      body: { email: invited },
    });

    expect(await harness.waitForAuditEntity(created.body.id)).toBe(true);

    const rows = await harness.db.execute<{
      action: string;
      actor_user_id: string | null;
      entity_type: string;
      entity_id: string | null;
      ip: string | null;
      user_agent: string | null;
      request_id: string | null;
      after: Record<string, unknown> | null;
    }>(
      sql`SELECT action, actor_user_id, entity_type, entity_id, ip, user_agent, request_id, after
            FROM audit_logs
           WHERE org_id = ${ORG_ID} AND entity_id = ${created.body.id}
           LIMIT 1`,
    );

    const row = rows.rows[0];
    expect(row).toBeDefined();
    expect(row?.action).toBe('invitation.created');
    expect(row?.actor_user_id).toBe(admin.id);
    expect(row?.entity_type).toBe('invitation');
    expect(row?.ip).toBeTruthy();
    expect(row?.request_id).toBeTruthy();
    expect(row?.after).toMatchObject({ email: invited });
  });

  it('does not record a refresh rotation, which would drown everything else', async () => {
    const jar = new CookieJar();
    await harness.post(
      '/auth/login',
      { body: { email: admin.email, password: admin.password }, withCookies: true },
      jar,
    );

    // The interceptor deliberately does not make the response wait on the
    // audit insert, so the login's own row can land after the response. Taking
    // the baseline immediately made this test flake -- and blamed the refresh
    // for a row the login wrote.
    const before = await settledAuditCount();
    await harness.post('/auth/refresh', { withCookies: true }, jar);
    const after = await settledAuditCount();

    expect(after).toBe(before);
  });

  it('never puts a password or a token in the trail', async () => {
    const rows = await harness.db.execute<{ payload: string }>(
      sql`SELECT coalesce(before::text, '') || coalesce(after::text, '') AS payload
            FROM audit_logs WHERE org_id = ${ORG_ID}`,
    );
    const everything = rows.rows.map((row) => row.payload).join(' ');

    expect(everything).not.toContain(admin.password);
    expect(everything).not.toContain(employee.password);
    expect(everything).not.toContain('$scrypt$');
    for (const mail of harness.mail.sent) {
      const token = mail.actionUrl?.split('/').pop();
      if (token !== undefined && token.length > 10) expect(everything).not.toContain(token);
    }
  });
});

/**
 * SEC-1 (audit, 4 Sep 2026). `employee.manage` gates both resets, and neither
 * asked who the target was: an HR account could clear the Admin's second
 * factor, mint the Admin's reset link, and be the Admin. Now an account may
 * only be reset by somebody who already holds every permission it holds, so
 * a reset is never a way up. HR is the caller here because it is the real
 * role this bites -- it holds employee.manage and every employee key, and
 * nothing of Admin's.
 */
describe('a reset is never a way up (SEC-1)', () => {
  let hrToken = '';
  let hrUserId = '';
  let ownerEmployeeId = '';
  let ownerUserId = '';

  beforeAll(async () => {
    const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR);
    const hr = await harness.createUser({ email: scopedEmail('sec1-hr'), roleIds: [hrRoleId] });
    hrUserId = hr.id;
    hrToken = (await harness.login(hr.email, hr.password)).token;
    expect(hrToken).not.toBe('');

    // An Admin with an employee record, so the employee-keyed reset can name them.
    ownerEmployeeId = await harness.createEmployee({ code: 'AE-SEC1', firstName: 'Owner' });
    const owner = await harness.createUser({
      email: scopedEmail('sec1-owner'),
      roleIds: [adminRoleId],
      employeeId: ownerEmployeeId,
    });
    ownerUserId = owner.id;
  });

  it('HR still resets an ordinary employee, whose keys HR already holds', async () => {
    const link = await harness.post<PasswordResetLinkBody>('/auth/password-resets/for-employee', {
      token: hrToken,
      body: { employeeId: linkedEmployeeRecordId },
    });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
  });

  it('HR cannot mint a reset link for an Admin, and no token is minted on the way', async () => {
    const refused = await harness.post<ErrorBody>('/auth/password-resets/for-employee', {
      token: hrToken,
      body: { employeeId: ownerEmployeeId },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.message).toContain('permissions you do not');

    const rows = await harness.db
      .select({ tokenHash: passwordResets.tokenHash })
      .from(passwordResets)
      .where(eq(passwordResets.userId, ownerUserId));
    expect(rows).toHaveLength(0);
  });

  it('HR cannot clear an Admin’s second factor; Admin can still clear HR’s', async () => {
    const refused = await harness.post<ErrorBody>(`/auth/mfa/reset/${ownerUserId}`, { token: hrToken });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);

    const allowed = await harness.post(`/auth/mfa/reset/${hrUserId}`, { token: adminToken });
    expect(allowed.status).toBe(204);
  });
});
