import {
  PERMISSIONS,
  ROLE_PERMISSION_MATRIX,
  SYSTEM_ROLES,
  uuidv7,
  type ApprovalRequestDetail,
  type ApprovalRequestSummary,
  type AttendanceDayDetail,
  type OnDutyRequest,
  type Paginated,
  type RegularizationPolicyView,
  type RegularizationRequest,
} from '@vyuha/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { files, settings } from '../../../platform/db/schema/index.js';
import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';
import { ApprovalService } from '../../../platform/approvals/approval.service.js';
import { addDays } from '../day-engine/calendar-date.js';
import { DayEngineService } from '../day-engine/day-engine.service.js';
import {
  attendanceAdjustments,
  attendancePeriodLocks,
  punches,
  regularizations,
  shifts,
} from '../schema/index.js';
import { REGULARIZATION_SETTING_KEYS } from './regularization.repository.js';

/**
 * REQ-F-01 … REQ-F-05 over real HTTP against the real application: the global
 * guard, the Zod pipe, `ScopeService`, the exception filter, the audit
 * interceptor, migration 0014's partial unique index and check constraint, and
 * the day engine's own recompute, all in the loop.
 *
 * The test that matters most is `the pilot's stuck day`. Everything else here
 * guards a rule; that one reproduces the failure this slice exists to fix — an
 * IN punch with no OUT, a day stuck on PENDING, and nothing in the product
 * able to move it — and proves the muster changes.
 *
 * `preservePeople`, because a punch can never be deleted (REQ-D-12) and its
 * employee is therefore undeletable too. People are minted per run with unique
 * codes, the same arrangement the punch and leave suites use.
 */

/**
 * Unique to this file. Sharing one with another suite is not merely untidy:
 * `ApiHarness.resetOrganisation` deletes the org's employees, and a punch or a
 * request written here makes them undeletable — which is how this file first
 * broke two unrelated suites that happened to pick the same id.
 */
const ORG_ID = '01900000-0000-7000-8000-0000000000f4';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let runId: string;
let dayEngine: DayEngineService;

let employeeAId: string;
let employeeBId: string;
let managerEmployeeId: string;

let employeeToken: string;
let otherToken: string;
let managerToken: string;
let hrToken: string;
let strangerToken: string;

let shiftId: string;
let photoId: string;
let thumbId: string;

/**
 * Today in UTC. Every date below is derived from it by whole days, and the
 * server compares against today in the *employee's* zone — at most a day
 * apart, which is well inside the seven-day window these dates sit in.
 */
const TODAY = new Date().toISOString().slice(0, 10);
/** The stuck day: far enough back that its out window has closed. */
const STUCK_DAY = addDays(TODAY, -2);
const SECOND_DAY = addDays(TODAY, -3);
const THIRD_DAY = addDays(TODAY, -4);
const FOURTH_DAY = addDays(TODAY, -5);
/** Outside a seven-day window under any timezone reading of "today". */
const ANCIENT_DAY = addDays(TODAY, -40);
const TOMORROW = addDays(TODAY, 1);

/** Asia/Kolkata, from `organizations.timezone`; the fixture sets no location. */
const OFFSET = '+05:30';
const at = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00${OFFSET}`);

let punchSequence = 0;
async function insertPunch(input: {
  employeeId: string;
  date: string;
  type: 'IN' | 'OUT';
  at: Date;
}): Promise<string> {
  punchSequence += 1;
  const rows = await harness.db
    .insert(punches)
    .values({
      orgId: ORG_ID,
      employeeId: input.employeeId,
      attendanceDate: input.date,
      punchType: input.type,
      serverTime: input.at,
      photoFileId: photoId,
      thumbnailFileId: thumbId,
      source: 'MOBILE',
      idempotencyKey: `reg-test-${runId}-${String(punchSequence)}`,
    })
    .returning({ id: punches.id });

  const id = rows[0]?.id;
  if (id === undefined) throw new Error('punch fixture insert returned no row');
  return id;
}

/** Runs the real engine, which is what a punch or a nightly sweep would do. */
async function computeDay(employeeId: string, date: string): Promise<void> {
  await dayEngine.forOrg({ orgId: ORG_ID, actorUserId: null }).computeDay(employeeId, date);
}

async function readDay(
  token: string,
  employeeId: string,
  date: string,
): Promise<AttendanceDayDetail> {
  const response = await harness.get<AttendanceDayDetail>(
    `/attendance/days/${employeeId}/${date}`,
    { token },
  );
  expect(response.status, response.text).toBe(200);
  return response.body;
}

/** Installs an org setting for one body and removes it however that body ends. */
async function withSetting(key: string, value: unknown, body: () => Promise<void>): Promise<void> {
  await harness.db
    .insert(settings)
    .values({ orgId: ORG_ID, scope: 'ORG', key, value });
  try {
    await body();
  } finally {
    await harness.db.delete(settings).where(and(eq(settings.orgId, ORG_ID), eq(settings.key, key)));
  }
}

/**
 * Clears this employee's requests so a cap test starts from a known count.
 *
 * A hard delete, not the soft one the product uses: these are fixture rows,
 * and `countRaisedBetween` filters `deleted_at IS NULL`, so a soft delete
 * would leave the partial unique index still holding the date.
 */
async function clearRequests(employeeId: string): Promise<void> {
  await harness.db.execute(sql`
    DELETE FROM attendance_adjustments WHERE org_id = ${ORG_ID} AND employee_id = ${employeeId}
  `);
  await harness.db
    .delete(regularizations)
    .where(and(eq(regularizations.orgId, ORG_ID), eq(regularizations.employeeId, employeeId)));
}

async function raise(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: RegularizationRequest & ErrorBody; text: string }> {
  return harness.post<RegularizationRequest & ErrorBody>('/regularizations', { token, body });
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Regularization Fixture Org', { preservePeople: true });
  runId = uuidv7().slice(-6).toUpperCase();
  dayEngine = harness.resolve(DayEngineService);

  // A red run leaves settings and locks standing, and either would make every
  // later run of this file fail from `beforeAll` onwards.
  await harness.db.execute(
    sql`DELETE FROM settings WHERE org_id = ${ORG_ID} AND key LIKE 'attendance.regularization%'`,
  );
  await harness.db.execute(sql`DELETE FROM attendance_period_locks WHERE org_id = ${ORG_ID}`);

  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);
  const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR);
  // A correction is decided by whoever may edit attendance -- which is what
  // approval-keys.ts has always declared for this subject, and what the
  // catalogue now says outright since `regularization.approve` was removed
  // (owner, 21 Aug 2026; PENDING A-01). The reporting manager here therefore
  // holds the Operations set plus `attendance.edit`, rather than a key that no
  // longer exists.
  const managerRoleId = await harness.createRole('Regularization Manager', [
    ...ROLE_PERMISSION_MATRIX.Operations,
    PERMISSIONS.ATTENDANCE_EDIT,
  ]);
  // Authenticated and holding no regularization key at all, so a 403 is about
  // the missing permission rather than about having no credentials.
  const strangerRoleId = await harness.createRole('Regularization Stranger', [
    'attendance.view.self',
  ]);

  const shiftRows = await harness.db
    .insert(shifts)
    .values({
      orgId: ORG_ID,
      name: `Reg Probe Day ${runId}`,
      code: `RG${runId}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
    })
    .returning({ id: shifts.id });
  const createdShift = shiftRows[0]?.id;
  if (createdShift === undefined) throw new Error('shift fixture returned no row');
  shiftId = createdShift;

  photoId = uuidv7();
  thumbId = uuidv7();
  await harness.db.insert(files).values([
    {
      id: photoId,
      orgId: ORG_ID,
      storageKey: `test/${ORG_ID}/reg-${runId}.jpg`,
      mime: 'image/jpeg',
      bytes: 1024,
      checksum: `reg-${runId}`,
      purpose: 'PUNCH_PHOTO',
    },
    {
      id: thumbId,
      orgId: ORG_ID,
      storageKey: `test/${ORG_ID}/reg-${runId}-thumb.jpg`,
      mime: 'image/jpeg',
      bytes: 256,
      checksum: `reg-thumb-${runId}`,
      purpose: 'PUNCH_PHOTO',
    },
  ]);

  managerEmployeeId = await harness.createEmployee({
    code: `RG-M-${runId}`,
    firstName: 'Meera',
    dateOfJoining: '2020-01-01',
  });
  employeeAId = await harness.createEmployee({
    code: `RG-A-${runId}`,
    firstName: 'Asha',
    reportingManagerId: managerEmployeeId,
    dateOfJoining: '2020-01-01',
  });
  employeeBId = await harness.createEmployee({
    code: `RG-B-${runId}`,
    firstName: 'Bhavin',
    reportingManagerId: managerEmployeeId,
    dateOfJoining: '2020-01-01',
  });

  await harness.db.execute(sql`
    UPDATE employees SET default_shift_id = ${shiftId}
     WHERE org_id = ${ORG_ID}
       AND id IN (${employeeAId}::uuid, ${employeeBId}::uuid, ${managerEmployeeId}::uuid)
  `);

  const userA = await harness.createUser({
    email: scopedEmail('reg-a'),
    roleIds: [employeeRoleId],
    employeeId: employeeAId,
  });
  const userB = await harness.createUser({
    email: scopedEmail('reg-b'),
    roleIds: [employeeRoleId],
    employeeId: employeeBId,
  });
  const manager = await harness.createUser({
    email: scopedEmail('reg-mgr'),
    roleIds: [managerRoleId],
    employeeId: managerEmployeeId,
  });
  const hrUser = await harness.createUser({ email: scopedEmail('reg-hr'), roleIds: [hrRoleId] });
  const stranger = await harness.createUser({
    email: scopedEmail('reg-stranger'),
    roleIds: [strangerRoleId],
  });

  employeeToken = (await harness.login(userA.email, userA.password)).token;
  otherToken = (await harness.login(userB.email, userB.password)).token;
  managerToken = (await harness.login(manager.email, manager.password)).token;
  hrToken = (await harness.login(hrUser.email, hrUser.password)).token;
  strangerToken = (await harness.login(stranger.email, stranger.password)).token;
  expect(
    [employeeToken, otherToken, managerToken, hrToken, strangerToken].every((t) => t !== ''),
  ).toBe(true);
}, 60_000);

afterAll(async () => {
  await harness.close();
});

// ---------------------------------------------------------- access control

describe('access control', () => {
  it('refuses an unauthenticated request on every route', async () => {
    const routes: readonly [string, string][] = [
      ['GET', '/regularizations'],
      ['GET', '/regularizations/policy'],
      ['POST', '/regularizations'],
      ['GET', '/on-duty-requests'],
      ['POST', '/on-duty-requests'],
    ];

    for (const [method, path] of routes) {
      const response = await harness.request(method, path, {
        body: method === 'GET' ? undefined : {},
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses a signed-in account holding no regularization permission', async () => {
    const response = await harness.get<ErrorBody>('/regularizations', { token: strangerToken });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('lets an employee raise but not decide (REQ-F-05 is an approver act)', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'Left at half six, the punch did not go through.',
    });
    expect(raised.status, raised.text).toBe(201);

    const decided = await harness.post<ErrorBody>(
      `/regularizations/${raised.body.id}/approve`,
      { token: employeeToken, body: {} },
    );
    expect(decided.status).toBe(403);
    expect(decided.body.error.code).toBe('FORBIDDEN');
  });

  it('hides one employee’s request from another (scope, not a 403)', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'A reason nobody else should be able to read.',
    });
    expect(raised.status, raised.text).toBe(201);

    // 404 rather than 403: a 403 would confirm the id names a real request.
    const peek = await harness.get<ErrorBody>(`/regularizations/${raised.body.id}`, {
      token: otherToken,
    });
    expect(peek.status).toBe(404);

    const list = await harness.get<Paginated<RegularizationRequest>>('/regularizations', {
      token: otherToken,
    });
    expect(list.status).toBe(200);
    expect(list.body.data.some((row) => row.id === raised.body.id)).toBe(false);
  });

  it('lets the manager see a report’s request through the team scope', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'The manager should be able to read this one.',
    });
    expect(raised.status, raised.text).toBe(201);

    const seen = await harness.get<RegularizationRequest>(`/regularizations/${raised.body.id}`, {
      token: managerToken,
    });
    expect(seen.status, seen.text).toBe(200);
    expect(seen.body.employee.id).toBe(employeeAId);
  });
});

// ------------------------------------------------------------- REQ-F-01

describe('raising a regularization (REQ-F-01)', () => {
  it('refuses a request with no reason', async () => {
    const response = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a one-character reason, which is not a reason', async () => {
    const response = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'x',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a kind without the time it needs', async () => {
    const response = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'FORGOT_TO_PUNCH',
      requestedIn: '09:15',
      reason: 'Forgot both, but only gave one time.',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a time the kind does not change', async () => {
    // MISSING_OUT moves the out punch. Accepting an in time here would move a
    // punch the employee never mentioned.
    const response = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedIn: '09:15',
      requestedOut: '18:30',
      reason: 'Trying to move a punch this kind does not touch.',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a malformed clock', async () => {
    const response = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '25:00',
      reason: 'There is no 25 o’clock.',
    });
    expect(response.status).toBe(400);
  });

  it('refuses an unknown field rather than dropping it', async () => {
    const response = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'A reason of sufficient length.',
      status: 'APPROVED',
    });
    expect(response.status).toBe(400);
  });

  it('records the reason and starts PENDING', async () => {
    await clearRequests(employeeAId);
    const response = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'Left at half six; the punch did not register.',
    });
    expect(response.status, response.text).toBe(201);
    expect(response.body.status).toBe('PENDING');
    expect(response.body.reason).toBe('Left at half six; the punch did not register.');
    expect(response.body.decidedAt).toBeNull();
    expect(response.body.employee.id).toBe(employeeAId);
    // Composed by the server from the wall clock: 18:30 Asia/Kolkata is 13:00Z.
    expect(response.body.requestedOut).toBe(`${SECOND_DAY}T13:00:00.000Z`);
    expect(response.body.requestedIn).toBeNull();
  });

  it('refuses a second open request for the same day', async () => {
    await clearRequests(employeeAId);
    const first = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'The first attempt at this day.',
    });
    expect(first.status, first.text).toBe(201);

    const second = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '19:00',
      reason: 'A second attempt at the same day.',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.details?.reason).toBe('ALREADY_PENDING');
  });

  it('writes an audit row (CLAUDE.md §4)', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'This one should leave a trail.',
    });
    expect(raised.status, raised.text).toBe(201);
    expect(await harness.waitForAuditAction('regularization.raised')).toBe(true);
  });
});

// ------------------------------------------------------------- REQ-F-02

describe('the configured limits (REQ-F-02)', () => {
  it('reports the defaults when the organisation has set nothing', async () => {
    const response = await harness.get<RegularizationPolicyView>('/regularizations/policy', {
      token: employeeToken,
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.windowDays).toBe(7);
    expect(response.body.maxPerMonth).toBe(3);
    // Today counts as one of the seven days.
    expect(response.body.earliestDate).toBe(addDays(response.body.today, -6));
  });

  it('reports the configured values rather than the defaults', async () => {
    await withSetting(REGULARIZATION_SETTING_KEYS.windowDays, 30, async () => {
      const response = await harness.get<RegularizationPolicyView>('/regularizations/policy', {
        token: employeeToken,
      });
      expect(response.status, response.text).toBe(200);
      expect(response.body.windowDays).toBe(30);
      expect(response.body.earliestDate).toBe(addDays(response.body.today, -29));
    });
  });

  it('refuses a date older than the window, naming the window in force', async () => {
    await clearRequests(employeeAId);
    const response = await raise(employeeToken, {
      date: ANCIENT_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'Six weeks ago, which is well outside the window.',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.details?.reason).toBe('OUTSIDE_WINDOW');
    expect(response.body.error.message).toContain('7');
  });

  it('accepts that same date once the window setting is widened', async () => {
    // The setting is what decides, not a constant in the code. This is the
    // assertion that would fail if the window were ever hardcoded.
    await clearRequests(employeeAId);
    await withSetting(REGULARIZATION_SETTING_KEYS.windowDays, 90, async () => {
      const response = await raise(employeeToken, {
        date: ANCIENT_DAY,
        kind: 'MISSING_OUT',
        requestedOut: '18:30',
        reason: 'Six weeks ago, inside a ninety-day window.',
      });
      expect(response.status, response.text).toBe(201);
    });
  });

  it('refuses a date in the future as a future date, not an old one', async () => {
    await clearRequests(employeeAId);
    const response = await raise(employeeToken, {
      date: TOMORROW,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'Tomorrow has not been worked yet.',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.details?.reason).toBe('FUTURE_DATE');
  });

  it('refuses the fourth request in a month and counts the spent ones', async () => {
    await clearRequests(employeeAId);
    for (const date of [STUCK_DAY, SECOND_DAY, THIRD_DAY]) {
      const response = await raise(employeeToken, {
        date,
        kind: 'MISSING_OUT',
        requestedOut: '18:30',
        reason: `Filling the monthly allowance on ${date}.`,
      });
      expect(response.status, response.text).toBe(201);
    }

    const policy = await harness.get<RegularizationPolicyView>('/regularizations/policy', {
      token: employeeToken,
    });
    expect(policy.body.raisedThisMonth).toBe(3);
    expect(policy.body.remainingThisMonth).toBe(0);

    const fourth = await raise(employeeToken, {
      date: FOURTH_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'One more than the organisation allows.',
    });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.details?.reason).toBe('MONTHLY_CAP_REACHED');
  });

  it('accepts a fourth once the cap setting is raised', async () => {
    // The three from the previous test are still standing, which is the point.
    await withSetting(REGULARIZATION_SETTING_KEYS.maxPerMonth, 5, async () => {
      const response = await raise(employeeToken, {
        date: FOURTH_DAY,
        kind: 'MISSING_OUT',
        requestedOut: '18:30',
        reason: 'The fourth, under a cap of five.',
      });
      expect(response.status, response.text).toBe(201);
    });
  });

  it('switches the feature off at a cap of zero', async () => {
    await clearRequests(employeeAId);
    await withSetting(REGULARIZATION_SETTING_KEYS.maxPerMonth, 0, async () => {
      const response = await raise(employeeToken, {
        date: SECOND_DAY,
        kind: 'MISSING_OUT',
        requestedOut: '18:30',
        reason: 'Should be refused: the organisation allows none.',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('switched off');
    });
  });
});

// ------------------------------------------------------- REQ-F-03, F-05

describe('deciding a regularization (REQ-F-03, REQ-F-05, REQ-I-05)', () => {
  it('refuses an approver deciding their own request (REQ-I-05)', async () => {
    await clearRequests(managerEmployeeId);
    const raised = await raise(managerToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'The approver correcting their own day.',
    });
    expect(raised.status, raised.text).toBe(201);

    const decided = await harness.post<ErrorBody>(`/regularizations/${raised.body.id}/approve`, {
      token: managerToken,
      body: {},
    });
    expect(decided.status).toBe(403);
    expect(decided.body.error.code).toBe('APPROVER_IS_REQUESTER');
  });

  it('refuses a rejection with no reason (REQ-F-05)', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'A request that will be rejected without a reason.',
    });
    expect(raised.status, raised.text).toBe(201);

    const rejected = await harness.post<ErrorBody>(`/regularizations/${raised.body.id}/reject`, {
      token: managerToken,
      body: {},
    });
    expect(rejected.status).toBe(400);
  });

  it('records the rejection reason where the employee can read it (REQ-F-05)', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'A request that will be rejected with a reason.',
    });
    expect(raised.status, raised.text).toBe(201);

    const rejected = await harness.post<RegularizationRequest & ErrorBody>(
      `/regularizations/${raised.body.id}/reject`,
      { token: managerToken, body: { reason: 'The roster shows you were not on site that day.' } },
    );
    expect(rejected.status, rejected.text).toBe(201);
    expect(rejected.body.status).toBe('REJECTED');

    // The employee's own read is what matters: an audit row is not somewhere
    // an employee can look.
    const mine = await harness.get<RegularizationRequest>(`/regularizations/${raised.body.id}`, {
      token: employeeToken,
    });
    expect(mine.status, mine.text).toBe(200);
    expect(mine.body.decisionReason).toBe('The roster shows you were not on site that day.');
    expect(mine.body.decidedBy).not.toBeNull();
    expect(await harness.waitForAuditAction('regularization.rejected')).toBe(true);
  });

  it('refuses a second decision on an already decided request', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'This one gets decided twice.',
    });
    expect(raised.status, raised.text).toBe(201);

    const first = await harness.post(`/regularizations/${raised.body.id}/reject`, {
      token: managerToken,
      body: { reason: 'Declined the first time.' },
    });
    expect(first.status).toBe(201);

    const second = await harness.post<ErrorBody>(`/regularizations/${raised.body.id}/reject`, {
      token: managerToken,
      body: { reason: 'Declined a second time.' },
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('APPROVAL_ALREADY_ACTIONED');
  });

  /**
   * The whole point of the slice.
   *
   * An IN punch with no OUT leaves the day PENDING (REQ-E-02), and before this
   * slice existed there was nothing in the product that could move it. This
   * drives the real fix end to end and asserts the muster changed.
   */
  it('the pilot’s stuck day: PENDING, regularized, approved, recomputed', async () => {
    await clearRequests(employeeBId);
    await insertPunch({
      employeeId: employeeBId,
      date: STUCK_DAY,
      type: 'IN',
      at: at(STUCK_DAY, '09:05'),
    });
    await computeDay(employeeBId, STUCK_DAY);

    const before = await readDay(hrToken, employeeBId, STUCK_DAY);
    expect(before.status).toBe('PENDING');
    expect(before.workedMinutes).toBe(0);
    expect(before.flags).toContain('missing_punch');
    expect(before.punches).toHaveLength(1);

    const raised = await harness.post<RegularizationRequest & ErrorBody>('/regularizations', {
      token: otherToken,
      body: {
        date: STUCK_DAY,
        kind: 'MISSING_OUT',
        requestedOut: '18:30',
        reason: 'I left at half six; the out punch never went through.',
      },
    });
    expect(raised.status, raised.text).toBe(201);

    const approved = await harness.post<RegularizationRequest & ErrorBody>(
      `/regularizations/${raised.body.id}/approve`,
      { token: managerToken, body: { reason: 'Confirmed with the site register.' } },
    );
    expect(approved.status, approved.text).toBe(201);
    expect(approved.body.status).toBe('APPROVED');

    const after = await readDay(hrToken, employeeBId, STUCK_DAY);
    // 09:05 to 18:30 is 565 minutes, less the shift's 60-minute break.
    expect(after.workedMinutes).toBe(505);
    expect(after.status).toBe('PRESENT');
    expect(after.flags).not.toContain('missing_punch');

    // REQ-F-03: "The original punches remain untouched and visible."
    expect(after.punches).toHaveLength(1);
    expect(after.punches[0]?.type).toBe('IN');
    expect(after.lastOutAt).toBe(`${STUCK_DAY}T13:00:00.000Z`);

    const adjustments = await harness.db
      .select({ id: attendanceAdjustments.id, reason: attendanceAdjustments.reason })
      .from(attendanceAdjustments)
      .where(
        and(
          eq(attendanceAdjustments.orgId, ORG_ID),
          eq(attendanceAdjustments.employeeId, employeeBId),
          eq(attendanceAdjustments.attendanceDate, STUCK_DAY),
        ),
      );
    expect(adjustments).toHaveLength(1);
    // The employee's words, not the approver's: a report asking why a day was
    // corrected wants the reason it was asked for.
    expect(adjustments[0]?.reason).toBe('I left at half six; the out punch never went through.');
    expect(await harness.waitForAuditAction('regularization.approved')).toBe(true);
  });

  it('refuses to approve into a locked period, and writes nothing (REQ-E-09)', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'Raised before the month was closed.',
    });
    expect(raised.status, raised.text).toBe(201);

    const [year, month] = [Number(SECOND_DAY.slice(0, 4)), Number(SECOND_DAY.slice(5, 7))];
    const lockRows = await harness.db
      .insert(attendancePeriodLocks)
      .values({ orgId: ORG_ID, year, month, lockedBy: null })
      .returning({ id: attendancePeriodLocks.id });
    const lockId = lockRows[0]?.id;
    if (lockId === undefined) throw new Error('period lock fixture returned no row');

    try {
      const approved = await harness.post<ErrorBody>(
        `/regularizations/${raised.body.id}/approve`,
        { token: managerToken, body: {} },
      );
      expect(approved.status).toBe(409);
      expect(approved.body.error.code).toBe('PERIOD_LOCKED');

      // The status must not have moved either: a request marked approved with
      // no adjustment beside it is a correction the muster will never show.
      const still = await harness.get<RegularizationRequest>(
        `/regularizations/${raised.body.id}`,
        { token: employeeToken },
      );
      expect(still.body.status).toBe('PENDING');

      const adjustments = await harness.db
        .select({ id: attendanceAdjustments.id })
        .from(attendanceAdjustments)
        .where(
          and(
            eq(attendanceAdjustments.orgId, ORG_ID),
            eq(attendanceAdjustments.employeeId, employeeAId),
            eq(attendanceAdjustments.attendanceDate, SECOND_DAY),
          ),
        );
      expect(adjustments).toHaveLength(0);
    } finally {
      await harness.db
        .delete(attendancePeriodLocks)
        .where(eq(attendancePeriodLocks.id, lockId));
    }
  });

  it('refuses to raise for a locked period at all', async () => {
    await clearRequests(employeeAId);
    const [year, month] = [Number(THIRD_DAY.slice(0, 4)), Number(THIRD_DAY.slice(5, 7))];
    const lockRows = await harness.db
      .insert(attendancePeriodLocks)
      .values({ orgId: ORG_ID, year, month, lockedBy: null })
      .returning({ id: attendancePeriodLocks.id });
    const lockId = lockRows[0]?.id;
    if (lockId === undefined) throw new Error('period lock fixture returned no row');

    try {
      const response = await raise(employeeToken, {
        date: THIRD_DAY,
        kind: 'MISSING_OUT',
        requestedOut: '18:30',
        reason: 'The month is already closed.',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PERIOD_LOCKED');
    } finally {
      await harness.db.delete(attendancePeriodLocks).where(eq(attendancePeriodLocks.id, lockId));
    }
  });
});

// ------------------------------------------------------------- REQ-F-04

describe('on duty (REQ-F-04)', () => {
  it('refuses a range that ends before it starts', async () => {
    const response = await harness.post<ErrorBody>('/on-duty-requests', {
      token: employeeToken,
      body: {
        fromDate: SECOND_DAY,
        toDate: THIRD_DAY,
        reason: 'A range the wrong way round.',
      },
    });
    expect(response.status).toBe(400);
  });

  it('refuses a range longer than the bound', async () => {
    const response = await harness.post<ErrorBody>('/on-duty-requests', {
      token: employeeToken,
      body: {
        fromDate: TODAY,
        toDate: addDays(TODAY, 120),
        reason: 'Four months at a client site, in one request.',
      },
    });
    expect(response.status).toBe(400);
  });

  it('turns approved days into ON_DUTY that count as present', async () => {
    const from = addDays(TODAY, 30);
    const to = addDays(from, 1);

    const raised = await harness.post<OnDutyRequest & ErrorBody>('/on-duty-requests', {
      token: otherToken,
      body: {
        fromDate: from,
        toDate: to,
        reason: 'Two days at the client site in Pune.',
        siteName: 'Pune plant',
      },
    });
    expect(raised.status, raised.text).toBe(201);
    expect(raised.body.status).toBe('PENDING');
    expect(raised.body.siteName).toBe('Pune plant');

    const approved = await harness.post<OnDutyRequest & ErrorBody>(
      `/on-duty-requests/${raised.body.id}/approve`,
      { token: managerToken, body: {} },
    );
    expect(approved.status, approved.text).toBe(201);
    expect(approved.body.status).toBe('APPROVED');

    // The recompute ran inline, so the muster already says so -- no sweep, no
    // second request.
    for (const date of [from, to]) {
      const day = await readDay(hrToken, employeeBId, date);
      expect(day.status, date).toBe('ON_DUTY');
    }
    expect(await harness.waitForAuditAction('on_duty.approved')).toBe(true);
  });

  it('refuses a second request overlapping a live one', async () => {
    const from = addDays(TODAY, 60);
    const first = await harness.post<OnDutyRequest & ErrorBody>('/on-duty-requests', {
      token: employeeToken,
      body: { fromDate: from, toDate: addDays(from, 3), reason: 'The first claim on these days.' },
    });
    expect(first.status, first.text).toBe(201);

    const overlapping = await harness.post<ErrorBody>('/on-duty-requests', {
      token: employeeToken,
      body: {
        fromDate: addDays(from, 2),
        toDate: addDays(from, 5),
        reason: 'Overlapping the first by two days.',
      },
    });
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.error.details?.reason).toBe('OVERLAPPING_ON_DUTY');
  });

  it('refuses an approver deciding their own on-duty request (REQ-I-05)', async () => {
    const from = addDays(TODAY, 90);
    const raised = await harness.post<OnDutyRequest & ErrorBody>('/on-duty-requests', {
      token: managerToken,
      body: { fromDate: from, toDate: from, reason: 'The approver’s own field day.' },
    });
    expect(raised.status, raised.text).toBe(201);

    const decided = await harness.post<ErrorBody>(
      `/on-duty-requests/${raised.body.id}/approve`,
      { token: managerToken, body: {} },
    );
    expect(decided.status).toBe(403);
    expect(decided.body.error.code).toBe('APPROVER_IS_REQUESTER');
  });
});

// ------------------------------------------- the regularization / approvals join

/**
 * REQ-I-01, the half `leave.endpoints.test.ts` proves for leave.
 *
 * A correction and an on-duty declaration now reach the same inbox leave
 * reaches, and the adjustment row is written by the framework's callback rather
 * than by this slice's own endpoint. Two properties matter more than the rest
 * and each has a test that fails alone if it stops holding:
 *
 *   - raising puts the request in the inbox, so REQ-G-09's escalation sweep
 *     can see it. Before this it could not.
 *   - the inbox and this slice's own endpoint produce the *same* adjustment,
 *     because the second is now a thin caller of the first. Two paths that both
 *     write an adjustment is exactly what the join removes.
 */
describe('the regularization / approvals join (REQ-I-01, REQ-F-03, REQ-F-04)', () => {
  /**
   * The request as the inbox actually lists it, found the way an approver
   * would: by reading the inbox, not by fetching the id directly. A detail read
   * would pass even if the row never appeared in any list.
   */
  async function inboxRow(
    token: string,
    approvalRequestId: string | null,
  ): Promise<ApprovalRequestSummary | undefined> {
    const inbox = await harness.get<Paginated<ApprovalRequestSummary>>(
      '/approvals?view=all&pageSize=100',
      { token },
    );
    expect(inbox.status, inbox.text).toBe(200);
    return inbox.body.data.find((row) => row.id === approvalRequestId);
  }

  async function adjustmentsFor(employeeId: string, date: string): Promise<number> {
    const rows = await harness.db
      .select({ id: attendanceAdjustments.id })
      .from(attendanceAdjustments)
      .where(
        and(
          eq(attendanceAdjustments.orgId, ORG_ID),
          eq(attendanceAdjustments.employeeId, employeeId),
          eq(attendanceAdjustments.attendanceDate, date),
        ),
      );
    return rows.length;
  }

  it('raises an approval with the correction, and puts it in the approver inbox', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'The out punch never went through on the gate.',
    });
    expect(raised.status, raised.text).toBe(201);
    // The column that has been null since migration 0004.
    expect(raised.body.approvalRequestId).not.toBeNull();

    const row = await inboxRow(managerToken, raised.body.approvalRequestId);
    expect(row).toBeDefined();
    expect(row?.type).toBe('REGULARIZATION');
    expect(row?.status).toBe('PENDING');
    // REQ-I-01: the inbox renders a sentence the framework never had to join a
    // subject table to produce.
    expect(row?.subject).toContain('Asha');
    expect(row?.subject).toContain(SECOND_DAY);

    // Routed to the reporting manager, one step -- not to every org-wide
    // approver as well, which would make one missing punch need two approvals.
    const detail = await harness.get<ApprovalRequestDetail>(
      `/approvals/${String(raised.body.approvalRequestId)}`,
      { token: managerToken },
    );
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.subjectType).toBe('regularization');
    expect(detail.body.subjectId).toBe(raised.body.id);
    expect(detail.body.steps).toHaveLength(1);
    expect(detail.body.awaiting?.name).toContain('Meera');
  });

  it('approving in the inbox writes the adjustment and recomputes the day', async () => {
    await clearRequests(employeeBId);
    await insertPunch({
      employeeId: employeeBId,
      date: FOURTH_DAY,
      type: 'IN',
      at: at(FOURTH_DAY, '09:05'),
    });
    await computeDay(employeeBId, FOURTH_DAY);
    expect((await readDay(managerToken, employeeBId, FOURTH_DAY)).status).toBe('PENDING');

    const raised = await raise(otherToken, {
      date: FOURTH_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'Left at half six, no out punch.',
    });
    expect(raised.status, raised.text).toBe(201);
    expect(await adjustmentsFor(employeeBId, FOURTH_DAY)).toBe(0);

    // Decided on the framework's endpoint, never on this slice's.
    const decided = await harness.post<ApprovalRequestDetail>(
      `/approvals/${String(raised.body.approvalRequestId)}/approve`,
      { token: managerToken, body: { reason: 'Confirmed with the site register.' } },
    );
    expect(decided.status, decided.text).toBe(201);
    expect(decided.body.status).toBe('APPROVED');

    // The subject moved with it, which is the failure the registry exists to
    // prevent: an inbox saying approved while the record it was about did not.
    const after = await harness.get<RegularizationRequest>(`/regularizations/${raised.body.id}`, {
      token: managerToken,
    });
    expect(after.body.status).toBe('APPROVED');
    expect(after.body.decisionReason).toBe('Confirmed with the site register.');

    expect(await adjustmentsFor(employeeBId, FOURTH_DAY)).toBe(1);
    const day = await readDay(managerToken, employeeBId, FOURTH_DAY);
    expect(day.status).toBe('PRESENT');
    expect(day.workedMinutes).toBe(505);
    // REQ-F-03: the original punch is untouched and still visible.
    expect(day.punches).toHaveLength(1);
  });

  it('rejecting in the inbox writes no adjustment and leaves the day alone', async () => {
    await clearRequests(employeeAId);
    await insertPunch({
      employeeId: employeeAId,
      date: THIRD_DAY,
      type: 'IN',
      at: at(THIRD_DAY, '09:05'),
    });
    await computeDay(employeeAId, THIRD_DAY);

    const raised = await raise(employeeToken, {
      date: THIRD_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '23:30',
      reason: 'I say I was here until half eleven.',
    });
    expect(raised.status, raised.text).toBe(201);

    const decided = await harness.post<ApprovalRequestDetail>(
      `/approvals/${String(raised.body.approvalRequestId)}/reject`,
      { token: managerToken, body: { reason: 'The gate log shows you left at six.' } },
    );
    expect(decided.status, decided.text).toBe(201);
    expect(decided.body.status).toBe('REJECTED');

    const after = await harness.get<RegularizationRequest>(`/regularizations/${raised.body.id}`, {
      token: employeeToken,
    });
    expect(after.body.status).toBe('REJECTED');
    // REQ-F-05: the reason is where the employee can read it, not only in a
    // notification that has already been and gone.
    expect(after.body.decisionReason).toBe('The gate log shows you left at six.');

    expect(await adjustmentsFor(employeeAId, THIRD_DAY)).toBe(0);
    expect((await readDay(managerToken, employeeAId, THIRD_DAY)).status).toBe('PENDING');
  });

  /**
   * The property the whole change exists for: one writer of the adjustment.
   *
   * Two corrections of the same shape, one decided in the inbox and one on this
   * slice's own endpoint, have to land identically. If the old endpoint ever
   * grows its own write again, the counts stay equal but the *audit action* and
   * the recompute would not -- so the day itself is compared, not just the row
   * count.
   */
  it('produces an identical outcome from the inbox and from the slice endpoint', async () => {
    const dayOne = addDays(TODAY, -6);
    const dayTwo = addDays(TODAY, -7);
    // Cleared once, not per iteration: `clearRequests` deletes this employee's
    // adjustments, so clearing inside the loop would erase the first outcome
    // before the second was compared against it.
    await clearRequests(employeeBId);
    await withSetting(REGULARIZATION_SETTING_KEYS.windowDays, 14, async () => {
      for (const [index, date] of [dayOne, dayTwo].entries()) {
        await insertPunch({
          employeeId: employeeBId,
          date,
          type: 'IN',
          at: at(date, '09:05'),
        });
        await computeDay(employeeBId, date);

        const raised = await raise(otherToken, {
          date,
          kind: 'MISSING_OUT',
          requestedOut: '18:30',
          reason: 'Same correction, decided two different ways.',
        });
        expect(raised.status, raised.text).toBe(201);

        const url =
          index === 0
            ? `/approvals/${String(raised.body.approvalRequestId)}/approve`
            : `/regularizations/${raised.body.id}/approve`;
        const decided = await harness.post(url, { token: managerToken, body: { reason: 'Yes.' } });
        expect(decided.status, decided.text).toBe(201);
      }

      for (const date of [dayOne, dayTwo]) {
        expect(await adjustmentsFor(employeeBId, date)).toBe(1);
        const day = await readDay(managerToken, employeeBId, date);
        expect(day.status).toBe('PRESENT');
        expect(day.workedMinutes).toBe(505);
      }
    });
  });

  it('refuses a second decision through the other surface, and writes nothing twice', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'WRONG_TIME',
      requestedIn: '09:00',
      requestedOut: '18:00',
      reason: 'The reader recorded the wrong times.',
    });
    expect(raised.status, raised.text).toBe(201);

    const first = await harness.post(`/regularizations/${raised.body.id}/approve`, {
      token: managerToken,
      body: { reason: 'Agreed.' },
    });
    expect(first.status, first.text).toBe(201);

    // The framework's compare-and-swap, reached from the other side.
    const second = await harness.post<ErrorBody>(
      `/approvals/${String(raised.body.approvalRequestId)}/approve`,
      { token: managerToken, body: {} },
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('APPROVAL_ALREADY_ACTIONED');
    expect(await adjustmentsFor(employeeAId, SECOND_DAY)).toBe(1);
  });

  it('refuses deciding a correction in the inbox without regularization.approve', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'Raised so a leave-only approver can be refused it.',
    });
    expect(raised.status, raised.text).toBe(201);

    // Holds both leave keys and no correction key. Before the handler declared
    // which permission decides its own subject type, routing a correction into
    // the shared inbox would have made this account able to approve it -- the
    // route guard on `/approvals/:id/approve` can only ask whether the caller
    // approves *something*.
    const leaveOnlyRoleId = await harness.createRole(`Leave Only ${runId}`, [
      'leave.approve.team',
      'leave.approve.all',
    ]);
    const leaveOnly = await harness.createUser({
      email: scopedEmail('reg-leave-only'),
      roleIds: [leaveOnlyRoleId],
    });
    const leaveOnlyToken = (await harness.login(leaveOnly.email, leaveOnly.password)).token;

    const refused = await harness.post<ErrorBody>(
      `/approvals/${String(raised.body.approvalRequestId)}/approve`,
      { token: leaveOnlyToken, body: {} },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/permission that decides this kind/u);

    const after = await harness.get<RegularizationRequest>(`/regularizations/${raised.body.id}`, {
      token: managerToken,
    });
    expect(after.body.status).toBe('PENDING');
    expect(await adjustmentsFor(employeeAId, SECOND_DAY)).toBe(0);
  });

  it('refuses to decide a correction raised before the join, and says what to do', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'Stripped of its approval to look like an old row.',
    });
    expect(raised.status, raised.text).toBe(201);

    // The shape a row written before this migration has: a request with no
    // approval, and therefore no route, no step and nobody the framework could
    // name as its approver.
    await harness.db.execute(
      sql`UPDATE regularizations SET approval_request_id = NULL WHERE id = ${raised.body.id}`,
    );

    const refused = await harness.post<ErrorBody>(`/regularizations/${raised.body.id}/approve`, {
      token: managerToken,
      body: {},
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/predates the approvals inbox/u);
    expect(await adjustmentsFor(employeeAId, SECOND_DAY)).toBe(0);
  });

  it('mirrors an escalation onto the correction and blocks a duplicate raise', async () => {
    await clearRequests(employeeAId);
    const raised = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '18:30',
      reason: 'Left to go stale so the sweep moves it.',
    });
    expect(raised.status, raised.text).toBe(201);

    await harness.db.execute(sql`
      UPDATE approval_requests
         SET current_step_started_at = now() - make_interval(days => 9), escalate_after_days = 1
       WHERE id = ${String(raised.body.approvalRequestId)}
    `);
    await harness.resolve(ApprovalService).escalateStale(new Date());

    const after = await harness.get<RegularizationRequest>(`/regularizations/${raised.body.id}`, {
      token: managerToken,
    });
    // Two records agreeing about the same fact. Before the handler mirrored it,
    // the correction would still read PENDING while its approval read ESCALATED.
    expect(after.body.status).toBe('ESCALATED');

    // And an escalated request is still open, so the same day cannot be
    // regularized twice. Migration 0017 widened the partial unique index to say
    // so; this is the service-side half of the same rule.
    const duplicate = await raise(employeeToken, {
      date: SECOND_DAY,
      kind: 'MISSING_OUT',
      requestedOut: '19:30',
      reason: 'A second bite while the first is still live.',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details?.['reason']).toBe('ALREADY_PENDING');

    // Still decidable, which is what makes ESCALATED open rather than terminal
    // -- and by the org-wide approver the sweep moved it to, who was not on the
    // route when it was raised.
    const decided = await harness.post<ApprovalRequestDetail>(
      `/approvals/${String(raised.body.approvalRequestId)}/approve`,
      { token: hrToken, body: { reason: 'Picked up after the escalation.' } },
    );
    expect(decided.status, decided.text).toBe(201);
    expect(decided.body.status).toBe('APPROVED');
  });

  it('raises an approval with an on-duty request and decides it in the inbox', async () => {
    const from = addDays(TODAY, 120);
    const to = addDays(TODAY, 121);
    const raised = await harness.post<OnDutyRequest & ErrorBody>('/on-duty-requests', {
      token: employeeToken,
      body: { fromDate: from, toDate: to, reason: 'Client site.', siteName: 'Pune plant' },
    });
    expect(raised.status, raised.text).toBe(201);
    expect(raised.body.approvalRequestId).not.toBeNull();

    const row = await inboxRow(managerToken, raised.body.approvalRequestId);
    expect(row?.type).toBe('ON_DUTY');
    expect(row?.subject).toContain('Pune plant');

    const decided = await harness.post<ApprovalRequestDetail>(
      `/approvals/${String(raised.body.approvalRequestId)}/approve`,
      { token: managerToken, body: {} },
    );
    expect(decided.status, decided.text).toBe(201);
    expect(decided.body.status).toBe('APPROVED');

    const after = await harness.get<OnDutyRequest>(`/on-duty-requests/${raised.body.id}`, {
      token: managerToken,
    });
    expect(after.body.status).toBe('APPROVED');

    // REQ-F-04: "those days become ON_DUTY and count as present."
    for (const date of [from, to]) {
      const day = await readDay(managerToken, employeeAId, date);
      expect(day.status).toBe('ON_DUTY');
    }
  });
});
