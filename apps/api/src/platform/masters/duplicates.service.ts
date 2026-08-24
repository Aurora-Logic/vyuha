import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_DUPLICATES_POLICY,
  DUPLICATE_MATCH_FIELDS,
  duplicatesPolicySchema,
  type DuplicateClusterMember,
  type DuplicateClusterState,
  type DuplicateClusterView,
  type DuplicateClustersQuery,
  type DuplicateDetectionResult,
  type DuplicateEntityType,
  type DuplicateFlag,
  type DuplicateMatchField,
  type Paginated,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import type { Principal } from '../rbac/principal.js';
import { blockKeys, clusterPairs, clusterSignature, scoreItems, scoreParties, type Cluster, type ItemRecord, type PairMatch, type PartyRecord } from './duplicate-matching.js';

/**
 * Area AO: the clusters, kept. The detector runs after a pull (a job, never
 * on a list render -- REQ-AO-13), compares what the projection holds, and
 * writes clusters with a signature; the lists read a flag through one join.
 * Nothing here writes to a party or an item (REQ-AO-11): a cluster is marked
 * sent to Tally, and the next pull shows the merge -- a member gone absent
 * or the pair no longer matching -- which resolves it with no hand on it.
 */

export const DUPLICATE_CONFIDENCE_SETTING_KEY = 'masters.duplicate_confidence_min';

/** The states in which a record still highlights: the data is still doubled, whatever has been said about it. */
const FLAGGING_STATES: readonly DuplicateClusterState[] = ['open', 'sent_to_tally'];

type ClusterRow = {
  id: string;
  entity_type: DuplicateEntityType;
  confidence: string;
  matched_fields: string;
  state: DuplicateClusterState;
  signature: string;
  dismissed_reason: string | null;
  dismissed_by_name: string | null;
  dismissed_at: Date | string | null;
  sent_to_tally_at: Date | string | null;
  detected_at: Date | string;
  last_seen_at: Date | string;
  resolved_at: Date | string | null;
  open_documents: number;
  outstanding: string;
  recent_transactions: number;
};

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function fieldsOf(text: string): DuplicateMatchField[] {
  return text.split(',').filter((f): f is DuplicateMatchField => (DUPLICATE_MATCH_FIELDS as readonly string[]).includes(f));
}

@Injectable()
export class DuplicatesService {
  private readonly logger = new Logger(DuplicatesService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
  ) {}

  // ---------------------------------------------------------------- detect

  /** REQ-AO-04 / D-56: the threshold from settings, the default when unset. */
  async confidenceMin(orgId: string): Promise<number> {
    const row = await this.db
      .execute<{ value: unknown }>(sql`SELECT value FROM settings WHERE org_id = ${orgId} AND scope = 'ORG' AND scope_id IS NULL AND deleted_at IS NULL AND key = ${DUPLICATE_CONFIDENCE_SETTING_KEY}`)
      .then((r) => r.rows[0]);
    if (row === undefined) return DEFAULT_DUPLICATES_POLICY.confidenceMin;
    const parsed = duplicatesPolicySchema.shape.confidenceMin.safeParse(row.value);
    return parsed.success ? parsed.data : DEFAULT_DUPLICATES_POLICY.confidenceMin;
  }

  async detect(orgId: string, entityType: DuplicateEntityType, actorUserId: string | null = null): Promise<DuplicateDetectionResult> {
    const threshold = await this.confidenceMin(orgId);
    const { records, pairs } = entityType === 'party' ? await this.partyPairs(orgId) : await this.itemPairs(orgId);
    const kept = pairs.filter((p) => p.confidence >= threshold - 1e-9);
    const clusters = clusterPairs(kept);
    const outcome = await this.persist(orgId, entityType, clusters);
    this.auditContext.record({
      orgId,
      actorUserId: actorUserId ?? undefined,
      action: 'masters.duplicates.detected',
      entityType: 'duplicate_cluster',
      entityId: orgId,
      before: null,
      after: { entityType, scanned: records, clusters: clusters.length, ...outcome, threshold },
    });
    this.logger.log({ msg: 'Duplicates detected', orgId, entityType, scanned: records, clusters: clusters.length, ...outcome });
    return { entityType, scanned: records, clusters: clusters.length, ...outcome };
  }

  private async partyPairs(orgId: string): Promise<{ records: number; pairs: PairMatch[] }> {
    const rows = await this.db
      .execute<{ id: string; name: string; alias: string | null; gstin: string | null; phone: string | null; email: string | null; address: string | null }>(sql`
        SELECT id, name, alias, gstin, phone, email, address FROM parties WHERE org_id = ${orgId} AND NOT absent_in_tally
      `)
      .then((r) => r.rows);
    const records: PartyRecord[] = rows.map((r) => ({ id: r.id, name: r.name, alias: r.alias, gstin: r.gstin, phone: r.phone, email: r.email, address: r.address }));
    return { records: records.length, pairs: this.pairsOf('party', records, (a, b) => scoreParties(a, b)) };
  }

  private async itemPairs(orgId: string): Promise<{ records: number; pairs: PairMatch[] }> {
    const rows = await this.db
      .execute<{ id: string; name: string; alias: string | null; unit: string; parent_group: string }>(sql`
        SELECT id, name, alias, unit, parent_group FROM stock_items WHERE org_id = ${orgId} AND NOT absent_in_tally
      `)
      .then((r) => r.rows);
    const records: ItemRecord[] = rows.map((r) => ({ id: r.id, name: r.name, alias: r.alias, unit: r.unit, parentGroup: r.parent_group }));
    return { records: records.length, pairs: this.pairsOf('stock_item', records, (a, b) => scoreItems(a, b)) };
  }

  /** Candidates share a block; each pair is scored once. */
  private pairsOf<T extends PartyRecord | ItemRecord>(entityType: DuplicateEntityType, records: readonly T[], score: (a: T, b: T) => PairMatch | null): PairMatch[] {
    const blocks = new Map<string, T[]>();
    for (const record of records) {
      for (const key of blockKeys(entityType, record)) {
        const block = blocks.get(key) ?? [];
        block.push(record);
        blocks.set(key, block);
      }
    }
    const seen = new Set<string>();
    const pairs: PairMatch[] = [];
    for (const block of blocks.values()) {
      if (block.length < 2 || block.length > 500) continue;
      for (let i = 0; i < block.length; i += 1) {
        for (let j = i + 1; j < block.length; j += 1) {
          const a = block[i];
          const b = block[j];
          if (a === undefined || b === undefined) continue;
          const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          const match = score(a, b);
          if (match !== null) pairs.push(match);
        }
      }
    }
    return pairs;
  }

  /**
   * Clusters by signature: the same again is seen again (a dismissal stands),
   * a new one opens, a resolved one seen again reopens, and one no longer
   * produced -- the merge happened in Tally, or a field changed -- resolves.
   */
  private async persist(orgId: string, entityType: DuplicateEntityType, clusters: readonly Cluster[]): Promise<{ opened: number; resolved: number; reopened: number }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .execute<{ id: string; signature: string; state: DuplicateClusterState }>(sql`
          SELECT id, signature, state FROM duplicate_clusters WHERE org_id = ${orgId} AND entity_type = ${entityType}
        `)
        .then((r) => new Map(r.rows.map((row) => [row.signature, row])));
      let opened = 0;
      let resolved = 0;
      let reopened = 0;
      const seen = new Set<string>();
      for (const cluster of clusters) {
        const signature = clusterSignature(cluster);
        seen.add(signature);
        const fields = cluster.fields.join(',');
        const found = existing.get(signature);
        if (found === undefined) {
          const inserted = await tx.execute<{ id: string }>(sql`
            INSERT INTO duplicate_clusters (org_id, entity_type, confidence, matched_fields, state, signature, member_count)
            VALUES (${orgId}, ${entityType}, ${cluster.confidence}, ${fields}, 'open', ${signature}, ${cluster.members.length}) RETURNING id
          `);
          const id = inserted.rows[0]?.id;
          if (id === undefined) throw new Error('Duplicate cluster insert returned no row.');
          for (const member of cluster.members) {
            await tx.execute(sql`INSERT INTO duplicate_cluster_members (org_id, cluster_id, entity_type, entity_id) VALUES (${orgId}, ${id}, ${entityType}, ${member})`);
          }
          opened += 1;
          continue;
        }
        if (found.state === 'resolved') {
          await tx.execute(sql`UPDATE duplicate_clusters SET state = 'open', resolved_at = NULL, confidence = ${cluster.confidence}, last_seen_at = now(), updated_at = now() WHERE id = ${found.id}`);
          reopened += 1;
        } else {
          await tx.execute(sql`UPDATE duplicate_clusters SET confidence = ${cluster.confidence}, last_seen_at = now(), updated_at = now() WHERE id = ${found.id}`);
        }
      }
      for (const [signature, row] of existing) {
        if (seen.has(signature) || row.state === 'resolved') continue;
        await tx.execute(sql`UPDATE duplicate_clusters SET state = 'resolved', resolved_at = now(), updated_at = now() WHERE id = ${row.id}`);
        resolved += 1;
      }
      return { opened, resolved, reopened };
    });
  }

  // ------------------------------------------------------------------ read

  /** REQ-AO-06: the flag a list row wears, for a page of ids in one query. */
  async flagsFor(orgId: string, entityType: DuplicateEntityType, ids: readonly string[]): Promise<Map<string, DuplicateFlag>> {
    const out = new Map<string, DuplicateFlag>();
    if (ids.length === 0) return out;
    const rows = await this.db
      .execute<{ entity_id: string; cluster_id: string; confidence: string; matched_fields: string; others: string[] | null }>(sql`
        SELECT m.entity_id, c.id AS cluster_id, c.confidence::text, c.matched_fields,
               (SELECT array_agg(coalesce(p.name, s.name) ORDER BY coalesce(p.name, s.name))
                  FROM duplicate_cluster_members o
                  LEFT JOIN parties p ON p.id = o.entity_id AND o.entity_type = 'party'
                  LEFT JOIN stock_items s ON s.id = o.entity_id AND o.entity_type = 'stock_item'
                 WHERE o.cluster_id = c.id AND o.entity_id <> m.entity_id) AS others
          FROM duplicate_cluster_members m
          JOIN duplicate_clusters c ON c.id = m.cluster_id
         WHERE m.org_id = ${orgId} AND m.entity_type = ${entityType}
           AND m.entity_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
           AND c.state IN ('open', 'sent_to_tally')
      `)
      .then((r) => r.rows);
    for (const row of rows) {
      out.set(row.entity_id, { clusterId: row.cluster_id, confidence: Number(row.confidence), matchedFields: fieldsOf(row.matched_fields), others: (row.others ?? []).filter((n): n is string => n !== null) });
    }
    return out;
  }

  /** REQ-AO-10: clusters ranked by impact -- open documents, outstanding, recent transactions -- so the ones splitting the ledger come first. */
  async list(principal: Principal, query: DuplicateClustersQuery): Promise<Paginated<DuplicateClusterView>> {
    const orgId = principal.orgId;
    const offset = (query.page - 1) * query.pageSize;
    const where = sql`c.org_id = ${orgId}
      ${query.entityType === undefined ? sql`` : sql`AND c.entity_type = ${query.entityType}`}
      ${query.state === undefined ? sql`AND c.state IN ('open', 'sent_to_tally')` : sql`AND c.state = ${query.state}`}`;
    const body = this.clusterBody(where);
    const [rows, total] = await Promise.all([
      this.db.execute<ClusterRow>(sql`
        SELECT * FROM (${body}) t
         ORDER BY (t.state = 'open') DESC, (t.open_documents + t.recent_transactions) DESC, t.outstanding::numeric DESC, t.confidence::numeric DESC, t.detected_at DESC
         LIMIT ${query.pageSize} OFFSET ${offset}
      `),
      this.db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM duplicate_clusters c WHERE ${where}`),
    ]);
    const members = await this.membersOf(orgId, rows.rows.map((r) => r.id));
    return {
      data: rows.rows.map((row) => this.toView(row, members.get(row.id) ?? [])),
      meta: { page: query.page, pageSize: query.pageSize, total: total.rows[0]?.count ?? 0 },
    };
  }

  /** One row as the screens read it. Shared, so the list and a single read cannot drift. */
  private toView(row: ClusterRow, members: DuplicateClusterMember[]): DuplicateClusterView {
    return {
      id: row.id,
      entityType: row.entity_type,
      confidence: Number(row.confidence),
      matchedFields: fieldsOf(row.matched_fields),
      state: row.state,
      members,
      impact: { openDocuments: row.open_documents, outstanding: Number(row.outstanding).toFixed(2), recentTransactions: row.recent_transactions },
      dismissedReason: row.dismissed_reason,
      dismissedByName: row.dismissed_by_name,
      dismissedAt: iso(row.dismissed_at),
      sentToTallyAt: iso(row.sent_to_tally_at),
      detectedAt: iso(row.detected_at) ?? '',
      lastSeenAt: iso(row.last_seen_at) ?? '',
      resolvedAt: iso(row.resolved_at),
    };
  }


  /**
   * One cluster with its impact figures, unordered and unlimited, so the
   * ranked list and a direct read of one row can compose it.
   *
   * `requireCluster` used to find its row by paging the ranked list -- one
   * row, then five hundred -- and give up. Every action on a cluster ranked
   * below five hundred (dismiss, send to Tally, reopen) answered 404 for a
   * cluster that plainly existed, and the comment above it said "a direct
   * read for the one row", which is what it did not do. Now there is one.
   */
  private clusterBody(where: SQL): SQL {
    return sql`
      SELECT c.id, c.entity_type, c.confidence::text, c.matched_fields, c.state, c.signature,
             c.dismissed_reason, c.dismissed_at, c.sent_to_tally_at, c.detected_at, c.last_seen_at, c.resolved_at,
             coalesce(nullif(concat_ws(' ', de.first_name, de.last_name), ''), du.email) AS dismissed_by_name,
             CASE WHEN c.entity_type = 'party' THEN
               (SELECT count(*)::int FROM sales_documents d WHERE d.org_id = c.org_id AND d.deleted_at IS NULL AND d.status IN ('CONFIRMED', 'PENDING_APPROVAL')
                  AND d.party_id IN (SELECT entity_id FROM duplicate_cluster_members mm WHERE mm.cluster_id = c.id))
             ELSE
               (SELECT count(DISTINCT l.document_id)::int FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
                 WHERE l.org_id = c.org_id AND d.status = 'CONFIRMED' AND d.short_closed_at IS NULL AND l.dispatched_qty < l.quantity
                   AND l.stock_item_id IN (SELECT entity_id FROM duplicate_cluster_members mm WHERE mm.cluster_id = c.id))
             END AS open_documents,
             CASE WHEN c.entity_type = 'party' THEN
               -- Allocations are signed against the party (owed positive, settled negative); a bill's outstanding is the sum of its new and against rows.
               coalesce((SELECT sum(b.amount) FROM bill_allocations b WHERE b.org_id = c.org_id AND b.ref_type IN ('new', 'against')
                           AND b.party_id IN (SELECT entity_id FROM duplicate_cluster_members mm WHERE mm.cluster_id = c.id)), 0)::text
             ELSE '0' END AS outstanding,
             CASE WHEN c.entity_type = 'party' THEN
               (SELECT count(*)::int FROM vouchers v WHERE v.org_id = c.org_id AND v.voucher_date >= current_date - 90
                  AND v.party_id IN (SELECT entity_id FROM duplicate_cluster_members mm WHERE mm.cluster_id = c.id))
             ELSE
               (SELECT count(*)::int FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id WHERE vl.org_id = c.org_id AND v.voucher_date >= current_date - 90
                  AND vl.stock_item_id IN (SELECT entity_id FROM duplicate_cluster_members mm WHERE mm.cluster_id = c.id))
             END AS recent_transactions
        FROM duplicate_clusters c
        LEFT JOIN users du ON du.id = c.dismissed_by
        LEFT JOIN employees de ON de.id = du.employee_id
       WHERE ${where}`;
  }

  private async membersOf(orgId: string, clusterIds: readonly string[]): Promise<Map<string, DuplicateClusterMember[]>> {
    const out = new Map<string, DuplicateClusterMember[]>();
    if (clusterIds.length === 0) return out;
    const rows = await this.db
      .execute<{ cluster_id: string; entity_id: string; name: string | null; detail: string | null; absent: boolean | null }>(sql`
        SELECT m.cluster_id, m.entity_id,
               coalesce(p.name, s.name) AS name,
               CASE WHEN m.entity_type = 'party' THEN concat_ws(' · ', p.gstin, p.parent_group, p.phone) ELSE concat_ws(' · ', s.alias, s.unit, s.parent_group) END AS detail,
               coalesce(p.absent_in_tally, s.absent_in_tally) AS absent
          FROM duplicate_cluster_members m
          LEFT JOIN parties p ON p.id = m.entity_id AND m.entity_type = 'party'
          LEFT JOIN stock_items s ON s.id = m.entity_id AND m.entity_type = 'stock_item'
         WHERE m.org_id = ${orgId} AND m.cluster_id IN (${sql.join(clusterIds.map((id) => sql`${id}::uuid`), sql`, `)})
         ORDER BY coalesce(p.name, s.name)
      `)
      .then((r) => r.rows);
    for (const row of rows) {
      const list = out.get(row.cluster_id) ?? [];
      list.push({ entityId: row.entity_id, name: row.name ?? 'Gone from the projection', detail: row.detail === '' ? null : row.detail, absentInTally: row.absent ?? true });
      out.set(row.cluster_id, list);
    }
    return out;
  }

  // ----------------------------------------------------------------- state

  /** REQ-AO-12: genuinely different, with a reason, by whom and when; never raised again unless a matched field changes. */
  async dismiss(principal: Principal, id: string, reason: string): Promise<DuplicateClusterView> {
    const cluster = await this.requireCluster(principal, id);
    if (cluster.state === 'resolved') throw AppError.conflict('This cluster resolved itself on a pull; there is nothing to dismiss.');
    await this.db.execute(sql`
      UPDATE duplicate_clusters SET state = 'dismissed', dismissed_reason = ${reason}, dismissed_by = ${principal.userId}, dismissed_at = now(), updated_at = now()
       WHERE id = ${id} AND org_id = ${principal.orgId}
    `);
    this.auditContext.record({ action: 'masters.duplicates.dismissed', entityType: 'duplicate_cluster', entityId: id, before: { state: cluster.state }, after: { state: 'dismissed', reason } });
    return this.requireCluster(principal, id);
  }

  /** REQ-AO-11: the merge is Tally's; this records that it was asked for. */
  async markSentToTally(principal: Principal, id: string): Promise<DuplicateClusterView> {
    const cluster = await this.requireCluster(principal, id);
    if (cluster.state !== 'open') throw AppError.conflict(`This cluster is ${cluster.state.replace(/_/gu, ' ')}; only an open one is sent to Tally.`);
    await this.db.execute(sql`
      UPDATE duplicate_clusters SET state = 'sent_to_tally', sent_to_tally_by = ${principal.userId}, sent_to_tally_at = now(), updated_at = now()
       WHERE id = ${id} AND org_id = ${principal.orgId}
    `);
    this.auditContext.record({ action: 'masters.duplicates.sent_to_tally', entityType: 'duplicate_cluster', entityId: id, before: { state: 'open' }, after: { state: 'sent_to_tally' } });
    return this.requireCluster(principal, id);
  }

  /** A dismissed or sent cluster back to open, when somebody was wrong. */
  async reopen(principal: Principal, id: string): Promise<DuplicateClusterView> {
    const cluster = await this.requireCluster(principal, id);
    if (cluster.state === 'open') return cluster;
    if (cluster.state === 'resolved') throw AppError.conflict('A resolved cluster comes back only if the next pull finds the duplicate again.');
    await this.db.execute(sql`
      UPDATE duplicate_clusters SET state = 'open', dismissed_reason = NULL, dismissed_by = NULL, dismissed_at = NULL, sent_to_tally_by = NULL, sent_to_tally_at = NULL, updated_at = now()
       WHERE id = ${id} AND org_id = ${principal.orgId}
    `);
    this.auditContext.record({ action: 'masters.duplicates.reopened', entityType: 'duplicate_cluster', entityId: id, before: { state: cluster.state }, after: { state: 'open' } });
    return this.requireCluster(principal, id);
  }

  private async requireCluster(principal: Principal, id: string): Promise<DuplicateClusterView> {
    const rows = await this.db.execute<ClusterRow>(
      this.clusterBody(sql`c.org_id = ${principal.orgId} AND c.id = ${id}`),
    );
    const row = rows.rows[0];
    if (row === undefined) throw AppError.notFound('Duplicate cluster', id);
    const members = await this.membersOf(principal.orgId, [id]);
    return this.toView(row, members.get(id) ?? []);
  }

  /** The states a record still highlights in, for the list services. */
  static readonly FLAGGING_STATES = FLAGGING_STATES;
}
