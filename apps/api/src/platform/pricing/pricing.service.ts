import { Injectable } from '@nestjs/common';
import {
  PERMISSIONS,
  PRICE_LIST_SUBJECT_TYPE,
  type Paginated,
  type PriceListAssignmentView,
  type PriceListDetail,
  type PriceListDiff,
  type PriceListDiffLine,
  type PriceListDraftInput,
  type PriceListLineInput,
  type PriceListLineView,
  type PriceListsQuery,
  type PriceListState,
  type PriceListSummary,
  type RateSimulation,
  type RateSimulationQuery,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import type { ApprovalSubjectDecision, ApprovalSubjectSettlement } from '../approvals/approval-subject.registry.js';
import { ApprovalService } from '../approvals/approval.service.js';
import { AuditContext } from '../audit/audit-context.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import type { OrgContext } from '../db/scoped-repository.js';
import { hasPermission, orgContextOf, type Principal } from '../rbac/principal.js';
import { resolveRate } from './pricing-resolver.js';

/**
 * Area AN: price lists Vyuha owns. A draft is the only thing that can be
 * edited; submitting it raises a request in the platform approvals inbox
 * for `pricing.approve` (REQ-AN-09); the decision activates it and, if it
 * replaces an earlier version, stamps that one superseded at the same
 * instant (REQ-AN-06). Nothing here touches a document already raised
 * (REQ-AN-08): a line stores what resolved when it was written, and the
 * resolver reads the version in force at the document's date.
 */

type ListRow = {
  id: string;
  name: string;
  version: number;
  state: PriceListState;
  effective_from: string;
  effective_to: string | null;
  supersedes_id: string | null;
  notes: string | null;
  approval_request_id: string | null;
  // The raw driver hands timestamps back as strings; the summary reads them as instants.
  approved_at: Date | string | null;
  approved_by_name: string | null;
  superseded_at: Date | string | null;
  created_at: Date | string;
  created_by_name: string | null;
  line_count: number;
  assignment_count: number;
};

type LineRow = {
  id: string;
  stock_item_id: string | null;
  item_name: string | null;
  item_group: string | null;
  basis: PriceListLineView['basis'];
  rate: string | null;
  discount_pct: string | null;
  min_qty: string | null;
  max_qty: string | null;
};

function toSummary(row: ListRow): PriceListSummary {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    state: row.state,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    supersedesId: row.supersedes_id,
    lineCount: row.line_count,
    assignmentCount: row.assignment_count,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    createdByName: row.created_by_name,
    approvedAt: row.approved_at === null ? null : new Date(row.approved_at).toISOString(),
    approvedByName: row.approved_by_name,
    supersededAt: row.superseded_at === null ? null : new Date(row.superseded_at).toISOString(),
    approvalRequestId: row.approval_request_id,
  };
}

function toLine(row: LineRow): PriceListLineView {
  return {
    id: row.id,
    stockItemId: row.stock_item_id,
    itemName: row.item_name,
    itemGroup: row.item_group,
    basis: row.basis,
    rate: row.rate,
    discountPct: row.discount_pct,
    minQty: row.min_qty,
    maxQty: row.max_qty,
  };
}

/** The identity of a line for the diff: what it prices and over which slab. */
function lineKey(line: Pick<PriceListLineView, 'stockItemId' | 'itemGroup' | 'minQty' | 'maxQty'>): string {
  return `${line.stockItemId ?? `group:${line.itemGroup ?? ''}`}|${line.minQty ?? ''}|${line.maxQty ?? ''}`;
}

function slabLabel(line: Pick<PriceListLineView, 'minQty' | 'maxQty'>): string {
  if (line.minQty === null && line.maxQty === null) return 'any quantity';
  return `${line.minQty ?? '0'} to ${line.maxQty ?? 'any'}`;
}

function diffLine(line: PriceListLineView): PriceListDiffLine {
  return { key: lineKey(line), itemName: line.itemName, itemGroup: line.itemGroup, slab: slabLabel(line), basis: line.basis, rate: line.rate, discountPct: line.discountPct };
}

/**
 * REQ-AN-03: two slabs on one target that share any quantity are refused at
 * save, naming both lines. A line without bounds is the slab [0, ∞).
 */
export function overlappingSlabs(lines: readonly PriceListLineInput[]): { a: number; b: number }[] {
  const out: { a: number; b: number }[] = [];
  const target = (l: PriceListLineInput) => l.stockItemId ?? `group:${l.itemGroup ?? ''}`;
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const a = lines[i];
      const b = lines[j];
      if (a === undefined || b === undefined || target(a) !== target(b)) continue;
      const aMin = Number(a.minQty ?? 0);
      const aMax = a.maxQty === null || a.maxQty === undefined ? Number.POSITIVE_INFINITY : Number(a.maxQty);
      const bMin = Number(b.minQty ?? 0);
      const bMax = b.maxQty === null || b.maxQty === undefined ? Number.POSITIVE_INFINITY : Number(b.maxQty);
      if (aMin <= bMax && bMin <= aMax) out.push({ a: i + 1, b: j + 1 });
    }
  }
  return out;
}

@Injectable()
export class PricingService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly approvals: ApprovalService,
    private readonly auditContext: AuditContext,
  ) {}

  // ------------------------------------------------------------------ read

  async list(principal: Principal, query: PriceListsQuery): Promise<Paginated<PriceListSummary>> {
    const orgId = principal.orgId;
    const offset = (query.page - 1) * query.pageSize;
    const where = sql`l.org_id = ${orgId} AND l.deleted_at IS NULL
      ${query.state === undefined ? sql`` : sql`AND ${this.effectiveState()} = ${query.state}`}
      ${query.q === undefined ? sql`` : sql`AND l.name ILIKE ${'%' + query.q + '%'}`}`;
    const [rows, total] = await Promise.all([
      this.db.execute<ListRow>(sql`
        SELECT ${this.summarySelection()}
          FROM price_lists l
          LEFT JOIN users cu ON cu.id = l.created_by
          LEFT JOIN employees ce ON ce.id = cu.employee_id
          LEFT JOIN users au ON au.id = l.approved_by
          LEFT JOIN employees ae ON ae.id = au.employee_id
         WHERE ${where}
         ORDER BY l.name, l.version DESC
         LIMIT ${query.pageSize} OFFSET ${offset}
      `),
      this.db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM price_lists l WHERE ${where}`),
    ]);
    return { data: rows.rows.map(toSummary), meta: { page: query.page, pageSize: query.pageSize, total: total.rows[0]?.count ?? 0 } };
  }

  async find(principal: Principal, id: string): Promise<PriceListDetail> {
    const row = await this.db
      .execute<ListRow>(sql`
        SELECT ${this.summarySelection()}
          FROM price_lists l
          LEFT JOIN users cu ON cu.id = l.created_by
          LEFT JOIN employees ce ON ce.id = cu.employee_id
          LEFT JOIN users au ON au.id = l.approved_by
          LEFT JOIN employees ae ON ae.id = au.employee_id
         WHERE l.org_id = ${principal.orgId} AND l.id = ${id} AND l.deleted_at IS NULL
      `)
      .then((r) => r.rows[0]);
    if (row === undefined) throw AppError.notFound('Price list', id);
    const [lines, assignments] = await Promise.all([this.linesOf(id), this.assignmentsOf(id)]);
    return { ...toSummary(row), lines, assignments };
  }

  /** REQ-AN-12: what changed against the version this draft replaces. */
  async diff(principal: Principal, id: string): Promise<PriceListDiff> {
    const list = await this.find(principal, id);
    const against = list.supersedesId === null ? null : await this.find(principal, list.supersedesId);
    const before = new Map((against?.lines ?? []).map((l) => [lineKey(l), l]));
    const after = new Map(list.lines.map((l) => [lineKey(l), l]));
    const added: PriceListDiffLine[] = [];
    const removed: PriceListDiffLine[] = [];
    const changed: { before: PriceListDiffLine; after: PriceListDiffLine }[] = [];
    let unchanged = 0;
    for (const [key, line] of after) {
      const old = before.get(key);
      if (old === undefined) added.push(diffLine(line));
      else if (old.basis !== line.basis || old.rate !== line.rate || old.discountPct !== line.discountPct) changed.push({ before: diffLine(old), after: diffLine(line) });
      else unchanged += 1;
    }
    for (const [key, line] of before) if (!after.has(key)) removed.push(diffLine(line));
    const parties = new Map<string, { id: string | null; name: string }>();
    for (const a of [...list.assignments, ...(against?.assignments ?? [])]) {
      if (a.partyId !== null) parties.set(a.partyId, { id: a.partyId, name: a.partyName ?? a.partyId });
      else if (a.partyGroup !== null) parties.set(`group:${a.partyGroup}`, { id: null, name: `Every party in ${a.partyGroup}` });
      else parties.set('default', { id: null, name: 'Every party without a list of its own (the default)' });
    }
    return { against: against === null ? null : { id: against.id, version: against.version }, added, removed, changed, unchanged, partiesAffected: [...parties.values()] };
  }

  /** REQ-AN-18: what would resolve for a party and an item, and why, without raising a document. */
  async simulate(principal: Principal, query: RateSimulationQuery): Promise<RateSimulation> {
    const date = query.date ?? new Date().toISOString().slice(0, 10);
    const result = await resolveRate(this.db, principal.orgId, { partyId: query.partyId ?? null, stockItemId: query.stockItemId, quantity: query.quantity, date });
    if (result.itemName === null) throw AppError.notFound('Stock item', query.stockItemId);
    const { considered, partyName, partyGroup, itemName, itemGroup, ...resolution } = result;
    return {
      ...resolution,
      partyName,
      partyGroup,
      itemName,
      itemGroup: itemGroup ?? '',
      quantity: query.quantity,
      date,
      considered: considered.map((c) => ({ priceListId: c.id, name: c.name, version: c.version, source: c.source, applied: c.applied, why: c.why })),
    };
  }

  // ----------------------------------------------------------------- write

  async createDraft(principal: Principal, input: PriceListDraftInput): Promise<PriceListDetail> {
    this.refuseOverlaps(input.lines);
    const ctx = orgContextOf(principal);
    const id = await this.db.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO price_lists (org_id, name, version, state, effective_from, effective_to, notes, created_by, updated_by)
        VALUES (${ctx.orgId}, ${input.name}, 1, 'draft', ${input.effectiveFrom}, ${input.effectiveTo ?? null}, ${input.notes ?? null}, ${ctx.actorUserId}, ${ctx.actorUserId})
        RETURNING id
      `);
      const created = inserted.rows[0]?.id;
      if (created === undefined) throw new Error('Price list insert returned no row.');
      await this.writeBody(tx, ctx, created, input);
      return created;
    });
    this.auditContext.record({ action: 'pricing.list.drafted', entityType: 'price_list', entityId: id, before: null, after: { name: input.name, version: 1, lines: input.lines.length } });
    return this.find(principal, id);
  }

  /** REQ-AN-06: only a draft changes. An active, superseded or pending list refuses at the API, not only in the UI. */
  async updateDraft(principal: Principal, id: string, input: PriceListDraftInput): Promise<PriceListDetail> {
    const existing = await this.find(principal, id);
    if (existing.state !== 'draft') {
      throw AppError.conflict(`${existing.name} v${String(existing.version)} is ${existing.state.replace('_', ' ')} and cannot be edited. Create a new version instead.`, { state: existing.state });
    }
    this.refuseOverlaps(input.lines);
    const ctx = orgContextOf(principal);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE price_lists SET name = ${input.name}, effective_from = ${input.effectiveFrom}, effective_to = ${input.effectiveTo ?? null}, notes = ${input.notes ?? null},
               updated_at = now(), updated_by = ${ctx.actorUserId}
         WHERE id = ${id} AND org_id = ${ctx.orgId}
      `);
      await tx.execute(sql`DELETE FROM price_list_lines WHERE price_list_id = ${id}`);
      await tx.execute(sql`DELETE FROM price_list_assignments WHERE price_list_id = ${id}`);
      await this.writeBody(tx, ctx, id, input);
    });
    this.auditContext.record({ action: 'pricing.list.edited', entityType: 'price_list', entityId: id, before: { lines: existing.lineCount }, after: { lines: input.lines.length } });
    return this.find(principal, id);
  }

  /** REQ-AN-06: a change to an active list is a new version in draft, carrying the old lines until edited. */
  async newVersion(principal: Principal, id: string): Promise<PriceListDetail> {
    const existing = await this.find(principal, id);
    // An expired list is versioned too: carrying last Diwali's prices forward
    // to this one, with its lines and assignments, is the whole reason the
    // lineage exists. Nothing becomes editable -- REQ-AN-06's immutability is
    // about the list itself, not about its successor.
    if (existing.state !== 'active' && existing.state !== 'expired') {
      throw AppError.conflict(`Only an active or expired list is versioned; ${existing.name} v${String(existing.version)} is ${existing.state.replace('_', ' ')}.`);
    }
    const open = await this.db
      .execute<{ id: string }>(sql`SELECT id FROM price_lists WHERE org_id = ${principal.orgId} AND supersedes_id = ${id} AND state IN ('draft', 'pending_approval') AND deleted_at IS NULL`)
      .then((r) => r.rows[0]);
    if (open !== undefined) throw AppError.conflict(`A newer version of ${existing.name} is already in draft or awaiting approval.`, { priceListId: open.id });
    const ctx = orgContextOf(principal);
    const created = await this.db.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO price_lists (org_id, name, version, supersedes_id, state, effective_from, effective_to, notes, created_by, updated_by)
        VALUES (${ctx.orgId}, ${existing.name}, ${existing.version + 1}, ${id}, 'draft', ${existing.effectiveFrom}, ${existing.effectiveTo}, ${existing.notes}, ${ctx.actorUserId}, ${ctx.actorUserId})
        RETURNING id
      `);
      const next = inserted.rows[0]?.id;
      if (next === undefined) throw new Error('Price list insert returned no row.');
      await tx.execute(sql`
        INSERT INTO price_list_lines (org_id, price_list_id, stock_item_id, item_group, basis, rate, discount_pct, min_qty, max_qty)
        SELECT org_id, ${next}, stock_item_id, item_group, basis, rate, discount_pct, min_qty, max_qty FROM price_list_lines WHERE price_list_id = ${id}
      `);
      await tx.execute(sql`
        INSERT INTO price_list_assignments (org_id, price_list_id, party_id, party_group, is_default)
        SELECT org_id, ${next}, party_id, party_group, is_default FROM price_list_assignments WHERE price_list_id = ${id}
      `);
      return next;
    });
    this.auditContext.record({ action: 'pricing.list.versioned', entityType: 'price_list', entityId: created, before: { supersedes: id, version: existing.version }, after: { version: existing.version + 1 } });
    return this.find(principal, created);
  }

  /** REQ-AN-09: a draft goes to the inbox for pricing.approve; a holder of the key activates it directly. */
  async submit(principal: Principal, id: string): Promise<PriceListDetail> {
    const existing = await this.find(principal, id);
    if (existing.state !== 'draft') throw AppError.conflict(`${existing.name} v${String(existing.version)} is ${existing.state.replace('_', ' ')}; only a draft is submitted.`);
    if (existing.lines.length === 0) throw AppError.validation('A price list needs at least one line before it is submitted.');
    await this.refuseAssignmentOverlaps(principal.orgId, existing);
    const ctx = orgContextOf(principal);
    if (hasPermission(principal, PERMISSIONS.PRICING_APPROVE)) {
      await this.db.transaction((tx) => this.activate(tx, ctx, existing, principal.userId, null));
      this.auditContext.record({ action: 'pricing.list.activated', entityType: 'price_list', entityId: id, before: { state: 'draft' }, after: { state: 'active', by: 'key holder' } });
      return this.find(principal, id);
    }
    const approvers = await this.approvers(ctx.orgId, principal.userId);
    if (approvers.length === 0) throw AppError.conflict('Nobody holds pricing.approve, so the list has nobody to go to.');
    await this.db.transaction(async (tx) => {
      const approval = await this.approvals.raise(
        ctx,
        {
          type: 'PRICE_LIST',
          subjectType: PRICE_LIST_SUBJECT_TYPE,
          subjectId: id,
          subject: `${existing.name} v${String(existing.version)} · ${String(existing.lines.length)} line${existing.lines.length === 1 ? '' : 's'} · from ${existing.effectiveFrom}`,
          requesterUserId: principal.userId,
          approverUserIds: approvers,
        },
        tx,
      );
      await tx.execute(sql`UPDATE price_lists SET state = 'pending_approval', approval_request_id = ${approval.id}, updated_at = now(), updated_by = ${ctx.actorUserId} WHERE id = ${id}`);
    });
    this.auditContext.record({ action: 'pricing.list.submitted', entityType: 'price_list', entityId: id, before: { state: 'draft' }, after: { state: 'pending_approval' } });
    return this.find(principal, id);
  }

  /** The inbox's decision, inside the framework's transaction: approved activates, rejected returns the draft. */
  async applyApprovalDecision(ctx: OrgContext, decision: ApprovalSubjectDecision, tx: Database): Promise<ApprovalSubjectSettlement | null> {
    const row = await tx
      .execute<{ id: string; name: string; version: number; state: PriceListState; supersedes_id: string | null; effective_from: string }>(sql`
        SELECT id, name, version, state, supersedes_id, effective_from FROM price_lists WHERE org_id = ${ctx.orgId} AND id = ${decision.subjectId} AND deleted_at IS NULL
      `)
      .then((r) => r.rows[0]);
    if (row === undefined || row.state !== 'pending_approval') return null;
    if (decision.status === 'APPROVED') {
      await this.activate(tx, ctx, { id: row.id, name: row.name, version: row.version, supersedesId: row.supersedes_id }, decision.decidedByUserId, decision.approvalRequestId);
      return () => {
        this.auditContext.record({ action: 'pricing.list.activated', entityType: 'price_list', entityId: row.id, before: { state: 'pending_approval' }, after: { state: 'active', approvalRequestId: decision.approvalRequestId } });
        return Promise.resolve();
      };
    }
    if (decision.status === 'REJECTED') {
      await tx.execute(sql`UPDATE price_lists SET state = 'draft', approval_request_id = NULL, updated_at = now(), updated_by = ${ctx.actorUserId} WHERE id = ${row.id}`);
      return () => {
        this.auditContext.record({ action: 'pricing.list.rejected', entityType: 'price_list', entityId: row.id, before: { state: 'pending_approval' }, after: { state: 'draft', reason: decision.reason } });
        return Promise.resolve();
      };
    }
    return null;
  }

  // --------------------------------------------------------------- private

  /**
   * The state a list is actually in, rather than the one last written.
   *
   * `expired` is declared in the contract and offered as a filter, and no
   * code path ever wrote it: a list past its effective-to date went on
   * reading `active`, so the register showed it as in force, the filter for
   * expired lists returned nothing for ever, and the only clue was the date
   * beside it. Derived at read time rather than swept: a date passing is not
   * an event anything fires, and a job that wrote the row would be wrong for
   * the hours between midnight and its next run.
   *
   * The stored value is what the resolver and every guard still read; this is
   * the reader's word for it.
   */
  private effectiveState() {
    return sql`CASE WHEN l.state = 'active' AND l.effective_to IS NOT NULL AND l.effective_to < current_date THEN 'expired'::price_list_state ELSE l.state END`;
  }

  private summarySelection() {
    return sql`l.id, l.name, l.version, ${this.effectiveState()} AS state, l.effective_from::text, l.effective_to::text, l.supersedes_id, l.notes, l.approval_request_id,
               l.approved_at, coalesce(nullif(concat_ws(' ', ae.first_name, ae.last_name), ''), au.email) AS approved_by_name, l.superseded_at, l.created_at,
               coalesce(nullif(concat_ws(' ', ce.first_name, ce.last_name), ''), cu.email) AS created_by_name,
               (SELECT count(*)::int FROM price_list_lines pl WHERE pl.price_list_id = l.id) AS line_count,
               (SELECT count(*)::int FROM price_list_assignments pa WHERE pa.price_list_id = l.id) AS assignment_count`;
  }

  private async linesOf(id: string): Promise<PriceListLineView[]> {
    const rows = await this.db.execute<LineRow>(sql`
      SELECT pl.id, pl.stock_item_id, i.name AS item_name, pl.item_group, pl.basis, pl.rate::text, pl.discount_pct::text, pl.min_qty::text, pl.max_qty::text
        FROM price_list_lines pl LEFT JOIN stock_items i ON i.id = pl.stock_item_id
       WHERE pl.price_list_id = ${id}
       ORDER BY coalesce(i.name, pl.item_group), pl.min_qty NULLS FIRST
    `);
    return rows.rows.map(toLine);
  }

  private async assignmentsOf(id: string): Promise<PriceListAssignmentView[]> {
    const rows = await this.db.execute<{ id: string; party_id: string | null; party_name: string | null; party_group: string | null; is_default: boolean }>(sql`
      SELECT a.id, a.party_id, p.name AS party_name, a.party_group, a.is_default
        FROM price_list_assignments a LEFT JOIN parties p ON p.id = a.party_id
       WHERE a.price_list_id = ${id}
       ORDER BY a.is_default DESC, a.party_group, p.name
    `);
    return rows.rows.map((r) => ({ id: r.id, partyId: r.party_id, partyName: r.party_name, partyGroup: r.party_group, isDefault: r.is_default }));
  }

  private async writeBody(tx: Database, ctx: OrgContext, id: string, input: PriceListDraftInput): Promise<void> {
    for (const line of input.lines) {
      await tx.execute(sql`
        INSERT INTO price_list_lines (org_id, price_list_id, stock_item_id, item_group, basis, rate, discount_pct, min_qty, max_qty)
        VALUES (${ctx.orgId}, ${id}, ${line.stockItemId ?? null}, ${line.itemGroup ?? null}, ${line.basis}, ${line.rate ?? null}, ${line.discountPct ?? null}, ${line.minQty ?? null}, ${line.maxQty ?? null})
      `);
    }
    for (const a of input.assignments) {
      await tx.execute(sql`
        INSERT INTO price_list_assignments (org_id, price_list_id, party_id, party_group, is_default)
        VALUES (${ctx.orgId}, ${id}, ${a.partyId ?? null}, ${a.partyGroup ?? null}, ${a.isDefault})
      `);
    }
  }

  private refuseOverlaps(lines: readonly PriceListLineInput[]): void {
    const overlaps = overlappingSlabs(lines);
    if (overlaps.length === 0) return;
    const named = overlaps.map((o) => `lines ${String(o.a)} and ${String(o.b)}`).join(', ');
    throw AppError.validation(`Quantity slabs overlap on the same item: ${named}. Give each slab its own range.`, {
      fields: overlaps.flatMap((o) => [
        { path: `lines.${String(o.a - 1)}.maxQty`, message: `overlaps line ${String(o.b)}` },
        { path: `lines.${String(o.b - 1)}.minQty`, message: `overlaps line ${String(o.a)}` },
      ]),
    });
  }

  /**
   * REQ-AN-04: one party, one list at a time. A party (or group, or the
   * default) assigned here must not be assigned on another lineage's list
   * whose effective period overlaps this one's. A newer version of the same
   * lineage replaces rather than overlaps.
   */
  private async refuseAssignmentOverlaps(orgId: string, list: PriceListDetail): Promise<void> {
    const lineage = await this.lineageIds(orgId, list.id);
    for (const a of list.assignments) {
      const clash = await this.db
        .execute<{ name: string; version: number }>(sql`
          SELECT l.name, l.version
            FROM price_list_assignments x JOIN price_lists l ON l.id = x.price_list_id
           WHERE l.org_id = ${orgId} AND l.deleted_at IS NULL AND l.state IN ('active', 'pending_approval')
             AND l.id NOT IN (${sql.join(lineage.map((lineageId) => sql`${lineageId}::uuid`), sql`, `)})
             AND l.effective_from <= ${list.effectiveTo ?? '9999-12-31'}::date
             AND coalesce(l.effective_to, '9999-12-31'::date) >= ${list.effectiveFrom}::date
             AND (${a.partyId === null ? sql`FALSE` : sql`x.party_id = ${a.partyId}`}
               OR ${a.partyGroup === null ? sql`FALSE` : sql`x.party_group = ${a.partyGroup}`}
               OR ${a.isDefault ? sql`x.is_default` : sql`FALSE`})
           LIMIT 1
        `)
        .then((r) => r.rows[0]);
      if (clash !== undefined) {
        const who = a.partyName ?? a.partyGroup ?? 'the default';
        throw AppError.conflict(`${who} is already on ${clash.name} v${String(clash.version)} for an overlapping period. One party, one list at a time.`, { assignmentId: a.id });
      }
    }
  }

  /** Every version of the lineage this list belongs to, itself included. */
  private async lineageIds(orgId: string, id: string): Promise<string[]> {
    const rows = await this.db.execute<{ id: string }>(sql`
      WITH RECURSIVE up AS (
        SELECT id, supersedes_id FROM price_lists WHERE org_id = ${orgId} AND id = ${id}
        UNION SELECT p.id, p.supersedes_id FROM price_lists p JOIN up ON up.supersedes_id = p.id
      ), down AS (
        SELECT id FROM price_lists WHERE org_id = ${orgId} AND id = ${id}
        UNION SELECT c.id FROM price_lists c JOIN down ON c.supersedes_id = down.id
      )
      SELECT id FROM up UNION SELECT id FROM down
    `);
    return rows.rows.map((r) => r.id);
  }

  /** Activation: the list comes into force, and the version it replaces ends at the same instant (REQ-AN-06). */
  private async activate(tx: Database, ctx: OrgContext, list: { id: string; name: string; version: number; supersedesId: string | null }, approvedBy: string | null, approvalRequestId: string | null): Promise<void> {
    await tx.execute(sql`
      UPDATE price_lists SET state = 'active', approved_by = ${approvedBy}, approved_at = now(), approval_request_id = coalesce(${approvalRequestId}, approval_request_id),
             updated_at = now(), updated_by = ${ctx.actorUserId}
       WHERE id = ${list.id} AND org_id = ${ctx.orgId}
    `);
    if (list.supersedesId !== null) {
      // The old version reigns until the new one actually starts, not until it
      // was approved. Approving a list that takes effect on 1 April in
      // February would otherwise leave six weeks with no list in force at all,
      // and every document raised in them would be written at Tally's rate --
      // permanently, because a line stores what resolved (REQ-AN-15).
      await tx.execute(sql`
        UPDATE price_lists SET state = 'superseded',
               superseded_at = GREATEST(now(), (SELECT effective_from FROM price_lists WHERE id = ${list.id})::timestamptz),
               updated_at = now(), updated_by = ${ctx.actorUserId}
         WHERE id = ${list.supersedesId} AND org_id = ${ctx.orgId} AND state = 'active'
      `);
    }
  }

  /** One level: the first holder of pricing.approve who is not the requester (the framework reads a route as a chain of levels). */
  private async approvers(orgId: string, requesterUserId: string): Promise<string[]> {
    const rows = await this.db.execute<{ user_id: string }>(sql`
      SELECT DISTINCT u.id AS user_id, u.email
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id
        JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
       WHERE u.org_id = ${orgId} AND u.deleted_at IS NULL AND u.status = 'ACTIVE' AND p.key = ${PERMISSIONS.PRICING_APPROVE}
       ORDER BY u.email
    `);
    return rows.rows.map((r) => r.user_id).filter((userId) => userId !== requesterUserId).slice(0, 1);
  }
}
