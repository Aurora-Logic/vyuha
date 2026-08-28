import { SYSTEM_ROLES } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, CookieJar } from '../../test-support/api-harness.js';

/**
 * REQ-B-09 over real HTTP: enrolment, the code step, recovery codes,
 * remembered browsers, the policy, and the administrator's reset.
 */

const ORG_ID = '01900000-0000-7000-8000-00000000f0ca';
const PASSWORD = 'fixture-passphrase-2026';

let harness: ApiHarness;
let admin: { id: string; email: string };
let employee: { id: string; email: string };

interface ErrorBody {
  error: { code: string; message: string };
}
interface LoginBody {
  accessToken?: string;
  mfaRequired?: boolean;
  challengeToken?: string;
}
interface MeBody {
  mfa: { enabled: boolean; required: boolean; enrolmentRequired: boolean };
}

/**
 * stepsAhead: the server spends each accepted step (users.totp_last_step),
 * so a flow that checks two codes must present the NEXT one the second
 * time, exactly as a person waiting for the app to tick over would. The
 * verifier's window of 1 accepts a one-step-ahead code.
 */
function codeFor(secret: string, email: string, stepsAhead = 0): string {
  return new TOTP({ issuer: 'Vyuha', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + stepsAhead * 30_000 });
}

async function signIn(email: string, jar = new CookieJar()) {
  await harness.clearLoginRateLimit();
  return harness.post<LoginBody>('/auth/login', { body: { email, password: PASSWORD }, withCookies: true }, jar);
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'MFA Org');
  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN);
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);
  const a = await harness.createUser({ email: 'mfa-admin@example.test', password: PASSWORD, roleIds: [adminRoleId] });
  const e = await harness.createUser({ email: 'mfa-employee@example.test', password: PASSWORD, roleIds: [employeeRoleId] });
  admin = { id: a.id, email: a.email };
  employee = { id: e.id, email: e.email };
});

afterAll(async () => {
  await harness.close();
});

describe('REQ-B-09: two-step sign-in', () => {
  it('refuses the same six digits twice: an accepted step is spent', async () => {
    const first = await signIn(employee.email);
    const start = await harness.post<{ secret: string }>('/auth/mfa/enrol', { token: first.body.accessToken });
    await harness.post('/auth/mfa/confirm', { token: first.body.accessToken, body: { code: codeFor(start.body.secret, employee.email) } });

    // Two fresh challenges, one code: the first passes, the replay is a wrong code.
    const one = await signIn(employee.email);
    const code = codeFor(start.body.secret, employee.email, 1);
    const ok = await harness.post<LoginBody>('/auth/mfa/verify', { body: { challengeToken: one.body.challengeToken, code, trustDevice: false } });
    expect(ok.status).toBe(200);
    const two = await signIn(employee.email);
    const replayed = await harness.post<ErrorBody>('/auth/mfa/verify', { body: { challengeToken: two.body.challengeToken, code, trustDevice: false } });
    expect(replayed.status).toBe(401);
    expect(replayed.body.error.code).toBe('MFA_CODE_INVALID');

    // Clearing the remembered step (the window passing, in effect) lets the
    // very same digits pass again: the refusal above was the spent step, not
    // the code.
    await harness.db.execute(sql`UPDATE users SET totp_last_step = NULL WHERE id = ${employee.id}`);
    const fine = await harness.post<LoginBody>('/auth/mfa/verify', { body: { challengeToken: two.body.challengeToken, code, trustDevice: false } });
    expect(fine.status).toBe(200);

    // Clean up: turn it off so the later employee test enrols from scratch.
    await harness.db.execute(sql`UPDATE users SET totp_last_step = NULL WHERE id = ${employee.id}`);
    const off = await harness.post('/auth/mfa/disable', { token: fine.body.accessToken, body: { code } });
    expect(off.status).toBe(204);
  });

  it('the default policy requires Admin and not Employee, and says so on /me before enrolment', async () => {
    const a = await signIn(admin.email);
    expect(a.status).toBe(200);
    const me = await harness.get<MeBody>('/auth/me', { token: a.body.accessToken });
    expect(me.body.mfa).toEqual({ enabled: false, required: true, enrolmentRequired: true });

    const e = await signIn(employee.email);
    const meE = await harness.get<MeBody>('/auth/me', { token: e.body.accessToken });
    expect(meE.body.mfa).toEqual({ enabled: false, required: false, enrolmentRequired: false });
  });

  it('enrols with the first correct code, hands out ten recovery codes, then challenges the next sign-in', async () => {
    const first = await signIn(admin.email);
    const token = first.body.accessToken;

    const start = await harness.post<{ secret: string; otpauthUri: string }>('/auth/mfa/enrol', { token });
    expect(start.status).toBe(200);
    expect(start.body.otpauthUri).toContain('otpauth://totp/');
    expect(start.body.otpauthUri).toContain(encodeURIComponent(admin.email));

    const wrong = await harness.post<ErrorBody>('/auth/mfa/confirm', { token, body: { code: '000000' } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('MFA_CODE_INVALID');

    const confirm = await harness.post<{ codes: string[] }>('/auth/mfa/confirm', { token, body: { code: codeFor(start.body.secret, admin.email) } });
    expect(confirm.status).toBe(200);
    expect(confirm.body.codes).toHaveLength(10);
    expect(confirm.body.codes.every((code) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/u.test(code))).toBe(true);

    const me = await harness.get<MeBody>('/auth/me', { token });
    expect(me.body.mfa).toEqual({ enabled: true, required: true, enrolmentRequired: false });

    // The password alone is now a challenge, not a session: no token, no refresh cookie.
    const jar = new CookieJar();
    const second = await signIn(admin.email, jar);
    expect(second.status).toBe(200);
    expect(second.body.mfaRequired).toBe(true);
    expect(second.body.accessToken).toBeUndefined();
    expect(jar.get('vyuha_refresh')).toBeNull();

    // Wrong code: refused, the challenge survives. Right code: a session, and this browser remembered.
    const bad = await harness.post<ErrorBody>('/auth/mfa/verify', { body: { challengeToken: second.body.challengeToken, code: '000000', trustDevice: false }, withCookies: true }, jar);
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('MFA_CODE_INVALID');

    const good = await harness.post<LoginBody>('/auth/mfa/verify', { body: { challengeToken: second.body.challengeToken, code: codeFor(start.body.secret, admin.email, 1), trustDevice: true }, withCookies: true }, jar);
    expect(good.status).toBe(200);
    expect(good.body.accessToken).toBeTruthy();
    expect(jar.get('vyuha_refresh')).not.toBeNull();
    expect(jar.get('vyuha_trust')).not.toBeNull();

    // A spent challenge cannot be replayed.
    const replay = await harness.post<ErrorBody>('/auth/mfa/verify', { body: { challengeToken: second.body.challengeToken, code: codeFor(start.body.secret, admin.email), trustDevice: false } });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('MFA_CHALLENGE_EXPIRED');

    // The remembered browser signs in with the password alone for thirty days.
    const trusted = await signIn(admin.email, jar);
    expect(trusted.body.mfaRequired).toBeUndefined();
    expect(trusted.body.accessToken).toBeTruthy();

    // The status lists it as this browser.
    const status = await harness.get<{ enabled: boolean; recoveryCodesLeft: number; trustedDevices: { current: boolean }[] }>('/auth/mfa', { token: trusted.body.accessToken, withCookies: true }, jar);
    expect(status.body.enabled).toBe(true);
    expect(status.body.recoveryCodesLeft).toBe(10);
    expect(status.body.trustedDevices.some((device) => device.current)).toBe(true);

    // A recovery code signs in once, from a browser that is not remembered.
    const fresh = await signIn(admin.email);
    const recovery = confirm.body.codes[0] ?? '';
    const viaRecovery = await harness.post<LoginBody>('/auth/mfa/verify', { body: { challengeToken: fresh.body.challengeToken, code: recovery.toLowerCase(), trustDevice: false } });
    expect(viaRecovery.status).toBe(200);
    const again = await signIn(admin.email);
    const spent = await harness.post<ErrorBody>('/auth/mfa/verify', { body: { challengeToken: again.body.challengeToken, code: recovery, trustDevice: false } });
    expect(spent.status).toBe(401);
    expect(spent.body.error.code).toBe('MFA_CODE_INVALID');

    // Five wrong codes spend the challenge.
    const fifth = await signIn(admin.email);
    let last: { status: number; body: ErrorBody } | null = null;
    for (let i = 0; i < 5; i += 1) {
      last = await harness.post<ErrorBody>('/auth/mfa/verify', { body: { challengeToken: fifth.body.challengeToken, code: '111111', trustDevice: false } });
    }
    expect(last?.body.error.code).toBe('MFA_CHALLENGE_EXPIRED');

    // The administrator's reset clears everything and is on the trail; the password alone signs in, and enrolment is required again.
    const reset = await harness.post('/auth/mfa/reset/' + admin.id, { token: trusted.body.accessToken });
    expect(reset.status).toBe(204);
    expect(await harness.waitForAuditAction('auth.mfa_reset')).toBe(true);
    const afterReset = await signIn(admin.email, jar);
    expect(afterReset.body.accessToken).toBeTruthy();
    const meAfter = await harness.get<MeBody>('/auth/me', { token: afterReset.body.accessToken });
    expect(meAfter.body.mfa).toEqual({ enabled: false, required: true, enrolmentRequired: true });
  });

  it('the policy is a setting: none means nobody is required', async () => {
    const a = await signIn(admin.email);
    const put = await harness.patch<{ security: { mfaPolicy: string } }>('/settings', { token: a.body.accessToken, body: { security: { mfaPolicy: 'none' } } });
    expect(put.status).toBe(200);
    expect(put.body.security.mfaPolicy).toBe('none');
    const me = await harness.get<MeBody>('/auth/me', { token: a.body.accessToken });
    expect(me.body.mfa.required).toBe(false);
    const back = await harness.patch('/settings', { token: a.body.accessToken, body: { security: { mfaPolicy: 'admin_accounts' } } });
    expect(back.status).toBe(200);
  });

  it('turning it off needs a code, and an employee who never enrolled cannot turn it off', async () => {
    const e = await signIn(employee.email);
    const none = await harness.post<ErrorBody>('/auth/mfa/disable', { token: e.body.accessToken, body: { code: '123456' } });
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('MFA_NOT_ENROLLED');

    const start = await harness.post<{ secret: string }>('/auth/mfa/enrol', { token: e.body.accessToken });
    await harness.post('/auth/mfa/confirm', { token: e.body.accessToken, body: { code: codeFor(start.body.secret, employee.email) } });
    const wrong = await harness.post<ErrorBody>('/auth/mfa/disable', { token: e.body.accessToken, body: { code: '000000' } });
    expect(wrong.status).toBe(401);
    const off = await harness.post('/auth/mfa/disable', { token: e.body.accessToken, body: { code: codeFor(start.body.secret, employee.email, 1) } });
    expect(off.status).toBe(204);
    const me = await harness.get<MeBody>('/auth/me', { token: e.body.accessToken });
    expect(me.body.mfa.enabled).toBe(false);
  });
});
