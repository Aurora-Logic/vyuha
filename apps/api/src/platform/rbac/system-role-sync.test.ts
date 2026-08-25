import { PERMISSIONS, SYSTEM_ROLES } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness } from '../../test-support/api-harness.js';

import { SystemRoleSyncService } from './system-role-sync.service.js';

/**
 * New permission keys reach organisations that already exist.
 *
 * The seed reconciles system roles at provisioning and never again, so the
 * first release to ship a brand-new key left every live organisation's Admin
 * without it -- and the product correctly hid everything the key protects,
 * which the owner met as "can't see it". The boot sync closes that class;
 * these prove its three edges: a missing grant returns, a stale one goes,
 * and a custom role is never touched.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0de';

let harness: ApiHarness;
let syncService: SystemRoleSyncService;
let adminRoleId = '';
let accountsRoleId = '';
let customRoleId = '';

async function keysOf(roleId: string): Promise<string[]> {
  const rows = await harness.db.execute<{ key: string }>(sql`
    SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ${roleId} ORDER BY p.key
  `);
  return rows.rows.map((row) => row.key);
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Role Sync Org');
  syncService = harness.resolve(SystemRoleSyncService);
  adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  accountsRoleId = await harness.createSystemRole(SYSTEM_ROLES.ACCOUNTS, { isSystem: true });
  customRoleId = await harness.createRole('Bespoke reader', [PERMISSIONS.REPORT_VIEW]);
});

afterAll(async () => {
  await harness.close();
});

describe('the boot-time system role sync', () => {
  it('restores a grant the matrix names that the role lost', async () => {
    await harness.db.execute(sql`
      DELETE FROM role_permissions rp USING permissions p
       WHERE p.id = rp.permission_id AND rp.role_id = ${adminRoleId} AND p.key = ${PERMISSIONS.INTEREST_VIEW}
    `);
    expect(await keysOf(adminRoleId)).not.toContain(PERMISSIONS.INTEREST_VIEW);

    const { granted } = await syncService.reconcile(ORG_ID);
    expect(granted).toBeGreaterThanOrEqual(1);
    expect(await keysOf(adminRoleId)).toContain(PERMISSIONS.INTEREST_VIEW);
  });

  it('revokes a grant the matrix does not name, because nobody can have chosen it', async () => {
    await harness.db.execute(sql`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT ${accountsRoleId}, p.id FROM permissions p WHERE p.key = ${PERMISSIONS.ROLES_MANAGE}
      ON CONFLICT DO NOTHING
    `);
    expect(await keysOf(accountsRoleId)).toContain(PERMISSIONS.ROLES_MANAGE);

    const { revoked } = await syncService.reconcile(ORG_ID);
    expect(revoked).toBeGreaterThanOrEqual(1);
    expect(await keysOf(accountsRoleId)).not.toContain(PERMISSIONS.ROLES_MANAGE);
  });

  it('leaves a custom role exactly as its owner made it', async () => {
    const before = await keysOf(customRoleId);
    await syncService.reconcile(ORG_ID);
    expect(await keysOf(customRoleId)).toEqual(before);
  });
});
