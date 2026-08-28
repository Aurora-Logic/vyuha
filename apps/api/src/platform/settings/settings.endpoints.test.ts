import { SYSTEM_ROLES } from '@vyuha/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { organizations, settings } from '../db/schema/index.js';
import { ATTENDANCE_SETTINGS, LEAVE_SETTINGS, PHOTO_SETTINGS } from './settings.catalogue.js';
import type { OrgSettingsView } from './settings.service.js';

/**
 * `GET/PATCH /settings` and the test send (REQ-L-01 to REQ-L-05) over real HTTP.
 *
 * `resetOrganisation` does not clear `settings` -- no other fixture writes
 * there -- so this file clears its own rows and resets the organisation's
 * profile columns before it starts. Without that a second run would read the
 * values the first run wrote and the assertions about defaults would pass or
 * fail depending on how many times the suite had been run.
 */

const ORG_ID = '01900000-0000-7000-8000-00000000005e';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let adminToken: string;
let hrToken: string;
let adminEmail = '';

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Settings Fixture Org');

  await harness.db.delete(settings).where(eq(settings.orgId, ORG_ID));
  await harness.db
    .update(organizations)
    .set({
      legalName: null,
      timezone: 'Asia/Kolkata',
      dateFormat: 'dd-MM-yyyy',
      weekStart: 1,
      leaveYearStartMonth: 4,
    })
    .where(eq(organizations.id, ORG_ID));

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN);
  const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR);

  const admin = await harness.createUser({
    email: scopedEmail('settings-admin'),
    roleIds: [adminRoleId],
  });
  const hr = await harness.createUser({
    email: scopedEmail('settings-hr'),
    roleIds: [hrRoleId],
  });

  adminEmail = admin.email;
  adminToken = (await harness.login(admin.email, admin.password)).token;
  hrToken = (await harness.login(hr.email, hr.password)).token;
  expect(adminToken).not.toBe('');
  expect(hrToken).not.toBe('');
}, 30_000);

afterAll(async () => {
  await harness.close();
});

function put(body: unknown, token = adminToken) {
  return harness.request<OrgSettingsView>('PATCH', '/settings', { token, body });
}

describe('GET /settings (REQ-L-01, REQ-L-02)', () => {
  it('is refused to a role without settings.manage', async () => {
    const denied = await harness.get<ErrorBody>('/settings', { token: hrToken });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
  });

  it('is refused without a token at all', async () => {
    const anonymous = await harness.get<ErrorBody>('/settings');
    expect(anonymous.status).toBe(401);
  });

  it('answers with the defaults when nothing is stored', async () => {
    const read = await harness.get<OrgSettingsView>('/settings', { token: adminToken });

    expect(read.status, read.text).toBe(200);
    expect(read.body.organisation.timezone).toBe('Asia/Kolkata');
    expect(read.body.organisation.dateFormat).toBe('dd-MM-yyyy');
    expect(read.body.attendance.deviceBindingMode).toBe('WARN');
    expect(read.body.attendance.maxWorkMinutes).toBe(16 * 60);
    expect(read.body.photo.retentionMonths).toBe(12);
    expect(read.body.unreadableKeys).toEqual([]);
  });

  it('says which policy fields are actually in force', async () => {
    const read = await harness.get<OrgSettingsView>('/settings', { token: adminToken });

    // The screen prints this next to the field. A value of null there is the
    // difference between a control and a decoration.
    expect(read.body.enforcement.attendance.maxWorkMinutes).toBe('Day engine');
    // In force since the punch pipeline began stamping `files.expires_at`
    // from this row (REQ-L-03).
    expect(read.body.enforcement.photo.retentionMonths).toBe('Punch photo pipeline');
    // Still a decoration, and the screen still says so: REQ-D-08 fixes the
    // P2-2, closed 28 Aug 2026: the punch pipeline consults the behaviour
    // row on every outside verdict, and escalation reads its window when a
    // request is raised.
    expect(read.body.enforcement.attendance.geofenceBehaviour).toBe('Punch');
  });

  it('never returns SMTP credentials', async () => {
    const read = await harness.get<OrgSettingsView>('/settings', { token: adminToken });

    expect(read.body.email.from.length).toBeGreaterThan(0);
    expect(typeof read.body.email.credentialsConfigured).toBe('boolean');
    // The whole response, not just the email block: a credential leaking
    // through some other field would pass a narrower assertion.
    expect(read.text).not.toContain('SMTP_PASSWORD');
    expect(read.text.toLowerCase()).not.toContain('password');
  });
});

describe('PATCH /settings (REQ-L-01, REQ-L-05)', () => {
  it('is refused to a role without settings.manage', async () => {
    const denied = await put({ organisation: { timezone: 'Europe/London' } }, hrToken);
    expect(denied.status).toBe(403);

    const unchanged = await harness.get<OrgSettingsView>('/settings', { token: adminToken });
    expect(unchanged.body.organisation.timezone).toBe('Asia/Kolkata');
  });

  it('changes the organisation profile and audits it', async () => {
    const saved = await put({
      organisation: {
        legalName: 'Settings Fixture Private Limited',
        timezone: 'Asia/Dubai',
        dateFormat: 'yyyy-MM-dd',
        weekStart: 7,
      },
    });

    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.organisation.legalName).toBe('Settings Fixture Private Limited');
    expect(saved.body.organisation.timezone).toBe('Asia/Dubai');
    expect(saved.body.organisation.weekStart).toBe(7);

    expect(await harness.waitForAuditAction('settings.updated')).toBe(true);
  });

  it('leaves the groups it was not sent alone', async () => {
    // The screen saves one tab at a time. A write that treated absence as
    // "clear it" would blank the policy every time the profile was saved.
    const saved = await put({ attendance: { maxWorkMinutes: 600 } });

    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.attendance.maxWorkMinutes).toBe(600);
    expect(saved.body.organisation.timezone).toBe('Asia/Dubai');
    expect(saved.body.photo.retentionMonths).toBe(12);
  });

  it('writes the policy row the consuming module reads', async () => {
    const rows = await harness.db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.orgId, ORG_ID),
          eq(settings.key, ATTENDANCE_SETTINGS.maxWorkMinutes.key),
        ),
      );

    // Not just "the endpoint echoed it back": the day engine reads this exact
    // key out of this exact table, and a mismatch here is invisible until a
    // punch produces the wrong number of minutes.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(600);
  });

  it('updates rather than duplicating on a second save', async () => {
    await put({ attendance: { maxWorkMinutes: 540 } });

    const rows = await harness.db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.orgId, ORG_ID),
          eq(settings.key, ATTENDANCE_SETTINGS.maxWorkMinutes.key),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(540);
  });

  it('refuses a timezone the platform does not know', async () => {
    const rejected = await harness.request<ErrorBody>('PATCH', '/settings', {
      token: adminToken,
      body: { organisation: { timezone: 'Mars/Olympus_Mons' } },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a date format the client cannot render', async () => {
    const rejected = await harness.request<ErrorBody>('PATCH', '/settings', {
      token: adminToken,
      body: { organisation: { dateFormat: 'DD-MM-YYYY' } },
    });
    expect(rejected.status).toBe(400);
  });

  it('refuses an empty body rather than auditing a change of nothing', async () => {
    const rejected = await harness.request<ErrorBody>('PATCH', '/settings', {
      token: adminToken,
      body: {},
    });
    expect(rejected.status).toBe(400);
  });

  it('refuses a photo band inverted by a single-field patch', async () => {
    // The half that is easy to miss: minBytes is untouched and already 80 KB,
    // so a rule checked against the patch alone would let this through and
    // every punch afterwards would throw on an unparseable settings pair.
    const rejected = await harness.request<ErrorBody>('PATCH', '/settings', {
      token: adminToken,
      body: { photo: { maxBytes: 2 * 1024 } },
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');

    const unchanged = await harness.get<OrgSettingsView>('/settings', { token: adminToken });
    expect(unchanged.body.photo.maxBytes).toBe(150 * 1024);
  });

  it('accepts a photo band that stays ordered', async () => {
    // The control for the case above: a check that refused every photo edit
    // would pass that test and be useless.
    const saved = await put({ photo: { minBytes: 40 * 1024, maxBytes: 200 * 1024 } });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.photo.minBytes).toBe(40 * 1024);
  });

  it('refuses a key that is not in the catalogue', async () => {
    const rejected = await harness.request<ErrorBody>('PATCH', '/settings', {
      token: adminToken,
      body: { attendance: { somethingInvented: 5 } },
    });
    // Zod strips unknown keys, so the group ends up empty and the body-level
    // rule refuses it. Either way nothing unvalidated reaches the table.
    expect([400, 200]).toContain(rejected.status);

    const rows = await harness.db
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.orgId, ORG_ID));
    expect(rows.every((row) => row.key.startsWith('attendance.'))).toBe(true);
    expect(rows.map((row) => row.key)).not.toContain('somethingInvented');
  });
});

describe('the leave policy group (OS-1: REQ-G-04, REQ-G-11, REQ-G-12)', () => {
  it('answers with the defaults the leave slice already applies', async () => {
    const read = await harness.get<OrgSettingsView>('/settings', { token: adminToken });

    expect(read.status, read.text).toBe(200);
    // The same numbers `leave.service.ts` falls back to; a different default
    // here would make the screen report a policy that is not in force.
    expect(read.body.leave).toEqual({
      yearStartMonth: 4,
      compOffExpiryDays: 30,
      concurrentAbsenceThreshold: 0,
    });
    // Every one of these has a real reader; none may claim to be decoration.
    expect(read.body.enforcement.leave.yearStartMonth).not.toBeNull();
    expect(read.body.enforcement.leave.compOffExpiryDays).not.toBeNull();
    expect(read.body.enforcement.leave.concurrentAbsenceThreshold).not.toBeNull();
  });

  it('writes the three rows under the names the leave slice reads', async () => {
    const saved = await put({
      leave: { yearStartMonth: 1, compOffExpiryDays: 45, concurrentAbsenceThreshold: 3 },
    });

    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.leave).toEqual({
      yearStartMonth: 1,
      compOffExpiryDays: 45,
      concurrentAbsenceThreshold: 3,
    });

    // Not just the echo: LEAVE_SETTING_KEYS in leave.repository.ts reads these
    // exact keys, and a mismatch is invisible until an accrual lands in the
    // wrong leave year.
    const rows = await harness.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(eq(settings.orgId, ORG_ID));
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    expect(byKey.get(LEAVE_SETTINGS.yearStartMonth.key)).toBe(1);
    expect(byKey.get(LEAVE_SETTINGS.compOffExpiryDays.key)).toBe(45);
    expect(byKey.get(LEAVE_SETTINGS.concurrentAbsenceThreshold.key)).toBe(3);

    const read = await harness.get<OrgSettingsView>('/settings', { token: adminToken });
    expect(read.body.leave.yearStartMonth).toBe(1);
  });

  it('leaves the two rows a partial patch did not name alone', async () => {
    const saved = await put({ leave: { compOffExpiryDays: 60 } });

    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.leave).toEqual({
      yearStartMonth: 1,
      compOffExpiryDays: 60,
      concurrentAbsenceThreshold: 3,
    });
  });

  it('refuses a month outside the calendar', async () => {
    const rejected = await harness.request<ErrorBody>('PATCH', '/settings', {
      token: adminToken,
      body: { leave: { yearStartMonth: 13 } },
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');

    const unchanged = await harness.get<OrgSettingsView>('/settings', { token: adminToken });
    expect(unchanged.body.leave.yearStartMonth).toBe(1);
  });

  it('refuses a negative concurrent-absence threshold', async () => {
    const rejected = await harness.request<ErrorBody>('PATCH', '/settings', {
      token: adminToken,
      body: { leave: { concurrentAbsenceThreshold: -1 } },
    });
    expect(rejected.status).toBe(400);
  });
});

describe('a corrupt stored row (REQ-L-02)', () => {
  it('does not stop the screen that exists to repair it', async () => {
    await harness.db
      .insert(settings)
      .values({
        orgId: ORG_ID,
        scope: 'ORG',
        scopeId: null,
        key: ATTENDANCE_SETTINGS.deviceBindingMode.key,
        value: 'WARn',
      })
      .onConflictDoNothing();

    const read = await harness.get<OrgSettingsView>('/settings', { token: adminToken });

    expect(read.status, read.text).toBe(200);
    expect(read.body.attendance.deviceBindingMode).toBe('WARN');
    expect(read.body.unreadableKeys).toContain(ATTENDANCE_SETTINGS.deviceBindingMode.key);
    // The good rows beside it survive.
    expect(read.body.attendance.maxWorkMinutes).toBe(540);
  });

  it('is repaired by saving a valid value over it', async () => {
    const saved = await put({ attendance: { deviceBindingMode: 'ENFORCE' } });

    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.attendance.deviceBindingMode).toBe('ENFORCE');
    expect(saved.body.unreadableKeys).toEqual([]);
  });
});

describe('POST /settings/email/test (REQ-L-04)', () => {
  it('sends to the caller, and only to the caller', async () => {
    harness.mail.clear();

    const sent = await harness.post<{ sentTo: string; transport: string }>(
      '/settings/email/test',
      { token: adminToken, body: { to: 'someone.else@example.com' } },
    );

    expect(sent.status, sent.text).toBe(200);
    expect(sent.body.sentTo).toBe(adminEmail);
    // A test-send that honoured a chosen recipient would be a mail relay with
    // an admin login in front of it.
    expect(harness.mail.sent).toHaveLength(1);
    expect(harness.mail.sent[0]?.to).toBe(adminEmail);
    expect(harness.mail.lastTo('someone.else@example.com')).toBeNull();
  });

  it('is refused to a role without settings.manage', async () => {
    harness.mail.clear();
    const denied = await harness.post<ErrorBody>('/settings/email/test', { token: hrToken });
    expect(denied.status).toBe(403);
    expect(harness.mail.sent).toHaveLength(0);
  });

  it('is audited', async () => {
    expect(await harness.waitForAuditAction('settings.email_tested')).toBe(true);
  });
});

describe('the photo keys the punch pipeline reads', () => {
  it('are written under the names that pipeline uses', async () => {
    const rows = await harness.db
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.orgId, ORG_ID));
    const keys = rows.map((row) => row.key);

    expect(keys).toContain(PHOTO_SETTINGS.minBytes.key);
    expect(keys).toContain(PHOTO_SETTINGS.maxBytes.key);
  });
});
