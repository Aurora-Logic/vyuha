import { sql } from 'drizzle-orm';
import { index, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { primaryId } from '../columns.js';
import { organizations } from './organizations.schema.js';

/**
 * Area AO: likely duplicates in the pulled masters, written by the
 * detector job after each pull and read by every list through one cheap
 * join (REQ-AO-13). Beside the projection, not on it: a cluster is
 * Vyuha's opinion about Tally's records, and it must survive a rebuild of
 * the projection the way a dismissal must survive a pull.
 *
 * `signature` is the sorted set of member ids plus the fields they matched
 * on, so the detector can tell "the same cluster again" (the dismissal
 * stands) from "a matching field changed" (it is raised anew, REQ-AO-12).
 */

export const duplicateEntityTypeEnum = pgEnum('duplicate_entity_type', ['party', 'stock_item']);
export const duplicateClusterStateEnum = pgEnum('duplicate_cluster_state', ['open', 'sent_to_tally', 'dismissed', 'resolved']);

export const duplicateClusters = pgTable(
  'duplicate_clusters',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    entityType: duplicateEntityTypeEnum('entity_type').notNull(),
    /** 0 to 1; the strongest pair in the cluster. */
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    /** Comma-separated DuplicateMatchField names, in the contract's order. */
    matchedFields: text('matched_fields').notNull(),
    state: duplicateClusterStateEnum('state').notNull().default('open'),
    signature: text('signature').notNull(),
    memberCount: integer('member_count').notNull(),
    dismissedReason: text('dismissed_reason'),
    dismissedBy: uuid('dismissed_by'),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    sentToTallyBy: uuid('sent_to_tally_by'),
    sentToTallyAt: timestamp('sent_to_tally_at', { withTimezone: true }),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('duplicate_clusters_org_type_state_idx').on(t.orgId, t.entityType, t.state),
    /*
     * The signature is member ids joined together and grows with the cluster;
     * a btree index row caps at ~2.7KB, so a cluster of about seventy-five
     * real (incompressible) uuids crashed the detector's insert. The index
     * dedupes on the hash; the service still compares full signatures in
     * memory, so a collision cannot merge two different clusters silently --
     * it would only refuse the second insert, which is the failure we can
     * live with.
     */
    uniqueIndex('duplicate_clusters_org_signature_md5_uq').on(t.orgId, sql`md5(${t.signature})`),
  ],
);

export const duplicateClusterMembers = pgTable(
  'duplicate_cluster_members',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => duplicateClusters.id, { onDelete: 'cascade' }),
    entityType: duplicateEntityTypeEnum('entity_type').notNull(),
    /** A party or stock item id; no foreign key, because the projection is truncatable and this must survive it. */
    entityId: uuid('entity_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('duplicate_cluster_members_cluster_idx').on(t.clusterId),
    // The list screens' one join: this record, in an open cluster?
    index('duplicate_cluster_members_org_entity_idx').on(t.orgId, t.entityType, t.entityId),
  ],
);
