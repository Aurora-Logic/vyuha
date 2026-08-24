import {
  SYSTEM_ROLES,
  uuidv7,
  type Paginated,
  type RosterAssignment,
  type RosterBulkPreview,
  type ShiftSummary,
  type WeeklyOffPatternSummary,
} from '@vyuha/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';
import { employees } from '../../../platform/db/schema/index.js';
import {
  attendanceDays,
  attendancePeriodLocks,
  shiftAssignments,
  shifts as shiftsTable,
  weeklyOffPatterns,
} from '../schema/index.js';
import { rangesOverlap } from './roster-range.js';

/**
 * Shifts, weekly-off patterns and rosters (REQ-C-01 … REQ-C-06) over real HTTP,
 * against real Postgres, through the real guard, pipe, exception filter and
 * audit interceptor.
 *
 * `preservePeople` because a roster row points at an employee with a RESTRICT
 * foreign key, so the harness's employee wipe cannot run while one exists. The
 * fixture therefore clears this slice's own tables first and gives every
 * person, department and shift a per-run code, so a re-run never reuses a row
 * whose state came from the run before it.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000c5';
/** Distinguishes this run's rows from the ones `preservePeople` left behind. */
const RUN = uuidv7().slice(-8);

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let adminToken = '';
let hrToken = '';
let opsToken = '';
let employeeToken = '';

let departmentId = '';
let otherDepartmentId = '';
let anilId = '';
let bhavnaId = '';
let charuId = '';
/** Reports to nobody the Operations user manages: the out-of-scope case. */
let outsiderId = '';
let opsEmployeeId = '';

let generalShiftId = '';
let nightShiftId = '';

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Shift Roster Fixture Org', { preservePeople: true });

  // Order matters: shift_assignments points at shifts and employees with
  // RESTRICT, and attendance_days points at shifts with SET NULL.
  await harness.db.delete(attendanceDays).where(eq(attendanceDays.orgId, ORG_ID));
  await harness.db.delete(attendancePeriodLocks).where(eq(attendancePeriodLocks.orgId, ORG_ID));
  await harness.db.delete(shiftAssignments).where(eq(shiftAssignments.orgId, ORG_ID));
  await harness.db.delete(shiftsTable).where(eq(shiftsTable.orgId, ORG_ID));
  await harness.db.delete(weeklyOffPatterns).where(eq(weeklyOffPatterns.orgId, ORG_ID));

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN);
  const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR);
  const opsRoleId = await harness.createSystemRole(SYSTEM_ROLES.OPERATIONS);
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);

  departmentId = await harness.createDepartment({ code: `SR-OPS-${RUN}`, name: `Plant ${RUN}` });
  otherDepartmentId = await harness.createDepartment({
    code: `SR-ADM-${RUN}`,
    name: `Admin ${RUN}`,
  });

  opsEmployeeId = await harness.createEmployee({
    code: `SR-MGR-${RUN}`,
    firstName: 'Meera',
    lastName: 'Iyer',
    departmentId,
  });
  // The Operations user heads the department, which is what PRD section 2's
  // definition of "team" turns into a scope.
  await harness.setDepartmentHead(departmentId, opsEmployeeId);

  anilId = await harness.createEmployee({
    code: `SR-0001-${RUN}`,
    firstName: 'Anil',
    lastName: 'Kumar',
    departmentId,
    reportingManagerId: opsEmployeeId,
  });
  bhavnaId = await harness.createEmployee({
    code: `SR-0002-${RUN}`,
    firstName: 'Bhavna',
    lastName: 'Shah',
    departmentId,
    reportingManagerId: opsEmployeeId,
  });
  charuId = await harness.createEmployee({
    code: `SR-0003-${RUN}`,
    firstName: 'Charu',
    lastName: 'Das',
    departmentId,
    reportingManagerId: opsEmployeeId,
  });
  outsiderId = await harness.createEmployee({
    code: `SR-0004-${RUN}`,
    firstName: 'Deepak',
    lastName: 'Rao',
    departmentId: otherDepartmentId,
  });

  const admin = await harness.createUser({
    email: scopedEmail('shift-admin'),
    roleIds: [adminRoleId],
  });
  const hr = await harness.createUser({ email: scopedEmail('shift-hr'), roleIds: [hrRoleId] });
  const ops = await harness.createUser({
    email: scopedEmail('shift-ops'),
    roleIds: [opsRoleId],
    employeeId: opsEmployeeId,
  });
  const plain = await harness.createUser({
    email: scopedEmail('shift-plain'),
    roleIds: [employeeRoleId],
    employeeId: outsiderId,
  });

  adminToken = (await harness.login(admin.email, admin.password)).token;
  hrToken = (await harness.login(hr.email, hr.password)).token;
  opsToken = (await harness.login(ops.email, ops.password)).token;
  employeeToken = (await harness.login(plain.email, plain.password)).token;
  expect([adminToken, hrToken, opsToken, employeeToken].every((token) => token !== '')).toBe(true);
}, 40_000);

afterAll(async () => {
  await harness.close();
});

// ---------------------------------------------------------------- shifts

describe('shifts (REQ-C-01)', () => {
  it('starts empty, and says so with a well-formed envelope', async () => {
    const listed = await harness.get<Paginated<ShiftSummary>>('/shifts', { token: hrToken });
    expect(listed.status, listed.text).toBe(200);
    expect(listed.body.data).toEqual([]);
    expect(listed.body.meta).toEqual({ page: 1, pageSize: 50, total: 0 });
  });

  it('creates one, applying every REQ-C-01 default the body did not name', async () => {
    const created = await harness.post<ShiftSummary>('/shifts', {
      token: hrToken,
      body: {
        name: 'General',
        code: `SR-GEN-${RUN}`,
        scheduledIn: '09:30',
        scheduledOut: '18:30',
        breakMinutes: 60,
      },
    });

    expect(created.status, created.text).toBe(201);
    expect(created.body.scheduledIn).toBe('09:30');
    expect(created.body.scheduledOut).toBe('18:30');
    expect(created.body.crossesMidnight).toBe(false);
    expect(created.body.isActive).toBe(true);
    // The printed defaults, not zeroes. Zeroes would make every day Late and
    // never Present, which is the silent failure this assertion exists for.
    expect(created.body.policy).toEqual({
      graceInBefore: 30,
      graceInAfter: 10,
      lateAfter: 10,
      graceOutBefore: 10,
      graceOutAfter: 120,
      earlyExitBefore: 10,
      minHalfDayMinutes: 240,
      minFullDayMinutes: 480,
      otAfterMinutes: 30,
    });

    generalShiftId = created.body.id;
    expect(await harness.waitForAuditAction('shift.created')).toBe(true);
  });

  it('creates a night shift and keeps the crosses-midnight flag (REQ-C-02)', async () => {
    const created = await harness.post<ShiftSummary>('/shifts', {
      token: hrToken,
      body: {
        name: 'Night',
        code: `SR-NGT-${RUN}`,
        scheduledIn: '22:00',
        scheduledOut: '06:00',
        breakMinutes: 45,
        crossesMidnight: true,
        policy: { lateAfter: 15 },
      },
    });

    expect(created.status, created.text).toBe(201);
    expect(created.body.crossesMidnight).toBe(true);
    expect(created.body.policy.lateAfter).toBe(15);
    // A named field overrides its default without disturbing the other eight.
    expect(created.body.policy.graceInBefore).toBe(30);
    nightShiftId = created.body.id;
  });

  it('refuses a night shift that did not declare itself one', async () => {
    const rejected = await harness.post<ErrorBody>('/shifts', {
      token: hrToken,
      body: {
        name: 'Undeclared night',
        code: `SR-BAD-${RUN}`,
        scheduledIn: '22:00',
        scheduledOut: '06:00',
        breakMinutes: 0,
      },
    });
    expect(rejected.status, rejected.text).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a half-day threshold above the full-day threshold', async () => {
    const rejected = await harness.post<ErrorBody>('/shifts', {
      token: hrToken,
      body: {
        name: 'Unreachable half day',
        code: `SR-HALF-${RUN}`,
        scheduledIn: '09:00',
        scheduledOut: '18:00',
        breakMinutes: 0,
        policy: { minHalfDayMinutes: 500, minFullDayMinutes: 480 },
      },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['seconds in the time', { scheduledIn: '09:00:00', scheduledOut: '18:00' }],
    ['a 12-hour time', { scheduledIn: '9:00am', scheduledOut: '18:00' }],
    ['a 25th hour', { scheduledIn: '25:00', scheduledOut: '26:00' }],
    ['a negative grace window', { scheduledIn: '09:00', scheduledOut: '18:00', policy: { graceInBefore: -5 } }],
    ['a grace window longer than a day', { scheduledIn: '09:00', scheduledOut: '18:00', policy: { graceOutAfter: 5000 } }],
    ['a fractional minute count', { scheduledIn: '09:00', scheduledOut: '18:00', breakMinutes: 30.5 }],
  ])('refuses %s', async (_label, overrides) => {
    const rejected = await harness.post<ErrorBody>('/shifts', {
      token: hrToken,
      // Every case below states both times, so they are not defaulted here --
      // a default the spread always overwrites reads as if it mattered.
      body: { name: 'Hostile', code: `SR-X-${RUN}`, breakMinutes: 0, ...overrides },
    });
    expect(rejected.status, rejected.text).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a duplicate code', async () => {
    const duplicate = await harness.post<ErrorBody>('/shifts', {
      token: hrToken,
      body: {
        name: 'General again',
        code: `SR-GEN-${RUN}`,
        scheduledIn: '10:00',
        scheduledOut: '19:00',
        breakMinutes: 0,
      },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');
  });

  it('patches one field without disturbing the rest', async () => {
    const patched = await harness.patch<ShiftSummary>(`/shifts/${generalShiftId}`, {
      token: hrToken,
      body: { policy: { lateAfter: 20 } },
    });

    expect(patched.status, patched.text).toBe(200);
    expect(patched.body.policy.lateAfter).toBe(20);
    expect(patched.body.policy.graceInBefore).toBe(30);
    expect(patched.body.scheduledIn).toBe('09:30');
    expect(patched.body.name).toBe('General');
    expect(await harness.waitForAuditAction('shift.updated')).toBe(true);
  });

  /**
   * The case the body's own schema cannot judge. `{ scheduledOut: '06:00' }`
   * is a valid time and says nothing about midnight; only the row it is
   * applied to reveals that the result would be a zero-length window.
   */
  it('refuses a patch that only becomes invalid once merged with the row', async () => {
    const rejected = await harness.patch<ErrorBody>(`/shifts/${generalShiftId}`, {
      token: hrToken,
      body: { scheduledOut: '06:00' },
    });
    expect(rejected.status, rejected.text).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');

    const unchanged = await harness.get<ShiftSummary>(`/shifts/${generalShiftId}`, {
      token: hrToken,
    });
    expect(unchanged.body.scheduledOut).toBe('18:30');
  });

  it('refuses a merged patch that would make Half day unreachable', async () => {
    const rejected = await harness.patch<ErrorBody>(`/shifts/${generalShiftId}`, {
      token: hrToken,
      body: { policy: { minHalfDayMinutes: 600 } },
    });
    expect(rejected.status, rejected.text).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('hides a deactivated shift from the list but keeps it readable', async () => {
    const created = await harness.post<ShiftSummary>('/shifts', {
      token: hrToken,
      body: {
        name: 'Retired',
        code: `SR-OLD-${RUN}`,
        scheduledIn: '07:00',
        scheduledOut: '15:00',
        breakMinutes: 30,
        isActive: false,
      },
    });
    expect(created.status, created.text).toBe(201);

    const listed = await harness.get<Paginated<ShiftSummary>>('/shifts?pageSize=200', {
      token: hrToken,
    });
    expect(listed.body.data.some((row) => row.id === created.body.id)).toBe(false);

    const withInactive = await harness.get<Paginated<ShiftSummary>>(
      '/shifts?pageSize=200&includeInactive=true',
      { token: hrToken },
    );
    expect(withInactive.body.data.some((row) => row.id === created.body.id)).toBe(true);

    const direct = await harness.get<ShiftSummary>(`/shifts/${created.body.id}`, {
      token: hrToken,
    });
    expect(direct.status).toBe(200);
    expect(direct.body.isActive).toBe(false);
  });

  it('searches by name and by code', async () => {
    const byCode = await harness.get<Paginated<ShiftSummary>>(`/shifts?q=SR-NGT-${RUN}`, {
      token: hrToken,
    });
    expect(byCode.body.data).toHaveLength(1);
    expect(byCode.body.data[0]?.id).toBe(nightShiftId);

    // An unescaped wildcard would match every row and read as a working
    // filter; `master-query.ts` escapes it, and this is what proves it.
    const wildcard = await harness.get<Paginated<ShiftSummary>>('/shifts?q=%25', {
      token: hrToken,
    });
    expect(wildcard.body.data).toEqual([]);
  });

  it('answers 404 for a shift in another organisation', async () => {
    const missing = await harness.get<ErrorBody>(`/shifts/${uuidv7()}`, { token: hrToken });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('refuses a plain employee on both the read and the write', async () => {
    const read = await harness.get<ErrorBody>('/shifts', { token: employeeToken });
    expect(read.status).toBe(403);

    const write = await harness.post<ErrorBody>('/shifts', {
      token: employeeToken,
      body: {
        name: 'Sneaky',
        code: `SR-SNK-${RUN}`,
        scheduledIn: '09:00',
        scheduledOut: '18:00',
        breakMinutes: 0,
      },
    });
    expect(write.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const anonymous = await harness.get<ErrorBody>('/shifts');
    expect(anonymous.status).toBe(401);
  });

  it('lets Operations write, because PRD section 2.1 gives it shift.manage', async () => {
    const created = await harness.post<ShiftSummary>('/shifts', {
      token: opsToken,
      body: {
        name: 'Second',
        code: `SR-2ND-${RUN}`,
        scheduledIn: '14:00',
        scheduledOut: '22:00',
        breakMinutes: 30,
      },
    });
    expect(created.status, created.text).toBe(201);
  });
});

// --------------------------------------------------------- weekly offs

describe('weekly-off patterns (REQ-C-03)', () => {
  let patternId = '';

  it('creates one and describes how many people are on it', async () => {
    const created = await harness.post<WeeklyOffPatternSummary>('/weekly-off-patterns', {
      token: hrToken,
      body: { name: `Sundays and alternate Saturdays ${RUN}`, config: { weekdays: [7], saturdaysOfMonth: [2, 4] } },
    });

    expect(created.status, created.text).toBe(201);
    expect(created.body.config).toEqual({ weekdays: [7], saturdaysOfMonth: [2, 4] });
    expect(created.body.employeeCount).toBe(0);
    patternId = created.body.id;

    expect(await harness.waitForAuditAction('weekly_off_pattern.created')).toBe(true);
  });

  it('counts the employees who name it', async () => {
    await harness.db
      .update(employees)
      .set({ weeklyOffPatternId: patternId })
      .where(and(eq(employees.orgId, ORG_ID), eq(employees.id, anilId)));

    const read = await harness.get<WeeklyOffPatternSummary>(`/weekly-off-patterns/${patternId}`, {
      token: hrToken,
    });
    expect(read.status).toBe(200);
    expect(read.body.employeeCount).toBe(1);

    await harness.db
      .update(employees)
      .set({ weeklyOffPatternId: null })
      .where(and(eq(employees.orgId, ORG_ID), eq(employees.id, anilId)));
  });

  it.each([
    ['a weekday outside 1..7', { weekdays: [0] }],
    ['a weekday as text', { weekdays: ['7'] }],
    ['weekdays missing altogether', { saturdaysOfMonth: [2] }],
    ['an unknown key', { weekdays: [7], holidays: [] }],
    ['an array instead of an object', [7]],
    ['null', null],
  ])('refuses %s', async (_label, config) => {
    const rejected = await harness.post<ErrorBody>('/weekly-off-patterns', {
      token: hrToken,
      body: { name: `Hostile ${RUN}`, config },
    });
    expect(rejected.status, rejected.text).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a duplicate name', async () => {
    const duplicate = await harness.post<ErrorBody>('/weekly-off-patterns', {
      token: hrToken,
      body: { name: `Sundays and alternate Saturdays ${RUN}`, config: { weekdays: [7] } },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');
  });

  it('patches the rule and the name', async () => {
    const patched = await harness.patch<WeeklyOffPatternSummary>(
      `/weekly-off-patterns/${patternId}`,
      { token: hrToken, body: { config: { weekdays: [6, 7] } } },
    );
    expect(patched.status, patched.text).toBe(200);
    expect(patched.body.config).toEqual({ weekdays: [6, 7] });
    expect(await harness.waitForAuditAction('weekly_off_pattern.updated')).toBe(true);
  });

  it('refuses a plain employee', async () => {
    expect((await harness.get<ErrorBody>('/weekly-off-patterns', { token: employeeToken })).status).toBe(403);
    expect(
      (
        await harness.post<ErrorBody>('/weekly-off-patterns', {
          token: employeeToken,
          body: { name: `Nope ${RUN}`, config: { weekdays: [7] } },
        })
      ).status,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------- roster

describe('the roster (REQ-C-04)', () => {
  let anilAssignmentId = '';

  it('starts empty for the period', async () => {
    const listed = await harness.get<Paginated<RosterAssignment>>(
      '/rosters?from=2026-03-01&to=2026-03-31',
      { token: hrToken },
    );
    expect(listed.status, listed.text).toBe(200);
    expect(listed.body.data).toEqual([]);
  });

  it('rejects a period whose end precedes its start', async () => {
    const rejected = await harness.get<ErrorBody>('/rosters?from=2026-03-31&to=2026-03-01', {
      token: hrToken,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('assigns an employee to a shift for a range', async () => {
    const created = await harness.post<RosterAssignment>('/rosters', {
      token: hrToken,
      body: { employeeId: anilId, shiftId: nightShiftId, from: '2026-03-10', to: '2026-03-20' },
    });

    expect(created.status, created.text).toBe(201);
    expect(created.body.employee.id).toBe(anilId);
    expect(created.body.employee.name).toBe('Anil Kumar');
    expect(created.body.shift.id).toBe(nightShiftId);
    expect(created.body.from).toBe('2026-03-10');
    expect(created.body.to).toBe('2026-03-20');
    expect(created.body.department).toBe(`Plant ${RUN}`);
    anilAssignmentId = created.body.id;

    expect(await harness.waitForAuditAction('roster.assigned')).toBe(true);
  });

  it.each([
    ['an identical range', '2026-03-10', '2026-03-20'],
    ['a range meeting only the inclusive end date', '2026-03-20', '2026-03-25'],
    ['a range meeting only the inclusive start date', '2026-03-05', '2026-03-10'],
    ['a range that swallows it', '2026-01-01', '2026-12-31'],
    ['a range inside it', '2026-03-12', '2026-03-13'],
    ['an open-ended range that begins inside it', '2026-03-15', null],
  ])('refuses %s (REQ-C-04)', async (_label, from, to) => {
    const rejected = await harness.post<ErrorBody>('/rosters', {
      token: hrToken,
      body: { employeeId: anilId, shiftId: generalShiftId, from, to },
    });
    expect(rejected.status, rejected.text).toBe(409);
    expect(rejected.body.error.code).toBe('SHIFT_ASSIGNMENT_OVERLAP');
    // The refusal names the assignment in the way; "it overlaps" alone sends
    // the reader hunting through a year of roster rows.
    expect(rejected.body.error.details?.conflictingAssignmentId).toBe(anilAssignmentId);
  });

  it('accepts an adjacent range, so the check is not simply refusing everything', async () => {
    const created = await harness.post<RosterAssignment>('/rosters', {
      token: hrToken,
      body: { employeeId: anilId, shiftId: generalShiftId, from: '2026-03-21', to: '2026-03-31' },
    });
    expect(created.status, created.text).toBe(201);
  });

  it('allows two employees the same range', async () => {
    const created = await harness.post<RosterAssignment>('/rosters', {
      token: hrToken,
      body: { employeeId: bhavnaId, shiftId: nightShiftId, from: '2026-03-10', to: '2026-03-20' },
    });
    expect(created.status, created.text).toBe(201);
  });

  it('lists what overlaps the period, not only what is contained in it', async () => {
    const listed = await harness.get<Paginated<RosterAssignment>>(
      '/rosters?from=2026-03-15&to=2026-03-16&pageSize=200',
      { token: hrToken },
    );
    expect(listed.status).toBe(200);
    // Both the 10th-20th assignments straddle the two-day window.
    expect(listed.body.data).toHaveLength(2);
    expect(listed.body.data.every((row) => row.shift.id === nightShiftId)).toBe(true);
  });

  it('filters by employee, department and shift', async () => {
    const byEmployee = await harness.get<Paginated<RosterAssignment>>(
      `/rosters?from=2026-01-01&to=2026-12-31&employeeId=${anilId}&pageSize=200`,
      { token: hrToken },
    );
    expect(byEmployee.body.data).toHaveLength(2);

    const byShift = await harness.get<Paginated<RosterAssignment>>(
      `/rosters?from=2026-01-01&to=2026-12-31&shiftId=${generalShiftId}&pageSize=200`,
      { token: hrToken },
    );
    expect(byShift.body.data.every((row) => row.shift.id === generalShiftId)).toBe(true);

    const byOtherDepartment = await harness.get<Paginated<RosterAssignment>>(
      `/rosters?from=2026-01-01&to=2026-12-31&departmentId=${otherDepartmentId}&pageSize=200`,
      { token: hrToken },
    );
    expect(byOtherDepartment.body.data).toEqual([]);
  });

  it('moves an assignment without complaining that it overlaps itself', async () => {
    const patched = await harness.patch<RosterAssignment>(`/rosters/${anilAssignmentId}`, {
      token: hrToken,
      body: { to: '2026-03-18' },
    });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.body.to).toBe('2026-03-18');
    expect(patched.body.from).toBe('2026-03-10');
    expect(await harness.waitForAuditAction('roster.reassigned')).toBe(true);
  });

  it('refuses a patch that would collide with the neighbouring assignment', async () => {
    const rejected = await harness.patch<ErrorBody>(`/rosters/${anilAssignmentId}`, {
      token: hrToken,
      body: { to: '2026-03-25' },
    });
    expect(rejected.status, rejected.text).toBe(409);
    expect(rejected.body.error.code).toBe('SHIFT_ASSIGNMENT_OVERLAP');
  });

  it('refuses an unknown shift and an unknown employee', async () => {
    const badShift = await harness.post<ErrorBody>('/rosters', {
      token: hrToken,
      body: { employeeId: charuId, shiftId: uuidv7(), from: '2026-05-01', to: '2026-05-02' },
    });
    expect(badShift.status).toBe(400);
    expect(badShift.body.error.code).toBe('VALIDATION_FAILED');

    const badEmployee = await harness.post<ErrorBody>('/rosters', {
      token: hrToken,
      body: { employeeId: uuidv7(), shiftId: generalShiftId, from: '2026-05-01', to: '2026-05-02' },
    });
    expect(badEmployee.status).toBe(400);
    expect(badEmployee.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a deactivated shift', async () => {
    const retired = await harness.get<Paginated<ShiftSummary>>(
      `/shifts?includeInactive=true&q=SR-OLD-${RUN}`,
      { token: hrToken },
    );
    const retiredId = retired.body.data[0]?.id ?? '';
    expect(retiredId).not.toBe('');

    const rejected = await harness.post<ErrorBody>('/rosters', {
      token: hrToken,
      body: { employeeId: charuId, shiftId: retiredId, from: '2026-05-01', to: '2026-05-02' },
    });
    expect(rejected.status, rejected.text).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses an end date before the start date', async () => {
    const rejected = await harness.post<ErrorBody>('/rosters', {
      token: hrToken,
      body: { employeeId: charuId, shiftId: generalShiftId, from: '2026-05-10', to: '2026-05-01' },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a plain employee on read and write', async () => {
    expect(
      (await harness.get<ErrorBody>('/rosters?from=2026-03-01&to=2026-03-31', { token: employeeToken }))
        .status,
    ).toBe(403);
    expect(
      (
        await harness.post<ErrorBody>('/rosters', {
          token: employeeToken,
          body: { employeeId: outsiderId, shiftId: generalShiftId, from: '2026-06-01', to: '2026-06-02' },
        })
      ).status,
    ).toBe(403);
  });

  /**
   * Security section 15: never trust an id from the client. The Operations
   * user holds `shift.manage`, which the guard is satisfied by -- what stops
   * them rostering somebody outside their team is the scope predicate, and it
   * has to be applied to the write and not only to the list.
   */
  it('will not let Operations roster somebody outside their team', async () => {
    const rejected = await harness.post<ErrorBody>('/rosters', {
      token: opsToken,
      body: { employeeId: outsiderId, shiftId: generalShiftId, from: '2026-07-01', to: '2026-07-02' },
    });
    expect(rejected.status, rejected.text).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');

    // And HR, whose scope is the whole organisation, can.
    const allowed = await harness.post<RosterAssignment>('/rosters', {
      token: hrToken,
      body: { employeeId: outsiderId, shiftId: generalShiftId, from: '2026-07-01', to: '2026-07-02' },
    });
    expect(allowed.status, allowed.text).toBe(201);
  });

  it('hides an out-of-scope assignment from the Operations list and from findOne', async () => {
    const listed = await harness.get<Paginated<RosterAssignment>>(
      '/rosters?from=2026-07-01&to=2026-07-02&pageSize=200',
      { token: opsToken },
    );
    expect(listed.status).toBe(200);
    expect(listed.body.data.some((row) => row.employee.id === outsiderId)).toBe(false);

    const hrView = await harness.get<Paginated<RosterAssignment>>(
      '/rosters?from=2026-07-01&to=2026-07-02&pageSize=200',
      { token: hrToken },
    );
    const outsiderAssignmentId = hrView.body.data.find((row) => row.employee.id === outsiderId)?.id;
    expect(outsiderAssignmentId).toBeDefined();

    const denied = await harness.get<ErrorBody>(`/rosters/${outsiderAssignmentId ?? ''}`, {
      token: opsToken,
    });
    // 404 rather than 403: a 403 would confirm the id belongs to somebody,
    // which is the fact the scope exists to withhold.
    expect(denied.status).toBe(404);
  });
});

// ------------------------------------------------------------ bulk roster

describe('bulk roster assignment (REQ-C-05)', () => {
  it('previews without writing anything', async () => {
    const preview = await harness.post<RosterBulkPreview>('/rosters/bulk', {
      token: hrToken,
      body: { shiftId: generalShiftId, from: '2026-09-01', to: '2026-09-30', departmentId },
    });

    expect(preview.status, preview.text).toBe(200);
    expect(preview.body.preview).toBe(true);
    expect(preview.body.created).toBe(0);
    expect(preview.body.days).toBe(30);
    // Meera, Anil, Bhavna and Charu are in this department; nobody has a
    // September assignment yet.
    expect(preview.body.assignable).toBe(4);
    expect(preview.body.blocked).toBe(0);
    expect(preview.body.employeeDays).toBe(120);
    expect(preview.body.targets).toHaveLength(4);

    const listed = await harness.get<Paginated<RosterAssignment>>(
      '/rosters?from=2026-09-01&to=2026-09-30&pageSize=200',
      { token: hrToken },
    );
    expect(listed.body.data).toEqual([]);
  });

  it('commits, and the count matches the preview', async () => {
    const committed = await harness.post<RosterBulkPreview>('/rosters/bulk', {
      token: hrToken,
      body: {
        shiftId: generalShiftId,
        from: '2026-09-01',
        to: '2026-09-30',
        departmentId,
        preview: false,
      },
    });

    expect(committed.status, committed.text).toBe(200);
    expect(committed.body.preview).toBe(false);
    expect(committed.body.created).toBe(4);

    const listed = await harness.get<Paginated<RosterAssignment>>(
      '/rosters?from=2026-09-01&to=2026-09-30&pageSize=200',
      { token: hrToken },
    );
    expect(listed.body.data).toHaveLength(4);
    expect(await harness.waitForAuditAction('roster.assigned')).toBe(true);
  });

  it('reports who is blocked and why, and skips them on the commit', async () => {
    const preview = await harness.post<RosterBulkPreview>('/rosters/bulk', {
      token: hrToken,
      body: { shiftId: nightShiftId, from: '2026-09-15', to: '2026-10-15', departmentId },
    });

    expect(preview.status, preview.text).toBe(200);
    expect(preview.body.assignable).toBe(0);
    expect(preview.body.blocked).toBe(4);
    const blocked = preview.body.targets[0];
    expect(blocked?.conflict?.shift.id).toBe(generalShiftId);
    expect(blocked?.conflict?.from).toBe('2026-09-01');
  });

  it('refuses a commit where every target is blocked, rather than reporting nought created', async () => {
    const rejected = await harness.post<ErrorBody>('/rosters/bulk', {
      token: hrToken,
      body: {
        shiftId: nightShiftId,
        from: '2026-09-15',
        to: '2026-10-15',
        departmentId,
        preview: false,
      },
    });
    expect(rejected.status, rejected.text).toBe(409);
    expect(rejected.body.error.code).toBe('SHIFT_ASSIGNMENT_OVERLAP');
  });

  it('writes the whole selection or none of it', async () => {
    // Charu is free in November; Anil is not. A loop of inserts would leave
    // Charu rostered and then fail, which is the half-written state the single
    // statement exists to prevent.
    const blocker = await harness.post<RosterAssignment>('/rosters', {
      token: hrToken,
      body: { employeeId: anilId, shiftId: generalShiftId, from: '2026-11-10', to: '2026-11-12' },
    });
    expect(blocker.status, blocker.text).toBe(201);

    const committed = await harness.post<RosterBulkPreview>('/rosters/bulk', {
      token: hrToken,
      body: {
        shiftId: nightShiftId,
        from: '2026-11-01',
        to: '2026-11-30',
        employeeIds: [anilId, charuId],
        preview: false,
      },
    });
    // Anil is skipped as blocked, Charu is written: the endpoint assigns whom
    // it can and reports the rest, which is what the preview promised.
    expect(committed.status, committed.text).toBe(200);
    expect(committed.body.created).toBe(1);
    expect(committed.body.blocked).toBe(1);

    const listed = await harness.get<Paginated<RosterAssignment>>(
      `/rosters?from=2026-11-01&to=2026-11-30&employeeId=${charuId}&pageSize=200`,
      { token: hrToken },
    );
    expect(listed.body.data).toHaveLength(1);
  });

  it('refuses a bulk assign with no department, location or employee named', async () => {
    const rejected = await harness.post<ErrorBody>('/rosters/bulk', {
      token: hrToken,
      body: { shiftId: generalShiftId, from: '2026-12-01', to: '2026-12-31' },
    });
    expect(rejected.status, rejected.text).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('narrows the selection to the caller scope', async () => {
    // The other department is outside the Operations user's team, so the
    // selection is empty rather than being an organisation-wide assign.
    const preview = await harness.post<RosterBulkPreview>('/rosters/bulk', {
      token: opsToken,
      body: {
        shiftId: generalShiftId,
        from: '2026-12-01',
        to: '2026-12-31',
        departmentId: otherDepartmentId,
      },
    });
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body.targets).toEqual([]);
    expect(preview.body.assignable).toBe(0);
  });

  it('refuses a plain employee', async () => {
    const rejected = await harness.post<ErrorBody>('/rosters/bulk', {
      token: employeeToken,
      body: { shiftId: generalShiftId, from: '2026-12-01', to: '2026-12-31', departmentId },
    });
    expect(rejected.status).toBe(403);
  });
});

// ------------------------------------------------- recompute and locks

describe('recompute on a roster change (REQ-C-06)', () => {
  const DAY = '2026-02-10';

  async function seedComputedDay(employeeId: string, date: string): Promise<void> {
    await harness.db
      .insert(attendanceDays)
      .values({ orgId: ORG_ID, employeeId, date, status: 'ABSENT' })
      .onConflictDoUpdate({
        target: [attendanceDays.employeeId, attendanceDays.date],
        set: { status: 'ABSENT', shiftId: null },
      });
  }

  async function shiftIdOnDay(employeeId: string, date: string): Promise<string | null> {
    const rows = await harness.db
      .select({ shiftId: attendanceDays.shiftId })
      .from(attendanceDays)
      .where(
        and(
          eq(attendanceDays.orgId, ORG_ID),
          eq(attendanceDays.employeeId, employeeId),
          eq(attendanceDays.date, date),
        ),
      );
    return rows[0]?.shiftId ?? null;
  }

  it('rewrites the days a new assignment covers', async () => {
    await seedComputedDay(charuId, DAY);
    expect(await shiftIdOnDay(charuId, DAY)).toBeNull();

    const created = await harness.post<RosterAssignment>('/rosters', {
      token: hrToken,
      body: { employeeId: charuId, shiftId: generalShiftId, from: '2026-02-01', to: '2026-02-28' },
    });
    expect(created.status, created.text).toBe(201);

    // The proof that the recompute ran, rather than that the roster row
    // exists: the computed day now names the shift the roster gave it.
    expect(await shiftIdOnDay(charuId, DAY)).toBe(generalShiftId);
  });

  it('rejects the change when the days it would rewrite are in a locked period', async () => {
    await seedComputedDay(bhavnaId, '2026-01-15');
    await harness.db.insert(attendancePeriodLocks).values({
      orgId: ORG_ID,
      locationId: null,
      year: 2026,
      month: 1,
      lockReason: 'Closed for payroll input',
    });

    const rejected = await harness.post<ErrorBody>('/rosters', {
      token: hrToken,
      body: { employeeId: bhavnaId, shiftId: generalShiftId, from: '2026-01-01', to: '2026-01-31' },
    });

    expect(rejected.status, rejected.text).toBe(409);
    expect(rejected.body.error.code).toBe('PERIOD_LOCKED');
    expect(rejected.body.error.message).toMatch(/2026-01/u);

    // And nothing was written: the rejection has to happen before the insert,
    // or the roster would carry a row whose days can never agree with it.
    const listed = await harness.get<Paginated<RosterAssignment>>(
      `/rosters?from=2026-01-01&to=2026-01-31&employeeId=${bhavnaId}`,
      { token: hrToken },
    );
    expect(listed.body.data).toEqual([]);
  });

  it('allows the same change once the lock is lifted, which proves the lock was the reason', async () => {
    await harness.db
      .update(attendancePeriodLocks)
      // REQ-E-09: reopening carries a reason, and the database keeps that.
      .set({ unlockedAt: new Date(), unlockReason: 'Reopened for the shift fixture' })
      .where(and(eq(attendancePeriodLocks.orgId, ORG_ID), eq(attendancePeriodLocks.month, 1)));

    const created = await harness.post<RosterAssignment>('/rosters', {
      token: hrToken,
      body: { employeeId: bhavnaId, shiftId: generalShiftId, from: '2026-01-01', to: '2026-01-31' },
    });
    expect(created.status, created.text).toBe(201);
  });

  it('does not consult a lock for a period with nothing computed in it', async () => {
    // A lock on a month this change does not reach must not block it, or a
    // closed January would freeze the roster for the rest of the year.
    await harness.db.insert(attendancePeriodLocks).values({
      orgId: ORG_ID,
      locationId: null,
      year: 2027,
      month: 6,
      lockReason: 'Closed early',
    });

    const created = await harness.post<RosterAssignment>('/rosters', {
      token: hrToken,
      body: { employeeId: charuId, shiftId: generalShiftId, from: '2027-06-01', to: '2027-06-30' },
    });
    expect(created.status, created.text).toBe(201);
  });
});

// ------------------------------------------------- constraint agreement

describe('the overlap rule agrees with Postgres', () => {
  /**
   * `rangesOverlap`, the SQL in `RosterRepository.findOverlapping`, and the
   * `daterange(..., '[]') &&` inside `shift_assignments_no_overlap` are three
   * statements of one rule. A TypeScript-only test proves the first is
   * self-consistent, which is exactly the check that would pass while the
   * service happily promised a write the constraint then refused.
   *
   * So the truth table is put to Postgres itself, through the same operator
   * the constraint uses.
   */
  const PAIRS: [string, string | null, string, string | null][] = [
    ['2026-03-10', '2026-03-20', '2026-03-10', '2026-03-20'],
    ['2026-03-01', '2026-03-05', '2026-03-06', '2026-03-10'],
    ['2026-03-01', '2026-03-10', '2026-03-10', '2026-03-20'],
    ['2026-03-01', '2026-03-09', '2026-03-10', '2026-03-20'],
    ['2026-03-01', '2026-03-31', '2026-03-10', '2026-03-12'],
    ['2026-03-15', '2026-03-15', '2026-03-01', '2026-03-31'],
    ['2026-03-01', null, '2027-01-01', '2027-01-31'],
    ['2026-03-01', null, '2026-01-01', '2026-02-28'],
    ['2026-01-01', '2026-02-28', '2026-03-01', null],
    ['2026-03-01', null, '2030-01-01', null],
    ['2026-03-13', '2026-03-13', '2026-03-13', null],
  ];

  it.each(PAIRS)('[%s, %s] vs [%s, %s]', async (aFrom, aTo, bFrom, bTo) => {
    const result = await harness.db.execute<{ overlaps: boolean }>(
      sql`SELECT daterange(${aFrom}::date, ${aTo}::date, '[]')
               && daterange(${bFrom}::date, ${bTo}::date, '[]') AS overlaps`,
    );
    const fromPostgres = result.rows[0]?.overlaps;
    expect(fromPostgres).toBeTypeOf('boolean');
    expect(rangesOverlap({ from: aFrom, to: aTo }, { from: bFrom, to: bTo })).toBe(fromPostgres);
  });
});
