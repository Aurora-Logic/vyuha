import {
  SYSTEM_ROLES,
  type EmployeeDetail,
  type EmployeeListItem,
  type Paginated,
} from '@vyuha/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { employees } from '../db/schema/index.js';
import type { EmployeeDetailView } from './employee.repository.js';

/**
 * The employee endpoints (REQ-A-03 … REQ-A-07) over real HTTP against the real
 * application, guard and audit interceptor included.
 *
 * The fixture is a five-level tree, because the two things most worth proving
 * here -- the team data scope and the reporting-cycle check -- both walk a
 * chain. A two-level tree cannot tell a correct recursive implementation from
 * one that looks at direct reports and stops.
 *
 *   Anita                                  (HR/Admin sees all of this)
 *     +- Bharat
 *          +- Farhan            <- the Operations account is bound to Farhan
 *               +- Lalit
 *                    +- Varun   <- two levels below Farhan, still their team
 *     +- Chandni                <- outside Farhan's team entirely
 *   Gita                        <- no relation to anybody
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000c1';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let hrToken: string;
let opsToken: string;
let employeeToken: string;

const people: Record<string, string> = {};
let engineeringId = '';
let salesId = '';
let managerDesignationId = '';
let headOfficeId = '';

function codesOf(page: Paginated<EmployeeListItem>): string[] {
  return page.data.map((row) => row.employeeCode);
}

async function listAs(token: string, query = ''): Promise<Paginated<EmployeeListItem>> {
  const result = await harness.get<Paginated<EmployeeListItem>>(`/employees${query}`, { token });
  expect(result.status, result.text).toBe(200);
  return result.body;
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Employee Endpoints Fixture Org');

  const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR);
  const operationsRoleId = await harness.createSystemRole(SYSTEM_ROLES.OPERATIONS);
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);

  engineeringId = await harness.createDepartment({ code: 'EN-ENG', name: 'Engineering' });
  salesId = await harness.createDepartment({ code: 'EN-SALES', name: 'Sales' });
  managerDesignationId = await harness.createDesignation({
    code: 'EN-MGR',
    name: 'Manager',
    grade: 'G3',
  });
  headOfficeId = await harness.createLocation({ code: 'EN-HO', name: 'Head Office' });

  people.anita = await harness.createEmployee({
    code: 'EN-0001',
    firstName: 'Anita',
    lastName: 'Rao',
    departmentId: engineeringId,
    designationId: managerDesignationId,
    locationId: headOfficeId,
  });
  people.bharat = await harness.createEmployee({
    code: 'EN-0002',
    firstName: 'Bharat',
    lastName: 'Menon',
    reportingManagerId: people.anita,
    departmentId: engineeringId,
    locationId: headOfficeId,
  });
  people.farhan = await harness.createEmployee({
    code: 'EN-0003',
    firstName: 'Farhan',
    lastName: 'Qureshi',
    reportingManagerId: people.bharat,
    departmentId: engineeringId,
    locationId: headOfficeId,
  });
  people.lalit = await harness.createEmployee({
    code: 'EN-0004',
    firstName: 'Lalit',
    lastName: 'Chauhan',
    reportingManagerId: people.farhan,
    departmentId: engineeringId,
  });
  people.varun = await harness.createEmployee({
    code: 'EN-0005',
    firstName: 'Varun',
    lastName: 'Tiwari',
    reportingManagerId: people.lalit,
    departmentId: engineeringId,
    status: 'ON_NOTICE',
    dateOfLeaving: '2026-12-31',
  });
  people.chandni = await harness.createEmployee({
    code: 'EN-0006',
    firstName: 'Chandni',
    lastName: 'Iyer',
    reportingManagerId: people.anita,
    departmentId: salesId,
  });
  people.gita = await harness.createEmployee({
    code: 'EN-0007',
    firstName: 'Gita',
    lastName: 'Shenoy',
    departmentId: salesId,
    status: 'INACTIVE',
    dateOfLeaving: '2026-02-28',
  });

  const hrUser = await harness.createUser({
    email: scopedEmail('employees-hr'),
    roleIds: [hrRoleId],
    employeeId: people.anita,
  });
  const opsUser = await harness.createUser({
    email: scopedEmail('employees-ops'),
    roleIds: [operationsRoleId],
    employeeId: people.farhan,
  });
  const plainUser = await harness.createUser({
    email: scopedEmail('employees-plain'),
    roleIds: [employeeRoleId],
    employeeId: people.gita,
  });

  hrToken = (await harness.login(hrUser.email, hrUser.password)).token;
  opsToken = (await harness.login(opsUser.email, opsUser.password)).token;
  employeeToken = (await harness.login(plainUser.email, plainUser.password)).token;
  expect([hrToken, opsToken, employeeToken].every((token) => token !== '')).toBe(true);
}, 30_000);

afterAll(async () => {
  await harness.close();
});

describe('GET /employees', () => {
  it('returns the §6 envelope with resolved names, not bare foreign keys', async () => {
    const page = await listAs(hrToken, '?q=EN-0001');

    expect(page.meta).toEqual({ page: 1, pageSize: 50, total: 1 });
    const anita = page.data[0];
    expect(anita).toBeDefined();
    expect(anita?.department).toEqual({ id: engineeringId, name: 'Engineering' });
    expect(anita?.designation).toEqual({ id: managerDesignationId, name: 'Manager' });
    expect(anita?.location).toEqual({ id: headOfficeId, name: 'Head Office' });
    expect(anita?.reportingManager).toBeNull();
  });

  it('composes the reporting manager name from both parts', async () => {
    const page = await listAs(hrToken, '?q=EN-0002');
    expect(page.data[0]?.reportingManager).toEqual({ id: people.anita, name: 'Anita Rao' });
  });

  it('paginates without dropping or repeating a row', async () => {
    const all = await listAs(hrToken, '?pageSize=100');
    expect(all.meta.total).toBe(7);

    const first = await listAs(hrToken, '?pageSize=3&page=1');
    const second = await listAs(hrToken, '?pageSize=3&page=2');
    const third = await listAs(hrToken, '?pageSize=3&page=3');

    // The union has to be the whole set with nothing seen twice. Without a
    // deterministic tiebreak in the ORDER BY, Postgres is free to return the
    // same row on two pages and skip another, which no single-page assertion
    // would notice.
    const seen = [...codesOf(first), ...codesOf(second), ...codesOf(third)];
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(second.meta).toEqual({ page: 2, pageSize: 3, total: 7 });
  });

  it('filters by department, location and status', async () => {
    expect(codesOf(await listAs(hrToken, `?departmentId=${salesId}&pageSize=100`)).sort()).toEqual([
      'EN-0006',
      'EN-0007',
    ]);
    expect(codesOf(await listAs(hrToken, `?locationId=${headOfficeId}&pageSize=100`)).sort()).toEqual([
      'EN-0001',
      'EN-0002',
      'EN-0003',
    ]);
    expect(codesOf(await listAs(hrToken, '?status=ON_NOTICE'))).toEqual(['EN-0005']);
    expect(codesOf(await listAs(hrToken, '?status=INACTIVE'))).toEqual(['EN-0007']);
  });

  it('searches over code, either name part, and the two joined', async () => {
    expect(codesOf(await listAs(hrToken, '?q=EN-000'))).toHaveLength(7);
    expect(codesOf(await listAs(hrToken, '?q=qureshi'))).toEqual(['EN-0003']);
    expect(codesOf(await listAs(hrToken, '?q=anita%20rao'))).toEqual(['EN-0001']);
  });

  it('treats a LIKE wildcard as text rather than as a pattern', async () => {
    // An unescaped `%` would match every employee, and a filter that silently
    // stops filtering looks exactly like a filter that works.
    expect(await listAs(hrToken, '?q=%25').then((page) => page.meta.total)).toBe(0);
    expect(await listAs(hrToken, '?q=_').then((page) => page.meta.total)).toBe(0);
  });

  it('sorts on a whitelisted field and ignores one that is not', async () => {
    const descending = await listAs(hrToken, '?sort=-employeeCode&pageSize=100');
    expect(codesOf(descending)[0]).toBe('EN-0007');

    // An unknown field falls back to the default rather than reaching SQL.
    const injected = await listAs(hrToken, '?sort=' + encodeURIComponent('password_hash'));
    expect(codesOf(injected)[0]).toBe('EN-0001');
  });

  it('excludes a soft-deleted employee', async () => {
    await harness.db
      .update(employees)
      .set({ deletedAt: new Date() })
      .where(eq(employees.id, people.gita ?? ''));

    const page = await listAs(hrToken, '?pageSize=100');
    expect(page.meta.total).toBe(6);
    expect(codesOf(page)).not.toContain('EN-0007');

    await harness.db
      .update(employees)
      .set({ deletedAt: null })
      .where(eq(employees.id, people.gita ?? ''));
  });
});

describe('scope (PRD §2.1)', () => {
  it('gives an Operations account its own chain and nothing else', async () => {
    const page = await listAs(opsToken, '?pageSize=100');

    // Farhan plus everyone below him, two levels deep. Not Bharat above him,
    // not Chandni beside him, not the unrelated Gita.
    expect(codesOf(page).sort()).toEqual(['EN-0003', 'EN-0004', 'EN-0005']);
    expect(page.meta.total).toBe(3);
  });

  it('cannot be widened by a filter', async () => {
    // The scope predicate and the filter predicate are ANDed. If a filter were
    // ever able to replace the scope instead, this would return both Sales
    // employees, neither of whom is on Farhan's team.
    const page = await listAs(opsToken, `?departmentId=${salesId}&pageSize=100`);
    expect(page.data).toEqual([]);
    expect(page.meta.total).toBe(0);
  });

  it('answers 404, not 403, for an employee outside the team', async () => {
    const inside = await harness.get(`/employees/${people.lalit ?? ''}`, { token: opsToken });
    expect(inside.status).toBe(200);

    const outside = await harness.get<ErrorBody>(`/employees/${people.chandni ?? ''}`, {
      token: opsToken,
    });
    // A 403 would confirm the id names a real employee, which is precisely
    // what someone walking ids is trying to find out.
    expect(outside.status).toBe(404);
    expect(outside.body.error.code).toBe('NOT_FOUND');
  });

  it('refuses an Operations write with 403 and writes nothing', async () => {
    const patched = await harness.patch<ErrorBody>(`/employees/${people.lalit ?? ''}`, {
      token: opsToken,
      body: { firstName: 'Renamed' },
    });
    expect(patched.status).toBe(403);
    expect(patched.body.error.code).toBe('FORBIDDEN');

    const created = await harness.post<ErrorBody>('/employees', {
      token: opsToken,
      body: { employeeCode: 'EN-9999', firstName: 'Sneaky', dateOfJoining: '2026-01-01' },
    });
    expect(created.status).toBe(403);

    const still = await listAs(hrToken, '?pageSize=100');
    expect(codesOf(still)).not.toContain('EN-9999');
    expect(still.data.find((row) => row.employeeCode === 'EN-0004')?.firstName).toBe('Lalit');
  });

  it('refuses an account holding neither key', async () => {
    const listed = await harness.get<ErrorBody>('/employees', { token: employeeToken });
    expect(listed.status).toBe(403);
    expect(listed.body.error.details?.requiredAnyOf).toEqual(['employee.view']);
  });

  it('refuses an unauthenticated request', async () => {
    const anonymous = await harness.get<ErrorBody>('/employees');
    expect(anonymous.status).toBe(401);
  });
});

describe('POST /employees', () => {
  it('creates, returns the detail, and leaves an audit row', async () => {
    const created = await harness.post<EmployeeDetail>('/employees', {
      token: hrToken,
      body: {
        employeeCode: 'EN-0100',
        firstName: 'Nikhil',
        lastName: 'Barua',
        workEmail: 'Nikhil.Barua@Vyuha.Local',
        dateOfJoining: '2026-03-01',
        departmentId: engineeringId,
        designationId: managerDesignationId,
        locationId: headOfficeId,
        reportingManagerId: people.farhan,
        employmentType: 'CONTRACT',
      },
    });

    expect(created.status, created.text).toBe(201);
    expect(created.body.employeeCode).toBe('EN-0100');
    // Normalised by the shared schema, so two records cannot differ only in
    // the case of an address.
    expect(created.body.workEmail).toBe('nikhil.barua@vyuha.local');
    expect(created.body.reportingManager?.name).toBe('Farhan Qureshi');

    expect(await harness.waitForAuditEntity(created.body.id)).toBe(true);
    expect(await harness.waitForAuditAction('employee.created')).toBe(true);
  });

  it('refuses a duplicate employee code', async () => {
    const duplicate = await harness.post<ErrorBody>('/employees', {
      token: hrToken,
      body: { employeeCode: 'EN-0100', firstName: 'Copy', dateOfJoining: '2026-03-01' },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');
  });

  it('refuses a reference that does not exist in this organisation', async () => {
    const rejected = await harness.post<ErrorBody>('/employees', {
      token: hrToken,
      body: {
        employeeCode: 'EN-0101',
        firstName: 'Orphan',
        dateOfJoining: '2026-03-01',
        // A real row, but a designation rather than a department.
        departmentId: managerDesignationId,
      },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a deactivation with no last working date (REQ-A-05)', async () => {
    const rejected = await harness.post<ErrorBody>('/employees', {
      token: hrToken,
      body: {
        employeeCode: 'EN-0102',
        firstName: 'Ghost',
        dateOfJoining: '2026-03-01',
        status: 'INACTIVE',
      },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toContain('last working date');
  });
});

describe('PATCH /employees/:id', () => {
  let subjectId = '';

  beforeAll(async () => {
    subjectId = await harness.createEmployee({
      code: 'EN-0200',
      firstName: 'Pooja',
      lastName: 'Grewal',
      departmentId: engineeringId,
    });
  });

  it('refuses to change the employee code (REQ-A-04)', async () => {
    const rejected = await harness.patch<ErrorBody>(`/employees/${subjectId}`, {
      token: hrToken,
      body: { employeeCode: 'EN-0299' },
    });

    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('EMPLOYEE_CODE_IMMUTABLE');

    // The refusal has to be real, not cosmetic: the point of the requirement
    // is that the stored code did not move.
    const after = await listAs(hrToken, '?q=EN-0299');
    expect(after.meta.total).toBe(0);
  });

  it('accepts the code it already has, so a full-object PATCH still works', async () => {
    const accepted = await harness.patch<EmployeeDetail>(`/employees/${subjectId}`, {
      token: hrToken,
      body: { employeeCode: 'EN-0200', mobile: '+91 90000 0200' },
    });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body.mobile).toBe('+91 90000 0200');
    expect(await harness.waitForAuditAction('employee.updated')).toBe(true);
  });

  it('refuses a self-reference (REQ-A-07)', async () => {
    const rejected = await harness.patch<ErrorBody>(`/employees/${subjectId}`, {
      token: hrToken,
      body: { reportingManagerId: subjectId },
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('REPORTING_CYCLE');
  });

  it('refuses a cycle several levels up the chain (REQ-A-07)', async () => {
    // Anita -> Bharat -> Farhan -> Lalit -> Varun. Pointing Anita at Varun
    // closes a four-hop loop, which a direct-reports check would miss.
    const rejected = await harness.patch<ErrorBody>(`/employees/${people.anita ?? ''}`, {
      token: hrToken,
      body: { reportingManagerId: people.varun },
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('REPORTING_CYCLE');
  });

  it('still allows a legitimate reorganisation', async () => {
    // The control for the two tests above: a validator that answered
    // REPORTING_CYCLE to everything would pass both of them.
    const moved = await harness.patch<EmployeeDetail>(`/employees/${people.chandni ?? ''}`, {
      token: hrToken,
      body: { reportingManagerId: people.farhan },
    });
    expect(moved.status, moved.text).toBe(200);
    expect(moved.body.reportingManager?.id).toBe(people.farhan);

    const restored = await harness.patch<EmployeeDetail>(`/employees/${people.chandni ?? ''}`, {
      token: hrToken,
      body: { reportingManagerId: people.anita },
    });
    expect(restored.status).toBe(200);
  });

  it('walks the lifecycle: on notice, deactivated, reactivated (REQ-A-05)', async () => {
    const onNotice = await harness.patch<EmployeeDetail>(`/employees/${subjectId}`, {
      token: hrToken,
      body: { status: 'ON_NOTICE', dateOfLeaving: '2026-11-30' },
    });
    expect(onNotice.status, onNotice.text).toBe(200);
    expect(onNotice.body.status).toBe('ON_NOTICE');

    const deactivated = await harness.patch<EmployeeDetail>(`/employees/${subjectId}`, {
      token: hrToken,
      body: { status: 'INACTIVE' },
    });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.dateOfLeaving).toBe('2026-11-30');

    // Reactivating has to clear the date explicitly. Leaving it in place would
    // keep the punch block from REQ-A-05 in force on a record that says active.
    const halfReactivated = await harness.patch<ErrorBody>(`/employees/${subjectId}`, {
      token: hrToken,
      body: { status: 'ACTIVE' },
    });
    expect(halfReactivated.status).toBe(400);

    const reactivated = await harness.patch<EmployeeDetail>(`/employees/${subjectId}`, {
      token: hrToken,
      body: { status: 'ACTIVE', dateOfLeaving: null },
    });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.dateOfLeaving).toBeNull();
  });

  describe('the holiday calendar override (OS-3, REQ-H-02)', () => {
    let calendarId = '';

    beforeAll(async () => {
      // Raw SQL rather than the drizzle table: holiday_calendars belongs to
      // modules/attendance, which platform files -- this one included -- must
      // not import (technical design §1).
      const created = await harness.db.execute<{ id: string }>(sql`
        INSERT INTO holiday_calendars (org_id, name, year)
        VALUES (${ORG_ID}, 'Employee Fixture 2026', 2026)
        RETURNING id
      `);
      calendarId = created.rows[0]?.id ?? '';
      expect(calendarId).not.toBe('');
    });

    it('attaches a calendar of this organisation, returns it, and clears it with null', async () => {
      const patched = await harness.patch<EmployeeDetailView>(`/employees/${subjectId}`, {
        token: hrToken,
        body: { holidayCalendarId: calendarId },
      });

      expect(patched.status, patched.text).toBe(200);
      expect(patched.body.holidayCalendarId).toBe(calendarId);

      // The form reads the detail back before it edits, so the GET has to
      // carry the link too -- an echo on PATCH alone would let the next edit
      // silently clear it.
      const read = await harness.get<EmployeeDetailView>(`/employees/${subjectId}`, {
        token: hrToken,
      });
      expect(read.status).toBe(200);
      expect(read.body.holidayCalendarId).toBe(calendarId);

      // Absent means unchanged: a PATCH that names other fields must not
      // quietly detach the calendar.
      const unrelated = await harness.patch<EmployeeDetailView>(`/employees/${subjectId}`, {
        token: hrToken,
        body: { mobile: '+91 90000 0201' },
      });
      expect(unrelated.status, unrelated.text).toBe(200);
      expect(unrelated.body.holidayCalendarId).toBe(calendarId);

      const cleared = await harness.patch<EmployeeDetailView>(`/employees/${subjectId}`, {
        token: hrToken,
        body: { holidayCalendarId: null },
      });
      expect(cleared.status, cleared.text).toBe(200);
      expect(cleared.body.holidayCalendarId).toBeNull();
    });

    it('refuses an id that names no calendar in this organisation', async () => {
      const rejected = await harness.patch<ErrorBody>(`/employees/${subjectId}`, {
        token: hrToken,
        body: { holidayCalendarId: '01900000-0000-7000-8000-00000000dead' },
      });

      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  it('retains the record rather than deleting it (REQ-M-04)', async () => {
    const rows = await harness.db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.id, subjectId));
    expect(rows).toHaveLength(1);
  });

  it('answers 400 for a malformed id instead of failing inside the driver', async () => {
    const malformed = await harness.get<ErrorBody>('/employees/not-a-uuid', { token: hrToken });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_FAILED');
  });
});
