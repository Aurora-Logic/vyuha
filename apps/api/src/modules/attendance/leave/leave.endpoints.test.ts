import {
  SYSTEM_ROLES,
  isLeaveBalanceConsistent,
  uuidv7,
  type ApprovalRequestDetail,
  type ApprovalRequestSummary,
  type CompOffCredit,
  type LeaveBalance,
  type LeaveCalendar,
  type LeaveLedgerEntry,
  type LeavePreview,
  type LeaveRequestDetail,
  type LeaveTypePolicy,
  type Paginated,
} from '@vyuha/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { employees, settings, notificationOutbox } from '../../../platform/db/schema/index.js';
import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';
import { ApprovalService } from '../../../platform/approvals/approval.service.js';
import { NotificationDispatcher } from '../../../platform/notifications/notification.dispatcher.js';
import { addDays } from '../day-engine/calendar-date.js';
import {
  holidayCalendars,
  holidays,
  leaveLedger,
  weeklyOffPatterns,
} from '../schema/index.js';
import { LEAVE_SETTING_KEYS } from './leave.repository.js';

/**
 * Every leave endpoint (REQ-G-01 … REQ-G-12) over real HTTP against the real
 * application: the global guard, the Zod pipe, `ScopeService`, the exception
 * filter, the audit interceptor, the append-only trigger and the check
 * constraint added in migration 0009 all in the loop.
 *
 * `preservePeople`, because an employee with a ledger row can never be
 * deleted -- `leave_ledger.employee_id` is RESTRICT and the table refuses a
 * DELETE. People are therefore minted per run with unique codes, the same
 * arrangement the punch suite uses and for the same reason.
 *
 * The fixture calendar is built around a fixed Monday so the weekend and the
 * holiday land where the sandwich tests expect them, and far enough in the
 * future that the notice-period rule is satisfiable.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000e1';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let runId: string;

let employeeAId: string;
let employeeBId: string;
let managerEmployeeId: string;
let managerUserId = '';
let employeeRoleId: string;

let employeeToken: string;
let otherToken: string;
let managerToken: string;
let hrToken: string;
let strangerToken: string;

let casualTypeId = '';
let sandwichTypeId = '';
let compOffTypeId = '';

/**
 * A Monday well clear of today, so a notice period of a few days is always
 * satisfiable and the weekend below is always in the future.
 */
const MONDAY = mondayAfter(addDays(new Date().toISOString().slice(0, 10), 120));
const FRIDAY = addDays(MONDAY, 4);
const SATURDAY = addDays(MONDAY, 5);
const SUNDAY = addDays(MONDAY, 6);
const NEXT_MONDAY = addDays(MONDAY, 7);
const NEXT_TUESDAY = addDays(MONDAY, 8);
/** A holiday placed on the Monday after the weekend, so a Friday-to-Tuesday
 *  range contains two weekly offs and a holiday. */
const HOLIDAY = NEXT_MONDAY;

const LEAVE_YEAR = leaveYearFor(MONDAY);

function mondayAfter(date: string): string {
  let cursor = date;
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    if (day === 1) return cursor;
    cursor = addDays(cursor, 1);
  }
  throw new Error('No Monday found in seven days, which is impossible.');
}

/** Mirrors the April default the fixture does not override. */
function leaveYearFor(date: string): number {
  const year = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= 4 ? year : year - 1;
}

async function createType(
  overrides: Record<string, unknown>,
): Promise<LeaveTypePolicy & ErrorBody> {
  const response = await harness.post<LeaveTypePolicy & ErrorBody>('/leave/types', {
    token: hrToken,
    body: { name: 'Fixture Type', code: `FX${runId}`, ...overrides },
  });
  expect(response.status, response.text).toBe(201);
  return response.body;
}

function previewPath(params: Record<string, string>): string {
  return `/leave/preview?${new URLSearchParams(params).toString()}`;
}

async function balanceOf(token: string, leaveTypeId: string): Promise<LeaveBalance> {
  const response = await harness.get<Paginated<LeaveBalance>>(
    `/leave/balances?year=${String(LEAVE_YEAR)}`,
    { token },
  );
  expect(response.status, response.text).toBe(200);
  const found = response.body.data.find((row) => row.leaveType.id === leaveTypeId);
  if (found === undefined) throw new Error(`No balance row for leave type ${leaveTypeId}.`);
  return found;
}

/** REQ-G-02's Compensatory Off, created once and reused on every later run. */
async function ensureCompOffType(): Promise<string> {
  const existing = await harness.get<Paginated<LeaveTypePolicy>>('/leave/types?pageSize=200', {
    token: hrToken,
  });
  expect(existing.status, existing.text).toBe(200);
  const found = existing.body.data.find((type) => type.code === 'CO');
  if (found !== undefined) return found.id;

  const created = await harness.post<LeaveTypePolicy>('/leave/types', {
    token: hrToken,
    body: { name: 'Compensatory Off', code: 'CO' },
  });
  expect(created.status, created.text).toBe(201);
  return created.body.id;
}

/**
 * The message Postgres actually raised.
 *
 * Drizzle wraps a driver error in one of its own whose message is the SQL it
 * tried to run, so asserting on `.message` would pass for any failure at all
 * -- including a typo in the statement, which is exactly the probe that lies.
 */
async function refusalMessage(statement: SQL): Promise<string> {
  try {
    await harness.db.execute(statement);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : null;
    if (cause instanceof Error) return cause.message;
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('The statement was accepted. It should have been refused.');
}

/**
 * Installs an org setting for the duration of one body, and removes it however
 * that body ends.
 *
 * `finally`, not a trailing delete. A failed assertion inside the body would
 * otherwise leave the setting standing, and a deliberately malformed one --
 * the value two of the tests below install on purpose -- makes every later run
 * of this file answer 500 from `beforeAll` onwards. Learned the hard way.
 */
async function withSetting(key: string, value: unknown, body: () => Promise<void>): Promise<void> {
  await harness.db.insert(settings).values({ orgId: ORG_ID, scope: 'ORG', key, value });
  try {
    await body();
  } finally {
    await harness.db
      .delete(settings)
      .where(and(eq(settings.orgId, ORG_ID), eq(settings.key, key)));
  }
}

/** Grants days through the audited adjustment route rather than a raw insert. */
async function grantDays(employeeId: string, leaveTypeId: string, days: number): Promise<void> {
  const response = await harness.post<LeaveBalance & ErrorBody>('/leave/balances/adjust', {
    token: hrToken,
    body: { employeeId, leaveTypeId, year: LEAVE_YEAR, days, reason: 'Opening balance for the test' },
  });
  expect(response.status, response.text).toBe(201);
}

beforeAll(async () => {
  // `resetOrganisation` clears last run's approval rows before it deletes the
  // users they reference; see the note there. The leave requests those
  // approvals governed survive with `approval_request_id` set to null, which
  // is exactly the "predates the join" shape one test below asserts on.
  harness = await ApiHarness.start(ORG_ID, 'Leave Endpoints Fixture Org', { preservePeople: true });
  runId = uuidv7().slice(-6).toUpperCase();

  // Two kinds of state `resetOrganisation` cannot clear, both of which made
  // the second run of this file fail while the first passed.
  //
  // Leave types: a type with ledger rows can never be deleted, so they
  // accumulate. Retiring the previous run's keeps the policy list bounded and
  // keeps this run's assertions looking only at this run's rows. `CO` is left
  // standing because REQ-G-02 fixes its code and comp-off looks it up by that.
  await harness.db.execute(sql`
    UPDATE leave_types SET deleted_at = now()
     WHERE org_id = ${ORG_ID} AND deleted_at IS NULL AND code <> 'CO'
  `);

  // Settings: several tests below install one and remove it afterwards, and a
  // failed assertion between the two would leave it standing for every later
  // run. Clearing here means a red run cannot poison the next one.
  await harness.db.execute(
    sql`DELETE FROM settings WHERE org_id = ${ORG_ID} AND key LIKE 'leave.%'`,
  );

  employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);
  const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR);
  const managerRoleId = await harness.createSystemRole(SYSTEM_ROLES.OPERATIONS);
  // Authenticated but holding no leave key at all, so a 403 here is about the
  // missing permission rather than about having no credentials.
  const strangerRoleId = await harness.createRole('Leave Stranger', ['attendance.view.self']);

  managerEmployeeId = await harness.createEmployee({ code: `LV-M-${runId}`, firstName: 'Meera' });
  employeeAId = await harness.createEmployee({
    code: `LV-A-${runId}`,
    firstName: 'Asha',
    reportingManagerId: managerEmployeeId,
    dateOfJoining: '2020-01-01',
  });
  employeeBId = await harness.createEmployee({
    code: `LV-B-${runId}`,
    firstName: 'Bhavin',
    dateOfJoining: '2020-01-01',
  });

  // Saturday and Sunday off, so the sandwich tests have a weekend to skip.
  const patternRows = await harness.db
    .insert(weeklyOffPatterns)
    .values({
      orgId: ORG_ID,
      name: `Leave Probe Weekend ${runId}`,
      config: { weekdays: [6, 7] },
    })
    .returning({ id: weeklyOffPatterns.id });
  const patternId = patternRows[0]?.id;
  if (patternId === undefined) throw new Error('weekly off pattern fixture returned no row');

  const calendarRows = await harness.db
    .insert(holidayCalendars)
    .values({ orgId: ORG_ID, name: `Leave Probe Calendar ${runId}`, year: Number(MONDAY.slice(0, 4)) })
    .returning({ id: holidayCalendars.id });
  const calendarId = calendarRows[0]?.id;
  if (calendarId === undefined) throw new Error('holiday calendar fixture returned no row');

  await harness.db
    .insert(holidays)
    .values({ orgId: ORG_ID, calendarId, date: HOLIDAY, name: 'Leave Probe Holiday' });

  await harness.db
    .update(employees)
    .set({ weeklyOffPatternId: patternId, holidayCalendarId: calendarId })
    .where(
      and(
        eq(employees.orgId, ORG_ID),
        sql`${employees.id} IN (${sql.join([employeeAId, employeeBId, managerEmployeeId].map((id) => sql`${id}::uuid`), sql`, `)})`,
      ),
    );

  const userA = await harness.createUser({
    email: scopedEmail('leave-a'),
    roleIds: [employeeRoleId],
    employeeId: employeeAId,
  });
  const userB = await harness.createUser({
    email: scopedEmail('leave-b'),
    roleIds: [employeeRoleId],
    employeeId: employeeBId,
  });
  const manager = await harness.createUser({
    email: scopedEmail('leave-mgr'),
    roleIds: [managerRoleId],
    employeeId: managerEmployeeId,
  });
  const hrUser = await harness.createUser({ email: scopedEmail('leave-hr'), roleIds: [hrRoleId] });
  const stranger = await harness.createUser({
    email: scopedEmail('leave-stranger'),
    roleIds: [strangerRoleId],
  });

  employeeToken = (await harness.login(userA.email, userA.password)).token;
  otherToken = (await harness.login(userB.email, userB.password)).token;
  managerUserId = manager.id;
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

describe('access control', () => {
  it('refuses an unauthenticated request on every route', async () => {
    const routes: readonly [string, string][] = [
      ['GET', '/leave/types'],
      ['POST', '/leave/types'],
      ['GET', `/leave/balances?year=${String(LEAVE_YEAR)}`],
      ['GET', `/leave/ledger?year=${String(LEAVE_YEAR)}`],
      ['POST', '/leave/balances/adjust'],
      ['GET', '/leave/requests'],
      ['POST', '/leave/requests'],
      ['GET', '/leave/comp-off'],
      ['POST', '/leave/comp-off'],
      ['GET', `/leave/calendar?from=${MONDAY}&to=${FRIDAY}`],
    ];

    for (const [method, path] of routes) {
      const response = await harness.request(method, path, { body: method === 'GET' ? undefined : {} });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses a signed-in account holding no leave permission', async () => {
    const response = await harness.get<ErrorBody>('/leave/types', { token: strangerToken });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('lets an employee read leave types but not write one (REQ-G-01)', async () => {
    const read = await harness.get<Paginated<LeaveTypePolicy>>('/leave/types', {
      token: employeeToken,
    });
    expect(read.status).toBe(200);

    const write = await harness.post<ErrorBody>('/leave/types', {
      token: employeeToken,
      body: { name: 'Sneaky', code: 'SNK' },
    });
    expect(write.status).toBe(403);
    expect(write.body.error.details?.requiredAnyOf).toEqual(['leave.policy.manage']);
  });
});

describe('leave types (REQ-G-01, REQ-G-02)', () => {
  it('creates a type and reads it back with every rule intact', async () => {
    const created = await createType({
      name: 'Probe Casual Leave',
      code: `CL${runId}`,
      accrualMethod: 'MONTHLY',
      annualEntitlement: 12,
      negativeBalanceLimit: 2,
      noticeDays: 2,
      attachmentRequiredAfterDays: 3,
      allowsHalfDay: true,
    });
    casualTypeId = created.id;

    expect(created.code).toBe(`CL${runId}`);
    expect(created.annualEntitlement).toBe(12);
    expect(created.negativeBalanceLimit).toBe(2);
    expect(created.noticeDays).toBe(2);
    expect(created.carryForwardAllowed).toBe(false);
    expect(created.carryForwardCap).toBeNull();

    const fetched = await harness.get<LeaveTypePolicy>(`/leave/types/${created.id}`, {
      token: hrToken,
    });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(created);
  });

  it('creates the sandwich and comp-off types the later tests need', async () => {
    sandwichTypeId = (
      await createType({
        name: 'Probe Sandwich Leave',
        code: `SW${runId}`,
        countsSandwichDays: true,
        allowsHalfDay: false,
      })
    ).id;

    // `CO` is a fixed code (REQ-G-02) and a leave type with ledger rows can
    // never be deleted, so a second run of this file finds one already there.
    // Reused rather than recreated -- the alternative is a file that passes
    // once and 409s for ever after.
    compOffTypeId = await ensureCompOffType();
  });

  it('upper-cases the code and refuses a duplicate of it', async () => {
    const lower = await harness.post<LeaveTypePolicy>('/leave/types', {
      token: hrToken,
      body: { name: 'Probe Lowercase', code: `lc${runId}` },
    });
    expect(lower.status).toBe(201);
    expect(lower.body.code).toBe(`LC${runId}`);

    const duplicate = await harness.post<ErrorBody>('/leave/types', {
      token: hrToken,
      body: { name: 'Probe Duplicate', code: `LC${runId}` },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');
  });

  it('refuses an unknown field rather than silently discarding it', async () => {
    const response = await harness.post<ErrorBody>('/leave/types', {
      token: hrToken,
      body: { name: 'Probe Strict', code: `ST${runId}`, monthlyEntitlement: 3 },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a carry-forward cap on a type that cannot carry forward', async () => {
    const response = await harness.post<ErrorBody>('/leave/types', {
      token: hrToken,
      body: {
        name: 'Probe Bad Cap',
        code: `BC${runId}`,
        carryForwardAllowed: false,
        carryForwardCap: 5,
      },
    });
    expect(response.status).toBe(400);
  });

  it('refuses a patch that would leave the merged row inconsistent', async () => {
    const type = await createType({ name: 'Probe Patch', code: `PT${runId}`, minDays: 1, maxDays: 5 });

    const bad = await harness.patch<ErrorBody>(`/leave/types/${type.id}`, {
      token: hrToken,
      // min stays at 1 and max drops below it: only visible on the merge.
      body: { maxDays: 0.5 },
    });
    expect(bad.status).toBe(400);

    const good = await harness.patch<LeaveTypePolicy>(`/leave/types/${type.id}`, {
      token: hrToken,
      body: { maxDays: 10, isActive: false },
    });
    expect(good.status, good.text).toBe(200);
    expect(good.body.maxDays).toBe(10);
    expect(good.body.isActive).toBe(false);
    expect(good.body.code).toBe(type.code);
  });

  it('audits the create and the update (Definition of Done)', async () => {
    expect(await harness.waitForAuditAction('leave_type.created')).toBe(true);
    expect(await harness.waitForAuditAction('leave_type.updated')).toBe(true);
  });
});

describe('the preview (REQ-G-06, REQ-G-07)', () => {
  it('counts only working days across a weekend and a holiday', async () => {
    const response = await harness.get<LeavePreview>(
      previewPath({ leaveTypeId: casualTypeId, fromDate: FRIDAY, toDate: NEXT_TUESDAY }),
      { token: employeeToken },
    );
    expect(response.status, response.text).toBe(200);

    // Fri, Sat(off), Sun(off), Mon(holiday), Tue = five calendar days, two
    // working.
    expect(response.body.calendarDays).toBe(5);
    expect(response.body.totalDays).toBe(2);
    expect(response.body.weeklyOffsSkipped).toBe(2);
    expect(response.body.holidaysSkipped).toBe(1);
    expect(response.body.sandwichDaysCounted).toBe(0);
    expect(response.body.days).toHaveLength(5);
  });

  it('counts every day for a type that counts sandwich days', async () => {
    const response = await harness.get<LeavePreview>(
      previewPath({ leaveTypeId: sandwichTypeId, fromDate: FRIDAY, toDate: NEXT_TUESDAY }),
      { token: employeeToken },
    );
    expect(response.status, response.text).toBe(200);
    expect(response.body.totalDays).toBe(5);
    expect(response.body.sandwichDaysCounted).toBe(3);
    expect(response.body.weeklyOffsSkipped).toBe(0);
    expect(response.body.holidaysSkipped).toBe(0);
  });

  it('reports the balance before and after, and the blockers, without writing', async () => {
    const before = await balanceOf(employeeToken, casualTypeId);

    const response = await harness.get<LeavePreview>(
      previewPath({ leaveTypeId: casualTypeId, fromDate: MONDAY, toDate: FRIDAY }),
      { token: employeeToken },
    );
    expect(response.status).toBe(200);
    expect(response.body.balanceBefore).toBe(before.closing);
    expect(response.body.balanceAfter).toBe(before.closing - 5);
    // No balance yet, and the type's negative limit is 2, so five days is
    // past it.
    expect(response.body.blockers).toContain('NEGATIVE_LIMIT_EXCEEDED');

    const after = await balanceOf(employeeToken, casualTypeId);
    expect(after.closing).toBe(before.closing);
  });

  it('halves a boundary day and refuses a half day the type does not allow', async () => {
    const half = await harness.get<LeavePreview>(
      previewPath({
        leaveTypeId: casualTypeId,
        fromDate: MONDAY,
        toDate: MONDAY,
        fromPortion: 'FIRST_HALF',
        toPortion: 'FIRST_HALF',
      }),
      { token: employeeToken },
    );
    expect(half.status, half.text).toBe(200);
    expect(half.body.totalDays).toBe(0.5);
    expect(half.body.halfDays).toBe(1);

    const refused = await harness.get<LeavePreview>(
      previewPath({
        leaveTypeId: sandwichTypeId,
        fromDate: MONDAY,
        toDate: MONDAY,
        fromPortion: 'FIRST_HALF',
        toPortion: 'FIRST_HALF',
      }),
      { token: employeeToken },
    );
    expect(refused.status).toBe(200);
    expect(refused.body.blockers).toContain('HALF_DAY_NOT_ALLOWED');
  });

  it('refuses a malformed query rather than guessing', async () => {
    const response = await harness.get<ErrorBody>(
      previewPath({ leaveTypeId: casualTypeId, fromDate: 'yesterday', toDate: FRIDAY }),
      { token: employeeToken },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('applying (REQ-G-06, REQ-G-07, REQ-G-08)', () => {
  it('refuses when the negative balance limit would be exceeded', async () => {
    const response = await harness.post<ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: { leaveTypeId: casualTypeId, fromDate: MONDAY, toDate: FRIDAY, reason: 'Too much' },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('LEAVE_NEGATIVE_LIMIT_EXCEEDED');
  });

  it('allows a negative balance up to the limit (REQ-G-08)', async () => {
    // Limit 2, balance 0, two days requested: exactly at the floor.
    const response = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: {
        leaveTypeId: casualTypeId,
        fromDate: MONDAY,
        toDate: addDays(MONDAY, 1),
        reason: 'At the limit',
      },
    });
    expect(response.status, response.text).toBe(201);
    expect(response.body.totalDays).toBe(2);
    expect(response.body.status).toBe('PENDING');

    // Applying does not move the balance; approving does.
    const balance = await balanceOf(employeeToken, casualTypeId);
    expect(balance.closing).toBe(0);
    expect(balance.availed).toBe(0);

    const cancelled = await harness.post<LeaveRequestDetail>(
      `/leave/requests/${response.body.id}/cancel`,
      { token: employeeToken, body: { reason: 'Clearing the fixture' } },
    );
    expect(cancelled.status, cancelled.text).toBe(201);
  });

  it('records the request even when the notice cannot be queued (H-06)', async () => {
    // The request was committed and then `emit` was awaited; a Redis blip
    // there surfaced as "applying failed" about a request that exists, and
    // the obvious retry made a second one.
    await grantDays(employeeBId, casualTypeId, 1);
    const dispatcher = harness.resolve(NotificationDispatcher);
    const spy = vi.spyOn(dispatcher, 'emit').mockRejectedValue(new Error('Redis blipped'));
    const callsBefore = spy.mock.calls.length;
    try {
      const response = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
        token: otherToken,
        body: { leaveTypeId: casualTypeId, fromDate: addDays(MONDAY, 14), toDate: addDays(MONDAY, 14), reason: 'While the queue is down' },
      });
      expect(response.status, response.text).toBe(201);
      expect(response.body.status).toBe('PENDING');
      expect(spy.mock.calls.length - callsBefore, 'request must not depend on a post-commit emit').toBe(0);
      const intents = await harness.db.select().from(notificationOutbox).where(eq(notificationOutbox.idempotencyKey, `leave-applied.${response.body.id}`));
      expect(intents).toHaveLength(1);
      expect(intents[0]?.state).toBe('PENDING');
      const cancelled = await harness.post<LeaveRequestDetail>(`/leave/requests/${response.body.id}/cancel`, { token: otherToken, body: { reason: 'Clearing the fixture' } });
      expect(cancelled.status, cancelled.text).toBe(201);
    } finally {
      spy.mockRestore();
      await grantDays(employeeBId, casualTypeId, -1);
    }
  });

  it('stores the skipped days uncounted so the day engine can read them', async () => {
    await grantDays(employeeAId, casualTypeId, 20);

    const response = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: {
        leaveTypeId: casualTypeId,
        fromDate: FRIDAY,
        toDate: NEXT_TUESDAY,
        reason: 'Across a weekend and a holiday',
      },
    });
    expect(response.status, response.text).toBe(201);
    expect(response.body.totalDays).toBe(2);
    expect(response.body.days).toHaveLength(5);
    expect(response.body.days.filter((day) => day.isCounted)).toHaveLength(2);
    expect(response.body.days.filter((day) => !day.isCounted).map((day) => day.date)).toEqual([
      SATURDAY,
      SUNDAY,
      HOLIDAY,
    ]);
  });

  it('refuses an overlapping application on the counted days (REQ-G-07)', async () => {
    const response = await harness.post<ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: { leaveTypeId: casualTypeId, fromDate: FRIDAY, toDate: FRIDAY, reason: 'Again' },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('LEAVE_OVERLAPS_EXISTING');
  });

  it('accepts the weekend the earlier request skipped, because nothing was consumed there', async () => {
    const response = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: {
        leaveTypeId: sandwichTypeId,
        fromDate: SATURDAY,
        toDate: SUNDAY,
        reason: 'Nothing is consumed here',
      },
    });
    // Every day in the range is non-working and neither is sandwiched, so the
    // application consumes nothing and is refused as such rather than accepted
    // as a zero-day leave.
    expect(response.status, response.text).toBe(400);
  });

  it('refuses an application that breaks the notice period (REQ-G-07)', async () => {
    const tomorrow = addDays(new Date().toISOString().slice(0, 10), 1);
    const response = await harness.post<ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: { leaveTypeId: casualTypeId, fromDate: tomorrow, toDate: tomorrow, reason: 'Tomorrow' },
    });
    // Either the notice period or a weekend; both are correct refusals, and
    // the assertion names the one this type is configured for.
    expect([400, 422]).toContain(response.status);
    if (response.status === 422) expect(response.body.error.code).toBe('LEAVE_NOTICE_PERIOD');
  });

  it('refuses a missing attachment past the type threshold (REQ-G-01)', async () => {
    const response = await harness.post<ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: {
        leaveTypeId: casualTypeId,
        fromDate: addDays(NEXT_MONDAY, 7),
        toDate: addDays(NEXT_MONDAY, 11),
        reason: 'Five days needs a document',
      },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('LEAVE_ATTACHMENT_REQUIRED');
  });

  it('refuses applying on somebody else without the org-wide key', async () => {
    const response = await harness.post<ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: {
        leaveTypeId: casualTypeId,
        fromDate: addDays(NEXT_MONDAY, 14),
        toDate: addDays(NEXT_MONDAY, 14),
        reason: 'On behalf of a colleague',
        employeeId: employeeBId,
      },
    });
    expect(response.status).toBe(403);
  });

  it('audits the application', async () => {
    expect(await harness.waitForAuditAction('leave_request.applied')).toBe(true);
  });
});

describe('deciding (REQ-G-09, REQ-F-05, REQ-I-05)', () => {
  let requestId = '';

  it('accepts an application to decide on', async () => {
    const response = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: {
        leaveTypeId: casualTypeId,
        fromDate: addDays(NEXT_MONDAY, 21),
        toDate: addDays(NEXT_MONDAY, 22),
        reason: 'For the approval path',
      },
    });
    expect(response.status, response.text).toBe(201);
    requestId = response.body.id;
  });

  it('refuses an employee deciding their own request', async () => {
    const response = await harness.post<ErrorBody>(`/leave/requests/${requestId}/approve`, {
      token: employeeToken,
      body: {},
    });
    // The employee holds no approver key at all, so the guard refuses first.
    expect(response.status).toBe(403);
  });

  it('refuses an approver deciding a request they raised themselves (REQ-I-05)', async () => {
    const own = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
      token: managerToken,
      body: {
        leaveTypeId: casualTypeId,
        fromDate: addDays(NEXT_MONDAY, 28),
        toDate: addDays(NEXT_MONDAY, 28),
        reason: "The manager's own leave",
      },
    });
    expect(own.status, own.text).toBe(201);

    const response = await harness.post<ErrorBody>(`/leave/requests/${own.body.id}/approve`, {
      token: managerToken,
      body: {},
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('APPROVER_IS_REQUESTER');
  });

  it('refuses a rejection with no reason (REQ-F-05)', async () => {
    const response = await harness.post<ErrorBody>(`/leave/requests/${requestId}/reject`, {
      token: managerToken,
      body: {},
    });
    expect(response.status).toBe(400);
  });

  it('deducts the balance on approval, not before (REQ-G-03)', async () => {
    const before = await balanceOf(employeeToken, casualTypeId);

    const response = await harness.post<LeaveRequestDetail & ErrorBody>(
      `/leave/requests/${requestId}/approve`,
      { token: managerToken, body: { reason: 'Approved for the test' } },
    );
    expect(response.status, response.text).toBe(201);
    expect(response.body.status).toBe('APPROVED');
    expect(response.body.decidedAt).not.toBeNull();
    expect(response.body.decidedBy?.name).toBe('Meera');

    const after = await balanceOf(employeeToken, casualTypeId);
    expect(after.availed).toBe(before.availed + 2);
    expect(after.closing).toBe(before.closing - 2);
    expect(isLeaveBalanceConsistent(after)).toBe(true);
  });

  it('refuses a second decision on the same request', async () => {
    const response = await harness.post<ErrorBody>(`/leave/requests/${requestId}/approve`, {
      token: managerToken,
      body: {},
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('APPROVAL_ALREADY_ACTIONED');
  });

  it('rejects with a reason and moves no balance', async () => {
    const raised = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: {
        leaveTypeId: casualTypeId,
        fromDate: addDays(NEXT_MONDAY, 35),
        toDate: addDays(NEXT_MONDAY, 35),
        reason: 'To be rejected',
      },
    });
    expect(raised.status, raised.text).toBe(201);

    const before = await balanceOf(employeeToken, casualTypeId);
    const response = await harness.post<LeaveRequestDetail & ErrorBody>(
      `/leave/requests/${raised.body.id}/reject`,
      { token: managerToken, body: { reason: 'The team is short that week' } },
    );
    expect(response.status, response.text).toBe(201);
    expect(response.body.status).toBe('REJECTED');

    const after = await balanceOf(employeeToken, casualTypeId);
    expect(after.closing).toBe(before.closing);
  });

  it('audits both decisions', async () => {
    expect(await harness.waitForAuditAction('leave_request.approved')).toBe(true);
    expect(await harness.waitForAuditAction('leave_request.rejected')).toBe(true);
  });
});

describe('cancelling (REQ-G-10)', () => {
  it('reverses the ledger and returns the balance to exactly what it was', async () => {
    const before = await balanceOf(employeeToken, casualTypeId);

    const raised = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: {
        leaveTypeId: casualTypeId,
        fromDate: addDays(NEXT_MONDAY, 42),
        toDate: addDays(NEXT_MONDAY, 43),
        reason: 'To be cancelled after approval',
      },
    });
    expect(raised.status, raised.text).toBe(201);

    const approved = await harness.post<LeaveRequestDetail>(
      `/leave/requests/${raised.body.id}/approve`,
      { token: managerToken, body: {} },
    );
    expect(approved.status, approved.text).toBe(201);
    expect((await balanceOf(employeeToken, casualTypeId)).closing).toBe(before.closing - 2);

    const cancelled = await harness.post<LeaveRequestDetail>(
      `/leave/requests/${raised.body.id}/cancel`,
      { token: employeeToken, body: { reason: 'Plans changed' } },
    );
    expect(cancelled.status, cancelled.text).toBe(201);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.cancelledAt).not.toBeNull();

    const after = await balanceOf(employeeToken, casualTypeId);
    expect(after.closing).toBe(before.closing);
    expect(after.availed).toBe(before.availed);
    expect(isLeaveBalanceConsistent(after)).toBe(true);

    // Reversed, never deleted: both rows are still in the ledger.
    const ledger = await harness.get<Paginated<LeaveLedgerEntry>>(
      `/leave/ledger?year=${String(LEAVE_YEAR)}&leaveTypeId=${casualTypeId}&pageSize=200`,
      { token: employeeToken },
    );
    expect(ledger.status).toBe(200);
    const forRequest = ledger.body.data.filter((row) => row.referenceId === raised.body.id);
    expect(forRequest.map((row) => row.movementType).sort()).toEqual(['AVAILED', 'REVERSAL']);
  });

  it('refuses a stranger cancelling somebody else s leave', async () => {
    const raised = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: {
        leaveTypeId: casualTypeId,
        fromDate: addDays(NEXT_MONDAY, 49),
        toDate: addDays(NEXT_MONDAY, 49),
        reason: 'Not yours to cancel',
      },
    });
    expect(raised.status, raised.text).toBe(201);

    const response = await harness.post<ErrorBody>(`/leave/requests/${raised.body.id}/cancel`, {
      token: otherToken,
      body: {},
    });
    // Out of scope reads as not found, so the id does not confirm a real request.
    expect(response.status).toBe(404);
  });

  it('audits the cancellation', async () => {
    expect(await harness.waitForAuditAction('leave_request.cancelled')).toBe(true);
  });
});

describe('decisions reach the muster inline (launch plan WS-B: REQ-G-09, REQ-G-10, REQ-E-02)', () => {
  // A fresh employee with a resolvable shift, because the recompute needs one:
  // the fixture people above deliberately have none, which is also what proves
  // a roster gap cannot fail an approval (the engine's refusal is counted and
  // logged, and the decision stands -- the same survival rule holiday
  // recompute follows).
  let shiftedEmployeeId = '';
  let shiftedToken = '';
  let musterRequestId = '';

  async function dayRow(
    date: string,
  ): Promise<{ status: string; leaveRequestId: string | null } | null> {
    const rows = await harness.db.execute<{ status: string; leave_request_id: string | null }>(sql`
      SELECT status, leave_request_id FROM attendance_days
       WHERE org_id = ${ORG_ID} AND employee_id = ${shiftedEmployeeId}::uuid AND date = ${date}
       LIMIT 1
    `);
    const row = rows.rows[0];
    if (row === undefined) return null;
    return { status: row.status, leaveRequestId: row.leave_request_id };
  }

  it('sets up an employee whose shift the engine can resolve', async () => {
    const shiftRows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO shifts (org_id, code, name, start_time, end_time)
      VALUES (${ORG_ID}, ${`LVD${runId}`}, 'Leave Decision Probe Shift', '09:00:00', '17:30:00')
      RETURNING id
    `);
    const shiftId = shiftRows.rows[0]?.id;
    if (shiftId === undefined) throw new Error('shift fixture insert returned no row');

    shiftedEmployeeId = await harness.createEmployee({
      code: `LV-D-${runId}`,
      firstName: 'Deepa',
      // Reports to Meera, so the manager's team scope reaches these requests.
      reportingManagerId: managerEmployeeId,
      dateOfJoining: '2020-01-01',
    });
    await harness.db.execute(sql`
      UPDATE employees SET default_shift_id = ${shiftId}::uuid
       WHERE org_id = ${ORG_ID} AND id = ${shiftedEmployeeId}::uuid
    `);

    const user = await harness.createUser({
      email: scopedEmail('leave-shifted'),
      roleIds: [employeeRoleId],
      employeeId: shiftedEmployeeId,
    });
    shiftedToken = (await harness.login(user.email, user.password)).token;
    expect(shiftedToken).not.toBe('');

    await grantDays(shiftedEmployeeId, casualTypeId, 10);
  });

  it('approval computes the day to ON_LEAVE, without waiting for any sweep', async () => {
    const raised = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
      token: shiftedToken,
      body: {
        leaveTypeId: casualTypeId,
        fromDate: MONDAY,
        toDate: MONDAY,
        reason: 'Muster recompute probe',
      },
    });
    expect(raised.status, raised.text).toBe(201);
    musterRequestId = raised.body.id;

    // Nothing on the muster yet: a pending request holds no day.
    expect(await dayRow(MONDAY)).toBeNull();

    const approved = await harness.post<LeaveRequestDetail>(
      `/leave/requests/${musterRequestId}/approve`,
      { token: managerToken, body: {} },
    );
    expect(approved.status, approved.text).toBe(201);

    // The row exists the moment the approval answers -- this is the inline
    // recompute, not a job that might run tonight.
    const day = await dayRow(MONDAY);
    expect(day?.status).toBe('ON_LEAVE');
    expect(day?.leaveRequestId).toBe(musterRequestId);
  });

  it('cancellation recomputes the day back off leave', async () => {
    const cancelled = await harness.post<LeaveRequestDetail>(
      `/leave/requests/${musterRequestId}/cancel`,
      { token: shiftedToken, body: { reason: 'Probe over' } },
    );
    expect(cancelled.status, cancelled.text).toBe(201);

    const day = await dayRow(MONDAY);
    expect(day?.status).not.toBe('ON_LEAVE');
    expect(day?.leaveRequestId).toBeNull();
  });

  it('respects a period lock: the cancellation stands, the locked day is left alone (REQ-E-09)', async () => {
    const TUESDAY = addDays(MONDAY, 1);

    // Approved while the month is open, so the Tuesday row reads ON_LEAVE.
    const raised = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
      token: shiftedToken,
      body: {
        leaveTypeId: casualTypeId,
        fromDate: TUESDAY,
        toDate: TUESDAY,
        reason: 'Locked period probe',
      },
    });
    expect(raised.status, raised.text).toBe(201);
    const approved = await harness.post<LeaveRequestDetail>(
      `/leave/requests/${raised.body.id}/approve`,
      { token: managerToken, body: {} },
    );
    expect(approved.status, approved.text).toBe(201);
    expect((await dayRow(TUESDAY))?.status).toBe('ON_LEAVE');

    // Then the month closes.
    const lock = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO attendance_period_locks (org_id, year, month, lock_reason)
      VALUES (${ORG_ID}, ${Number(MONDAY.slice(0, 4))}, ${Number(MONDAY.slice(5, 7))},
              'Locked for the WS-B recompute probe')
      RETURNING id
    `);
    const lockId = lock.rows[0]?.id;
    if (lockId === undefined) throw new Error('period lock fixture insert returned no row');

    try {
      // An approver cancelling inside the locked month: the cancellation and
      // its ledger reversal stand, and the engine answers `locked` without
      // writing -- the frozen muster row is counted in the audit summary, not
      // rewritten. The same deliberate outcome holiday recompute has.
      const cancelled = await harness.post<LeaveRequestDetail>(
        `/leave/requests/${raised.body.id}/cancel`,
        { token: managerToken, body: { reason: 'Cancelled after the month closed' } },
      );
      expect(cancelled.status, cancelled.text).toBe(201);
      expect(cancelled.body.status).toBe('CANCELLED');

      const day = await dayRow(TUESDAY);
      expect(day?.status).toBe('ON_LEAVE');
      expect(day?.leaveRequestId).toBe(raised.body.id);
    } finally {
      await harness.db.execute(
        sql`DELETE FROM attendance_period_locks WHERE id = ${lockId}::uuid`,
      );
    }
  });
});

/**
 * The leave / approvals join (REQ-G-09, REQ-I-01 … REQ-I-05).
 *
 * The one thing this slice cannot get wrong: `leave_ledger` is append-only, so
 * a decision applied twice writes a deduction that can never be taken back, and
 * the balance is then wrong for ever with no error anywhere. Every test below
 * exists because of that sentence.
 *
 * The two surfaces -- the approvals inbox and this slice's own
 * `/leave/requests/:id/approve` -- must be one code path with one writer.
 * Asserting that they merely "both work" is the probe that lies: two paths that
 * each produce a plausible ledger is exactly the bug. So the assertions compare
 * their outcomes against each other, row for row.
 */
describe('the leave / approvals join (REQ-G-09, REQ-I-01, REQ-I-05)', () => {
  let joinWeek = 0;

  /**
   * A fresh date per request: always a Monday, always in the future, always
   * inside `LEAVE_YEAR`, and never one another fixture in this file uses.
   *
   * Walking *backwards* in whole weeks from `MONDAY` rather than forwards past
   * the other fixtures, because the balance is per leave year (REQ-G-04) and
   * forward dates run out of the year the grants were made in -- an
   * application would then be refused for an empty balance in a year nothing
   * credited, which reads as a broken feature rather than a broken fixture.
   * Whole weeks keep every date on the same weekday, clear of the Saturday and
   * Sunday this employee has off.
   */
  function nextDate(): string {
    joinWeek += 1;
    return addDays(MONDAY, -7 * joinWeek);
  }

  async function applyFor(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<LeaveRequestDetail> {
    const from = nextDate();
    const response = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
      token,
      body: {
        leaveTypeId: casualTypeId,
        fromDate: from,
        toDate: from,
        reason: 'Join probe',
        ...overrides,
      },
    });
    expect(response.status, response.text).toBe(201);
    return response.body;
  }

  /** Every ledger row the database holds for one leave request. */
  async function ledgerRowsFor(
    leaveRequestId: string,
  ): Promise<{ movementType: string; days: string }[]> {
    const rows = await harness.db.execute<{ movement_type: string; days: string }>(sql`
      SELECT movement_type, days::text AS days
        FROM leave_ledger
       WHERE org_id = ${ORG_ID} AND reference_type = 'leave_request'
         AND reference_id = ${leaveRequestId}::uuid
       ORDER BY created_at, id
    `);
    return rows.rows.map((row) => ({ movementType: row.movement_type, days: row.days }));
  }

  async function statusOf(leaveRequestId: string): Promise<string> {
    const rows = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM leave_requests WHERE id = ${leaveRequestId}::uuid`,
    );
    const row = rows.rows[0];
    if (row === undefined) throw new Error(`No leave request ${leaveRequestId}`);
    return row.status;
  }

  async function approvalStatusOf(approvalRequestId: string): Promise<string> {
    const rows = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM approval_requests WHERE id = ${approvalRequestId}::uuid`,
    );
    const row = rows.rows[0];
    if (row === undefined) throw new Error(`No approval request ${approvalRequestId}`);
    return row.status;
  }

  beforeAll(async () => {
    // Enough balance that none of the applications below is refused for a
    // reason unrelated to what is being tested.
    await grantDays(employeeAId, casualTypeId, 60);
  });

  it('raises an approval with the request, and puts it in the approver inbox', async () => {
    const request = await applyFor(employeeToken);

    // The column has existed since migration 0004 and was null on every row
    // until this join; a null here means the request reaches no inbox at all.
    expect(request.approvalRequestId).not.toBeNull();
    expect(request.status).toBe('PENDING');

    const inbox = await harness.get<Paginated<ApprovalRequestSummary>>(
      '/approvals?pageSize=200',
      { token: managerToken },
    );
    expect(inbox.status, inbox.text).toBe(200);
    const row = inbox.body.data.find((item) => item.id === request.approvalRequestId);
    expect(row).toBeDefined();
    expect(row?.type).toBe('LEAVE');
    // REQ-I-03's one line, so the inbox needs no join and no branch on type.
    expect(row?.subject).toContain('Asha');
    expect(row?.subject).toContain('Probe Casual Leave');

    // REQ-I-05 is written about the requester, and the requester is the person
    // the leave is *about* -- so their own manager is the one being asked.
    const detail = await harness.get<ApprovalRequestDetail>(
      `/approvals/${String(request.approvalRequestId)}`,
      { token: managerToken },
    );
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.subjectType).toBe('leave_request');
    expect(detail.body.subjectId).toBe(request.id);
    expect(detail.body.awaiting?.name).toBe('Meera');
  });

  it('approving in the inbox moves the ledger and the balance, once', async () => {
    const request = await applyFor(employeeToken);
    const before = await balanceOf(employeeToken, casualTypeId);

    const decided = await harness.post<ApprovalRequestDetail & ErrorBody>(
      `/approvals/${String(request.approvalRequestId)}/approve`,
      { token: managerToken, body: { reason: 'Cover arranged.' } },
    );
    expect(decided.status, decided.text).toBe(201);
    expect(decided.body.status).toBe('APPROVED');

    expect(await statusOf(request.id)).toBe('APPROVED');
    expect(await ledgerRowsFor(request.id)).toEqual([
      { movementType: 'AVAILED', days: '-1.00' },
    ]);

    const after = await balanceOf(employeeToken, casualTypeId);
    expect(after.availed).toBe(before.availed + 1);
    expect(after.closing).toBe(before.closing - 1);
    expect(isLeaveBalanceConsistent(after)).toBe(true);
  });

  /**
   * The assertion the whole join turns on. Two requests identical in every
   * respect but the surface they were decided on; if the two surfaces are one
   * code path, their ledgers and their balance movements are indistinguishable.
   */
  it('produces identical ledger and balance outcomes from the inbox and the direct endpoint', async () => {
    const viaInbox = await applyFor(employeeToken);
    const viaEndpoint = await applyFor(employeeToken);

    const start = await balanceOf(employeeToken, casualTypeId);

    const inboxDecision = await harness.post<ApprovalRequestDetail & ErrorBody>(
      `/approvals/${String(viaInbox.approvalRequestId)}/approve`,
      { token: managerToken, body: { reason: 'Same reason.' } },
    );
    expect(inboxDecision.status, inboxDecision.text).toBe(201);
    const middle = await balanceOf(employeeToken, casualTypeId);

    const endpointDecision = await harness.post<LeaveRequestDetail & ErrorBody>(
      `/leave/requests/${viaEndpoint.id}/approve`,
      { token: managerToken, body: { reason: 'Same reason.' } },
    );
    expect(endpointDecision.status, endpointDecision.text).toBe(201);
    const end = await balanceOf(employeeToken, casualTypeId);

    expect(await ledgerRowsFor(viaInbox.id)).toEqual(await ledgerRowsFor(viaEndpoint.id));
    expect(await statusOf(viaInbox.id)).toBe(await statusOf(viaEndpoint.id));

    // The same movement in the balance, both times.
    expect(middle.closing - start.closing).toBe(end.closing - middle.closing);
    expect(middle.availed - start.availed).toBe(end.availed - middle.availed);
    expect(isLeaveBalanceConsistent(end)).toBe(true);

    // And the direct endpoint really did route through the framework rather
    // than deciding beside it: the approval request is closed too.
    expect(await approvalStatusOf(String(viaEndpoint.approvalRequestId))).toBe('APPROVED');
    expect(endpointDecision.body.decidedBy?.name).toBe('Meera');
  });

  it('writes exactly one ledger row when the same request is decided twice in a row', async () => {
    const request = await applyFor(employeeToken);
    const before = await balanceOf(employeeToken, casualTypeId);

    const first = await harness.post<LeaveRequestDetail & ErrorBody>(
      `/leave/requests/${request.id}/approve`,
      { token: managerToken, body: {} },
    );
    expect(first.status, first.text).toBe(201);

    // The second attempt through each surface in turn, because a refusal on
    // one of them proves nothing about the other.
    const againEndpoint = await harness.post<ErrorBody>(
      `/leave/requests/${request.id}/approve`,
      { token: managerToken, body: {} },
    );
    expect(againEndpoint.status).toBe(409);
    expect(againEndpoint.body.error.code).toBe('APPROVAL_ALREADY_ACTIONED');

    const againInbox = await harness.post<ErrorBody>(
      `/approvals/${String(request.approvalRequestId)}/approve`,
      { token: managerToken, body: {} },
    );
    expect(againInbox.status).toBe(409);
    expect(againInbox.body.error.code).toBe('APPROVAL_ALREADY_ACTIONED');

    expect(await ledgerRowsFor(request.id)).toEqual([
      { movementType: 'AVAILED', days: '-1.00' },
    ]);

    const after = await balanceOf(employeeToken, casualTypeId);
    expect(after.availed).toBe(before.availed + 1);
    expect(after.closing).toBe(before.closing - 1);
    expect(isLeaveBalanceConsistent(after)).toBe(true);
  });

  /**
   * The same question with the requests in flight together, which is the one
   * the sequential test cannot answer: before this join the status check and
   * the ledger write were separate statements, so two approvals arriving at
   * once could both read PENDING and both deduct.
   */
  it('writes exactly one ledger row when two approvals arrive at the same instant', async () => {
    const request = await applyFor(employeeToken);
    const before = await balanceOf(employeeToken, casualTypeId);

    // One through each surface, deliberately: they contend on the same
    // approval row only if they really are the same code path.
    const [viaEndpoint, viaInbox] = await Promise.all([
      harness.post<ErrorBody>(`/leave/requests/${request.id}/approve`, {
        token: managerToken,
        body: {},
      }),
      harness.post<ErrorBody>(`/approvals/${String(request.approvalRequestId)}/approve`, {
        token: hrToken,
        body: {},
      }),
    ]);

    const statuses = [viaEndpoint.status, viaInbox.status].sort((a, b) => a - b);
    expect(statuses, `${viaEndpoint.text} | ${viaInbox.text}`).toEqual([201, 409]);

    expect(await ledgerRowsFor(request.id)).toEqual([
      { movementType: 'AVAILED', days: '-1.00' },
    ]);
    expect(await statusOf(request.id)).toBe('APPROVED');

    const after = await balanceOf(employeeToken, casualTypeId);
    expect(after.availed).toBe(before.availed + 1);
    expect(after.closing).toBe(before.closing - 1);
    expect(isLeaveBalanceConsistent(after)).toBe(true);
  });

  it('rejecting through the inbox closes the leave request and moves no balance', async () => {
    const request = await applyFor(employeeToken);
    const before = await balanceOf(employeeToken, casualTypeId);

    const decided = await harness.post<ApprovalRequestDetail & ErrorBody>(
      `/approvals/${String(request.approvalRequestId)}/reject`,
      { token: managerToken, body: { reason: 'The team is short that week.' } },
    );
    expect(decided.status, decided.text).toBe(201);
    expect(decided.body.status).toBe('REJECTED');

    expect(await statusOf(request.id)).toBe('REJECTED');
    expect(await ledgerRowsFor(request.id)).toEqual([]);

    const after = await balanceOf(employeeToken, casualTypeId);
    expect(after.closing).toBe(before.closing);
    expect(after.availed).toBe(before.availed);
  });

  it('refuses to decide its own request through either surface (REQ-I-05)', async () => {
    // Meera has no manager, so her own leave routes to the org-wide approver.
    const own = await applyFor(managerToken);
    expect(own.approvalRequestId).not.toBeNull();

    const viaEndpoint = await harness.post<ErrorBody>(
      `/leave/requests/${own.id}/approve`,
      { token: managerToken, body: {} },
    );
    expect(viaEndpoint.status).toBe(403);
    expect(viaEndpoint.body.error.code).toBe('APPROVER_IS_REQUESTER');

    const viaInbox = await harness.post<ErrorBody>(
      `/approvals/${String(own.approvalRequestId)}/approve`,
      { token: managerToken, body: {} },
    );
    expect(viaInbox.status).toBe(403);
    expect(viaInbox.body.error.code).toBe('APPROVER_IS_REQUESTER');

    expect(await ledgerRowsFor(own.id)).toEqual([]);
    expect(await statusOf(own.id)).toBe('PENDING');
  });

  it('routes a two-step type through both levels, and deducts only at the last', async () => {
    // REQ-G-09: "then HR if the leave type requires two-step approval."
    const twoStep = await createType({
      name: 'Probe Two Step Leave',
      code: `TS${runId}`,
      requiresTwoStepApproval: true,
    });
    await grantDays(employeeAId, twoStep.id, 5);

    const from = nextDate();
    const raised = await harness.post<LeaveRequestDetail & ErrorBody>('/leave/requests', {
      token: employeeToken,
      body: { leaveTypeId: twoStep.id, fromDate: from, toDate: from, reason: 'Two step' },
    });
    expect(raised.status, raised.text).toBe(201);

    const detail = await harness.get<ApprovalRequestDetail>(
      `/approvals/${String(raised.body.approvalRequestId)}`,
      { token: hrToken },
    );
    expect(detail.body.steps).toHaveLength(2);
    expect(detail.body.steps[0]?.approver.name).toBe('Meera');

    const before = await balanceOf(employeeToken, twoStep.id);

    // Level one. The request is still open, so nothing may have been deducted.
    const step = await harness.post<ApprovalRequestDetail & ErrorBody>(
      `/approvals/${String(raised.body.approvalRequestId)}/approve`,
      { token: managerToken, body: {} },
    );
    expect(step.status, step.text).toBe(201);
    expect(step.body.status).toBe('PENDING');
    expect(step.body.currentStep).toBe(2);
    expect(await statusOf(raised.body.id)).toBe('PENDING');
    expect(await ledgerRowsFor(raised.body.id)).toEqual([]);
    expect((await balanceOf(employeeToken, twoStep.id)).closing).toBe(before.closing);

    const final = await harness.post<ApprovalRequestDetail & ErrorBody>(
      `/approvals/${String(raised.body.approvalRequestId)}/approve`,
      { token: hrToken, body: {} },
    );
    expect(final.status, final.text).toBe(201);
    expect(final.body.status).toBe('APPROVED');
    expect(await statusOf(raised.body.id)).toBe('APPROVED');
    expect(await ledgerRowsFor(raised.body.id)).toEqual([
      { movementType: 'AVAILED', days: '-1.00' },
    ]);
    expect((await balanceOf(employeeToken, twoStep.id)).closing).toBe(before.closing - 1);
  });

  /** REQ-G-09's "auto-escalate if untouched for N days", end to end. */
  it('mirrors an escalation onto the leave request, without touching the balance', async () => {
    const request = await applyFor(employeeToken);
    const before = await balanceOf(employeeToken, casualTypeId);

    await harness.db.execute(sql`
      UPDATE approval_requests
         SET current_step_started_at = now() - make_interval(days => 5)
       WHERE id = ${String(request.approvalRequestId)}::uuid
    `);

    const outcome = await harness.resolve(ApprovalService).escalateStale(new Date());
    expect(outcome.escalated).toBeGreaterThanOrEqual(1);

    // The status nothing used to set. Before this join, `leave_requests.status`
    // could never be ESCALATED, and every branch written for it was dead.
    expect(await statusOf(request.id)).toBe('ESCALATED');
    expect(await approvalStatusOf(String(request.approvalRequestId))).toBe('ESCALATED');
    expect(await ledgerRowsFor(request.id)).toEqual([]);

    const afterEscalation = await balanceOf(employeeToken, casualTypeId);
    expect(afterEscalation.closing).toBe(before.closing);
    expect(await harness.waitForAuditAction('leave_request.escalated')).toBe(true);

    // Escalated is open, not terminal: the level it was escalated to decides it.
    const decided = await harness.post<LeaveRequestDetail & ErrorBody>(
      `/leave/requests/${request.id}/approve`,
      { token: hrToken, body: {} },
    );
    expect(decided.status, decided.text).toBe(201);
    expect(decided.body.status).toBe('APPROVED');
    expect(await ledgerRowsFor(request.id)).toEqual([
      { movementType: 'AVAILED', days: '-1.00' },
    ]);
    expect((await balanceOf(employeeToken, casualTypeId)).closing).toBe(before.closing - 1);
  });

  it('withdraws the approval when the leave is cancelled, so no inbox keeps it', async () => {
    const request = await applyFor(employeeToken);

    const cancelled = await harness.post<LeaveRequestDetail & ErrorBody>(
      `/leave/requests/${request.id}/cancel`,
      { token: employeeToken, body: { reason: 'Plans changed' } },
    );
    expect(cancelled.status, cancelled.text).toBe(201);
    expect(await approvalStatusOf(String(request.approvalRequestId))).toBe('CANCELLED');

    const inbox = await harness.get<Paginated<ApprovalRequestSummary>>(
      '/approvals?pageSize=200',
      { token: managerToken },
    );
    const row = inbox.body.data.find((item) => item.id === request.approvalRequestId);
    // Still visible -- REQ-I-02 keeps the history -- but no longer open.
    expect(row?.status).toBe('CANCELLED');

    const refused = await harness.post<ErrorBody>(
      `/approvals/${String(request.approvalRequestId)}/approve`,
      { token: managerToken, body: {} },
    );
    expect(refused.status).toBe(409);
    expect(await ledgerRowsFor(request.id)).toEqual([]);
  });

  it('reverses exactly once when an approved leave is cancelled', async () => {
    const request = await applyFor(employeeToken);
    const before = await balanceOf(employeeToken, casualTypeId);

    const approved = await harness.post<LeaveRequestDetail & ErrorBody>(
      `/approvals/${String(request.approvalRequestId)}/approve`,
      { token: managerToken, body: {} },
    );
    expect(approved.status, approved.text).toBe(201);

    const cancelled = await harness.post<LeaveRequestDetail & ErrorBody>(
      `/leave/requests/${request.id}/cancel`,
      { token: employeeToken, body: { reason: 'Plans changed after approval' } },
    );
    expect(cancelled.status, cancelled.text).toBe(201);

    expect(await ledgerRowsFor(request.id)).toEqual([
      { movementType: 'AVAILED', days: '-1.00' },
      { movementType: 'REVERSAL', days: '1.00' },
    ]);

    const after = await balanceOf(employeeToken, casualTypeId);
    expect(after.closing).toBe(before.closing);
    expect(after.availed).toBe(before.availed);
    expect(isLeaveBalanceConsistent(after)).toBe(true);

    // A second cancellation adds no second reversal.
    const again = await harness.post<ErrorBody>(`/leave/requests/${request.id}/cancel`, {
      token: employeeToken,
      body: { reason: 'Again' },
    });
    expect(again.status).toBe(409);
    expect(await ledgerRowsFor(request.id)).toHaveLength(2);
  });

  /**
   * The one branch that cannot be reached through the API any more, and the
   * reason it answers rather than deciding: a request with no approval has no
   * route, no step and nobody the framework could name as the approver, and
   * deciding it on the old terms would restore the second ledger writer this
   * change removed.
   */
  it('refuses to decide a request that predates the join, and says what to do instead', async () => {
    const request = await applyFor(employeeToken);
    await harness.db.execute(
      sql`UPDATE leave_requests SET approval_request_id = NULL WHERE id = ${request.id}::uuid`,
    );

    const refused = await harness.post<ErrorBody>(`/leave/requests/${request.id}/approve`, {
      token: managerToken,
      body: {},
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/Cancel it and apply again/u);
    expect(await ledgerRowsFor(request.id)).toEqual([]);

    // And the escape hatch the message names actually works.
    const cancelled = await harness.post<LeaveRequestDetail & ErrorBody>(
      `/leave/requests/${request.id}/cancel`,
      { token: employeeToken, body: { reason: 'As the refusal suggested' } },
    );
    expect(cancelled.status, cancelled.text).toBe(201);
  });

  it('refuses a second AVAILED row at the database, not only in the service', async () => {
    const request = await applyFor(employeeToken);
    const approved = await harness.post<LeaveRequestDetail & ErrorBody>(
      `/leave/requests/${request.id}/approve`,
      { token: managerToken, body: {} },
    );
    expect(approved.status, approved.text).toBe(201);

    // Migration 0014. The service refuses first, so this is the layer that
    // catches a future writer that forgets to ask -- and an insert with no
    // ON CONFLICT clause is what proves the index, rather than the check.
    const rows = await harness.db.execute<{ employee_id: string; leave_type_id: string; leave_year: number }>(sql`
      SELECT employee_id, leave_type_id, leave_year FROM leave_ledger
       WHERE reference_id = ${request.id}::uuid AND movement_type = 'AVAILED' LIMIT 1
    `);
    const row = rows.rows[0];
    if (row === undefined) throw new Error('The approval wrote no AVAILED row.');

    const message = await refusalMessage(sql`
      INSERT INTO leave_ledger (org_id, employee_id, leave_type_id, leave_year, movement_type, days, reference_type, reference_id)
      VALUES (${ORG_ID}, ${row.employee_id}::uuid, ${row.leave_type_id}::uuid, ${row.leave_year},
              'AVAILED', -1, 'leave_request', ${request.id}::uuid)
    `);
    expect(message).toMatch(/leave_ledger_request_movement_uq/u);
    expect(await ledgerRowsFor(request.id)).toHaveLength(1);
  });

  /**
   * The hole the widened route guard would have opened, tested from the side
   * that could actually be exploited.
   *
   * `APPROVAL_ACT_KEYS` is the union of every approval key, because a guard is
   * handed a request id and a token and never a subject type. So the moment
   * `regularization.approve` joined that union, a holder of it alone stopped
   * being refused at the door of `/approvals/:id/approve` -- and the only
   * thing still standing between them and somebody's leave balance is the
   * handler's `actPermissions`.
   *
   * The approver here is the requester's own reporting manager, deliberately.
   * A stranger would be refused for not being on the step, which is a pass for
   * the wrong reason and would keep passing with the narrowing deleted. Routed
   * and eligible, the *only* thing that can refuse them is the subject type.
   *
   * No seeded role holds `regularization.approve` without a leave key today --
   * Operations holds both -- but REQ-B-07 lets an administrator build this
   * role in the UI, and `ROLE_PERMISSION_MATRIX` says in its own comment that
   * it is a starting point the code may not rely on.
   */
  it('refuses a correction-only approver on leave, even as the routed manager', async () => {
    const correctorEmployeeId = await harness.createEmployee({
      code: `LV-RA-${runId}`,
      firstName: 'Rohit',
      lastName: 'Deshmukh',
    });
    const subjectEmployeeId = await harness.createEmployee({
      code: `LV-RS-${runId}`,
      firstName: 'Devi',
      lastName: 'Kulkarni',
      reportingManagerId: correctorEmployeeId,
      dateOfJoining: '2020-01-01',
    });

    // Owner, 21 Aug 2026: corrections are decided by attendance.edit now.
    const correctionOnlyRoleId = await harness.createRole('Correction Approver Only', [
      'attendance.edit',
    ]);
    const corrector = await harness.createUser({
      email: scopedEmail('leave-corrector'),
      roleIds: [correctionOnlyRoleId],
      employeeId: correctorEmployeeId,
    });
    const subject = await harness.createUser({
      email: scopedEmail('leave-subject'),
      roleIds: [employeeRoleId],
      employeeId: subjectEmployeeId,
    });
    const correctorToken = (await harness.login(corrector.email, corrector.password)).token;
    const subjectToken = (await harness.login(subject.email, subject.password)).token;

    await grantDays(subjectEmployeeId, casualTypeId, 10);
    const request = await applyFor(subjectToken);

    // Routed to Rohit, so the refusal below cannot be about whose turn it is.
    const detail = await harness.get<ApprovalRequestDetail>(
      `/approvals/${String(request.approvalRequestId)}`,
      { token: hrToken },
    );
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.awaiting?.name).toContain('Rohit');

    const refused = await harness.post<ErrorBody>(
      `/approvals/${String(request.approvalRequestId)}/approve`,
      { token: correctorToken, body: { reason: 'Should never be applied' } },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/permission that decides this kind/u);

    // The balance is the thing that must not have moved.
    expect(await statusOf(request.id)).toBe('PENDING');
    expect(await approvalStatusOf(String(request.approvalRequestId))).toBe('PENDING');
    expect(await ledgerRowsFor(request.id)).toEqual([]);

    // And the fixture is sound: the same person, on the same step, with the
    // leave key added, decides it. Without this the test above would still
    // pass if the request were unroutable or the token were junk.
    await harness.db.execute(sql`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT ${correctionOnlyRoleId}::uuid, id FROM permissions WHERE key = 'leave.approve.team'
    `);
    const rearmed = (await harness.login(corrector.email, corrector.password)).token;
    const allowed = await harness.post<ApprovalRequestDetail & ErrorBody>(
      `/approvals/${String(request.approvalRequestId)}/approve`,
      { token: rearmed, body: { reason: 'Now holds the key' } },
    );
    expect(allowed.status, allowed.text).toBe(201);
    expect(await ledgerRowsFor(request.id)).toEqual([
      { movementType: 'AVAILED', days: '-1.00' },
    ]);
  });

  /**
   * The same hole one step further out: a delegation cannot create authority
   * its author never had.
   *
   * The test above proves a correction-only approver cannot decide leave
   * themselves. This proves they cannot have somebody else decide it for them.
   * `evaluateDecision`'s delegation branch is a bare membership test, and
   * `decideWithin` checks `actPermissions` against the *delegate* -- so before
   * the fix nothing anywhere asked whether the delegator was entitled, and the
   * widened route guard is what let a correction-only holder reach
   * `POST /approvals/delegations` to originate one.
   *
   * The delegate here holds a real leave key and would be perfectly entitled to
   * decide a request routed to *them*. What must not happen is that Rohit's
   * delegation hands them one that never was.
   */
  it('refuses a delegation from an approver who could not decide it themselves', async () => {
    const correctorEmployeeId = await harness.createEmployee({
      code: `LV-DA-${runId}`,
      firstName: 'Rohit',
      lastName: 'Delegator',
    });
    const subjectEmployeeId = await harness.createEmployee({
      code: `LV-DS-${runId}`,
      firstName: 'Sunita',
      lastName: 'Rane',
      reportingManagerId: correctorEmployeeId,
      dateOfJoining: '2020-01-01',
    });

    const correctionOnlyRoleId = await harness.createRole(`Correction Delegator ${runId}`, [
      'attendance.edit',
    ]);
    const corrector = await harness.createUser({
      email: scopedEmail('leave-delegator'),
      roleIds: [correctionOnlyRoleId],
      employeeId: correctorEmployeeId,
    });
    const subject = await harness.createUser({
      email: scopedEmail('leave-delegated-subject'),
      roleIds: [employeeRoleId],
      employeeId: subjectEmployeeId,
    });
    const correctorToken = (await harness.login(corrector.email, corrector.password)).token;
    const subjectToken = (await harness.login(subject.email, subject.password)).token;

    await grantDays(subjectEmployeeId, casualTypeId, 10);
    const request = await applyFor(subjectToken);

    // Routed to Rohit, who holds no leave key.
    const detail = await harness.get<ApprovalRequestDetail>(
      `/approvals/${String(request.approvalRequestId)}`,
      { token: hrToken },
    );
    expect(detail.body.awaiting?.name).toContain('Rohit');

    // The widened guard lets him reach the delegation endpoint at all, which is
    // the step that used to be impossible. Creating it is allowed -- he may
    // legitimately delegate the corrections he *can* decide.
    const delegated = await harness.post<{ id: string } & ErrorBody>('/approvals/delegations', {
      token: correctorToken,
      body: {
        toUserId: managerUserId,
        fromDate: '2020-01-01',
        toDate: '2030-12-31',
        reason: 'Cover while I am away',
      },
    });
    expect(delegated.status, delegated.text).toBe(201);

    // Meera holds leave.approve.team and a live delegation from Rohit. She is
    // still refused: the authority Rohit delegated was never his to give.
    const refused = await harness.post<ErrorBody>(
      `/approvals/${String(request.approvalRequestId)}/approve`,
      { token: managerToken, body: { reason: 'Acting on the delegation' } },
    );
    expect(refused.status).toBe(403);

    // The balance is the thing that must not have moved.
    expect(await statusOf(request.id)).toBe('PENDING');
    expect(await ledgerRowsFor(request.id)).toEqual([]);

    /*
     * And it must not be readable either.
     *
     * Refusing the button while still listing the request is not the control:
     * the inbox row carries the subject line -- the employee's name, leave type
     * and dates -- plus the requester and the full step history. The read path
     * has its own delegation lookup (`ApprovalRepository.delegatorIds`) and
     * narrowing only the decide path left this open.
     */
    const inbox = await harness.get<Paginated<ApprovalRequestSummary>>(
      '/approvals?view=inbox&pageSize=200',
      { token: managerToken },
    );
    expect(inbox.status, inbox.text).toBe(200);
    expect(inbox.body.data.some((row) => row.id === request.approvalRequestId)).toBe(false);

    // Not merely absent from the list: unreadable by id as well.
    const readBack = await harness.get<ErrorBody>(
      `/approvals/${String(request.approvalRequestId)}`,
      { token: managerToken },
    );
    expect([403, 404]).toContain(readBack.status);
  });
});

describe('scope (technical design §10)', () => {
  it('shows an employee only their own requests', async () => {
    const response = await harness.get<Paginated<{ employee: { id: string } }>>(
      '/leave/requests?pageSize=200',
      { token: employeeToken },
    );
    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
    expect(response.body.data.every((row) => row.employee.id === employeeAId)).toBe(true);
  });

  it("shows a manager their report's requests", async () => {
    const response = await harness.get<Paginated<{ employee: { id: string } }>>(
      '/leave/requests?pageSize=200',
      { token: managerToken },
    );
    expect(response.status).toBe(200);
    expect(response.body.data.some((row) => row.employee.id === employeeAId)).toBe(true);
    // Bhavin reports to nobody, so he is outside the manager's team.
    expect(response.body.data.some((row) => row.employee.id === employeeBId)).toBe(false);
  });

  it("refuses an employee asking for a colleague's balance", async () => {
    const response = await harness.get<ErrorBody>(
      `/leave/balances?year=${String(LEAVE_YEAR)}&employeeId=${employeeBId}`,
      { token: employeeToken },
    );
    expect(response.status).toBe(403);
  });

  it('lets HR read anybody', async () => {
    const response = await harness.get<Paginated<LeaveBalance>>(
      `/leave/balances?year=${String(LEAVE_YEAR)}&employeeId=${employeeAId}`,
      { token: hrToken },
    );
    expect(response.status, response.text).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
  });
});

describe('the ledger is append-only (REQ-G-03)', () => {
  it('refuses an UPDATE through the same connection the API uses', async () => {
    const message = await refusalMessage(
      sql`UPDATE leave_ledger SET note = 'edited' WHERE org_id = ${ORG_ID}`,
    );
    expect(message).toMatch(/Table leave_ledger is append-only/u);
  });

  it('refuses a DELETE that would match nothing', async () => {
    // Statement-level, so an empty match is refused too: a DELETE that
    // succeeded because it happened to hit no rows teaches the wrong lesson.
    const message = await refusalMessage(
      sql`DELETE FROM leave_ledger WHERE id = ${uuidv7()}::uuid`,
    );
    expect(message).toMatch(/Table leave_ledger is append-only/u);
  });

  it('refuses a balance whose six numbers do not add up (migration 0009)', async () => {
    const message = await refusalMessage(sql`
      UPDATE leave_balances SET closing = closing + 1
       WHERE org_id = ${ORG_ID} AND employee_id = ${employeeAId}::uuid
    `);
    expect(message).toMatch(/leave_balances_closing_is_the_sum/u);
  });

  it('keeps every stored balance reconcilable against its own ledger', async () => {
    const rows = await harness.db.execute<{
      employee_id: string;
      leave_type_id: string;
      leave_year: number;
      closing: string;
      ledger_sum: string;
    }>(sql`
      SELECT b.employee_id, b.leave_type_id, b.leave_year, b.closing::text AS closing,
             coalesce(sum(l.days), 0)::text AS ledger_sum
        FROM leave_balances b
        LEFT JOIN leave_ledger l
          ON l.employee_id = b.employee_id
         AND l.leave_type_id = b.leave_type_id
         AND l.leave_year = b.leave_year
       WHERE b.org_id = ${ORG_ID}
       GROUP BY b.employee_id, b.leave_type_id, b.leave_year, b.closing
    `);

    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      // The independent route: the plain sum of the signed rows, computed by
      // Postgres rather than by the projection under test.
      expect(Number(row.closing), JSON.stringify(row)).toBe(Number(row.ledger_sum));
    }
  });
});

describe('adjustments (REQ-G-03)', () => {
  it('refuses an adjustment from an approver who is not a policy manager', async () => {
    const response = await harness.post<ErrorBody>('/leave/balances/adjust', {
      token: managerToken,
      body: {
        employeeId: employeeAId,
        leaveTypeId: casualTypeId,
        year: LEAVE_YEAR,
        days: 5,
        reason: 'Should not be allowed',
      },
    });
    expect(response.status).toBe(403);
  });

  it('refuses a zero-day adjustment', async () => {
    const response = await harness.post<ErrorBody>('/leave/balances/adjust', {
      token: hrToken,
      body: {
        employeeId: employeeAId,
        leaveTypeId: casualTypeId,
        year: LEAVE_YEAR,
        days: 0,
        reason: 'Nothing at all',
      },
    });
    expect(response.status).toBe(400);
  });

  it('moves the adjusted bucket and keeps the invariant', async () => {
    const before = await balanceOf(employeeToken, casualTypeId);
    const response = await harness.post<LeaveBalance & ErrorBody>('/leave/balances/adjust', {
      token: hrToken,
      body: {
        employeeId: employeeAId,
        leaveTypeId: casualTypeId,
        year: LEAVE_YEAR,
        days: -1.5,
        reason: 'Correcting an earlier grant',
      },
    });
    expect(response.status, response.text).toBe(201);
    expect(response.body.adjusted).toBe(before.adjusted - 1.5);
    expect(response.body.closing).toBe(before.closing - 1.5);
    expect(isLeaveBalanceConsistent(response.body)).toBe(true);
    expect(await harness.waitForAuditAction('leave_balance.adjusted')).toBe(true);
  });
});

describe('comp-off (REQ-G-11)', () => {
  let creditId = '';

  it('refuses a grant from somebody with no approver key', async () => {
    const response = await harness.post<ErrorBody>('/leave/comp-off', {
      token: employeeToken,
      body: { employeeId: employeeAId, earnedForDate: SATURDAY, days: 1 },
    });
    expect(response.status).toBe(403);
  });

  it('grants a credit, expiring 30 days later by default', async () => {
    const response = await harness.post<CompOffCredit & ErrorBody>('/leave/comp-off', {
      token: hrToken,
      body: { employeeId: employeeAId, earnedForDate: SATURDAY, days: 1 },
    });
    expect(response.status, response.text).toBe(201);
    expect(response.body.days).toBe(1);
    expect(response.body.expiresOn).toBe(addDays(SATURDAY, 30));
    expect(response.body.leaveType.code).toBe('CO');
    creditId = response.body.id;

    const balance = await balanceOf(employeeToken, compOffTypeId);
    expect(balance.accrued).toBe(1);
    expect(balance.closing).toBe(1);
    expect(isLeaveBalanceConsistent(balance)).toBe(true);
  });

  it('refuses a second credit for the same worked date', async () => {
    const response = await harness.post<ErrorBody>('/leave/comp-off', {
      token: hrToken,
      body: { employeeId: employeeAId, earnedForDate: SATURDAY, days: 1 },
    });
    expect(response.status).toBe(409);
  });

  it('honours a configured expiry window instead of the default', async () => {
    await withSetting(LEAVE_SETTING_KEYS.compOffExpiryDays, 10, async () => {
      const response = await harness.post<CompOffCredit & ErrorBody>('/leave/comp-off', {
        token: hrToken,
        body: { employeeId: employeeAId, earnedForDate: SUNDAY, days: 0.5 },
      });
      expect(response.status, response.text).toBe(201);
      expect(response.body.expiresOn).toBe(addDays(SUNDAY, 10));
    });
  });

  it('refuses a malformed setting rather than falling back to the default', async () => {
    await withSetting(LEAVE_SETTING_KEYS.compOffExpiryDays, 'thirty days', async () => {
      const response = await harness.post<ErrorBody>('/leave/comp-off', {
        token: hrToken,
        body: { employeeId: employeeAId, earnedForDate: addDays(SUNDAY, 7), days: 1 },
      });
      expect(response.status).toBe(500);
    });
  });

  it('lists the credit and audits the grant', async () => {
    const response = await harness.get<Paginated<CompOffCredit>>('/leave/comp-off?state=ACTIVE', {
      token: employeeToken,
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.data.some((row) => row.id === creditId)).toBe(true);
    expect(await harness.waitForAuditAction('comp_off.granted')).toBe(true);
  });
});

describe('the team calendar (REQ-G-12)', () => {
  it('lists approved absences in the range and no pending ones', async () => {
    const response = await harness.get<LeaveCalendar>(
      `/leave/calendar?from=${MONDAY}&to=${addDays(NEXT_MONDAY, 60)}`,
      { token: managerToken },
    );
    expect(response.status, response.text).toBe(200);
    expect(response.body.entries.length).toBeGreaterThan(0);
    expect(response.body.entries.every((entry) => entry.employee.id === employeeAId)).toBe(true);
    // No threshold configured, so no warnings are invented.
    expect(response.body.threshold).toBe(0);
    expect(response.body.warnings).toEqual([]);
  });

  it('warns once a concurrent-absence threshold is configured', async () => {
    await withSetting(LEAVE_SETTING_KEYS.concurrentAbsenceThreshold, 1, async () => {
      const response = await harness.get<LeaveCalendar>(
        `/leave/calendar?from=${MONDAY}&to=${addDays(NEXT_MONDAY, 60)}`,
        { token: managerToken },
      );
      expect(response.status).toBe(200);
      expect(response.body.threshold).toBe(1);
      expect(response.body.warnings.length).toBeGreaterThan(0);
    });
  });

  it('refuses a range that ends before it starts', async () => {
    const response = await harness.get<ErrorBody>(
      `/leave/calendar?from=${FRIDAY}&to=${MONDAY}`,
      { token: managerToken },
    );
    expect(response.status).toBe(400);
  });
});

describe('the leave year is configurable (REQ-G-04)', () => {
  it('moves which year a date belongs to when the start month changes', async () => {
    // With an April start, a January date belongs to the previous leave year.
    const january = `${String(Number(MONDAY.slice(0, 4)) + 1)}-01-15`;

    const beforeChange = await harness.get<Paginated<LeaveLedgerEntry>>(
      `/leave/ledger?year=${String(LEAVE_YEAR)}`,
      { token: employeeToken },
    );
    expect(beforeChange.status).toBe(200);
    const rowsInAprilYear = beforeChange.body.meta.total;
    expect(rowsInAprilYear).toBeGreaterThan(0);

    await withSetting(LEAVE_SETTING_KEYS.yearStartMonth, 1, async () => {
      // A January-start org files that same January date under the same
      // calendar year, so a comp-off granted for it lands in a different
      // leave year than it would have under April.
      const granted = await harness.post<CompOffCredit & ErrorBody>('/leave/comp-off', {
        token: hrToken,
        body: { employeeId: employeeBId, earnedForDate: january, days: 1 },
      });
      expect(granted.status, granted.text).toBe(201);

      const januaryYear = Number(january.slice(0, 4));
      const rows = await harness.db
        .select({ value: sql<number>`count(*)::int` })
        .from(leaveLedger)
        .where(
          and(
            eq(leaveLedger.orgId, ORG_ID),
            eq(leaveLedger.employeeId, employeeBId),
            eq(leaveLedger.leaveYear, januaryYear),
          ),
        );
      expect(rows[0]?.value).toBe(1);
    });
  });

  it('refuses a start month outside 1..12', async () => {
    await withSetting(LEAVE_SETTING_KEYS.yearStartMonth, 13, async () => {
      const response = await harness.get<ErrorBody>(
        previewPath({ leaveTypeId: casualTypeId, fromDate: MONDAY, toDate: MONDAY }),
        { token: employeeToken },
      );
      expect(response.status).toBe(500);
    });
  });
});
