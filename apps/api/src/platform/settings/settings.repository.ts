import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../db/db.provider.js';
import { organizations, settings } from '../db/schema/index.js';
import { ScopedRepository, type OrgContext } from '../db/scoped-repository.js';

/**
 * The two places organisation settings live: columns on `organizations` for the
 * profile (REQ-L-01) and rows in `settings` for policy (REQ-L-02, REQ-L-03).
 *
 * A `ScopedRepository` subclass so every statement against `settings` starts
 * from `this.scoped(...)` -- `org_id` and `deleted_at IS NULL` before anything
 * else. `organizations` is not a scopable table (its own id *is* the org id),
 * so those two reads name their predicates explicitly and are the only
 * statements here that do.
 */

export interface OrgProfileRow {
  readonly id: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly timezone: string;
  readonly dateFormat: string;
  readonly weekStart: number;
  readonly logoKey: string | null;
}

export type OrgProfilePatch = Partial<Omit<OrgProfileRow, 'id'>>;

export class SettingsRepository extends ScopedRepository<typeof settings> {
  constructor(db: Database, ctx: OrgContext) {
    super(db, settings, ctx);
  }

  async readProfile(): Promise<OrgProfileRow | null> {
    const rows = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        legalName: organizations.legalName,
        timezone: organizations.timezone,
        dateFormat: organizations.dateFormat,
        weekStart: organizations.weekStart,
        logoKey: organizations.logoKey,
      })
      .from(organizations)
      .where(and(eq(organizations.id, this.ctx.orgId), isNull(organizations.deletedAt)))
      .limit(1);

    return rows[0] ?? null;
  }

  /** Every live org-scoped row, keyed. Location scope is not edited here yet. */
  async readValues(): Promise<Map<string, unknown>> {
    const rows = await this.findMany({
      where: and(eq(settings.scope, 'ORG'), isNull(settings.scopeId)),
    });
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  /**
   * Applies a profile patch and a set of policy rows as one transaction.
   *
   * Both halves or neither: a screen that saved the timezone and then failed on
   * the photo band would leave the organisation in a state nobody chose, and
   * the audit row -- written from the diff the caller computed before this ran
   * -- would describe a change that only half happened.
   */
  async write(input: {
    profile: OrgProfilePatch;
    values: ReadonlyMap<string, unknown>;
  }): Promise<void> {
    const hasProfile = Object.keys(input.profile).length > 0;
    if (!hasProfile && input.values.size === 0) return;

    const now = new Date();

    await this.db.transaction(async (tx) => {
      if (hasProfile) {
        await tx
          .update(organizations)
          .set({ ...input.profile, updatedAt: now, updatedBy: this.ctx.actorUserId })
          .where(and(eq(organizations.id, this.ctx.orgId), isNull(organizations.deletedAt)));
      }

      for (const [key, value] of input.values) {
        // Insert-then-update rather than read-then-branch. Two administrators
        // saving at once would each read "no row" and each insert one; the
        // partial unique index would turn the loser into a 500. `DO NOTHING`
        // with no target names no constraint on purpose -- the index is on a
        // COALESCE expression, which drizzle cannot express as a conflict
        // target, and any conflict on this statement means the row is already
        // there, which is exactly the case the update below handles.
        await tx
          .insert(settings)
          .values({
            orgId: this.ctx.orgId,
            scope: 'ORG',
            scopeId: null,
            key,
            value,
            createdAt: now,
            updatedAt: now,
            createdBy: this.ctx.actorUserId,
            updatedBy: this.ctx.actorUserId,
          })
          .onConflictDoNothing();

        await tx
          .update(settings)
          .set({ value, updatedAt: now, updatedBy: this.ctx.actorUserId })
          .where(
            this.scoped(
              eq(settings.scope, 'ORG'),
              isNull(settings.scopeId),
              eq(settings.key, key),
            ),
          );
      }
    });
  }
}
