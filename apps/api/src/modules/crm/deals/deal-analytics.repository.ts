import type {
  CrmOutcomeMonth,
  CrmOwnerLoad,
  CrmStageSlice,
} from '@vyuha/shared';
import { DEAL_STALE_DAYS } from '@vyuha/shared';
import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';

import type { Database } from '../../../platform/db/db.provider.js';
import { employees } from '../../../platform/db/schema/index.js';
import { ScopedRepository, type OrgContext } from '../../../platform/db/scoped-repository.js';
import { crmDeals, crmPipelineStages } from '../schema/index.js';

/**
 * The dashboard's arithmetic (REQ-U-11), done in the database.
 *
 * Every query here carries `this.scoped(scope, ...)`, the same pair of
 * predicates the list and the board carry: the organisation, and whatever
 * the viewer's deal scope resolves to. A figure assembled any other way
 * would be a way to learn the size of a pipeline you are not allowed to
 * read, one aggregate at a time.
 *
 * Sums come back as `::text`. `numeric` through a JavaScript number loses
 * the last place on a large pipeline, and this is a screen someone checks
 * against the deals it came from.
 */

const dealOwner = alias(employees, 'analytics_owner');

const ownerName = (owner: { id: PgColumn; firstName: PgColumn; lastName: PgColumn }): SQL<string | null> =>
  sql<string | null>`CASE WHEN ${owner.id} IS NULL THEN NULL ELSE concat_ws(' ', ${owner.firstName}, ${owner.lastName}) END`;

const IS_OPEN = sql`${crmPipelineStages.isWon} = false AND ${crmPipelineStages.isLost} = false`;

export interface DealTotals {
  readonly openCount: number;
  readonly openValue: string;
  readonly wonCount: number;
  readonly lostCount: number;
  readonly wonValue: string;
  readonly avgDaysToWin: number | null;
}

export interface DealAttention {
  readonly overdue: number;
  readonly followUpDue: number;
  readonly stale: number;
  readonly closingSoon: number;
}

export class DealAnalyticsRepository extends ScopedRepository<typeof crmDeals> {
  constructor(db: Database, ctx: OrgContext) {
    super(db, crmDeals, ctx);
  }

  private where(scope: SQL, pipelineId: string | undefined, ...extra: (SQL | undefined)[]): SQL {
    return this.scoped(
      scope,
      pipelineId === undefined ? undefined : eq(crmDeals.pipelineId, pipelineId),
      ...extra,
    );
  }

  /**
   * Open value and count, plus what has been decided inside the window.
   *
   * `avgDaysToWin` measures creation to close, not stage to stage: it is the
   * figure someone quotes when asked how long a deal takes, and stage timing
   * would need a history table this product does not keep.
   */
  async totals(scope: SQL, pipelineId: string | undefined, since: Date): Promise<DealTotals> {
    const rows = await this.db
      .select({
        openCount: sql<number>`count(*) filter (where ${IS_OPEN})::int`,
        openValue: sql<string>`coalesce(sum(${crmDeals.value}) filter (where ${IS_OPEN}), 0)::text`,
        wonCount: sql<number>`count(*) filter (where ${crmPipelineStages.isWon} and ${crmDeals.closedAt} >= ${since})::int`,
        lostCount: sql<number>`count(*) filter (where ${crmPipelineStages.isLost} and ${crmDeals.closedAt} >= ${since})::int`,
        wonValue: sql<string>`coalesce(sum(${crmDeals.value}) filter (where ${crmPipelineStages.isWon} and ${crmDeals.closedAt} >= ${since}), 0)::text`,
        avgDaysToWin: sql<number | null>`avg(extract(epoch from (${crmDeals.closedAt} - ${crmDeals.createdAt})) / 86400) filter (where ${crmPipelineStages.isWon} and ${crmDeals.closedAt} >= ${since})`,
      })
      .from(crmDeals)
      .innerJoin(crmPipelineStages, eq(crmPipelineStages.id, crmDeals.stageId))
      .where(this.where(scope, pipelineId));

    const row = rows[0];
    return {
      openCount: row?.openCount ?? 0,
      openValue: row?.openValue ?? '0',
      wonCount: row?.wonCount ?? 0,
      lostCount: row?.lostCount ?? 0,
      wonValue: row?.wonValue ?? '0',
      // Postgres returns numeric as text through the driver; a null here is
      // "nothing has been won yet", which is not the same as zero days.
      avgDaysToWin:
        row?.avgDaysToWin === null || row?.avgDaysToWin === undefined
          ? null
          : Math.round(Number(row.avgDaysToWin) * 10) / 10,
    };
  }

  /** One row per stage, including the stages holding nothing. */
  async stages(scope: SQL, pipelineId: string | undefined): Promise<CrmStageSlice[]> {
    const rows = await this.db
      .select({
        stageId: crmPipelineStages.id,
        stageName: crmPipelineStages.name,
        position: crmPipelineStages.sortOrder,
        isWon: crmPipelineStages.isWon,
        isLost: crmPipelineStages.isLost,
        count: sql<number>`count(${crmDeals.id})::int`,
        value: sql<string>`coalesce(sum(${crmDeals.value}), 0)::text`,
      })
      .from(crmPipelineStages)
      // Left, so a stage nobody has reached still draws as an empty column
      // rather than vanishing and making the funnel look shorter than it is.
      .leftJoin(crmDeals, and(eq(crmDeals.stageId, crmPipelineStages.id), this.where(scope, pipelineId)))
      .where(
        and(
          eq(crmPipelineStages.orgId, this.ctx.orgId),
          pipelineId === undefined ? undefined : eq(crmPipelineStages.pipelineId, pipelineId),
        ),
      )
      .groupBy(
        crmPipelineStages.id,
        crmPipelineStages.name,
        crmPipelineStages.sortOrder,
        crmPipelineStages.isWon,
        crmPipelineStages.isLost,
      )
      .orderBy(crmPipelineStages.sortOrder);
    return rows;
  }

  /** Won and lost by calendar month, in the organisation's own timezone. */
  async outcomes(
    scope: SQL,
    pipelineId: string | undefined,
    since: Date,
    timezone: string,
  ): Promise<CrmOutcomeMonth[]> {
    const month = sql<string>`to_char(date_trunc('month', ${crmDeals.closedAt} at time zone ${timezone}), 'YYYY-MM')`;
    const rows = await this.db
      .select({
        month,
        won: sql<number>`count(*) filter (where ${crmPipelineStages.isWon})::int`,
        lost: sql<number>`count(*) filter (where ${crmPipelineStages.isLost})::int`,
        wonValue: sql<string>`coalesce(sum(${crmDeals.value}) filter (where ${crmPipelineStages.isWon}), 0)::text`,
      })
      .from(crmDeals)
      .innerJoin(crmPipelineStages, eq(crmPipelineStages.id, crmDeals.stageId))
      .where(
        this.where(
          scope,
          pipelineId,
          isNotNull(crmDeals.closedAt),
          sql`${crmDeals.closedAt} >= ${since}`,
        ),
      )
      // By ordinal, not by the expression. Drizzle emits the timezone as a
      // fresh placeholder in each clause, so `group by to_char(... $4 ...)`
      // is a different expression to `select to_char(... $1 ...)` as far as
      // Postgres is concerned, and it refuses the whole query.
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return rows;
  }

  /** Who is carrying the open pipeline, heaviest first. */
  async owners(scope: SQL, pipelineId: string | undefined, limit: number): Promise<CrmOwnerLoad[]> {
    const rows = await this.db
      .select({
        ownerId: crmDeals.ownerId,
        ownerName: ownerName(dealOwner),
        openCount: sql<number>`count(*)::int`,
        openValue: sql<string>`coalesce(sum(${crmDeals.value}), 0)::text`,
      })
      .from(crmDeals)
      .innerJoin(crmPipelineStages, eq(crmPipelineStages.id, crmDeals.stageId))
      .leftJoin(dealOwner, eq(dealOwner.id, crmDeals.ownerId))
      .where(this.where(scope, pipelineId, sql`${IS_OPEN}`))
      .groupBy(crmDeals.ownerId, dealOwner.id, dealOwner.firstName, dealOwner.lastName)
      .orderBy(sql`count(*) desc`)
      .limit(limit);
    return rows;
  }

  /**
   * The four counts the dashboard turns into "what needs you today".
   *
   * `today` is the organisation's date, passed in rather than taken from the
   * database's clock: an office in Nashik reading a server in another
   * timezone would otherwise see a deal go overdue several hours early.
   */
  async attention(scope: SQL, pipelineId: string | undefined, today: string): Promise<DealAttention> {
    const soon = sql`(${today}::date + 7)`;
    const staleBefore = sql`(now() - ${`${String(DEAL_STALE_DAYS)} days`}::interval)`;
    const rows = await this.db
      .select({
        overdue: sql<number>`count(*) filter (where ${crmDeals.expectedCloseDate} < ${today}::date)::int`,
        followUpDue: sql<number>`count(*) filter (where ${crmDeals.nextFollowUpDate} <= ${today}::date)::int`,
        stale: sql<number>`count(*) filter (where ${crmDeals.updatedAt} < ${staleBefore})::int`,
        closingSoon: sql<number>`count(*) filter (where ${crmDeals.expectedCloseDate} between ${today}::date and ${soon})::int`,
      })
      .from(crmDeals)
      .innerJoin(crmPipelineStages, eq(crmPipelineStages.id, crmDeals.stageId))
      .where(this.where(scope, pipelineId, sql`${IS_OPEN}`));

    const row = rows[0];
    return {
      overdue: row?.overdue ?? 0,
      followUpDue: row?.followUpDue ?? 0,
      stale: row?.stale ?? 0,
      closingSoon: row?.closingSoon ?? 0,
    };
  }
}
