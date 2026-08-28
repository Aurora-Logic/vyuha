import {
  SYSTEM_ROLES,
  type DepartmentSummary,
  type DesignationSummary,
  type LocationSummary,
  type Paginated,
} from '@vyuha/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { locations } from '../db/schema/index.js';
import type { LocationView } from './location.service.js';

/**
 * Departments, designations and locations (REQ-A-01, REQ-A-02) over real HTTP.
 *
 * The permission split these tests assert is the one recorded in
 * docs/OPEN-QUESTIONS P1-1, because PRD §2.1 names no key for these three:
 * `employee.view` reads, `employee.manage` writes departments and
 * designations, and `settings.manage` writes locations. HR getting 403 on a
 * location is the deliberate part -- a location row decides from where a punch
 * is accepted.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000c2';
/**
 * A second organisation whose holiday calendar the location tests try -- and
 * fail -- to attach (OS-3). Never reset by a harness, so it only ever holds
 * the one calendar row.
 */
const FOREIGN_CALENDAR_ORG_ID = '01900000-0000-7000-8000-0000000000c7';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let adminToken: string;
let hrToken: string;
let opsToken: string;
let employeeToken: string;
let headEmployeeId = '';

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Org Masters Fixture Org');

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN);
  const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR);
  const operationsRoleId = await harness.createSystemRole(SYSTEM_ROLES.OPERATIONS);
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);

  headEmployeeId = await harness.createEmployee({
    code: 'OM-0001',
    firstName: 'Anita',
    lastName: 'Rao',
  });

  const admin = await harness.createUser({
    email: scopedEmail('org-admin'),
    roleIds: [adminRoleId],
  });
  const hr = await harness.createUser({ email: scopedEmail('org-hr'), roleIds: [hrRoleId] });
  const ops = await harness.createUser({
    email: scopedEmail('org-ops'),
    roleIds: [operationsRoleId],
    employeeId: headEmployeeId,
  });
  const plain = await harness.createUser({
    email: scopedEmail('org-plain'),
    roleIds: [employeeRoleId],
  });

  adminToken = (await harness.login(admin.email, admin.password)).token;
  hrToken = (await harness.login(hr.email, hr.password)).token;
  opsToken = (await harness.login(ops.email, ops.password)).token;
  employeeToken = (await harness.login(plain.email, plain.password)).token;
  expect([adminToken, hrToken, opsToken, employeeToken].every((t) => t !== '')).toBe(true);
}, 30_000);

afterAll(async () => {
  await harness.close();
});

describe('departments (REQ-A-02)', () => {
  let operationsId = '';
  let fieldId = '';

  it('creates one, resolving the head to a name', async () => {
    const created = await harness.post<DepartmentSummary>('/departments', {
      token: hrToken,
      body: { name: 'Operations', code: 'OM-OPS', headEmployeeId },
    });

    expect(created.status, created.text).toBe(201);
    expect(created.body.head).toEqual({ id: headEmployeeId, name: 'Anita Rao' });
    expect(created.body.parent).toBeNull();
    operationsId = created.body.id;

    expect(await harness.waitForAuditAction('department.created')).toBe(true);
  });

  it('nests a child under it', async () => {
    const created = await harness.post<DepartmentSummary>('/departments', {
      token: hrToken,
      body: { name: 'Field Operations', code: 'OM-FIELD', parentId: operationsId },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.parent).toEqual({ id: operationsId, name: 'Operations' });
    fieldId = created.body.id;
  });

  it('refuses a duplicate code', async () => {
    const duplicate = await harness.post<ErrorBody>('/departments', {
      token: hrToken,
      body: { name: 'Operations Again', code: 'OM-OPS' },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');
  });

  it('refuses a head who is not an employee of this organisation', async () => {
    const rejected = await harness.post<ErrorBody>('/departments', {
      token: hrToken,
      body: { name: 'Ghost', code: 'OM-GHOST', headEmployeeId: operationsId },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a parent cycle, direct and indirect', async () => {
    const self = await harness.patch<ErrorBody>(`/departments/${operationsId}`, {
      token: hrToken,
      body: { parentId: operationsId },
    });
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe('REPORTING_CYCLE');

    // Operations -> Field Operations -> Operations.
    const indirect = await harness.patch<ErrorBody>(`/departments/${operationsId}`, {
      token: hrToken,
      body: { parentId: fieldId },
    });
    expect(indirect.status).toBe(422);
    expect(indirect.body.error.code).toBe('REPORTING_CYCLE');
  });

  it('still allows a legitimate reparent', async () => {
    // The control: a check that refused every parent would pass the two cases
    // above and be useless.
    const other = await harness.post<DepartmentSummary>('/departments', {
      token: hrToken,
      body: { name: 'Support', code: 'OM-SUP' },
    });
    expect(other.status).toBe(201);

    const moved = await harness.patch<DepartmentSummary>(`/departments/${other.body.id}`, {
      token: hrToken,
      body: { parentId: fieldId },
    });
    expect(moved.status, moved.text).toBe(200);
    expect(moved.body.parent?.id).toBe(fieldId);
  });

  it('lists with the §6 envelope, and searches by name or code', async () => {
    const all = await harness.get<Paginated<DepartmentSummary>>('/departments?pageSize=100', {
      token: opsToken,
    });
    expect(all.status).toBe(200);
    expect(all.body.meta.pageSize).toBe(100);
    expect(all.body.meta.total).toBe(3);

    const searched = await harness.get<Paginated<DepartmentSummary>>('/departments?q=field', {
      token: opsToken,
    });
    expect(searched.body.data.map((row) => row.code)).toEqual(['OM-FIELD']);

    const wildcard = await harness.get<Paginated<DepartmentSummary>>('/departments?q=%25', {
      token: opsToken,
    });
    expect(wildcard.body.meta.total).toBe(0);
  });

  it('refuses a write from Operations and a read from a plain employee', async () => {
    const written = await harness.post<ErrorBody>('/departments', {
      token: opsToken,
      body: { name: 'Sneaky', code: 'OM-SNEAK' },
    });
    expect(written.status).toBe(403);

    const read = await harness.get<ErrorBody>('/departments', { token: employeeToken });
    expect(read.status).toBe(403);
    expect(read.body.error.details?.requiredAnyOf).toEqual(['employee.view']);
  });
});

describe('designations (REQ-A-02)', () => {
  let managerId = '';

  it('creates, lists and edits', async () => {
    const created = await harness.post<DesignationSummary>('/designations', {
      token: hrToken,
      body: { name: 'Manager', code: 'OM-MGR', grade: 'G3' },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.grade).toBe('G3');
    managerId = created.body.id;

    const listed = await harness.get<Paginated<DesignationSummary>>('/designations', {
      token: opsToken,
    });
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((row) => row.code)).toEqual(['OM-MGR']);

    const patched = await harness.patch<DesignationSummary>(`/designations/${managerId}`, {
      token: hrToken,
      body: { grade: 'G2' },
    });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.body.grade).toBe('G2');
    expect(patched.body.name).toBe('Manager');

    expect(await harness.waitForAuditAction('designation.updated')).toBe(true);
  });

  it('refuses a code already used by another designation', async () => {
    const other = await harness.post<DesignationSummary>('/designations', {
      token: hrToken,
      body: { name: 'Executive', code: 'OM-EXEC' },
    });
    expect(other.status).toBe(201);

    const clash = await harness.patch<ErrorBody>(`/designations/${other.body.id}`, {
      token: hrToken,
      body: { code: 'OM-MGR' },
    });
    expect(clash.status).toBe(409);
  });

  it('accepts a PATCH that resends the code it already has', async () => {
    const same = await harness.patch<DesignationSummary>(`/designations/${managerId}`, {
      token: hrToken,
      body: { code: 'OM-MGR', name: 'Manager II' },
    });
    expect(same.status, same.text).toBe(200);
    expect(same.body.name).toBe('Manager II');
  });

  it('refuses a write from Operations', async () => {
    const written = await harness.post<ErrorBody>('/designations', {
      token: opsToken,
      body: { name: 'Sneaky', code: 'OM-SNEAK2' },
    });
    expect(written.status).toBe(403);
  });
});

describe('locations (REQ-A-01)', () => {
  let headOfficeId = '';

  it('creates one with no geofence and no allowlist', async () => {
    const created = await harness.post<LocationSummary>('/locations', {
      token: adminToken,
      body: { name: 'Head Office', code: 'OM-HO' },
    });

    expect(created.status, created.text).toBe(201);
    headOfficeId = created.body.id;

    // OPEN-QUESTIONS items 1 and 3. A default centre would make geofenced
    // punch look configured while pointing somewhere nobody works, and a
    // populated allowlist would admit punches from wherever the guess pointed.
    expect(created.body.geofenceLat).toBeNull();
    expect(created.body.geofenceLng).toBeNull();
    expect(created.body.ipAllowlist).toEqual([]);
    expect(created.body.geofenceRadiusM).toBe(100);
  });

  it('accepts a whole geofence and a valid allowlist', async () => {
    const patched = await harness.patch<LocationSummary>(`/locations/${headOfficeId}`, {
      token: adminToken,
      body: {
        geofenceLat: 19.076,
        geofenceLng: 72.8777,
        geofenceRadiusM: 150,
        ipAllowlist: ['203.0.113.7', '198.51.100.0/24'],
      },
    });

    expect(patched.status, patched.text).toBe(200);
    expect(patched.body.geofenceRadiusM).toBe(150);
    expect(patched.body.ipAllowlist).toEqual(['203.0.113.7', '198.51.100.0/24']);

    // Put it back: the fixture's contract is that nothing here ships with a
    // guessed centre.
    const cleared = await harness.patch<LocationSummary>(`/locations/${headOfficeId}`, {
      token: adminToken,
      body: { geofenceLat: null, geofenceLng: null, ipAllowlist: [] },
    });
    expect(cleared.body.geofenceLat).toBeNull();
  });

  it('refuses half a geofence centre', async () => {
    const rejected = await harness.patch<ErrorBody>(`/locations/${headOfficeId}`, {
      token: adminToken,
      body: { geofenceLat: 19.076 },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toContain('latitude and a longitude');
  });

  it('refuses an allowlist entry that is not an address or a block', async () => {
    const rejected = await harness.patch<ErrorBody>(`/locations/${headOfficeId}`, {
      token: adminToken,
      body: { ipAllowlist: ['not-an-ip'] },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a timezone the platform does not know', async () => {
    const rejected = await harness.patch<ErrorBody>(`/locations/${headOfficeId}`, {
      token: adminToken,
      body: { timezone: 'Asia/Nowhere' },
    });
    expect(rejected.status).toBe(400);
  });

  describe('the holiday calendar link (OS-3, REQ-H-02)', () => {
    let calendarId = '';

    beforeAll(async () => {
      // Raw SQL rather than the drizzle table: holiday_calendars belongs to
      // modules/attendance, which platform files -- this one included -- must
      // not import (technical design §1).
      const created = await harness.db.execute<{ id: string }>(sql`
        INSERT INTO holiday_calendars (org_id, name, year)
        VALUES (${ORG_ID}, 'Maharashtra 2026', 2026)
        RETURNING id
      `);
      calendarId = created.rows[0]?.id ?? '';
      expect(calendarId).not.toBe('');
    });

    it('attaches a calendar of this organisation, and clears it with null', async () => {
      const patched = await harness.patch<LocationView>(`/locations/${headOfficeId}`, {
        token: adminToken,
        body: { holidayCalendarId: calendarId },
      });

      expect(patched.status, patched.text).toBe(200);
      expect(patched.body.holidayCalendarId).toBe(calendarId);

      const listed = await harness.get<Paginated<LocationView>>('/locations', {
        token: adminToken,
      });
      expect(listed.body.data.find((row) => row.id === headOfficeId)?.holidayCalendarId).toBe(
        calendarId,
      );

      const cleared = await harness.patch<LocationView>(`/locations/${headOfficeId}`, {
        token: adminToken,
        body: { holidayCalendarId: null },
      });
      expect(cleared.status, cleared.text).toBe(200);
      expect(cleared.body.holidayCalendarId).toBeNull();
    });

    it('refuses an id that names no calendar', async () => {
      const rejected = await harness.patch<ErrorBody>(`/locations/${headOfficeId}`, {
        token: adminToken,
        body: { holidayCalendarId: '01900000-0000-7000-8000-00000000dead' },
      });

      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a calendar belonging to another organisation', async () => {
      await harness.db.execute(sql`
        INSERT INTO organizations (id, name)
        VALUES (${FOREIGN_CALENDAR_ORG_ID}, 'Org Masters Foreign Calendar Org')
        ON CONFLICT (id) DO NOTHING
      `);
      const foreign = await harness.db.execute<{ id: string }>(sql`
        INSERT INTO holiday_calendars (org_id, name, year)
        VALUES (${FOREIGN_CALENDAR_ORG_ID}, 'Foreign 2026', 2026)
        RETURNING id
      `);
      const foreignCalendarId = foreign.rows[0]?.id ?? '';
      expect(foreignCalendarId).not.toBe('');

      const rejected = await harness.patch<ErrorBody>(`/locations/${headOfficeId}`, {
        token: adminToken,
        body: { holidayCalendarId: foreignCalendarId },
      });

      // The same answer as a nonexistent id, on purpose: a different status
      // would confirm that the guessed id names a real calendar somewhere.
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe('VALIDATION_FAILED');

      const unchanged = await harness.get<Paginated<LocationView>>('/locations', {
        token: adminToken,
      });
      expect(unchanged.body.data.find((row) => row.id === headOfficeId)?.holidayCalendarId).toBeNull();
    });

    it('refuses a soft-deleted calendar; the foreign key alone would accept it', async () => {
      await harness.db.execute(sql`
        UPDATE holiday_calendars SET deleted_at = now() WHERE id = ${calendarId}
      `);

      const rejected = await harness.patch<ErrorBody>(`/locations/${headOfficeId}`, {
        token: adminToken,
        body: { holidayCalendarId: calendarId },
      });
      expect(rejected.status).toBe(400);

      await harness.db.execute(sql`
        UPDATE holiday_calendars SET deleted_at = NULL WHERE id = ${calendarId}
      `);
    });

    it('accepts a calendar on create as well', async () => {
      const created = await harness.post<LocationView>('/locations', {
        token: adminToken,
        body: { name: 'Warehouse', code: 'OM-WH', holidayCalendarId: calendarId },
      });

      expect(created.status, created.text).toBe(201);
      expect(created.body.holidayCalendarId).toBe(calendarId);

      // Removed so the earlier list assertions about this fixture's locations
      // stay true for the tests that follow.
      await harness.db
        .update(locations)
        .set({ deletedAt: new Date() })
        .where(eq(locations.id, created.body.id));
    });
  });

  it('lets HR read a location but not write one', async () => {
    const read = await harness.get<Paginated<LocationSummary>>('/locations', { token: hrToken });
    expect(read.status).toBe(200);
    // The harness puts placeless fixture employees at FIXTURE-HQ; it is not this test's.
    expect(read.body.data.map((row) => row.code).filter((code) => code !== 'FIXTURE-HQ')).toEqual(['OM-HO']);

    const written = await harness.patch<ErrorBody>(`/locations/${headOfficeId}`, {
      token: hrToken,
      body: { name: 'Renamed By HR' },
    });
    expect(written.status).toBe(403);
    expect(written.body.error.details?.requiredAnyOf).toEqual(['settings.manage']);

    const unchanged = await harness.get<Paginated<LocationSummary>>('/locations', {
      token: hrToken,
    });
    expect(unchanged.body.data.find((row) => row.code === 'OM-HO')?.name).toBe('Head Office');
  });

  it('hides a soft-deleted location from the list', async () => {
    // No route soft-deletes one yet (OPEN-QUESTIONS P1-2), so this asserts the
    // repository's half of REQ-M-04: the row stays, the list stops showing it.
    await harness.db
      .update(locations)
      .set({ deletedAt: new Date() })
      .where(eq(locations.id, headOfficeId));

    const listed = await harness.get<Paginated<LocationSummary>>('/locations', {
      token: adminToken,
    });
    expect(listed.body.data.filter((row) => row.code !== 'FIXTURE-HQ')).toHaveLength(0);

    const rows = await harness.db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.id, headOfficeId));
    expect(rows).toHaveLength(1);

    await harness.db
      .update(locations)
      .set({ deletedAt: null })
      .where(eq(locations.id, headOfficeId));
  });
});
