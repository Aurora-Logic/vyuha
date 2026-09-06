import {
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { isUuid } from '@vyuha/shared';
import type { Request, Response } from 'express';
import { tap, type Observable } from 'rxjs';

import { requestIdOf } from '../common/request-id.js';
import { principalOf } from '../rbac/principal.js';
import type { AuditEntry, AuditStore } from './audit-context.js';
import { AuditContext } from './audit-context.js';
import { AuditService } from './audit.service.js';

/**
 * Definition of Done: "Audit log written for every state-changing action."
 *
 * The word doing the work is *every*. A trail that depends on each service
 * remembering to call an audit method is a trail with holes in it, and the
 * holes are invisible -- nobody notices the row that was not written. So the
 * default is inverted: any mutating request that succeeds produces a row, and
 * a service's only job is to enrich it. Opting out is explicit
 * (`AuditContext.suppress()`) and there is exactly one caller.
 *
 * Only successful requests are audited here. A rejected request changed
 * nothing, and its refusal is already a warn line from the exception filter
 * carrying the same request id.
 */

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const SUCCESS_FLOOR = 200;
const SUCCESS_CEILING = 400;

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly audit: AuditService,
    private readonly context: AuditContext,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    if (!MUTATING_METHODS.has(request.method)) return next.handle();

    // Captured now, synchronously, while the middleware's async context is
    // certainly active. The tap callbacks below then hold a direct reference
    // and do not depend on the context still being current when they run.
    const store = this.context.current();
    if (store === null) return next.handle();
    store.requestMetadata = {
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      requestId: requestIdOf(request),
    };

    const route = this.routeOf(context);
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      tap({
        next: (body: unknown) => {
          if (response.statusCode < SUCCESS_FLOOR || response.statusCode >= SUCCESS_CEILING) {
            return;
          }
          // Deliberately not awaited: the response should not wait on the
          // trail, and `write` never rejects.
          void this.persist(store, request, route, body);
        },
      }),
    );
  }

  private async persist(
    store: AuditStore,
    request: Request,
    route: string,
    body: unknown,
  ): Promise<void> {
    if (store.suppressed) return;

    const principal = principalOf(request);
    const orgId = principal?.orgId ?? store.orgId;
    const actorUserId = principal?.userId ?? store.actorUserId;

    if (orgId === null || orgId === undefined) {
      // `audit_logs.org_id` is NOT NULL and there is no sensible placeholder.
      // This is reachable for a public endpoint that succeeded without
      // identifying anyone -- a password reset requested for an address that
      // has no account. Recorded in the log so the gap is not silent.
      this.logger.warn({
        msg: 'Mutating request completed with no organisation; no audit row written.',
        route,
        requestId: requestIdOf(request),
      });
      return;
    }

    const shared = {
      orgId,
      actorUserId: actorUserId ?? null,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      requestId: requestIdOf(request),
    };

    const entries: AuditEntry[] = store.entries.length > 0 ? store.entries : [{}];

    for (const entry of entries) {
      if (entry.persisted === true) continue;
      await this.audit.write({
        ...shared,
        orgId: entry.orgId ?? shared.orgId,
        actorUserId: entry.actorUserId ?? shared.actorUserId,
        action: entry.action ?? `${request.method} ${route}`,
        entityType: entry.entityType ?? entityTypeFromRoute(route),
        entityId: entry.entityId ?? idFromResponse(body),
        // `undefined` and `null` differ here: undefined means the service said
        // nothing and there is no diff to store, null is a deliberate "there
        // was no prior state" from a create.
        ...(entry.before === undefined && entry.after === undefined
          ? {}
          : { before: entry.before, after: entry.after }),
      });
    }
  }

  /**
   * The route *pattern*, not the URL. `auth/invitations/:token/accept` rather
   * than the URL that carries a live single-use token in its path -- which is
   * exactly the sort of thing that must not be written into a table people
   * read for audit purposes.
   */
  private routeOf(context: ExecutionContext): string {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, context.getClass()) as unknown;
    const handlerPath = Reflect.getMetadata(PATH_METADATA, context.getHandler()) as unknown;
    const parts = [controllerPath, handlerPath]
      .filter((part): part is string => typeof part === 'string')
      .map((part) => part.replace(/^\/+|\/+$/gu, ''))
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join('/') : 'unknown';
  }
}

function entityTypeFromRoute(route: string): string {
  return route.split('/')[0] ?? 'unknown';
}

/**
 * A created resource almost always answers with its own id. Reading it saves
 * every create path from repeating itself; anything more specific comes from
 * the service via `AuditContext.record`.
 */
function idFromResponse(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const id: unknown = (body as Record<string, unknown>).id;
  return typeof id === 'string' && isUuid(id) ? id : null;
}
