import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { ALIVE, primaryId, standardColumns } from '../columns.js';
import { organizations, parties } from './index.js';

/**
 * Area AL — the customer portal's access (15 REQ-AL-03…AL-07).
 *
 * The key is stored as a hash and nowhere else. It is shown once, in the
 * reply that issues it, and a list of keys can never leak a portal: the
 * same reason a password is not kept in the clear applies here, because
 * this key *is* the credential for one customer's whole trading history.
 *
 * `revoked_at` rather than a delete, and read on every request rather than
 * cached: REQ-AL-07 wants a withdrawal to take effect now, not at the next
 * expiry, and a row that is gone cannot say when or why it went.
 */
export const portalLinkKeys = pgTable(
  'portal_link_keys',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    /** SHA-256 of the key. Unique across the table: a collision would hand one key two parties. */
    keyHash: text('key_hash').notNull(),
    issuedBy: uuid('issued_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
    revokeReason: text('revoke_reason'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    note: text('note'),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('portal_link_keys_hash_uq').on(t.keyHash),
    // REQ-AL-01: one link per party. A second live key for the same party is
    // a second thing to withdraw, and somebody will withdraw only one of them.
    uniqueIndex('portal_link_keys_party_live_uq').on(t.orgId, t.partyId).where(sql`deleted_at IS NULL AND revoked_at IS NULL`),
    index('portal_link_keys_org_party_idx').on(t.orgId, t.partyId).where(ALIVE),
    check('portal_link_keys_revocation_reasoned', sql`revoked_at IS NULL OR revoke_reason IS NOT NULL`),
  ],
);

/**
 * REQ-AL-06: every view — key, party, what was viewed, when, from where.
 *
 * Its own table rather than `audit_logs`, which records what a *user* did:
 * there is no user here, and an actor column full of nulls would make the
 * staff trail harder to read to no benefit. Refused attempts are recorded
 * too, with a null key, because a stream of them is the signal that matters.
 */
export const portalAccessLog = pgTable(
  'portal_access_log',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    linkKeyId: uuid('link_key_id').references(() => portalLinkKeys.id, { onDelete: 'set null' }),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }),
    /** `portal`, `media`, or `refused`. */
    view: text('view').notNull(),
    outcome: text('outcome').notNull(),
    // text, as `audit_logs` stores it: the value is read by people, and an
    // `inet` column refuses the proxy-supplied strings that actually arrive.
    ip: text('ip'),
    userAgent: text('user_agent'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('portal_access_log_org_at_idx').on(t.orgId, t.at), index('portal_access_log_key_idx').on(t.linkKeyId)],
);
