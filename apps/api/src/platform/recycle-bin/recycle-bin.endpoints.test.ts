import {
  SYSTEM_ROLES,
  type DepartmentSummary,
  type DesignationSummary,
  type LocationSummary,
  type Paginated,
  type RecycleBinEntry,
} from '@vyuha/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { departments, deletionRecords } from '../db/schema/index.js';

/**
 * REQ-M-04 and REQ-B-09a over real HTTP: soft delete with a reason, the refusal
 * that names what is in the way, restore, and the bin.
 *
 * P1-2 recorded that no delete route existed for any master and described the
 * shape one would have to take -- "a soft-delete route guarded by the write
 * key, refusing while any live employee still points at the row". That sentence
 * is what these tests check, one clause at a time.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000d6';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface DeleteResult {
  entityType: string;
  id: string;
  name: string;
  deleted: boolean;
}

let harness: ApiHarness;
let adminToken: string;
let hrToken: string;
let opsToken: string;

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Recycle Bin Fixture Org');

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR, { isSystem: true });
  const opsRoleId = await harness.createSystemRole(SYSTEM_ROLES.OPERATIONS, { isSystem: true });

  const admin = await harness.createUser({
    email: scopedEmail('bin-admin'),
    roleIds: [adminRoleId],
  });
  const hr = await harness.createUser({ email: scopedEmail('bin-hr'), roleIds: [hrRoleId] });
  const ops = await harness.createUser({ email: scopedEmail('bin-ops'), roleIds: [opsRoleId] });

  adminToken = (await harness.login(admin.email, admin.password)).token;
  hrToken = (await harness.login(hr.email, hr.password)).token;
  opsToken = (await harness.login(ops.email, ops.password)).token;
  expect([adminToken, hrToken, opsToken].every((token) => token !== '')).toBe(true);
}, 30_000);

afterAll(async () => {
  await harness.close();
});

describe('the reason is mandatory on every destructive route', () => {
  let designationId = '';

  beforeAll(async () => {
    const created = await harness.post<DesignationSummary>('/designations', {
      token: hrToken,
      body: { name: 'Reason Probe', code: 'RB-REASON' },
    });
    expect(created.status, created.text).toBe(201);
    designationId = created.body.id;
  });

  it('refuses a delete with no body at all', async () => {
    const refused = await harness.del<ErrorBody>(`/masters/designation/${designationId}`, {
      token: hrToken,
    });
    expect(refused.status, refused.text).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a delete with a one-character reason', async () => {
    const refused = await harness.del<ErrorBody>(`/masters/designation/${designationId}`, {
      token: hrToken,
      body: { reason: 'x' },
    });
    expect(refused.status, refused.text).toBe(400);
  });

  it('refuses a delete whose reason is only whitespace round three letters', async () => {
    const refused = await harness.del<ErrorBody>(`/masters/designation/${designationId}`, {
      token: hrToken,
      body: { reason: '   abc                    ' },
    });
    expect(refused.status, refused.text).toBe(400);
  });

  it('leaves the record alive after every refusal', async () => {
    const listed = await harness.get<Paginated<DesignationSummary>>('/designations?pageSize=200', {
      token: hrToken,
    });
    expect(listed.body.data.some((row) => row.id === designationId)).toBe(true);
  });

  it('refuses a restore with no reason', async () => {
    const removed = await harness.del<DeleteResult>(`/masters/designation/${designationId}`, {
      token: hrToken,
      body: { reason: 'Created by mistake during setup' },
    });
    expect(removed.status, removed.text).toBe(200);

    const refused = await harness.post<ErrorBody>(
      `/masters/designation/${designationId}/restore`,
      { token: hrToken },
    );
    expect(refused.status, refused.text).toBe(400);

    // Still deleted: a refused restore must not half-restore.
    const listed = await harness.get<Paginated<DesignationSummary>>('/designations?pageSize=200', {
      token: hrToken,
    });
    expect(listed.body.data.some((row) => row.id === designationId)).toBe(false);
  });
});

describe('a delete refuses while a live row points at the record', () => {
  let departmentId = '';
  let employeeId = '';

  beforeAll(async () => {
    const created = await harness.post<DepartmentSummary>('/departments', {
      token: hrToken,
      body: { name: 'Dispatch', code: 'RB-DISP' },
    });
    expect(created.status, created.text).toBe(201);
    departmentId = created.body.id;

    employeeId = await harness.createEmployee({
      code: 'RB-0001',
      firstName: 'Meera',
      lastName: 'Nair',
      departmentId,
    });
  });

  it('names the rows in the way, not merely that there are some', async () => {
    const refused = await harness.del<ErrorBody>(`/masters/department/${departmentId}`, {
      token: hrToken,
      body: { reason: 'Merging dispatch into operations' },
    });

    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.error.code).toBe('RECORD_IN_USE');
    expect(refused.body.error.message).toContain('RB-0001');
    expect(refused.body.error.details?.references).toEqual([
      { entityType: 'employees', label: 'employees', count: 1, examples: ['RB-0001'] },
    ]);
  });

  it('also refuses while a child department points at it', async () => {
    const parent = await harness.post<DepartmentSummary>('/departments', {
      token: hrToken,
      body: { name: 'Regions', code: 'RB-REG' },
    });
    const child = await harness.post<DepartmentSummary>('/departments', {
      token: hrToken,
      body: { name: 'South', code: 'RB-SOUTH', parentId: parent.body.id },
    });
    expect(child.status, child.text).toBe(201);

    const refused = await harness.del<ErrorBody>(`/masters/department/${parent.body.id}`, {
      token: hrToken,
      body: { reason: 'Flattening the hierarchy this quarter' },
    });
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.error.message).toContain('South');
  });

  it('accepts the delete once nothing points at it any more', async () => {
    await harness.patch(`/employees/${employeeId}`, {
      token: hrToken,
      body: { departmentId: null },
    });

    const removed = await harness.del<DeleteResult>(`/masters/department/${departmentId}`, {
      token: hrToken,
      body: { reason: 'Merged into operations on the 1st' },
    });

    expect(removed.status, removed.text).toBe(200);
    expect(removed.body.deleted).toBe(true);
    expect(removed.body.name).toBe('Dispatch');
    expect(await harness.waitForAuditAction('department.deleted')).toBe(true);
  });

  it('stamps deleted_at on the row and writes a deletion record with the reason', async () => {
    const rows = await harness.db
      .select({ id: departments.id })
      .from(departments)
      .where(and(eq(departments.id, departmentId), isNotNull(departments.deletedAt)));
    expect(rows).toHaveLength(1);

    const records = await harness.db
      .select({ reason: deletionRecords.reason, label: deletionRecords.entityLabel })
      .from(deletionRecords)
      .where(eq(deletionRecords.entityId, departmentId));
    expect(records).toHaveLength(1);
    expect(records[0]?.reason).toBe('Merged into operations on the 1st');
    expect(records[0]?.label).toBe('Dispatch (RB-DISP)');
  });

  it('drops it out of the ordinary list', async () => {
    const listed = await harness.get<Paginated<DepartmentSummary>>('/departments?pageSize=200', {
      token: hrToken,
    });
    expect(listed.body.data.some((row) => row.id === departmentId)).toBe(false);
  });

  it('restores it, and it comes back into the list', async () => {
    const restored = await harness.post<DeleteResult>(
      `/masters/department/${departmentId}/restore`,
      { token: hrToken, body: { reason: 'The merge was called off on the 4th' } },
    );
    expect(restored.status, restored.text).toBe(201);
    expect(restored.body.deleted).toBe(false);

    const listed = await harness.get<Paginated<DepartmentSummary>>('/departments?pageSize=200', {
      token: hrToken,
    });
    expect(listed.body.data.some((row) => row.id === departmentId)).toBe(true);
    expect(await harness.waitForAuditAction('department.restored')).toBe(true);
  });

  it('closes the deletion record rather than leaving it open', async () => {
    const records = await harness.db
      .select({ restoreReason: deletionRecords.restoreReason })
      .from(deletionRecords)
      .where(eq(deletionRecords.entityId, departmentId));
    expect(records[0]?.restoreReason).toBe('The merge was called off on the 4th');
  });

  it('refuses to restore a record that is not deleted', async () => {
    const refused = await harness.post<ErrorBody>(
      `/masters/department/${departmentId}/restore`,
      { token: hrToken, body: { reason: 'Restoring something already alive' } },
    );
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.error.code).toBe('RECORD_NOT_DELETED');
  });
});

describe('a retired employee does not hold the delete up', () => {
  let designationId = '';
  let employeeId = '';

  beforeAll(async () => {
    const created = await harness.post<DesignationSummary>('/designations', {
      token: hrToken,
      body: { name: 'Telex Operator', code: 'RB-TELEX' },
    });
    expect(created.status, created.text).toBe(201);
    designationId = created.body.id;

    employeeId = await harness.createEmployee({
      code: 'RB-0002',
      firstName: 'Suresh',
      lastName: 'Pillai',
      designationId,
    });
  });

  it('refuses while the employee is still working', async () => {
    const refused = await harness.del<ErrorBody>(`/masters/designation/${designationId}`, {
      token: hrToken,
      body: { reason: 'Nobody has held this title since the nineties' },
    });
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.error.code).toBe('RECORD_IN_USE');
    expect(refused.body.error.message).toContain('RB-0002');
  });

  it('accepts once that employee is retired, without repointing them', async () => {
    // REQ-A-05's retirement, through the real route: INACTIVE plus a last
    // working date. The designation reference on the employee is left alone --
    // that is the point being tested.
    const retired = await harness.patch(`/employees/${employeeId}`, {
      token: hrToken,
      body: { status: 'INACTIVE', dateOfLeaving: '2026-08-27' },
    });
    expect(retired.status, retired.text).toBe(200);

    const removed = await harness.del<DeleteResult>(`/masters/designation/${designationId}`, {
      token: hrToken,
      body: { reason: 'Nobody has held this title since the nineties' },
    });
    expect(removed.status, removed.text).toBe(200);
    expect(removed.body.deleted).toBe(true);
    expect(await harness.waitForAuditEntityAction(designationId, 'designation.deleted')).toBe(true);

    const listed = await harness.get<Paginated<DesignationSummary>>('/designations?pageSize=200', {
      token: hrToken,
    });
    expect(listed.body.data.some((row) => row.id === designationId)).toBe(false);
  });
});

describe('the code a delete freed cannot be silently stolen back', () => {
  it('refuses the restore and names what took the code', async () => {
    const first = await harness.post<DesignationSummary>('/designations', {
      token: hrToken,
      body: { name: 'Foreman', code: 'RB-CLASH' },
    });
    expect(first.status, first.text).toBe(201);

    const removed = await harness.del(`/masters/designation/${first.body.id}`, {
      token: hrToken,
      body: { reason: 'Replacing it with the new grade scheme' },
    });
    expect(removed.status, removed.text).toBe(200);

    // The partial unique index frees the code for the living.
    const second = await harness.post<DesignationSummary>('/designations', {
      token: hrToken,
      body: { name: 'Site Foreman', code: 'RB-CLASH' },
    });
    expect(second.status, second.text).toBe(201);

    const refused = await harness.post<ErrorBody>(
      `/masters/designation/${first.body.id}/restore`,
      { token: hrToken, body: { reason: 'Undoing the grade scheme change' } },
    );
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT');
    expect(refused.body.error.message).toContain('Site Foreman');
  });
});

describe('RBAC is enforced per record type, not per route', () => {
  let locationId = '';

  beforeAll(async () => {
    const created = await harness.post<LocationSummary>('/locations', {
      token: adminToken,
      body: { name: 'Warehouse', code: 'RB-WH' },
    });
    expect(created.status, created.text).toBe(201);
    locationId = created.body.id;
  });

  it('refuses HR on a location, which needs settings.manage', async () => {
    // HR passes the route guard -- it holds employee.manage, one of the listed
    // keys -- and is stopped by the per-record check. That is the case a static
    // route policy alone cannot express, and the reason the service re-checks.
    const refused = await harness.del<ErrorBody>(`/masters/location/${locationId}`, {
      token: hrToken,
      body: { reason: 'HR should not be able to remove a punch location' },
    });
    expect(refused.status, refused.text).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
    expect(refused.body.error.details?.requiredAnyOf).toEqual(['settings.manage']);
  });

  it('refuses Operations on the route outright, holding none of the keys', async () => {
    const refused = await harness.del<ErrorBody>(`/masters/location/${locationId}`, {
      token: opsToken,
      body: { reason: 'Operations holds no manage key at all' },
    });
    expect(refused.status, refused.text).toBe(403);
  });

  it('refuses Operations on a department: employee.view reads the list, it does not delete from it', async () => {
    const created = await harness.post<DepartmentSummary>('/departments', {
      token: hrToken,
      body: { name: 'Stores', code: 'RB-STORE' },
    });
    expect(created.status, created.text).toBe(201);

    const refused = await harness.del<ErrorBody>(`/masters/department/${created.body.id}`, {
      token: opsToken,
      body: { reason: 'Operations can see departments but not manage them' },
    });
    expect(refused.status, refused.text).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
    expect(refused.body.error.details?.requiredAnyOf).toEqual(['employee.manage']);

    // Refused means untouched: still in the list for everyone.
    const listed = await harness.get<Paginated<DepartmentSummary>>('/departments?pageSize=200', {
      token: hrToken,
    });
    expect(listed.body.data.some((row) => row.id === created.body.id)).toBe(true);
  });

  it('accepts Admin', async () => {
    const removed = await harness.del<DeleteResult>(`/masters/location/${locationId}`, {
      token: adminToken,
      body: { reason: 'The warehouse lease ended in June' },
    });
    expect(removed.status, removed.text).toBe(200);
  });

  it('refuses an entity type that is not registered', async () => {
    const refused = await harness.del<ErrorBody>(`/masters/employee/${locationId}`, {
      token: adminToken,
      body: { reason: 'Employees are retired, not deleted (REQ-A-05)' },
    });
    expect(refused.status, refused.text).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /recycle-bin', () => {
  it('lists deleted records with who deleted them, when, and why', async () => {
    const bin = await harness.get<Paginated<RecycleBinEntry>>('/recycle-bin?pageSize=200', {
      token: adminToken,
    });

    expect(bin.status, bin.text).toBe(200);
    const warehouse = bin.body.data.find((entry) => entry.name === 'Warehouse');
    expect(warehouse).toBeDefined();
    expect(warehouse?.entityType).toBe('location');
    expect(warehouse?.entityLabel).toBe('Location');
    expect(warehouse?.code).toBe('RB-WH');
    expect(warehouse?.reason).toBe('The warehouse lease ended in June');
    expect(warehouse?.deletedBy?.name).toContain('bin-admin');
    expect(Date.parse(warehouse?.deletedAt ?? '')).not.toBeNaN();
  });

  it('filters to one record type', async () => {
    const bin = await harness.get<Paginated<RecycleBinEntry>>(
      '/recycle-bin?entityType=designation&pageSize=200',
      { token: adminToken },
    );
    expect(bin.status, bin.text).toBe(200);
    expect(bin.body.data.every((entry) => entry.entityType === 'designation')).toBe(true);
    expect(bin.body.data.length).toBeGreaterThan(0);
  });

  it('shows a caller only the record types they can manage', async () => {
    // HR holds employee.manage, leave.policy.manage and holiday.manage, but not
    // settings.manage -- so the deleted location must not appear. Showing it
    // would leak what was removed on the side of the system HR cannot touch.
    const bin = await harness.get<Paginated<RecycleBinEntry>>('/recycle-bin?pageSize=200', {
      token: hrToken,
    });
    expect(bin.status, bin.text).toBe(200);
    expect(bin.body.data.some((entry) => entry.entityType === 'location')).toBe(false);
    expect(bin.body.data.some((entry) => entry.entityType === 'designation')).toBe(true);
  });

  it('gives a holder of one narrow key an empty page, not somebody else’s bin', async () => {
    // Operations holds exactly one of the manage keys -- `shift.manage` -- so it
    // passes the route guard and then sees only deleted shifts, of which there
    // are none. An empty bin is the correct answer; the deleted location and
    // designations are not Operations' business.
    const bin = await harness.get<Paginated<RecycleBinEntry>>('/recycle-bin?pageSize=200', {
      token: opsToken,
    });
    expect(bin.status, bin.text).toBe(200);
    expect(bin.body.data).toEqual([]);
    expect(bin.body.meta.total).toBe(0);
  });

  it('refuses a caller holding none of the manage keys at all', async () => {
    const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);
    const plain = await harness.createUser({
      email: scopedEmail('bin-plain'),
      roleIds: [employeeRoleId],
    });
    const token = (await harness.login(plain.email, plain.password)).token;

    const bin = await harness.get<ErrorBody>('/recycle-bin', { token });
    expect(bin.status).toBe(403);
    expect(bin.body.error.code).toBe('FORBIDDEN');
  });

  it('orders newest first across record types', async () => {
    const bin = await harness.get<Paginated<RecycleBinEntry>>('/recycle-bin?pageSize=200', {
      token: adminToken,
    });
    const timestamps = bin.body.data.map((entry) => entry.deletedAt);
    expect([...timestamps].sort((a, b) => b.localeCompare(a))).toEqual(timestamps);
  });
});
