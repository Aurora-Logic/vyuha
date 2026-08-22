import { Injectable } from '@nestjs/common';
import type { VoucherPushPayload } from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../db/db.provider.js';

/**
 * One push job for one document (09 §3.3: one voucher per request). The
 * job's entity_type carries the document id, so two documents queue side by
 * side while one document can never have two pushes open. The agent renders
 * the XML from the payload; the API never writes Tally XML. Shared by every
 * pushing module (D-37).
 */
@Injectable()
export class PushQueueService {
  constructor(@InjectDatabase() private readonly db: Database) {}

  /**
   * The connection an agent can work for this party, or failing that for this
   * organisation, or null.
   *
   * An organisation may hold more than one Tally company, one connection
   * each. This used to take the oldest connection whatever the document was
   * for, so a document raised against the second company queued on the first,
   * and the agent bound to that company would have written the voucher into
   * the wrong books. The party names its company, so the party decides.
   *
   * `parties` is the platform's own projection, so asking it here crosses no
   * module boundary.
   */
  async agentConnection(orgId: string, partyId?: string | null): Promise<string | null> {
    const rows = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM integration_connections
       WHERE org_id = ${orgId} AND deleted_at IS NULL AND company_guid IS NOT NULL AND agent_token_hash IS NOT NULL
       ORDER BY (id = (SELECT connection_id FROM parties WHERE id = ${partyId ?? null}::uuid AND org_id = ${orgId})) DESC NULLS LAST,
                created_at
       LIMIT 1
    `);
    return rows.rows[0]?.id ?? null;
  }

  /** Null when no connection can carry it, or when a push for this document is already open. */
  async enqueue(orgId: string, actorUserId: string | null, payload: VoucherPushPayload, partyId?: string | null): Promise<string | null> {
    const connectionId = await this.agentConnection(orgId, partyId);
    if (connectionId === null) return null;
    const inserted = await this.db.execute<{ id: string }>(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type, payload, created_by)
      VALUES (${orgId}, ${connectionId}, 'PUSH', ${`voucher_push:${payload.documentId}`}, ${JSON.stringify(payload)}::jsonb, ${actorUserId})
      ON CONFLICT (connection_id, entity_type) WHERE state IN ('QUEUED', 'CLAIMED')
      DO NOTHING
      RETURNING id
    `);
    return inserted.rows[0]?.id ?? null;
  }
}
