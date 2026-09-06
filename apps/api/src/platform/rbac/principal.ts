import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { PermissionKey, UserStatus } from '@vyuha/shared';
import type { Request } from 'express';

import type { OrgContext } from '../db/scoped-repository.js';

/**
 * Who is making this request, resolved once by `AccessGuard` and read by
 * everything downstream.
 *
 * The permission set is loaded from the database on every request rather than
 * carried in the access token. That costs one indexed query and buys three
 * things the token version cannot: a role edit takes effect immediately rather
 * than after the access token expires, suspending an account logs it out now,
 * and a stolen token stops working the moment the account is touched.
 */
export interface Principal {
  readonly userId: string;
  readonly orgId: string;
  /** Null for an account with no employee record (REQ-B-02). */
  readonly employeeId: string | null;
  readonly email: string;
  readonly status: UserStatus;
  /** The session this request's access token belongs to. */
  readonly sessionId: string;
  readonly roles: readonly { readonly id: string; readonly name: string }[];
  readonly permissions: ReadonlySet<PermissionKey>;
}

export function hasPermission(principal: Principal, key: PermissionKey): boolean {
  return principal.permissions.has(key);
}

export function hasAnyPermission(
  principal: Principal,
  keys: readonly PermissionKey[],
): boolean {
  return keys.some((key) => principal.permissions.has(key));
}

/**
 * Whether `principal` could already do everything an account holding
 * `target` can.
 *
 * The question behind resetting somebody's password or second factor. Both
 * are gated on `employee.manage`, a people key -- and an account that can
 * reset any account can reset the one that granted it the key, and is then
 * that account. So this is the rule that keeps a reset from being a way up:
 * you may only reset an account that holds nothing you lack. The system roles
 * nest (Employee within Operations within HR within Admin), so HR reaches
 * every employee, Admin reaches everyone, and neither can be climbed.
 */
export function holdsEveryPermissionOf(
  principal: Principal,
  target: ReadonlySet<PermissionKey>,
): boolean {
  for (const key of target) if (!principal.permissions.has(key)) return false;
  return true;
}

/** The context a `ScopedRepository` needs, derived rather than reassembled. */
export function orgContextOf(principal: Principal): OrgContext {
  return { orgId: principal.orgId, actorUserId: principal.userId };
}

/**
 * `@types/express-serve-static-core` declares `Request extends Express.Request`,
 * so the global `Express` namespace is the supported extension point. A
 * `declare module 'express-serve-static-core'` augmentation does not resolve
 * under pnpm's non-flat node_modules, where that package is not a direct
 * dependency of this workspace.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `AccessGuard`. Absent on `@Public()` routes. */
      principal?: Principal;
    }
  }
}

/**
 * `@CurrentUser()` on a handler parameter. Throws rather than returning
 * undefined: a handler that asks for the principal is a handler the guard
 * should already have authenticated, so the absence is a wiring bug and must
 * not be papered over with an optional type the handler then ignores.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<Request>();
    const principal = request.principal;
    if (principal === undefined) {
      throw new Error(
        'CurrentUser was requested on a route with no authenticated principal. ' +
          'The handler is probably marked @Public().',
      );
    }
    return principal;
  },
);

/** For services that receive a possibly-anonymous request. */
export function principalOf(request: Request): Principal | null {
  return request.principal ?? null;
}
