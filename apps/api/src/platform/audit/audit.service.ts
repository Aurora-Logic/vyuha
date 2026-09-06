import { Injectable, Logger } from '@nestjs/common';
import { isUuid } from '@vyuha/shared';

import { describeError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { auditLogs } from '../db/schema/index.js';

/**
 * REQ-M-01: the append-only trail. This is the only writer.
 *
 * Existing best-effort callers report a failed write explicitly. Callers with
 * a business transaction can use writeInTransaction so the mutation and its
 * audit entry commit together. Migration of existing callers is incremental.
 */

/** Never written to the trail, whatever a caller passes. */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'password',
  'newPassword',
  'passwordHash',
  'password_hash',
  'token',
  'tokenHash',
  'token_hash',
  'refreshToken',
  'refreshTokenHash',
  'refresh_token_hash',
  'accessToken',
  'totpSecret',
  'totp_secret',
  'secret',
  'authorization',
  'cookie',
  'setCookie',
  'apiKey',
  'clientSecret',
  'recoveryCodes',
  'backupCodes',
].map((key) => key.replaceAll(/[_-]/g, '').toLowerCase()));

const REDACTION = '[redacted]';

/** Guards against a runaway object filling a jsonb column. */
const MAX_DEPTH = 6;

export interface AuditWrite {
  readonly orgId: string;
  readonly actorUserId: string | null;
  readonly impersonatorUserId?: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

type Json = Record<string, unknown>;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTION;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const output: Json = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = REDACTED_KEYS.has(key.replaceAll(/[_-]/g, '').toLowerCase())
      ? REDACTION : redact(item, depth + 1);
  }
  return output;
}

function isPlainRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows before/after to the fields that actually changed.
 *
 * An unnarrowed pair stores the whole row twice on every edit, and the reader
 * of REQ-M-02's history panel then has to diff it by eye to find that someone
 * changed a shift. Creates and deletes keep everything: there is nothing to
 * compare against, and the full row is the useful record.
 */
export function diffJson(
  before: unknown,
  after: unknown,
): { before: unknown; after: unknown } {
  if (!isPlainRecord(before) || !isPlainRecord(after)) {
    return { before: redact(before), after: redact(after) };
  }

  const changedBefore: Json = {};
  const changedAfter: Json = {};

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const left = before[key];
    const right = after[key];
    // JSON comparison rather than deep equality: the values are about to be
    // stored as jsonb, so equality after serialisation is the equality that
    // matters, and it costs nothing to reuse it.
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    changedBefore[key] = left;
    changedAfter[key] = right;
  }

  return { before: redact(changedBefore), after: redact(changedAfter) };
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectDatabase() private readonly db: Database) {}

  /**
   * Best-effort writer for existing callers. Returns false and logs identifiers
   * on failure; this does not provide a durable recovery record.
   */
  async write(entry: AuditWrite): Promise<boolean> {
    try {
      await this.writeInTransaction(entry, this.db);
      return true;
    } catch (error: unknown) {
      this.logger.error({
        msg: 'AUDIT WRITE FAILED. The action succeeded but is not in the trail.',
        reason: describeError(error),
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        actorUserId: entry.actorUserId,
        orgId: entry.orgId,
        requestId: entry.requestId,
      });
      return false;
    }
  }

  /** Call inside the business transaction when a missing trail must roll it back. */
  async writeInTransaction(entry: AuditWrite, executor: Database): Promise<void> {
    const hasDiff = entry.before !== undefined || entry.after !== undefined;
    const diff = hasDiff ? diffJson(entry.before, entry.after) : { before: null, after: null };

    await executor.insert(auditLogs).values({
      orgId: entry.orgId,
      actorUserId: entry.actorUserId,
      impersonatorUserId: entry.impersonatorUserId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      // A non-UUID id would be rejected by the column type and take the
      // request's error path with it. Entities keyed by something else are
      // identified inside `after` instead.
      entityId: typeof entry.entityId === 'string' && isUuid(entry.entityId)
        ? entry.entityId
        : null,
      before: diff.before ?? null,
      after: diff.after ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      requestId: entry.requestId ?? null,
    });
  }

}
