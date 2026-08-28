import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PERMISSIONS } from '@vyuha/shared';
import { ne } from 'drizzle-orm';

import { departments, designations, employees, locations } from '../db/schema/index.js';
import { SoftDeletableRegistry } from '../recycle-bin/soft-deletable.js';

/**
 * REQ-M-04 delete and restore for the three masters an employee points at
 * (P1-2). The permission on each write is the one P1-1 already settled:
 * `employee.manage` for departments and designations because they are people
 * master data, `settings.manage` for a location because its row carries the
 * geofence centre and the IP allowlist.
 *
 * What blocks a delete is a *live* row pointing at the record. Every foreign
 * key here is `ON DELETE set null`, which protects nothing against a soft
 * delete — the row keeps pointing at an id that no scoped query will ever
 * resolve again, and the employee's department silently reads as empty. So the
 * check is explicit, and it names the rows in the way rather than saying "in
 * use".
 *
 * `attendance_days.shift_id` and its like are deliberately *not* blockers.
 * History is allowed to reference a retired master — that is the point of a
 * soft delete — and refusing to retire a shift because somebody worked it in
 * March would mean no shift could ever be retired.
 */
@Injectable()
export class OrgSoftDeletes implements OnModuleInit {
  constructor(private readonly registry: SoftDeletableRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      entityType: 'department',
      label: 'Department',
      table: departments,
      nameColumn: departments.name,
      codeColumn: departments.code,
      uniqueColumn: departments.code,
      managePermission: PERMISSIONS.EMPLOYEE_MANAGE,
      references: [
        {
          label: 'employees',
          table: employees,
          column: employees.departmentId,
          labelColumn: employees.employeeCode,
          // A retired employee is history, and history may reference a retired
          // master — the `attendance_days.shift_id` rule above. Only
          // someone still working (ACTIVE or ON_NOTICE) holds the delete up;
          // otherwise a department whose last member left years ago could
          // never be removed from the pickers (P1-2, owner, 28 Aug 2026).
          extraPredicate: ne(employees.status, 'INACTIVE'),
        },
        {
          // A parent whose children were left behind would orphan a branch of
          // the REQ-A-02 hierarchy, and the children would render with a parent
          // that no longer resolves.
          label: 'child departments',
          table: departments,
          column: departments.parentId,
          labelColumn: departments.name,
        },
      ],
    });

    this.registry.register({
      entityType: 'designation',
      label: 'Designation',
      table: designations,
      nameColumn: designations.name,
      codeColumn: designations.code,
      uniqueColumn: designations.code,
      managePermission: PERMISSIONS.EMPLOYEE_MANAGE,
      references: [
        {
          label: 'employees',
          table: employees,
          column: employees.designationId,
          labelColumn: employees.employeeCode,
          // Same rule as the department reference: the retired do not block.
          extraPredicate: ne(employees.status, 'INACTIVE'),
        },
      ],
    });

    this.registry.register({
      entityType: 'location',
      label: 'Location',
      table: locations,
      nameColumn: locations.name,
      codeColumn: locations.code,
      uniqueColumn: locations.code,
      managePermission: PERMISSIONS.SETTINGS_MANAGE,
      references: [
        {
          label: 'employees',
          table: employees,
          column: employees.locationId,
          // The code rather than the name: a refusal listing "Asha, Asha, Asha"
          // is a refusal nobody can act on, and codes are unique.
          labelColumn: employees.employeeCode,
        },
      ],
    });
  }
}
