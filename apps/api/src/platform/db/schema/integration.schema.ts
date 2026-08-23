import type { AgentCondition } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { ALIVE, primaryId, standardColumns } from '../columns.js';
import { organizations } from './organizations.schema.js';

export const integrationSystemEnum = pgEnum('integration_system', ['TALLY']);

/**
 * Where a Vyuha-created document stands against Tally (08 §3 glossary).
 * `voided_in_tally` rather than deletion, per REQ-T-04: history is not erased
 * by a voucher disappearing from the books. Defined here beside the table
 * that carries it; `sync.schema.ts` imports from this file, never back.
 */
export const tallySyncStateEnum = pgEnum('tally_sync_state', [
  'draft',
  'queued',
  'pushed',
  'failed',
  'voided_in_tally',
]);
export const integrationStatusEnum = pgEnum('integration_status', [
  'DISCONNECTED',
  'CONNECTED',
  'STALE',
  'ERROR',
]);

/**
 * Technical design §14, Phase 0 scope: the tables and the interface exist now
 * so Phase 6 is additive. Nothing syncs yet, and the stubbed provider only
 * heartbeats.
 *
 * The agent authenticates with a per-connection token and calls outbound only,
 * so Tally's port 9000 never faces the internet (§14.1).
 */
export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    system: integrationSystemEnum('system').notNull(),
    name: text('name').notNull(),
    status: integrationStatusEnum('status').notNull().default('DISCONNECTED'),
    agentTokenHash: text('agent_token_hash'),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    config: jsonb('config'),

    /*
     * Phase 6b (09 §4.2): a connection is one Tally *company*, not one
     * installation — four financial years as four companies is four
     * connections (REQ-Q-03). The company GUID is what the agent reports on
     * every heartbeat, so a job for the wrong open company is refused rather
     * than executed against the wrong books (09 §7).
     */
    companyGuid: text('company_guid'),
    companyName: text('company_name'),
    fyFrom: date('fy_from'),
    fyTo: date('fy_to'),
    /** REQ-Q-04: the heartbeat carries both versions; staleness alerts read them. */
    agentVersion: text('agent_version'),
    tallyVersion: text('tally_version'),
    /** One agent per company, enforced by a lease (09 §3.4). Null means unheld. */
    leaseHolder: text('lease_holder'),
    /**
     * REQ-Q-05: which specific problem the last heartbeat carried — reported
     * by the agent or derived from a company-GUID mismatch. Stored so the
     * Integrations screen can name the fix, not just say ERROR.
     */
    lastCondition: text('last_condition').$type<AgentCondition>(),
    /**
     * REQ-Q-04's edge detector. Set when the staleness sweep alerts, cleared
     * when heartbeats resume (which sends the recovery notice). The alert
     * fires on the transition, not the state — without this, every sweep
     * over a dead agent would notify again, and a bell that cries every two
     * minutes about the same silence teaches people to silence the bell.
     */
    staleNotifiedAt: timestamp('stale_notified_at', { withTimezone: true }),
    /**
     * The OpsTally webhook signing secret (whsec_…), sealed with AES-GCM
     * under a key derived from the app secret — reversible on purpose, and
     * unlike the agent token hash: verifying an HMAC over a delivery needs
     * the secret itself, not a digest of it. Present means this connection's
     * transport is the webhook; it and `agent_token_hash` are exclusive.
     */
    webhookSecretEnc: text('webhook_secret_enc'),
    /**
     * OpsTally's install id, bound on the first verified delivery. A second
     * install pointing at the same connection is refused, the way a second
     * agent instance is refused by the lease (REQ-Q-03: one company, one
     * connection).
     */
    webhookInstallId: text('webhook_install_id'),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('integration_connections_uq').on(t.orgId, t.system, t.name).where(ALIVE),
    /*
     * One company, one connection, one door. The comment on
     * `webhookSecretEnc` already says the two credentials are exclusive, and
     * the service checked it -- by reading the row first, outside any lock,
     * so two administrators acting at once both read "no other credential"
     * and both wrote. A connection then had an agent token and a webhook
     * secret at the same time, and which transport it used depended on which
     * lookup ran. This is that sentence made load-bearing, beside the two
     * unique indexes that hold the neighbouring rules for the same reason.
     */
    check('integration_connections_one_door', sql`agent_token_hash IS NULL OR webhook_secret_enc IS NULL`),
    /*
     * The hot auth lookup, and a guarantee in one: a credential can never
     * resolve to two connections, however the issuance code evolves.
     */
    uniqueIndex('integration_connections_token_uq')
      .on(t.agentTokenHash)
      .where(sql`agent_token_hash IS NOT NULL AND deleted_at IS NULL`),
    /*
     * REQ-Q-03 held by the schema rather than by admin discipline: two live
     * connections bound to one company would mean two leases, two cursors and
     * two idempotency scopes legally syncing the same books — defeating both
     * controls that presume this uniqueness.
     */
    uniqueIndex('integration_connections_company_uq')
      .on(t.orgId, t.system, t.companyGuid)
      .where(sql`company_guid IS NOT NULL AND deleted_at IS NULL`),
  ],
);

/**
 * Technical design §14.2, and the reason Phase 6 is possible at all.
 *
 * Tally identifies masters by a stable GUID and tracks changes with a
 * monotonic ALTERID. Storing both lets an incremental sync ask only for
 * records newer than the last one seen, instead of re-importing everything.
 *
 * Mapping is explicit and never inferred: a name match between a Tally ledger
 * and an internal record is a suggestion for a human to confirm, never an
 * automatic link. Two employees called the same thing is not a hypothetical.
 */
export const externalRefs = pgTable(
  'external_refs',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    system: integrationSystemEnum('system').notNull(),

    entityType: text('entity_type').notNull(),
    externalGuid: text('external_guid').notNull(),
    externalAlterId: bigint('external_alter_id', { mode: 'number' }),

    /** `EMPLOYEE` is required in Phase 0 per §14.3 step 1. */
    internalType: text('internal_type').notNull(),
    internalId: uuid('internal_id').notNull(),

    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),

    /*
     * Phase 6b (09 §4.1): the seam becomes a sync anchor. 09's sketch spells
     * some of these differently — its `provider` is this table's `system`,
     * its `remote_guid` and `remote_alter_id` are `external_guid` and
     * `external_alter_id` above — and the existing Phase 0 names win, because
     * renaming a live table's columns buys nothing but churn. All additive;
     * Phase 0 rows simply carry nulls.
     */
    connectionId: uuid('connection_id').references(() => integrationConnections.id, {
      onDelete: 'restrict',
    }),
    remoteVoucherNumber: text('remote_voucher_number'),
    remoteVoucherType: text('remote_voucher_type'),
    /** Never inferred, only reported by the agent (REQ-W-06). */
    syncState: tallySyncStateEnum('sync_state'),
    /**
     * Carried in the voucher's remote narration field and queried before any
     * retry, so a lost response cannot become a second voucher (09 §3.3) —
     * the single most damaging failure this system could have.
     */
    idempotencyKey: text('idempotency_key'),
    lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
    lastPulledAt: timestamp('last_pulled_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('external_refs_external_uq')
      .on(t.orgId, t.system, t.entityType, t.externalGuid)
      .where(ALIVE),
    // One internal record maps to at most one external record per system, or
    // the conflict rule in §14.2 has no single answer about what Tally wins over.
    uniqueIndex('external_refs_internal_uq')
      .on(t.orgId, t.system, t.internalType, t.internalId)
      .where(ALIVE),
    index('external_refs_alter_idx').on(t.orgId, t.system, t.entityType, t.externalAlterId),
    // A reused idempotency key within one company would defeat the duplicate
    // check it exists for. Partial: Phase 0 rows and pull-only rows carry none.
    uniqueIndex('external_refs_idempotency_uq')
      .on(t.connectionId, t.idempotencyKey)
      .where(sql`connection_id IS NOT NULL AND idempotency_key IS NOT NULL AND deleted_at IS NULL`),
  ],
);
