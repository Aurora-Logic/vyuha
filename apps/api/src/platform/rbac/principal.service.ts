import { Injectable } from '@nestjs/common';
import { ALL_PERMISSIONS, ERROR_CODES, type PermissionKey, type UserStatus } from '@vyuha/shared';
import { and, eq, isNull } from 'drizzle-orm';

import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import {
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoles,
  users,
} from '../db/schema/index.js';
import type { Principal } from './principal.js';

/**
 * Turns a verified access token into a `Principal`, by reading the account and
 * its effective permission set out of the database.
 *
 * Every refusal here is deliberately a distinct error code. "Your session is
 * stale, refresh it" and "your account was suspended" need different responses
 * from the web client, and collapsing them into a single 401 makes a suspended
 * user look like a bug in token handling.
 */

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set<string>(ALL_PERMISSIONS);

export interface ResolveInput {
  readonly userId: string;
  readonly orgId: string;
  readonly sessionId: string;
  /** The access token's `iat`, in seconds. Checked against `password_changed_at`. */
  readonly issuedAtSeconds: number;
}

@Injectable()
export class PrincipalService {
  constructor(@InjectDatabase() private readonly db: Database) {}

  async resolve(input: ResolveInput): Promise<Principal> {
    const rows = await this.db
      .select({
        id: users.id,
        orgId: users.orgId,
        employeeId: users.employeeId,
        email: users.email,
        status: users.status,
        passwordChangedAt: users.passwordChangedAt,
        sessionId: sessions.id,
        sessionRevokedAt: sessions.revokedAt,
      })
      .from(users)
      // The session the access token names. Joined rather than fetched
      // separately so revocation costs no extra round trip.
      .leftJoin(
        sessions,
        and(eq(sessions.id, input.sessionId), eq(sessions.userId, users.id)),
      )
      .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
      .limit(1);

    const user = rows[0];
    if (user === undefined) {
      // The account was deleted after the token was issued. Not "not found":
      // from the caller's side their credential simply stopped working.
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This account no longer exists.');
    }

    // A token minted for one organisation must never resolve against another,
    // even if the same user id somehow appeared in both. Cheap, and it turns a
    // whole class of cross-tenant mistake into a hard failure.
    if (user.orgId !== input.orgId) {
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'Token does not match this account.');
    }

    /*
     * An allow-list, not a list of the statuses that are refused. The two
     * named reasons still answer separately, because the web client shows a
     * different screen for each -- but the *shape* is "only ACTIVE gets in",
     * so a fourth member added to `USER_STATUSES` is refused until somebody
     * decides what it means. Written the other way round, adding a status
     * granted it full access and no test would have failed.
     */
    if (user.status !== 'ACTIVE') {
      if (user.status === 'SUSPENDED') {
        throw new AppError(ERROR_CODES.ACCOUNT_INACTIVE, 'This account is suspended.');
      }
      if (user.status === 'INVITED') {
        throw new AppError(
          ERROR_CODES.ACCOUNT_INACTIVE,
          'This account has not accepted its invitation yet.',
        );
      }
      throw new AppError(ERROR_CODES.ACCOUNT_INACTIVE, 'This account cannot sign in.');
    }

    /**
     * REQ-B-04 ("password change invalidates all other sessions") and REQ-B-06
     * ("user can revoke a session, Admin can revoke any") both require an
     * access token to stop working *now*, not when it happens to expire.
     *
     * The session row is the exact answer. The `iat` comparison below was the
     * first attempt and is kept as a second line, but it cannot stand alone:
     * `iat` has one-second resolution, so a token minted in the same second as
     * the password change compares equal and survives. An integration test
     * caught precisely that.
     */
    if (user.sessionId === null) {
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This session no longer exists.');
    }
    if (user.sessionRevokedAt !== null) {
      throw new AppError(ERROR_CODES.TOKEN_INVALID, 'This session has ended; sign in again.');
    }

    if (user.passwordChangedAt !== null) {
      const changedAtSeconds = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (input.issuedAtSeconds < changedAtSeconds) {
        throw new AppError(
          ERROR_CODES.TOKEN_EXPIRED,
          'The password for this account changed; sign in again.',
        );
      }
    }

    const grants = await this.loadGrants(input.userId, user.orgId);

    return {
      userId: user.id,
      orgId: user.orgId,
      employeeId: user.employeeId,
      email: user.email,
      status: user.status satisfies UserStatus,
      sessionId: input.sessionId,
      roles: grants.roles,
      permissions: grants.permissions,
    };
  }

  /**
   * One join for roles and their permissions. A user with a role that has no
   * permissions still yields the role, which is why the permission side is a
   * left join -- an empty role is a real, and confusing, configuration to be
   * able to see in `/me`.
   */
  async loadGrants(
    userId: string,
    orgId: string,
  ): Promise<{
    roles: { id: string; name: string }[];
    permissions: ReadonlySet<PermissionKey>;
  }> {
    const rows = await this.db
      .select({
        roleId: roles.id,
        roleName: roles.name,
        permissionKey: permissions.key,
      })
      .from(userRoles)
      .innerJoin(roles, and(eq(roles.id, userRoles.roleId), isNull(roles.deletedAt)))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(and(eq(userRoles.userId, userId), eq(roles.orgId, orgId)));

    const roleById = new Map<string, string>();
    const granted = new Set<PermissionKey>();

    for (const row of rows) {
      roleById.set(row.roleId, row.roleName);
      const key = row.permissionKey;
      if (key === null) continue;
      // A key in the table that no code defines grants nothing. Silently
      // ignoring it is right: the seed reconciles the catalogue, and a stale
      // row must never widen access.
      if (!KNOWN_PERMISSIONS.has(key)) continue;
      granted.add(key as PermissionKey);
    }

    return {
      roles: [...roleById].map(([id, name]) => ({ id, name })),
      permissions: granted,
    };
  }
}
