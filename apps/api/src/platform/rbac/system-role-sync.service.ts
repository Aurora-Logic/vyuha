import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PERMISSIONS, ROLE_PERMISSION_MATRIX, SYSTEM_ROLES } from '@vyuha/shared';
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';

import { organizations } from '../db/schema/organizations.schema.js';
import { permissions, rolePermissions, roles } from '../db/schema/identity.schema.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';

/**
 * Every release's new permission keys reach the organisations that already
 * exist.
 *
 * The seed reconciles system-role grants against ROLE_PERMISSION_MATRIX --
 * but only when it runs, which is at provisioning. The first release to ship
 * a brand-new key (interest_cost.*) left every live organisation's Admin
 * without it, and the product then did exactly what it should for a person
 * without access: hid the reports, the settings section and the tile. The
 * owner met that as "can't see it".
 *
 * So the same reconciliation runs at boot: the catalogue gains missing keys,
 * and every system role in every organisation is brought to the matrix --
 * grants added and stale ones revoked. Revocation is safe here for the same
 * reason it is in the seed: `roles.is_system` locks these roles against
 * editing, so the matrix is their only author and any drift is a leftover,
 * not a decision. Custom roles are never touched. Catalogue rows for keys
 * the matrix no longer names are left for the seed to report and remove --
 * deleting them here would cascade into custom roles' grants silently.
 */
@Injectable()
export class SystemRoleSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemRoleSyncService.name);

  constructor(@InjectDatabase() private readonly db: Database) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const { granted, revoked } = await this.reconcile();
      if (granted > 0 || revoked > 0) {
        this.logger.log({ msg: 'System roles brought to the permission matrix', granted, revoked });
      }
    } catch (error) {
      // Boot must not die for this -- the seed path still exists -- but a
      // silent failure would recreate the very gap this closes.
      this.logger.error({ msg: 'System role sync failed', err: error });
    }
  }

  /** Exposed for the test; boot calls it with no arguments. */
  async reconcile(onlyOrgId?: string): Promise<{ granted: number; revoked: number }> {
    return this.db.transaction(async (tx) => {
      const known = Object.values(PERMISSIONS);
      await tx
        .insert(permissions)
        .values(known.map((key) => ({ key, description: '' })))
        .onConflictDoNothing({ target: [permissions.key] });

      const catalogue = await tx
        .select({ id: permissions.id, key: permissions.key })
        .from(permissions)
        .where(inArray(permissions.key, known));
      const idByKey = new Map(catalogue.map((row) => [row.key, row.id]));

      const systemNames = Object.values(SYSTEM_ROLES);
      const targets = await tx
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .innerJoin(organizations, eq(organizations.id, roles.orgId))
        .where(
          and(
            eq(roles.isSystem, true),
            inArray(roles.name, systemNames),
            isNull(roles.deletedAt),
            isNull(organizations.deletedAt),
            ...(onlyOrgId === undefined ? [] : [eq(roles.orgId, onlyOrgId)]),
          ),
        );

      let granted = 0;
      let revoked = 0;
      for (const role of targets) {
        const wanted = ROLE_PERMISSION_MATRIX[role.name as keyof typeof ROLE_PERMISSION_MATRIX];
        if (wanted === undefined) continue;
        const wantedIds = wanted.map((key) => {
          const id = idByKey.get(key);
          if (id === undefined) throw new Error(`Permission "${key}" missing from the catalogue after reconcile.`);
          return id;
        });
        const added = await tx
          .insert(rolePermissions)
          .values(wantedIds.map((permissionId) => ({ roleId: role.id, permissionId })))
          .onConflictDoNothing({ target: [rolePermissions.roleId, rolePermissions.permissionId] })
          .returning({ permissionId: rolePermissions.permissionId });
        const removed = await tx
          .delete(rolePermissions)
          .where(and(eq(rolePermissions.roleId, role.id), notInArray(rolePermissions.permissionId, wantedIds)))
          .returning({ permissionId: rolePermissions.permissionId });
        granted += added.length;
        revoked += removed.length;
      }
      return { granted, revoked };
    });
  }
}
