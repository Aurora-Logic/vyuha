import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

import type { Database } from '../db/db.provider.js';
import { AuditService, type AuditWrite } from './audit.service.js';

/**
 * The channel a service uses to tell the audit interceptor what it just did,
 * without the controller having to thread an audit object through every call.
 *
 * The interceptor writes a row whether or not anything is recorded here --
 * "It must not require call sites to remember it" -- so everything on this
 * class is enrichment. A service that says nothing still produces an audit row
 * naming the actor, the route, and the request id.
 */

export interface AuditEntry {
  /** Already written in the business transaction; never write it twice. */
  readonly persisted?: boolean;
  /** Overrides the route-derived default, e.g. `session.family_revoked`. */
  readonly action?: string;
  readonly entityType?: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  /** Required for a row: `audit_logs.org_id` is NOT NULL. */
  readonly orgId?: string;
  readonly actorUserId?: string | null;
}

export interface AuditStore {
  requestMetadata?: Pick<AuditWrite, 'ip' | 'userAgent' | 'requestId'>;
  entries: AuditEntry[];
  /** True when this request should produce no row at all. */
  suppressed: boolean;
  /** Learned from the guard or a service; the fallback for every entry. */
  orgId: string | null;
  actorUserId: string | null;
}

function emptyStore(): AuditStore {
  return { entries: [], suppressed: false, orgId: null, actorUserId: null };
}

@Injectable()
export class AuditContext {
  private readonly storage = new AsyncLocalStorage<AuditStore>();

  constructor(private readonly audit: AuditService) {}

  /** Failure propagates so the caller's business transaction rolls back. */
  async recordInTransaction(entry: AuditWrite, executor: Database): Promise<void> {
    const store = this.storage.getStore();
    await this.audit.writeInTransaction({ ...store?.requestMetadata, ...entry }, executor);
    this.record({ ...entry, persisted: true });
  }

  /**
   * Established by `AuditContextMiddleware`, which is the earliest point in
   * the request where a synchronous call to `next()` puts guards, pipes, the
   * handler, and the interceptor's own callbacks all inside one async context.
   *
   * Doing this from the interceptor instead is the tempting mistake: an
   * interceptor's `next.handle()` builds an observable that is subscribed
   * *after* the interceptor returns, so the handler would run outside any
   * context established around the call.
   */
  run<T>(fn: (store: AuditStore) => T): T {
    const store = emptyStore();
    return this.storage.run(store, () => fn(store));
  }

  current(): AuditStore | null {
    return this.storage.getStore() ?? null;
  }

  /**
   * Records one audited change. Called more than once in a request means more
   * than one row, which is correct for a bulk action.
   *
   * Silently does nothing outside a request context -- a background job has no
   * request to audit and must not crash for saying so. Jobs write their own
   * rows through `AuditService` directly.
   */
  record(entry: AuditEntry): void {
    const store = this.storage.getStore();
    if (store === undefined) return;
    store.entries.push(entry);
    if (entry.orgId !== undefined) store.orgId = entry.orgId;
    if (entry.actorUserId !== undefined) store.actorUserId = entry.actorUserId;
  }

  /** Fills in the actor for a request whose principal was resolved late. */
  attribute(orgId: string, actorUserId: string | null): void {
    const store = this.storage.getStore();
    if (store === undefined) return;
    store.orgId = orgId;
    store.actorUserId = actorUserId;
  }

  /**
   * Opts this request out of the automatic row.
   *
   * Used by `POST /auth/refresh`, and only there. A rotation is bookkeeping,
   * not a business change: every signed-in user produces one every fifteen
   * minutes, which over a working day would be more audit rows than everything
   * else in the product combined, and would bury the entries that matter.
   * Reuse detection is not suppressed -- that one records a row explicitly.
   */
  suppress(): void {
    const store = this.storage.getStore();
    if (store === undefined) return;
    store.suppressed = true;
  }
}
