import type { BlockingReference, RecycleBinEntry, SoftDeletableEntity } from '@vyuha/shared';
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import type { Database } from '../db/db.provider.js';
import { escapeLike } from '../db/like.js';
import { deletionRecords, users } from '../db/schema/index.js';
import type { OrgContext, ScopedTable } from '../db/scoped-repository.js';
import type { BlockingReferenceSpec, SoftDeletableSpec } from './soft-deletable.js';

/**
 * Every read and write the recycle bin performs.
 *
 * `ScopedRepository` is not the base class here for the same reason the day
 * engine's is not: the table is chosen at runtime from a registry, so the
 * statements are built from `PgColumn` references rather than from one concrete
 * table type. The rule that class exists to enforce still holds — every
 * statement below filters `org_id` from `ctx`, and because "deleted" is
 * sometimes the thing being *selected for*, the aliveness predicate is stated
 * explicitly on both sides rather than defaulted.
 */

/** How many blocking rows to name before falling back to "and N others". */
const REFERENCE_EXAMPLES = 3;

export interface MasterRow {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  /** The value of `spec.uniqueColumn`, for the restore clash check. */
  readonly uniqueValue: string | null;
}

/** A column rendered as text, so one query shape serves six differently typed masters. */
function asText(column: PgColumn | null): SQL<string | null> {
  return column === null ? sql<string | null>`null::text` : sql<string | null>`${column}::text`;
}

export class RecycleBinRepository {
  constructor(
    private readonly db: Database,
    private readonly ctx: OrgContext,
  ) {}

  /** The living row, or null when the id is another org's, unknown, or deleted. */
  findLive(spec: SoftDeletableSpec, id: string): Promise<MasterRow | null> {
    return this.findOne(spec, id, isNull(spec.table.deletedAt));
  }

  /** The soft-deleted row, or null when it is another org's, unknown, or alive. */
  findDeleted(spec: SoftDeletableSpec, id: string): Promise<MasterRow | null> {
    return this.findOne(spec, id, isNotNull(spec.table.deletedAt));
  }

  /**
   * Which live rows point at this record, and what they are called.
   *
   * One small query per declared reference rather than a single joined one. Six
   * masters declare between one and three references each and the counts are
   * tiny; a hand-built union would be a lot of SQL to save a few milliseconds
   * on an action somebody performs once a month.
   */
  async findBlockingReferences(
    spec: SoftDeletableSpec,
    id: string,
  ): Promise<BlockingReference[]> {
    const found: BlockingReference[] = [];

    for (const reference of spec.references) {
      const rows = await this.db
        .select({
          label: sql<string>`coalesce(${reference.labelColumn}::text, '(unnamed)')`,
          total: sql<number>`count(*) OVER ()::int`,
        })
        .from(widen(reference.table))
        .where(this.liveReference(reference, id))
        .limit(REFERENCE_EXAMPLES);

      const total = rows[0]?.total ?? 0;
      if (total === 0) continue;

      found.push({
        entityType: reference.label,
        label: reference.label,
        count: total,
        examples: rows.map((row) => row.label),
      });
    }

    return found;
  }

  /**
   * Sets `deleted_at`. False means the row was already gone, which the caller
   * reads as a lost race rather than as an error.
   *
   * `updated_by` is stamped too, so the row can name its own last actor rather
   * than only the deletion record beside it.
   */
  async markDeleted(spec: SoftDeletableSpec, id: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(widen(spec.table))
      .set({ deletedAt: now, updatedAt: now, updatedBy: this.ctx.actorUserId })
      .where(and(this.scopedTo(spec.table, id), isNull(spec.table.deletedAt)))
      .returning({ id: spec.table.id });
    return rows.length > 0;
  }

  async markRestored(spec: SoftDeletableSpec, id: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(widen(spec.table))
      .set({ deletedAt: null, updatedAt: now, updatedBy: this.ctx.actorUserId })
      .where(and(this.scopedTo(spec.table, id), isNotNull(spec.table.deletedAt)))
      .returning({ id: spec.table.id });
    return rows.length > 0;
  }

  /**
   * A restore can collide with a living row.
   *
   * The unique indexes on every master are partial on `deleted_at IS NULL`, so
   * the code or name a delete frees can be taken by somebody else before the
   * restore. Postgres would refuse with a violation naming an index; this turns
   * it into an answer a person can act on. Returns the name of whatever took it.
   */
  async findUniqueClash(spec: SoftDeletableSpec, value: string | null): Promise<string | null> {
    const uniqueColumn = spec.uniqueColumn;
    if (uniqueColumn === null || value === null) return null;

    const rows = await this.db
      .select({ name: sql<string>`${spec.nameColumn}::text` })
      .from(widen(spec.table))
      .where(
        and(
          eq(spec.table.orgId, this.ctx.orgId),
          isNull(spec.table.deletedAt),
          sql`${uniqueColumn}::text = ${value}`,
        ),
      )
      .limit(1);

    return rows[0]?.name ?? null;
  }

  async writeDeletionRecord(input: {
    spec: SoftDeletableSpec;
    id: string;
    label: string;
    reason: string;
    at: Date;
  }): Promise<void> {
    await this.db.insert(deletionRecords).values({
      orgId: this.ctx.orgId,
      entityType: input.spec.entityType,
      entityId: input.id,
      entityLabel: input.label,
      reason: input.reason,
      deletedBy: this.ctx.actorUserId,
      deletedAt: input.at,
    });
  }

  /**
   * Closes the open deletion record, if there is one.
   *
   * There may not be: a row soft-deleted before this table existed, or by a
   * repair script, is still in the bin and still restorable. Refusing to
   * restore it for want of its paperwork would make the bin useless for exactly
   * the rows somebody most needs out of it.
   */
  async closeDeletionRecord(
    entityType: SoftDeletableEntity,
    id: string,
    reason: string,
    at: Date,
  ): Promise<void> {
    await this.db
      .update(deletionRecords)
      .set({ restoredAt: at, restoredBy: this.ctx.actorUserId, restoreReason: reason })
      .where(
        and(
          eq(deletionRecords.orgId, this.ctx.orgId),
          eq(deletionRecords.entityType, entityType),
          eq(deletionRecords.entityId, id),
          isNull(deletionRecords.restoredAt),
        ),
      );
  }

  /**
   * One master's deleted rows, with whatever the deletion record can add.
   *
   * A LEFT JOIN, not an INNER one: the master table is the source of truth for
   * what is deleted, and a row with no record still has to appear. It shows
   * with no actor and no reason, which reads as "deleted by a path that did not
   * say why" — true, and better than absent.
   */
  async listDeleted(
    spec: SoftDeletableSpec,
    filters: { q?: string | undefined; limit: number },
  ): Promise<{ entries: RecycleBinEntry[]; total: number }> {
    const search =
      filters.q === undefined
        ? undefined
        : sql`${spec.nameColumn}::text ILIKE ${`%${escapeLike(filters.q)}%`} ESCAPE '\\'`;

    const where = and(
      eq(spec.table.orgId, this.ctx.orgId),
      isNotNull(spec.table.deletedAt),
      search,
    );

    const rows = await this.db
      .select({
        id: sql<string>`${spec.table.id}::text`,
        name: sql<string>`${spec.nameColumn}::text`,
        code: asText(spec.codeColumn),
        deletedAt: sql<string>`to_char(${spec.table.deletedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        reason: deletionRecords.reason,
        actorId: users.id,
        // Left-joined, so drizzle's non-null column type is a lie here: an
        // unmatched join produces null. Coalesced rather than asserted.
        actorEmail: sql<string>`coalesce(${users.email}, '')`,
        total: sql<number>`count(*) OVER ()::int`,
      })
      .from(widen(spec.table))
      .leftJoin(
        deletionRecords,
        and(
          eq(deletionRecords.entityId, spec.table.id),
          eq(deletionRecords.entityType, spec.entityType),
          isNull(deletionRecords.restoredAt),
        ),
      )
      .leftJoin(users, eq(users.id, deletionRecords.deletedBy))
      .where(where)
      .orderBy(desc(spec.table.deletedAt))
      .limit(filters.limit);

    const entries = rows.map(
      (row): RecycleBinEntry => ({
        entityType: spec.entityType,
        entityLabel: spec.label,
        id: row.id,
        name: row.name,
        code: row.code,
        deletedAt: row.deletedAt,
        deletedBy: row.actorId === null ? null : { id: row.actorId, name: row.actorEmail },
        reason: row.reason,
      }),
    );

    return { entries, total: rows[0]?.total ?? 0 };
  }

  // ------------------------------------------------------------- internals

  private scopedTo(table: SoftDeletableSpec['table'], id: string): SQL {
    const predicate = and(eq(table.orgId, this.ctx.orgId), eq(table.id, id));
    if (predicate === undefined) {
      throw new Error('Scope predicate collapsed to undefined; refusing to run an unscoped query.');
    }
    return predicate;
  }

  private liveReference(reference: BlockingReferenceSpec, id: string): SQL {
    const predicate = and(
      eq(reference.table.orgId, this.ctx.orgId),
      isNull(reference.table.deletedAt),
      eq(reference.column, id),
      reference.extraPredicate,
    );
    if (predicate === undefined) {
      throw new Error('Scope predicate collapsed to undefined; refusing to run an unscoped query.');
    }
    return predicate;
  }

  private async findOne(
    spec: SoftDeletableSpec,
    id: string,
    aliveness: SQL,
  ): Promise<MasterRow | null> {
    const rows = await this.db
      .select({
        id: sql<string>`${spec.table.id}::text`,
        name: sql<string>`${spec.nameColumn}::text`,
        code: asText(spec.codeColumn),
        uniqueValue: asText(spec.uniqueColumn),
      })
      .from(widen(spec.table))
      .where(and(this.scopedTo(spec.table, id), aliveness))
      .limit(1);

    return rows[0] ?? null;
  }
}

/**
 * Drizzle's builder signatures are conditional types over the *concrete* table
 * and cannot resolve against a value typed only as `ScopedTable`. Widened in
 * one place, exactly as `ScopedRepository.widened` does it and for the reason
 * given there.
 */
function widen(table: ScopedTable): PgTable {
  return table;
}

