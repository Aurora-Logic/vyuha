import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError } from '../common/errors.js';
import type { Transaction } from './db.provider.js';

const keySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Technical design §6: receipt and mutation share the caller's transaction. */
export async function idempotentCreate(
  tx: Transaction,
  request: { orgId: string; userId: string; operation: string; key?: string; input: unknown },
  create: () => Promise<string>,
): Promise<string> {
  if (request.key === undefined) return create();
  if (!keySchema.safeParse(request.key).success) {
    throw AppError.validation('Idempotency-Key must be 1–128 letters, digits, dots, dashes or underscores.');
  }
  const fingerprint = createHash('sha256').update(canonical(request.input)).digest('hex');
  const lock = JSON.stringify([request.orgId, request.userId, request.operation, request.key]);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
  const existing = await tx.execute<{ fingerprint: string; entity_id: string }>(sql`
    SELECT fingerprint, entity_id FROM request_receipts
    WHERE org_id = ${request.orgId} AND user_id = ${request.userId}
      AND operation = ${request.operation} AND request_key = ${request.key}
  `);
  const receipt = existing.rows[0];
  if (receipt !== undefined) {
    if (receipt.fingerprint !== fingerprint) throw AppError.conflict('That Idempotency-Key was already used with different request data.');
    return receipt.entity_id;
  }
  const id = await create();
  await tx.execute(sql`
    INSERT INTO request_receipts (org_id, user_id, operation, request_key, fingerprint, entity_id)
    VALUES (${request.orgId}, ${request.userId}, ${request.operation}, ${request.key}, ${fingerprint}, ${id})
  `);
  return id;
}
