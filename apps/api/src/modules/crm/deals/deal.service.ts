import { Injectable } from '@nestjs/common';
import {
  DATA_SCOPES,
  DEAL_SORT_FIELDS,
  DEFAULT_DEAL_SORT,
  PERMISSIONS,
  pageSlice,
  paginated,
  parseSort,
  type CreateDealInput,
  type CreatePipelineInput,
  type CreatePipelineStageInput,
  type DealBoardQuery,
  type DealBoardView,
  type DealListQuery,
  type DealView,
  type Paginated,
  type PipelineStageView,
  type PipelineView,
  type ReorderPipelineStagesInput,
  type UpdateDealInput,
  type UpdatePipelineInput,
  type UpdatePipelineStageInput,
} from '@vyuha/shared';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { AuditContext } from '../../../platform/audit/audit-context.js';
import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { employees } from '../../../platform/db/schema/index.js';
import { orgContextOf, type Principal } from '../../../platform/rbac/principal.js';
import { ScopeService, type ScopeGrants } from '../../../platform/rbac/scope.service.js';
import { CrmService } from '../contacts/crm.service.js';
import { crmDeals } from '../schema/index.js';
import { DealRepository, PipelineRepository } from './deal.repository.js';

/**
 * Pipelines and deals (REQ-U-04, REQ-U-05). Same ownership model as
 * contacts, under the `crm.deal.*` family; a stage move is one audited
 * write, and entering a won or lost stage closes the deal (`deal.won`,
 * `deal.lost`) the way a done column closes a task. Nothing here touches
 * Tally: REQ-U-05 says a deal has no accounting existence, and REQ-U-06's
 * documents arrive with the sales module.
 */

const DEAL_GRANTS: ScopeGrants = {
  self: PERMISSIONS.CRM_DEAL_VIEW_SELF,
  all: PERMISSIONS.CRM_DEAL_VIEW_ALL,
};

const SQL_TRUE = sql`true`;

@Injectable()
export class DealService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly scopes: ScopeService,
    private readonly crm: CrmService,
  ) {}

  // -------------------------------------------------------------- pipelines

  listPipelines(principal: Principal): Promise<PipelineView[]> {
    return this.pipelines(principal).listOrCreateDefault();
  }

  async createPipeline(principal: Principal, input: CreatePipelineInput): Promise<PipelineView> {
    const repository = this.pipelines(principal);
    await repository.listOrCreateDefault();
    if ((await repository.findByName(input.name)) !== null) {
      throw AppError.conflict(`A pipeline called ${input.name} already exists.`);
    }
    // The partial unique index allows one default at a time, so the old one
    // steps down before the new one is written.
    if (input.isDefault) await repository.clearDefault('00000000-0000-0000-0000-000000000000');
    const created = await repository.insert({ name: input.name, isDefault: input.isDefault });
    const view = await repository.findWithStages(created.id);
    if (view === null) throw new Error(`Pipeline ${created.id} vanished between insert and read-back.`);
    this.auditContext.record({
      action: 'crm.pipeline.created',
      entityType: 'crm_pipeline',
      entityId: view.id,
      before: null,
      after: { name: view.name, isDefault: view.isDefault },
    });
    return view;
  }

  async updatePipeline(principal: Principal, id: string, input: UpdatePipelineInput): Promise<PipelineView> {
    const repository = this.pipelines(principal);
    const existing = await repository.findWithStages(id);
    if (existing === null) throw AppError.notFound('Pipeline', id);
    if (input.name !== undefined && (await repository.findByName(input.name, id)) !== null) {
      throw AppError.conflict(`A pipeline called ${input.name} already exists.`);
    }
    if (input.isDefault === false && existing.isDefault) {
      throw AppError.conflict('One pipeline must be the default; make another the default instead.');
    }
    const patch: Parameters<PipelineRepository['update']>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.isDefault !== undefined) patch.isDefault = input.isDefault;
    // Clear the old default before setting the new one, or the partial unique
    // index refuses the moment two are true.
    if (input.isDefault === true) await repository.clearDefault(id);
    const updated = await repository.update(id, patch);
    if (updated === null) throw AppError.notFound('Pipeline', id);
    const view = await repository.findWithStages(id);
    if (view === null) throw AppError.notFound('Pipeline', id);
    this.auditContext.record({
      action: 'crm.pipeline.updated',
      entityType: 'crm_pipeline',
      entityId: id,
      before: { name: existing.name, isDefault: existing.isDefault },
      after: { name: view.name, isDefault: view.isDefault },
    });
    return view;
  }

  async addStage(principal: Principal, pipelineId: string, input: CreatePipelineStageInput): Promise<PipelineStageView> {
    const repository = this.pipelines(principal);
    const pipeline = await repository.findWithStages(pipelineId);
    if (pipeline === null) throw AppError.notFound('Pipeline', pipelineId);
    if ((await repository.stageByName(pipelineId, input.name)) !== null) {
      throw AppError.conflict(`A stage called ${input.name} already exists in ${pipeline.name}.`);
    }
    const stage = await repository.insertStage(pipelineId, { ...input, sortOrder: pipeline.stages.length });
    this.auditContext.record({
      action: 'crm.pipeline.stage.created',
      entityType: 'crm_pipeline_stage',
      entityId: stage.id,
      before: null,
      after: { pipelineId, ...stage },
    });
    return stage;
  }

  async updateStage(
    principal: Principal,
    pipelineId: string,
    stageId: string,
    input: UpdatePipelineStageInput,
  ): Promise<PipelineStageView> {
    const repository = this.pipelines(principal);
    const pipeline = await repository.findWithStages(pipelineId);
    if (pipeline === null) throw AppError.notFound('Pipeline', pipelineId);
    const existing = pipeline.stages.find((s) => s.id === stageId);
    if (existing === undefined) throw AppError.notFound('Stage', stageId);
    if (input.name !== undefined && (await repository.stageByName(pipelineId, input.name, stageId)) !== null) {
      throw AppError.conflict(`A stage called ${input.name} already exists in ${pipeline.name}.`);
    }
    const nextWon = input.isWon ?? existing.isWon;
    const nextLost = input.isLost ?? existing.isLost;
    if (nextWon && nextLost) throw AppError.validation('A stage is won or lost, not both.');
    // The last open stage cannot close: a new deal would have nowhere to start.
    if ((nextWon || nextLost) && !existing.isWon && !existing.isLost) {
      const otherOpen = pipeline.stages.some((s) => s.id !== stageId && !s.isWon && !s.isLost);
      if (!otherOpen) throw AppError.conflict('At least one stage must stay open, or a new deal has nowhere to start.');
    }
    const patch: Partial<{ name: string; probability: number; isWon: boolean; isLost: boolean }> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.probability !== undefined) patch.probability = input.probability;
    if (input.isWon !== undefined) patch.isWon = input.isWon;
    if (input.isLost !== undefined) patch.isLost = input.isLost;
    const updated = await repository.updateStage(pipelineId, stageId, patch);
    if (updated === null) throw AppError.notFound('Stage', stageId);

    // Deals in a stage that changed its closing nature follow it, in one statement.
    const wasClosed = existing.isWon || existing.isLost;
    const isClosed = updated.isWon || updated.isLost;
    if (wasClosed !== isClosed) {
      await this.db
        .update(crmDeals)
        .set({ closedAt: isClosed ? new Date() : null, updatedAt: new Date() })
        .where(and(eq(crmDeals.orgId, principal.orgId), eq(crmDeals.stageId, stageId), isNull(crmDeals.deletedAt)));
    }
    this.auditContext.record({
      action: 'crm.pipeline.stage.updated',
      entityType: 'crm_pipeline_stage',
      entityId: stageId,
      before: { ...existing },
      after: { ...updated },
    });
    return updated;
  }

  async reorderStages(principal: Principal, pipelineId: string, input: ReorderPipelineStagesInput): Promise<PipelineView> {
    const repository = this.pipelines(principal);
    const pipeline = await repository.findWithStages(pipelineId);
    if (pipeline === null) throw AppError.notFound('Pipeline', pipelineId);
    const alive = new Set(pipeline.stages.map((s) => s.id));
    const given = new Set(input.stageIds);
    if (alive.size !== given.size || ![...alive].every((id) => given.has(id))) {
      throw AppError.validation('The order must name every stage exactly once.', { stageIds: input.stageIds });
    }
    await repository.reorderStages(pipelineId, input.stageIds);
    const after = await repository.findWithStages(pipelineId);
    if (after === null) throw AppError.notFound('Pipeline', pipelineId);
    this.auditContext.record({
      action: 'crm.pipeline.stage.reordered',
      entityType: 'crm_pipeline',
      entityId: pipelineId,
      before: { order: pipeline.stages.map((s) => s.id) },
      after: { order: after.stages.map((s) => s.id) },
    });
    return after;
  }

  async deleteStage(principal: Principal, pipelineId: string, stageId: string): Promise<void> {
    const repository = this.pipelines(principal);
    const pipeline = await repository.findWithStages(pipelineId);
    if (pipeline === null) throw AppError.notFound('Pipeline', pipelineId);
    const existing = pipeline.stages.find((s) => s.id === stageId);
    if (existing === undefined) throw AppError.notFound('Stage', stageId);
    const inStage = await this.deals(principal).countInStage(stageId);
    if (inStage > 0) {
      throw AppError.conflict(`${existing.name} still holds ${inStage} deal${inStage === 1 ? '' : 's'}. Move them first.`, { dealCount: inStage });
    }
    if (!existing.isWon && !existing.isLost && !pipeline.stages.some((s) => s.id !== stageId && !s.isWon && !s.isLost)) {
      throw AppError.conflict('At least one stage must stay open, or a new deal has nowhere to start.');
    }
    const deleted = await repository.softDeleteStage(pipelineId, stageId);
    if (!deleted) throw AppError.notFound('Stage', stageId);
    this.auditContext.record({
      action: 'crm.pipeline.stage.deleted',
      entityType: 'crm_pipeline_stage',
      entityId: stageId,
      before: { ...existing },
      after: null,
    });
  }

  // ------------------------------------------------------------------ deals

  async listDeals(principal: Principal, query: DealListQuery): Promise<Paginated<DealView>> {
    const { limit, offset } = pageSlice(query);
    const { rows, total } = await this.deals(principal).list(this.scope(principal), {
      filter: query,
      sort: parseSort(query.sort ?? DEFAULT_DEAL_SORT, DEAL_SORT_FIELDS),
      limit,
      offset,
    });
    return paginated(rows, query, total);
  }

  async board(principal: Principal, query: DealBoardQuery): Promise<DealBoardView> {
    const repository = this.pipelines(principal);
    const pipeline =
      query.pipelineId === undefined ? await repository.defaultPipeline() : await repository.findWithStages(query.pipelineId);
    if (pipeline === null) throw AppError.notFound('Pipeline', query.pipelineId);
    const lanes = await this.deals(principal).board(this.scope(principal), { ...query, pipelineId: pipeline.id }, pipeline.stages);
    return {
      pipeline,
      lanes: pipeline.stages.map((stage) => {
        const lane = lanes.find((l) => l.stageId === stage.id);
        return { stage, deals: lane?.deals ?? [], total: lane?.total ?? 0, valueTotal: lane?.valueTotal ?? '0' };
      }),
    };
  }

  async findDeal(principal: Principal, id: string): Promise<DealView> {
    const deal = await this.deals(principal).view(this.scope(principal), id);
    if (deal === null) throw AppError.notFound('Deal', id);
    return deal;
  }

  async createDeal(principal: Principal, input: CreateDealInput): Promise<DealView> {
    const repository = this.deals(principal);
    const pipelines = this.pipelines(principal);
    const ownerId = await this.resolveOwner(principal, input.ownerId);
    const pipeline =
      input.pipelineId === undefined || input.pipelineId === null
        ? await pipelines.defaultPipeline()
        : await pipelines.findWithStages(input.pipelineId);
    if (pipeline === null) throw AppError.validation('The pipeline was not found.', { pipelineId: input.pipelineId ?? null });
    const stage =
      input.stageId === undefined || input.stageId === null
        ? (pipeline.stages.find((s) => !s.isWon && !s.isLost) ?? pipeline.stages[0] ?? null)
        : (pipeline.stages.find((s) => s.id === input.stageId) ?? null);
    if (stage === null) throw AppError.validation('The stage was not found in that pipeline.', { stageId: input.stageId ?? null });
    await this.assertLinks(principal, input.companyId, input.contactId);

    const created = await repository.insert({
      name: input.name,
      companyId: input.companyId ?? null,
      contactId: input.contactId ?? null,
      pipelineId: pipeline.id,
      stageId: stage.id,
      value: input.value ?? null,
      expectedCloseDate: input.expectedCloseDate ?? null,
      ownerId,
      closedAt: stage.isWon || stage.isLost ? new Date() : null,
      leadSource: input.leadSource ?? null,
      priority: input.priority ?? null,
      nextFollowUpDate: input.nextFollowUpDate ?? null,
      competitor: input.competitor ?? null,
      lossReason: input.lossReason ?? null,
      notes: input.notes ?? null,
    });
    const deal = await repository.view(SQL_TRUE, created.id);
    if (deal === null) throw new Error(`Deal ${created.id} vanished between insert and read-back.`);
    this.auditContext.record({
      action: 'crm.deal.created',
      entityType: 'crm_deal',
      entityId: deal.id,
      before: null,
      after: dealAuditView(deal),
    });
    return deal;
  }

  async updateDeal(principal: Principal, id: string, input: UpdateDealInput): Promise<DealView> {
    const repository = this.deals(principal);
    const existing = await this.findDeal(principal, id);

    const patch: Parameters<DealRepository['update']>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.value !== undefined) patch.value = input.value;
    if (input.expectedCloseDate !== undefined) patch.expectedCloseDate = input.expectedCloseDate;
    if (input.leadSource !== undefined) patch.leadSource = input.leadSource;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.nextFollowUpDate !== undefined) patch.nextFollowUpDate = input.nextFollowUpDate;
    if (input.competitor !== undefined) patch.competitor = input.competitor;
    if (input.lossReason !== undefined) patch.lossReason = input.lossReason;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.companyId !== undefined || input.contactId !== undefined) {
      const companyId = input.companyId === undefined ? existing.companyId : input.companyId;
      const contactId = input.contactId === undefined ? existing.contactId : input.contactId;
      await this.assertLinks(principal, companyId, contactId);
      if (input.companyId !== undefined) patch.companyId = input.companyId;
      if (input.contactId !== undefined) patch.contactId = input.contactId;
    }
    if (input.ownerId !== undefined && input.ownerId !== existing.ownerId) {
      patch.ownerId = await this.resolveOwner(principal, input.ownerId);
    }

    let moved: PipelineStageView | null = null;
    if (input.stageId !== undefined && input.stageId !== existing.stageId) {
      const stage = await this.pipelines(principal).stage(existing.pipelineId, input.stageId);
      if (stage === null) throw AppError.validation('The stage was not found in this deal’s pipeline.', { stageId: input.stageId });
      patch.stageId = stage.id;
      const closing = stage.isWon || stage.isLost;
      if (closing && existing.status === 'open') patch.closedAt = new Date();
      if (!closing && existing.status !== 'open') patch.closedAt = null;
      moved = stage;
    }

    const updated = await repository.update(id, patch);
    if (updated === null) throw AppError.notFound('Deal', id);
    const deal = await repository.view(SQL_TRUE, id);
    if (deal === null) throw AppError.notFound('Deal', id);

    const action =
      moved === null
        ? 'crm.deal.updated'
        : moved.isWon
          ? 'crm.deal.won'
          : moved.isLost
            ? 'crm.deal.lost'
            : existing.status !== 'open'
              ? 'crm.deal.reopened'
              : 'crm.deal.stage_changed';
    this.auditContext.record({
      action,
      entityType: 'crm_deal',
      entityId: id,
      before: dealAuditView(existing),
      after: dealAuditView(deal),
    });
    return deal;
  }

  async deleteDeal(principal: Principal, id: string): Promise<void> {
    const existing = await this.findDeal(principal, id);
    const deleted = await this.deals(principal).softDelete(id);
    if (!deleted) throw AppError.notFound('Deal', id);
    this.auditContext.record({
      action: 'crm.deal.deleted',
      entityType: 'crm_deal',
      entityId: id,
      before: dealAuditView(existing),
      after: null,
    });
  }

  // ---------------------------------------------------------------- helpers

  private scope(principal: Principal): SQL {
    return this.scopes.resolve(principal, DEAL_GRANTS, crmDeals.ownerId).where;
  }

  private async resolveOwner(principal: Principal, requested: string | null | undefined): Promise<string | null> {
    if (requested === undefined || requested === null) return principal.employeeId;
    if (requested === principal.employeeId) return requested;
    if (this.scopes.breadth(principal, DEAL_GRANTS) !== DATA_SCOPES.ALL) {
      throw AppError.forbidden('Only a holder of crm.deal.view.all may assign a deal to somebody else.');
    }
    const rows = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.orgId, principal.orgId), eq(employees.id, requested), isNull(employees.deletedAt)))
      .limit(1);
    if (rows.length === 0) throw AppError.validation('The owner must be a current employee.', { ownerId: requested });
    return requested;
  }

  /** The company and contact a deal names must be ones the caller can see, and the contact must belong to the company when both are given. */
  private async assertLinks(principal: Principal, companyId: string | null | undefined, contactId: string | null | undefined): Promise<void> {
    if (companyId !== undefined && companyId !== null) {
      await this.crm.findCompany(principal, companyId).catch(() => {
        throw AppError.validation('The company was not found.', { companyId });
      });
    }
    if (contactId !== undefined && contactId !== null) {
      const contact = await this.crm.findContact(principal, contactId).catch(() => {
        throw AppError.validation('The contact was not found.', { contactId });
      });
      if (companyId !== undefined && companyId !== null && contact.companyId !== null && contact.companyId !== companyId) {
        throw AppError.validation(`${contact.name} belongs to ${contact.companyName ?? 'another company'}, not this one.`, { contactId, companyId });
      }
    }
  }

  private deals(principal: Principal): DealRepository {
    return new DealRepository(this.db, orgContextOf(principal));
  }

  private pipelines(principal: Principal): PipelineRepository {
    return new PipelineRepository(this.db, orgContextOf(principal));
  }
}

function dealAuditView(deal: DealView): Record<string, unknown> {
  return {
    name: deal.name,
    companyId: deal.companyId,
    contactId: deal.contactId,
    pipelineId: deal.pipelineId,
    stageId: deal.stageId,
    stageName: deal.stageName,
    value: deal.value,
    expectedCloseDate: deal.expectedCloseDate,
    ownerId: deal.ownerId,
    status: deal.status,
    notes: deal.notes,
  };
}
