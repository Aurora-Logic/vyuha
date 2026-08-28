import { randomBytes } from 'node:crypto';

import {
  ALL_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  ROLE_PERMISSION_MATRIX,
  SYSTEM_ROLES,
  type PermissionKey,
  type SystemRoleName,
} from '@vyuha/shared';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';

import type { Database } from '../src/platform/db/db.provider.js';
import {
  employees,
  organizations,
  permissions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '../src/platform/db/schema/index.js';
import { hashPassword } from '../src/platform/auth/password.js';
import { SEED_LEAVE_TYPES } from '../src/modules/attendance/leave/leave-seed-types.js';
import { leaveTypes } from '../src/modules/attendance/schema/index.js';
import {
  ADMINISTRATOR_EMPLOYEE_CODE,
  seedMasterData,
  type MasterDataReport,
} from './master-data.js';

/**
 * Technical design §18 and PRD §2.1: one organisation, the four seeded roles
 * with the §2.1 permission matrix, the permission catalogue, and an account
 * that can sign in.
 *
 * **Idempotent, and that is the requirement, not a nicety.** This runs on a
 * fresh developer database, again after a schema change, and again on a
 * staging box that already has data. Every step is written as "make the world
 * match this description", never as "insert this row".
 *
 * The one thing it will not do twice is set a password. A re-run against a
 * database that already has the administrator leaves that account exactly as
 * it is -- otherwise re-seeding would silently rotate the credential someone
 * is currently using, and print a new one nobody was expecting.
 */

/**
 * A fixed id rather than a lookup by name.
 *
 * The organisation's name is editable in the UI (REQ-L-01). Matching on it
 * would mean a re-seed after a rename creates a *second* organisation and
 * every subsequent step attaches to the wrong one -- the worst possible
 * outcome for a script whose contract is idempotency.
 */
export const SEED_ORG_ID = '01900000-0000-7000-8000-000000000001';

export const DEFAULT_SEED_ORG_NAME = 'Vyuha';
export const DEFAULT_ADMIN_EMAIL = 'admin@vyuha.local';

export interface SeedOptions {
  readonly orgName?: string;
  readonly adminEmail?: string;
  /** Overridden only by the idempotency test, so it does not touch the real
   *  seeded organisation on a developer's database. */
  readonly orgId?: string;
  /**
   * Create the twenty-five example employees (REQ-A-01's sample roster).
   *
   * Off unless asked for. `master-data.ts` carries the reasoning: the deploy
   * checklist runs this seed against the real database, and these are
   * fictional people who would appear in the muster, headcount and every
   * export, undeletable as soon as anything references them.
   */
  readonly examplePeople?: boolean;
  /**
   * The five REQ-G-02 types, on unless a caller says otherwise. A fixture
   * that must be able to delete its own people opts out: once types exist,
   * the accrual job posts ledger rows, and `leave_ledger` is append-only by
   * trigger (REQ-G-03) with a restrict key onto employees -- so an accrued
   * employee can never be removed again, which is right for a real database
   * and fatal for a scratch one.
   */
  readonly leaveTypes?: boolean;
}

export interface SeedReport {
  readonly permissions: { inserted: number; updated: number; removed: number };
  readonly organization: { id: string; created: boolean };
  readonly roles: readonly {
    name: SystemRoleName;
    id: string;
    created: boolean;
    granted: number;
    revoked: number;
  }[];
  readonly admin: {
    userId: string;
    email: string;
    created: boolean;
    /** Present only on the run that created the account. Printed once, never stored. */
    password: string | null;
    /** REQ-B-02: the employee record this login acts as. */
    employee: AdminEmployeeLink;
  };
  /** REQ-A-01 … REQ-A-03: locations, departments, designations, employees. */
  readonly masterData: MasterDataReport;
  /** REQ-G-02 (OS-4): the five seed leave types, so a fresh database can apply for leave. */
  readonly leaveTypes: { created: number; total: number };
}

export interface AdminEmployeeLink {
  /** The employee this login acts as, or null when none could be joined. */
  readonly id: string | null;
  readonly code: string | null;
  /** True only on the run that wrote the join. A re-run reports false. */
  readonly linked: boolean;
  /** Null exactly when `id` is set. */
  readonly reason: 'no-such-employee' | 'employee-already-linked' | null;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export async function runSeed(db: Database, options: SeedOptions = {}): Promise<SeedReport> {
  const orgName = options.orgName ?? DEFAULT_SEED_ORG_NAME;
  const orgId = options.orgId ?? SEED_ORG_ID;
  const adminEmail = (options.adminEmail ?? DEFAULT_ADMIN_EMAIL).trim().toLowerCase();

  // The generated password has to exist before the transaction so the hash --
  // which takes tens of milliseconds -- is not computed while holding locks.
  const candidatePassword = generatePassword();
  const candidateHash = await hashPassword(candidatePassword);

  return db.transaction(async (tx) => {
    const permissionReport = await reconcilePermissions(tx);
    const organization = await ensureOrganisation(tx, orgId, orgName);
    const roleReport = await reconcileRoles(tx, orgId);
    const admin = await ensureAdministrator(tx, orgId, adminEmail, candidateHash, candidatePassword);
    // Before the link below, because the departments it creates are headed by
    // the employees it creates, and both need the organisation to exist first.
    const masterData = await seedMasterData(tx, orgId, {
      examplePeople: options.examplePeople === true,
    });
    // And after it, because the employee the administrator is joined to does
    // not exist until the line above has run.
    const adminEmployee = await linkAdministratorEmployee(tx, orgId, admin.userId);
    const leaveTypeReport = options.leaveTypes === false ? { created: 0, total: 0 } : await seedLeaveTypes(tx, orgId);

    return {
      permissions: permissionReport,
      organization,
      roles: roleReport,
      admin: { ...admin, employee: adminEmployee },
      masterData,
      leaveTypes: leaveTypeReport,
    };
  });
}

/**
 * The catalogue is owned by code: `ALL_PERMISSIONS` in `@vyuha/shared` is the
 * definition, and this table is a projection of it that exists so
 * `role_permissions` can carry a foreign key.
 *
 * Keys the code no longer defines are deleted. That cascades to
 * `role_permissions`, which is correct -- a permission nothing checks grants
 * nothing, and leaving it in place means a role screen offering a checkbox
 * with no effect. Each deletion is reported so it is never silent.
 */
async function reconcilePermissions(
  tx: Transaction,
): Promise<{ inserted: number; updated: number; removed: number }> {
  const existing = await tx
    .select({ key: permissions.key, description: permissions.description })
    .from(permissions);

  const byKey = new Map(existing.map((row) => [row.key, row.description]));

  const missing = ALL_PERMISSIONS.filter((key) => !byKey.has(key));
  if (missing.length > 0) {
    await tx
      .insert(permissions)
      .values(missing.map((key) => ({ key, description: PERMISSION_DESCRIPTIONS[key] })))
      .onConflictDoNothing({ target: permissions.key });
  }

  let updated = 0;
  for (const key of ALL_PERMISSIONS) {
    const current = byKey.get(key);
    if (current === undefined || current === PERMISSION_DESCRIPTIONS[key]) continue;
    await tx
      .update(permissions)
      .set({ description: PERMISSION_DESCRIPTIONS[key] })
      .where(eq(permissions.key, key));
    updated += 1;
  }

  const orphans = existing.filter((row) => !ALL_PERMISSIONS.includes(row.key as PermissionKey));
  if (orphans.length > 0) {
    await tx.delete(permissions).where(
      inArray(
        permissions.key,
        orphans.map((row) => row.key),
      ),
    );
  }

  return { inserted: missing.length, updated, removed: orphans.length };
}

async function ensureOrganisation(
  tx: Transaction,
  orgId: string,
  name: string,
): Promise<{ id: string; created: boolean }> {
  const found = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (found[0] !== undefined) return { id: found[0].id, created: false };

  // Undoes a previous soft delete as well as inserting: `deletedAt` is set
  // explicitly rather than left to the column default, so a re-seed after
  // someone deleted the organisation restores a usable one.
  const inserted = await tx
    .insert(organizations)
    .values({ id: orgId, name, deletedAt: null })
    .onConflictDoUpdate({ target: organizations.id, set: { deletedAt: null } })
    .returning({ id: organizations.id });

  const row = inserted[0];
  if (row === undefined) throw new Error('Organisation upsert returned no row.');
  return { id: row.id, created: true };
}

/**
 * REQ-B-07 makes role permission sets editable in the UI, so reconciling them
 * back to the matrix is a deliberate reset, not a merge. It is reported per
 * role -- `granted` and `revoked` are non-zero exactly when a re-seed changed
 * something an administrator had configured.
 */
async function reconcileRoles(tx: Transaction, orgId: string): Promise<SeedReport['roles']> {
  const catalogue = await tx
    .select({ id: permissions.id, key: permissions.key })
    .from(permissions);
  const permissionIdByKey = new Map(catalogue.map((row) => [row.key, row.id]));

  const report: {
    name: SystemRoleName;
    id: string;
    created: boolean;
    granted: number;
    revoked: number;
  }[] = [];

  for (const name of Object.values(SYSTEM_ROLES)) {
    const existing = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.name, name), isNull(roles.deletedAt)))
      .limit(1);

    let roleId = existing[0]?.id;
    const created = roleId === undefined;

    if (roleId === undefined) {
      const inserted = await tx
        .insert(roles)
        .values({ orgId, name, isSystem: true })
        .returning({ id: roles.id });
      const row = inserted[0];
      if (row === undefined) throw new Error(`Role insert returned no row for "${name}".`);
      roleId = row.id;
    }

    const wantedKeys = ROLE_PERMISSION_MATRIX[name];
    const wantedIds = wantedKeys.map((key) => {
      const id = permissionIdByKey.get(key);
      if (id === undefined) {
        // Only reachable if reconcilePermissions above did not run, which
        // would be a bug in this file rather than in the database.
        throw new Error(`Permission "${key}" is missing from the catalogue.`);
      }
      return id;
    });

    const granted = await tx
      .insert(rolePermissions)
      .values(wantedIds.map((permissionId) => ({ roleId, permissionId })))
      .onConflictDoNothing({ target: [rolePermissions.roleId, rolePermissions.permissionId] })
      .returning({ permissionId: rolePermissions.permissionId });

    const revoked = await tx
      .delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.roleId, roleId),
          notInArray(rolePermissions.permissionId, wantedIds),
        ),
      )
      .returning({ permissionId: rolePermissions.permissionId });

    report.push({ name, id: roleId, created, granted: granted.length, revoked: revoked.length });
  }

  return report;
}

async function ensureAdministrator(
  tx: Transaction,
  orgId: string,
  email: string,
  passwordHash: string,
  password: string,
): Promise<Omit<SeedReport['admin'], 'employee'>> {
  const adminRole = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(eq(roles.orgId, orgId), eq(roles.name, SYSTEM_ROLES.ADMIN), isNull(roles.deletedAt)),
    )
    .limit(1);

  const adminRoleId = adminRole[0]?.id;
  if (adminRoleId === undefined) throw new Error('Admin role is missing after reconciliation.');

  const existing = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.orgId, orgId), sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
    .limit(1);

  const found = existing[0];

  if (found === undefined) {
    // An email identifies one person across the whole deployment
    // (`users_email_uq` is on lower(email), not on the pair). This lookup used
    // to omit the organisation, so seeding a second one with an address that
    // already existed found the other organisation's user, granted them a role
    // row that `PrincipalService` will never honour -- it filters roles by the
    // principal's own org -- and returned created:false with no password. The
    // operator was told the administrator already existed, and the new
    // organisation had none. Refusing says the true thing instead.
    const elsewhere = await tx
      .select({ orgId: users.orgId })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
      .limit(1);
    const other = elsewhere[0];
    if (other !== undefined) {
      throw new Error(
        `${email} already belongs to organisation ${other.orgId}. An email address identifies one person across the ` +
          'whole deployment, so this organisation needs an administrator address of its own; pass --admin-email.',
      );
    }
  }

  if (found !== undefined) {
    // The role assignment is still reconciled: an administrator who lost the
    // Admin role is exactly the situation someone re-runs the seed to fix.
    await tx
      .insert(userRoles)
      .values({ userId: found.id, roleId: adminRoleId })
      .onConflictDoNothing({ target: [userRoles.userId, userRoles.roleId] });

    return { userId: found.id, email: found.email, created: false, password: null };
  }

  const now = new Date();
  const inserted = await tx
    .insert(users)
    .values({
      orgId,
      email,
      passwordHash,
      status: 'ACTIVE',
      passwordChangedAt: now,
    })
    .returning({ id: users.id, email: users.email });

  const row = inserted[0];
  if (row === undefined) throw new Error('Administrator insert returned no row.');

  await tx
    .insert(userRoles)
    .values({ userId: row.id, roleId: adminRoleId })
    .onConflictDoNothing({ target: [userRoles.userId, userRoles.roleId] });

  return { userId: row.id, email: row.email, created: true, password };
}

/**
 * REQ-B-02: the login and the employee record are separate rows joined 1:1, and
 * nothing joined them. A freshly seeded `admin@vyuha.local` therefore had no
 * employee record at all, so `/punch` answered "this sign-in is not linked to
 * an employee record" and `GET /leave/balances` answered 400 -- the two
 * employee-scoped screens were unreachable on every clean checkout, which is
 * the whole of what a pilot administrator opens on day one.
 *
 * **Joined to a person the seed already created, not to an employee row of the
 * administrator's own.** A dedicated row would put a twenty-sixth body into the
 * headcount, the muster and every export -- invented data on a path that runs,
 * which CLAUDE.md §6 forbids -- while this writes one foreign key between two
 * rows the seed already owns and invents nothing.
 *
 * The seed is a development and pilot bootstrap; `run-seed.ts` refuses to run
 * with `NODE_ENV=production` unless forced. Onboarding a real administrator
 * means correcting or repointing that employee record, which is now a step in
 * the launch plan (§WS-D) rather than something a pilot discovers at the punch
 * screen.
 *
 * Idempotent in the same shape as everything else here: it fills a join that is
 * empty and never repoints one. Somebody who moved the login onto their own
 * employee record in the UI must not have that dragged back by a re-seed.
 */
async function linkAdministratorEmployee(
  tx: Transaction,
  orgId: string,
  userId: string,
): Promise<AdminEmployeeLink> {
  // The organisation is named as well as the id. `ensureAdministrator` now
  // guarantees the user belongs to it, so this cannot select anything else --
  // which is the point of writing it down: the guarantee lives one function
  // away, and this join sets `users.employee_id`, the column every self-scoped
  // read resolves through.
  const current = await tx
    .select({ employeeId: users.employeeId })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .limit(1);

  const alreadyJoined = current[0]?.employeeId ?? null;
  if (alreadyJoined !== null) {
    const held = await tx
      .select({ code: employees.employeeCode })
      .from(employees)
      .where(eq(employees.id, alreadyJoined))
      .limit(1);

    return { id: alreadyJoined, code: held[0]?.code ?? null, linked: false, reason: null };
  }

  const target = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(
      and(
        eq(employees.orgId, orgId),
        eq(employees.employeeCode, ADMINISTRATOR_EMPLOYEE_CODE),
        isNull(employees.deletedAt),
      ),
    )
    .limit(1);

  const employeeId = target[0]?.id;
  if (employeeId === undefined) {
    return { id: null, code: null, linked: false, reason: 'no-such-employee' };
  }

  // `users_employee_uq` allows one living login per employee, so taking a
  // record that already belongs to somebody else would be rejected by the
  // index -- and would be the wrong outcome even if it were not. Reported
  // rather than thrown: an administrator who has to be linked by hand is a
  // worse day than a failed seed, not a reason to refuse the other twelve
  // things this script does.
  const claimed = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.employeeId, employeeId), isNull(users.deletedAt)))
    .limit(1);

  if (claimed[0] !== undefined) {
    return { id: null, code: null, linked: false, reason: 'employee-already-linked' };
  }

  await tx
    .update(users)
    .set({ employeeId })
    .where(and(eq(users.id, userId), isNull(users.employeeId)));

  return { id: employeeId, code: ADMINISTRATOR_EMPLOYEE_CODE, linked: true, reason: null };
}

/**
 * REQ-G-02 (OS-4, decided 28 Aug 2026): the five leave types, so a fresh
 * database can apply for leave without somebody first typing CL, SL, EL, LWP
 * and CO into the admin screen. The numbers come from `SEED_LEAVE_TYPES`
 * verbatim -- placeholders on the record, editable in the UI (OPEN-QUESTIONS
 * item 4 carries the real policy question).
 *
 * Matched on code among the living, like the master data: a re-run inserts
 * what is missing and never touches a type an administrator has edited, so
 * re-seeding cannot quietly reset an entitlement.
 */
async function seedLeaveTypes(
  tx: Transaction,
  orgId: string,
): Promise<{ created: number; total: number }> {
  const existing = await tx
    .select({ code: leaveTypes.code })
    .from(leaveTypes)
    .where(and(eq(leaveTypes.orgId, orgId), isNull(leaveTypes.deletedAt)));
  const present = new Set(existing.map((row) => row.code));

  const missing = SEED_LEAVE_TYPES.filter((type) => !present.has(type.code));
  for (const type of missing) {
    // The note is documentation for whoever renders the type, not a column.
    const { placeholderNote: _note, ...input } = type;
    await tx.insert(leaveTypes).values({ orgId, ...input });
  }

  return { created: missing.length, total: SEED_LEAVE_TYPES.length };
}

/**
 * 24 base64url characters, which is 144 bits. Not a fixed default and not
 * derived from anything -- CLAUDE.md §6: "Do not commit secrets". A seeded
 * default password is the most commonly committed secret there is.
 */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}
