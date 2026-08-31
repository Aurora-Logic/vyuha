import {
  DEAL_BOARD_LANE_CAP,
  DEFAULT_PIPELINE,
  type DealFilter,
  type DealPriority,
  type DealView,
  type PipelineStageView,
  type PipelineView,
  type SortTerm,
} from '@vyuha/shared';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';

import type { Database } from '../../../platform/db/db.provider.js';
import { employees } from '../../../platform/db/schema/index.js';
import { ScopedRepository, type OrgContext } from '../../../platform/db/scoped-repository.js';
import { masterSearch } from '../../../platform/org/master-query.js';
import { crmCompanies, crmContacts, crmDeals, crmPipelineStages, crmPipelines } from '../schema/index.js';

/**
 * Pipelines, stages and deals (REQ-U-04, REQ-U-05). The board is the list
 * grouped by stage, from one `filterPredicate` — the tasks repository's
 * shape, because REQ-V-04's argument holds for deals just as well.
 */

const dealOwner = alias(employees, 'deal_owner');

const ownerName = (owner: { id: PgColumn; firstName: PgColumn; lastName: PgColumn }): SQL<string | null> =>
  sql<string | null>`CASE WHEN ${owner.id} IS NULL THEN NULL ELSE concat_ws(' ', ${owner.firstName}, ${owner.lastName}) END`;

const STATUS = sql<'open' | 'won' | 'lost'>`CASE WHEN ${crmPipelineStages.isWon} THEN 'won' WHEN ${crmPipelineStages.isLost} THEN 'lost' ELSE 'open' END`;

export interface DealListOptions {
  readonly filter: DealFilter;
  readonly sort: readonly SortTerm[];
  readonly limit: number;
  readonly offset: number;
}

export class DealRepository extends ScopedRepository<typeof crmDeals> {
  constructor(db: Database, ctx: OrgContext) {
    super(db, crmDeals, ctx);
  }

  private query(where: SQL) {
    return this.db
      .select({
        id: crmDeals.id,
        name: crmDeals.name,
        companyId: crmDeals.companyId,
        companyName: crmCompanies.name,
        partyId: crmCompanies.partyId,
        contactId: crmDeals.contactId,
        contactName: crmContacts.name,
        pipelineId: crmDeals.pipelineId,
        pipelineName: crmPipelines.name,
        stageId: crmDeals.stageId,
        stageName: crmPipelineStages.name,
        probability: crmPipelineStages.probability,
        value: crmDeals.value,
        expectedCloseDate: crmDeals.expectedCloseDate,
        ownerId: crmDeals.ownerId,
        ownerName: ownerName(dealOwner),
        status: STATUS,
        closedAt: crmDeals.closedAt,
        leadSource: crmDeals.leadSource,
        priority: crmDeals.priority,
        nextFollowUpDate: crmDeals.nextFollowUpDate,
        competitor: crmDeals.competitor,
        lossReason: crmDeals.lossReason,
        notes: crmDeals.notes,
        createdAt: crmDeals.createdAt,
        updatedAt: crmDeals.updatedAt,
      })
      .from(crmDeals)
      .innerJoin(crmPipelines, eq(crmPipelines.id, crmDeals.pipelineId))
      .innerJoin(crmPipelineStages, eq(crmPipelineStages.id, crmDeals.stageId))
      .leftJoin(crmCompanies, and(eq(crmCompanies.id, crmDeals.companyId), isNull(crmCompanies.deletedAt)))
      .leftJoin(crmContacts, and(eq(crmContacts.id, crmDeals.contactId), isNull(crmContacts.deletedAt)))
      .leftJoin(dealOwner, eq(dealOwner.id, crmDeals.ownerId))
      .where(where);
  }

  /** The predicate over `crm_deals` alone; the status slice needs the stage join and is applied by the caller. */
  static filterPredicate(filter: DealFilter): SQL | undefined {
    return and(
      filter.q === undefined ? undefined : masterSearch(filter.q, [crmDeals.name, crmDeals.notes]),
      filter.pipelineId === undefined ? undefined : eq(crmDeals.pipelineId, filter.pipelineId),
      filter.stageId === undefined ? undefined : eq(crmDeals.stageId, filter.stageId),
      filter.ownerId === undefined ? undefined : eq(crmDeals.ownerId, filter.ownerId),
      filter.companyId === undefined ? undefined : eq(crmDeals.companyId, filter.companyId),
      filter.contactId === undefined ? undefined : eq(crmDeals.contactId, filter.contactId),
    );
  }

  /**
   * Won/lost/open is a property of the stage. Answered as an `IN` over stage
   * ids rather than a join in the count, so `count()` — which sees only the
   * base table — can apply it too.
   */
  private async statusPredicate(status: DealFilter['status']): Promise<SQL | undefined> {
    const effective = status ?? 'open';
    if (effective === 'all') return undefined;
    const rows = await this.db
      .select({ id: crmPipelineStages.id })
      .from(crmPipelineStages)
      .where(
        and(
          eq(crmPipelineStages.orgId, this.ctx.orgId),
          isNull(crmPipelineStages.deletedAt),
          effective === 'won'
            ? eq(crmPipelineStages.isWon, true)
            : effective === 'lost'
              ? eq(crmPipelineStages.isLost, true)
              : and(eq(crmPipelineStages.isWon, false), eq(crmPipelineStages.isLost, false)),
        ),
      );
    if (rows.length === 0) return sql`false`;
    return inArray(crmDeals.stageId, rows.map((r) => r.id));
  }

  private orderBy(sort: readonly SortTerm[]): (SQL | PgColumn)[] {
    const clauses: (SQL | PgColumn)[] = [];
    for (const term of sort) {
      const dir = term.direction === 'desc' ? desc : asc;
      switch (term.field) {
        case 'name':
          clauses.push(dir(crmDeals.name));
          break;
        case 'value':
          clauses.push(sql`${crmDeals.value} IS NULL`, dir(crmDeals.value));
          break;
        case 'expectedCloseDate':
          clauses.push(sql`${crmDeals.expectedCloseDate} IS NULL`, dir(crmDeals.expectedCloseDate));
          break;
        case 'createdAt':
          clauses.push(dir(crmDeals.createdAt));
          break;
        case 'updatedAt':
          clauses.push(dir(crmDeals.updatedAt));
          break;
        default:
          break;
      }
    }
    if (clauses.length === 0) clauses.push(desc(crmDeals.updatedAt));
    clauses.push(asc(crmDeals.id));
    return clauses;
  }

  async list(scope: SQL, options: DealListOptions): Promise<{ rows: DealView[]; total: number }> {
    const predicate = and(DealRepository.filterPredicate(options.filter), await this.statusPredicate(options.filter.status));
    const rows = await this.query(this.scoped(scope, predicate))
      .orderBy(...this.orderBy(options.sort))
      .limit(options.limit)
      .offset(options.offset);
    const total = await this.count(and(scope, predicate));
    return { rows: rows.map(toDealView), total };
  }

  async board(
    scope: SQL,
    filter: DealFilter,
    stages: readonly PipelineStageView[],
  ): Promise<{ stageId: string; deals: DealView[]; total: number; valueTotal: string }[]> {
    // The board is one pipeline's stages; the status slice does not apply —
    // won and lost are lanes of their own on it.
    const predicate = DealRepository.filterPredicate({ ...filter, status: 'all' });
    const lanes: { stageId: string; deals: DealView[]; total: number; valueTotal: string }[] = [];
    for (const stage of stages) {
      const where = this.scoped(scope, predicate, eq(crmDeals.stageId, stage.id));
      const rows = await this.query(where).orderBy(desc(crmDeals.updatedAt), asc(crmDeals.id)).limit(DEAL_BOARD_LANE_CAP);
      const totals = await this.db
        .select({
          total: sql<number>`count(*)::int`,
          value: sql<string>`coalesce(sum(${crmDeals.value}), 0)::text`,
        })
        .from(crmDeals)
        .where(where);
      lanes.push({
        stageId: stage.id,
        deals: rows.map(toDealView),
        total: totals[0]?.total ?? rows.length,
        valueTotal: totals[0]?.value ?? '0',
      });
    }
    return lanes;
  }

  async view(scope: SQL, id: string): Promise<DealView | null> {
    const rows = await this.query(this.scoped(scope, eq(crmDeals.id, id))).limit(1);
    const row = rows[0];
    return row === undefined ? null : toDealView(row);
  }

  async countInStage(stageId: string): Promise<number> {
    return this.count(eq(crmDeals.stageId, stageId));
  }

  async countInPipeline(pipelineId: string): Promise<number> {
    return this.count(eq(crmDeals.pipelineId, pipelineId));
  }
}

export class PipelineRepository extends ScopedRepository<typeof crmPipelines> {
  constructor(db: Database, ctx: OrgContext) {
    super(db, crmPipelines, ctx);
  }

  /** Every pipeline with its stages, in order; the default one created on first read. */
  async listOrCreateDefault(): Promise<PipelineView[]> {
    const existing = await this.listWithStages();
    if (existing.length > 0) return existing;
    try {
      const created = await this.insert({ name: DEFAULT_PIPELINE.name, isDefault: true });
      await this.db.insert(crmPipelineStages).values(
        DEFAULT_PIPELINE.stages.map((stage, index) => ({
          orgId: this.ctx.orgId,
          pipelineId: created.id,
          name: stage.name,
          sortOrder: index,
          probability: stage.probability,
          isWon: stage.isWon,
          isLost: stage.isLost,
          createdBy: this.ctx.actorUserId,
          updatedBy: this.ctx.actorUserId,
        })),
      );
    } catch {
      // A racing first read created it; read below.
    }
    return this.listWithStages();
  }

  async listWithStages(): Promise<PipelineView[]> {
    const pipelines = await this.findMany({ orderBy: [desc(crmPipelines.isDefault), asc(crmPipelines.name), asc(crmPipelines.id)] });
    if (pipelines.length === 0) return [];
    const stages = await this.db
      .select()
      .from(crmPipelineStages)
      .where(
        and(
          eq(crmPipelineStages.orgId, this.ctx.orgId),
          isNull(crmPipelineStages.deletedAt),
          inArray(crmPipelineStages.pipelineId, pipelines.map((p) => p.id)),
        ),
      )
      .orderBy(asc(crmPipelineStages.sortOrder), asc(crmPipelineStages.createdAt));
    return pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      isDefault: p.isDefault,
      stages: stages.filter((s) => s.pipelineId === p.id).map(toStageView),
    }));
  }

  async findWithStages(id: string): Promise<PipelineView | null> {
    return (await this.listOrCreateDefault()).find((p) => p.id === id) ?? null;
  }

  async defaultPipeline(): Promise<PipelineView | null> {
    const all = await this.listOrCreateDefault();
    return all.find((p) => p.isDefault) ?? all[0] ?? null;
  }

  async findByName(name: string, excludeId?: string): Promise<string | null> {
    const rows = await this.findMany({
      where: and(
        sql`lower(${crmPipelines.name}) = lower(${name})`,
        excludeId === undefined ? undefined : sql`${crmPipelines.id} <> ${excludeId}`,
      ),
      limit: 1,
    });
    return rows[0]?.id ?? null;
  }

  async clearDefault(exceptId: string): Promise<void> {
    await this.db
      .update(crmPipelines)
      .set({ isDefault: false, updatedAt: new Date(), updatedBy: this.ctx.actorUserId })
      .where(and(eq(crmPipelines.orgId, this.ctx.orgId), isNull(crmPipelines.deletedAt), sql`${crmPipelines.id} <> ${exceptId}`, eq(crmPipelines.isDefault, true)));
  }

  // -------------------------------------------------------------- stages

  async stage(pipelineId: string, stageId: string): Promise<PipelineStageView | null> {
    const rows = await this.db
      .select()
      .from(crmPipelineStages)
      .where(this.stageScope(pipelineId, eq(crmPipelineStages.id, stageId)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toStageView(row);
  }

  async stageByName(pipelineId: string, name: string, excludeId?: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: crmPipelineStages.id })
      .from(crmPipelineStages)
      .where(
        this.stageScope(
          pipelineId,
          sql`lower(${crmPipelineStages.name}) = lower(${name})`,
          excludeId === undefined ? undefined : sql`${crmPipelineStages.id} <> ${excludeId}`,
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async insertStage(pipelineId: string, input: { name: string; probability: number; isWon: boolean; isLost: boolean; sortOrder: number }): Promise<PipelineStageView> {
    const rows = await this.db
      .insert(crmPipelineStages)
      .values({
        orgId: this.ctx.orgId,
        pipelineId,
        name: input.name,
        probability: input.probability,
        isWon: input.isWon,
        isLost: input.isLost,
        sortOrder: input.sortOrder,
        createdBy: this.ctx.actorUserId,
        updatedBy: this.ctx.actorUserId,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('Stage insert returned no row.');
    return toStageView(row);
  }

  async updateStage(
    pipelineId: string,
    stageId: string,
    patch: Partial<{ name: string; probability: number; isWon: boolean; isLost: boolean; sortOrder: number }>,
  ): Promise<PipelineStageView | null> {
    const rows = await this.db
      .update(crmPipelineStages)
      .set({ ...patch, updatedAt: new Date(), updatedBy: this.ctx.actorUserId })
      .where(this.stageScope(pipelineId, eq(crmPipelineStages.id, stageId)))
      .returning();
    const row = rows[0];
    return row === undefined ? null : toStageView(row);
  }

  async softDeleteStage(pipelineId: string, stageId: string): Promise<boolean> {
    const rows = await this.db
      .update(crmPipelineStages)
      .set({ deletedAt: new Date(), updatedAt: new Date(), updatedBy: this.ctx.actorUserId })
      .where(this.stageScope(pipelineId, eq(crmPipelineStages.id, stageId)))
      .returning({ id: crmPipelineStages.id });
    return rows.length > 0;
  }

  async reorderStages(pipelineId: string, stageIds: readonly string[]): Promise<void> {
    for (const [index, id] of stageIds.entries()) {
      await this.updateStage(pipelineId, id, { sortOrder: index });
    }
  }

  private stageScope(pipelineId: string, ...extra: (SQL | undefined)[]): SQL {
    const predicate = and(
      eq(crmPipelineStages.orgId, this.ctx.orgId),
      eq(crmPipelineStages.pipelineId, pipelineId),
      isNull(crmPipelineStages.deletedAt),
      ...extra,
    );
    if (predicate === undefined) throw new Error('Stage predicate collapsed to undefined.');
    return predicate;
  }
}

interface StageRow {
  id: string;
  name: string;
  sortOrder: number;
  probability: number;
  isWon: boolean;
  isLost: boolean;
}

function toStageView(row: StageRow): PipelineStageView {
  return { id: row.id, name: row.name, sortOrder: row.sortOrder, probability: row.probability, isWon: row.isWon, isLost: row.isLost };
}

interface DealRow {
  id: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  partyId: string | null;
  contactId: string | null;
  contactName: string | null;
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
  probability: number;
  value: string | null;
  expectedCloseDate: string | null;
  ownerId: string | null;
  ownerName: string | null;
  status: 'open' | 'won' | 'lost';
  closedAt: Date | null;
  leadSource: string | null;
  priority: DealPriority | null;
  nextFollowUpDate: string | null;
  competitor: string | null;
  lossReason: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDealView(row: DealRow): DealView {
  return {
    id: row.id,
    name: row.name,
    companyId: row.companyId,
    companyName: row.companyName,
    partyId: row.partyId,
    contactId: row.contactId,
    contactName: row.contactName,
    pipelineId: row.pipelineId,
    pipelineName: row.pipelineName,
    stageId: row.stageId,
    stageName: row.stageName,
    probability: row.probability,
    value: row.value,
    expectedCloseDate: row.expectedCloseDate,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    status: row.status,
    closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
    leadSource: row.leadSource,
    priority: row.priority,
    nextFollowUpDate: row.nextFollowUpDate,
    competitor: row.competitor,
    lossReason: row.lossReason,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

