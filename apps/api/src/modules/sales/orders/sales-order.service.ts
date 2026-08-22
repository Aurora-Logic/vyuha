import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DEFAULT_SALES_SETTINGS,
  ERROR_CODES,
  type ConfirmSalesOrderInput,
  type CreditPosition,
  type SalesSettings,
  DEFAULT_ESTIMATE_SORT,
  ESTIMATE_SORT_FIELDS,
  PERMISSIONS,
  PUSH_KIND_VOUCHER_TYPE,
  pageSlice,
  paginated,
  parseSort,
  type ConvertEstimateInput,
  type CreateSalesOrderInput,
  type Paginated,
  type SalesDocumentSummary,
  type SalesDocumentView,
  type SalesOrderListQuery,
  type UpdateSalesOrderInput,
  type VoucherPushPayload, type SalesLineView } from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AuditContext } from '../../../platform/audit/audit-context.js';
import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database, type Transaction } from '../../../platform/db/db.provider.js';
import { ApprovalService } from '../../../platform/approvals/approval.service.js';
import { CollectionsService } from '../../../platform/collections/collections.service.js';
import type { ApprovalSubjectDecision, ApprovalSubjectSettlement } from '../../../platform/approvals/approval-subject.registry.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import { hasPermission, orgContextOf, type Principal } from '../../../platform/rbac/principal.js';
import { ScopeService, type ScopeGrants } from '../../../platform/rbac/scope.service.js';
import { PushOutcomeRegistry, type PushMirror, type PushOutcome } from '../../../platform/sync/push-outcome.registry.js';
import { PushQueueService } from '../../../platform/sync/push-queue.service.js';
import { RequirementsService } from '../../../platform/procurement/requirements.service.js';
import { orgToday, resolveDocumentCustomer, resolveDocumentLines, resolveDocumentOwner } from '../../../platform/documents/document-support.js';
import { EstimateRepository, type EstimateHeaderInput } from '../estimates/estimate.repository.js';
import { salesDocuments } from '../schema/index.js';

/**
 * Sales orders (REQ-W-03) and the push path they ride (09 §3.3, REQ-W-06,
 * REQ-W-07). Created fresh or converted from an accepted estimate; a draft
 * is edited freely; confirming it queues one push job — one voucher per
 * request, always — and from then on the document's sync state is whatever
 * the agent reported, never inferred. An alter re-pushes against the GUID
 * Tally gave and never creates a second voucher.
 *
 * The customer must be a Tally party: an order pushes, and Tally has no
 * ledger for a prospect (REQ-U-03).
 */

const GRANTS: ScopeGrants = {
  self: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
  all: PERMISSIONS.SALES_DOCUMENT_VIEW_ALL,
};

const SQL_TRUE = sql`true`;
const SETTING_DISCOUNT_PCT = 'sales.discountApprovalPct';
/** `snake_case`, the approval framework's spelling (see APPROVAL_SUBJECT_TYPES). */
export const SALES_ORDER_SUBJECT_TYPE = 'sales_order';
const DOC_TYPE = 'SALES_ORDER' as const;

/**
 * 15 REQ-AN-16: what a line actually charges, against what the price lists
 * resolved. The comparison is the net rate, not the typed one: a line at the
 * list rate with 90% off its face is nine tenths below the floor, and reading
 * only `rate` let exactly that through.
 */
function netRate(line: Pick<SalesLineView, 'rate' | 'discountPct'>): number {
  return Number(line.rate) * (1 - Number(line.discountPct) / 100);
}

function isBelowFloor(line: SalesLineView): boolean {
  // 15 REQ-AK-09: a free replacement line is below every floor by
  // construction, and the decision that made it free was recorded on the
  // return. Asking for a discount reason as well would be asking twice.
  if (line.freeOfCharge) return false;
  return line.resolvedRate !== null && netRate(line) < Number(line.resolvedRate) - 0.005;
}

function belowFloorRefusal(line: SalesLineView): AppError {
  return AppError.validation(
    `Line ${String(line.lineNo)} (${line.description}) works out at ${netRate(line).toFixed(2)} against a floor of ${line.resolvedRate ?? ''}; a reason is needed to go below the price list.`,
    { fields: [{ path: `lines.${String(line.lineNo - 1)}.rateOverrideReason`, message: 'required below the resolved rate' }] },
  );
}

@Injectable()
export class SalesOrderService implements OnModuleInit {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly scopes: ScopeService,
    private readonly pushOutcomes: PushOutcomeRegistry,
    private readonly pushQueue: PushQueueService,
    private readonly requirements: RequirementsService,
    private readonly approvals: ApprovalService,
    private readonly collections: CollectionsService,
  ) {}

  onModuleInit(): void {
    this.pushOutcomes.register({
      kind: 'SALES_ORDER',
      onOutcome: (tx, orgId, payload, outcome) => this.applyOutcome(tx, orgId, payload, outcome),
      onMirror: (tx, orgId, documentId, mirror) => this.applyMirror(tx, orgId, documentId, mirror),
    });
  }

  /**
   * D-38 / REQ-W-06, the other direction: the pushed voucher came back on the
   * pull. Tally is the system of record — an order cancelled there is
   * cancelled here, and its number is whatever Tally now calls it. Nothing
   * else moves: quantities are Vyuha's own facts.
   */
  private async applyMirror(tx: Transaction, orgId: string, documentId: string, mirror: PushMirror): Promise<void> {
    const rows = await tx.execute<{ status: string; number: string }>(sql`SELECT status, number FROM sales_documents WHERE org_id = ${orgId} AND id = ${documentId} AND deleted_at IS NULL`);
    const current = rows.rows[0];
    if (current === undefined) return;
    await tx.execute(sql`
      UPDATE sales_documents SET remote_voucher_number = COALESCE(${mirror.remoteVoucherNumber}, remote_voucher_number), remote_guid = ${mirror.remoteGuid}, updated_at = now()
       WHERE id = ${documentId}
    `);
    if (mirror.isCancelled && current.status === 'CONFIRMED') {
      await tx.execute(sql`UPDATE sales_documents SET status = 'CANCELLED', updated_at = now() WHERE id = ${documentId}`);
      this.auditContext.record({ action: 'sales.order.cancelled_in_tally', entityType: 'sales_document', entityId: documentId, before: { status: current.status }, after: { number: current.number, remoteGuid: mirror.remoteGuid } });
    }
  }

  async list(principal: Principal, query: SalesOrderListQuery): Promise<Paginated<SalesDocumentSummary>> {
    const { limit, offset } = pageSlice(query);
    const { rows, total } = await this.repository(principal).list(this.scope(principal), {
      q: query.q,
      status: query.status,
      syncState: query.syncState,
      partyId: query.partyId,
      companyId: query.companyId,
      dealId: query.dealId,
      ownerId: query.ownerId,
      sort: parseSort(query.sort ?? DEFAULT_ESTIMATE_SORT, ESTIMATE_SORT_FIELDS),
      limit,
      offset,
    });
    return paginated(rows, query, total);
  }

  async find(principal: Principal, id: string): Promise<SalesDocumentView> {
    const order = await this.repository(principal).view(this.scope(principal), id);
    if (order === null) throw AppError.notFound('Sales order', id);
    // 13 REQ-X-26: why it waits and what it waits on, from the platform seam.
    return { ...order, waitingOn: await this.requirements.waitingOn(principal.orgId, id) };
  }

  async create(principal: Principal, input: CreateSalesOrderInput): Promise<SalesDocumentView> {
    const repository = this.repository(principal);
    const customer = await resolveDocumentCustomer(this.db, principal, input.partyId, null, null);
    const lines = await resolveDocumentLines(this.db, principal, input.lines);
    const header: EstimateHeaderInput = {
      date: input.date ?? (await orgToday(this.db, principal.orgId)),
      validUntil: null,
      partyId: customer.partyId,
      companyId: null,
      dealId: input.dealId ?? null,
      customerName: customer.name,
      ownerId: await resolveDocumentOwner(this.db, this.scopes, GRANTS, principal, input.ownerId),
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      placeOfSupply: input.placeOfSupply ?? null,
      shipTo: input.shipTo ?? null,
      details: input.details ?? null,
      // REQ-AA-28: the party master's contact unless this order says otherwise.
      ...(await this.partyContact(principal.orgId, customer.partyId, input.customerEmail, input.customerWhatsapp)),
    };
    const id = await repository.create(header, lines);
    const order = await repository.view(SQL_TRUE, id);
    if (order === null) throw new Error(`Sales order ${id} vanished between insert and read-back.`);
    this.auditContext.record({ action: 'sales.order.created', entityType: 'sales_document', entityId: id, before: null, after: auditView(order) });
    return order;
  }

  /** REQ-W-03: an accepted estimate becomes a draft order carrying its lines. */
  async convertFromEstimate(principal: Principal, estimateId: string, input: ConvertEstimateInput): Promise<SalesDocumentView> {
    const estimates = new EstimateRepository(this.db, orgContextOf(principal), 'ESTIMATE');
    const estimate = await estimates.view(this.scope(principal), estimateId);
    if (estimate === null) throw AppError.notFound('Estimate', estimateId);
    if (estimate.status !== 'ACCEPTED') {
      throw AppError.conflict(`${estimate.number} is ${estimate.status.toLowerCase()}; only an accepted estimate becomes an order.`);
    }
    const partyId = input.partyId ?? estimate.partyId;
    if (partyId === null) {
      throw AppError.validation('The estimate was addressed to a prospect. Choose the Tally party the order is for.', {
        fields: [{ path: 'partyId', message: 'is required' }],
      });
    }
    const customer = await resolveDocumentCustomer(this.db, principal, partyId, null, null);
    const repository = this.repository(principal);
    const header: EstimateHeaderInput = {
      sourceDocumentId: estimate.id,
      date: await orgToday(this.db, principal.orgId),
      validUntil: null,
      partyId: customer.partyId,
      companyId: estimate.companyId,
      dealId: estimate.dealId,
      customerName: customer.name,
      ownerId: estimate.ownerId ?? principal.employeeId,
      notes: estimate.notes,
      terms: estimate.terms,
      // The GST header travels with the conversion; the order's own boxes start from the estimate's.
      placeOfSupply: estimate.placeOfSupply,
      shipTo: estimate.shipTo,
      details: estimate.details,
      ...(await this.partyContact(principal.orgId, customer.partyId, undefined, undefined)),
    };
    const id = await repository.create(
      header,
      estimate.lines.map((line) => ({
        stockItemId: line.stockItemId,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        rate: line.rate,
        discountPct: line.discountPct,
        taxPct: line.taxPct,
        hsnCode: line.hsnCode,
      })),
    );
    const order = await repository.view(SQL_TRUE, id);
    if (order === null) throw new Error(`Sales order ${id} vanished between insert and read-back.`);
    this.auditContext.record({
      action: 'sales.order.converted',
      entityType: 'sales_document',
      entityId: id,
      before: { estimateId: estimate.id, estimateNumber: estimate.number },
      after: auditView(order),
    });
    return order;
  }

  async update(principal: Principal, id: string, input: UpdateSalesOrderInput): Promise<SalesDocumentView> {
    const existing = await this.find(principal, id);
    if (existing.status !== 'DRAFT') {
      throw AppError.conflict(`${existing.number} is ${existing.status.toLowerCase()}. A confirmed order changes only through Alter (REQ-W-07).`);
    }
    return this.applyEdit(principal, existing, input, 'sales.order.updated');
  }

  /**
   * Draft → confirmed, and one push job queued for the agent. Without a
   * connection an agent can work, the order is confirmed and stays
   * NOT_PUSHED — said plainly on the screen — and Push queues it later.
   */
  async confirm(principal: Principal, id: string, input: ConfirmSalesOrderInput = {}): Promise<SalesDocumentView> {
    const existing = await this.find(principal, id);
    if (existing.status !== 'DRAFT') throw AppError.conflict(`${existing.number} is already ${existing.status.toLowerCase()}.`);
    if (existing.lines.length === 0) throw AppError.conflict(`${existing.number} has no lines.`);
    // REQ-W-09: over the party's credit limit, the order stops here unless a
    // holder of sales.credit.override releases it with a reason on record.
    const position = existing.partyId === null ? null : await this.creditPosition(principal.orgId, existing.partyId);
    if (position !== null && position.creditLimit !== null && Number(position.exposure) + Number(position.openOrders) + Number(existing.grandTotal) > Number(position.creditLimit)) {
      const reason = input.creditOverrideReason?.trim() ?? '';
      if (reason === '' || !hasPermission(principal, PERMISSIONS.SALES_CREDIT_OVERRIDE)) {
        throw new AppError(
          ERROR_CODES.CREDIT_BLOCKED,
          `${position.partyName} is over its credit limit: exposure ${position.exposure} plus open orders ${position.openOrders} plus this order ${existing.grandTotal} exceeds ${position.creditLimit}. A holder of sales.credit.override may release it with a reason.`,
          { details: { position, requiredPermission: PERMISSIONS.SALES_CREDIT_OVERRIDE, orderTotal: existing.grandTotal } },
        );
      }
      this.auditContext.record({ action: 'sales.order.credit_overridden', entityType: 'sales_document', entityId: id, before: { position }, after: { reason, orderTotal: existing.grandTotal } });
    }
    // REQ-W-08: a discount past the threshold waits in the approvals inbox for
    // sales.discount.approve, unless the confirmer holds the key themselves.
    const settings = await this.readSettings(principal.orgId);
    const steepest = Math.max(0, ...existing.lines.map((l) => Number(l.discountPct)));
    // 15 REQ-AN-16: the resolved rate is the floor. A line under it needs a
    // reason, and goes to the same inbox as a steep discount.
    const belowFloor = existing.lines.filter((l) => isBelowFloor(l));
    const unexplained = belowFloor.find((l) => l.rateOverrideReason === null || l.rateOverrideReason.trim() === '');
    if (unexplained !== undefined) throw belowFloorRefusal(unexplained);
    const steepDiscount = settings.discountApprovalPct !== null && steepest > settings.discountApprovalPct;
    if ((steepDiscount || belowFloor.length > 0) && !hasPermission(principal, PERMISSIONS.SALES_DISCOUNT_APPROVE)) {
      const approvers = await this.approvers(principal.orgId, principal.userId);
      const ctx = orgContextOf(principal);
      await this.db.transaction(async (tx) => {
        const approval = await this.approvals.raise(
          ctx,
          {
            type: 'SALES_DISCOUNT',
            subjectType: SALES_ORDER_SUBJECT_TYPE,
            subjectId: id,
            subject: `${existing.number} · ${existing.customerName} · ${belowFloor.length > 0 ? `${String(belowFloor.length)} line${belowFloor.length === 1 ? '' : 's'} below the price list` : `${String(steepest)}% off`} · ${existing.grandTotal}`,
            requesterUserId: principal.userId,
            approverUserIds: approvers,
          },
          tx,
        );
        await tx.execute(sql`UPDATE sales_documents SET status = 'PENDING_APPROVAL', approval_request_id = ${approval.id}, updated_at = now(), updated_by = ${principal.userId} WHERE id = ${id}`);
      });
      this.auditContext.record({ action: 'sales.order.submitted_for_approval', entityType: 'sales_document', entityId: id, before: auditView(existing), after: { steepestDiscountPct: steepest, threshold: settings.discountApprovalPct } });
      return this.find(principal, id);
    }
    return this.release(principal, existing);
  }

  /** The order becomes confirmed and its voucher is queued — from confirm directly, or from the inbox's decision. */
  private async release(principal: Principal, existing: SalesDocumentView): Promise<SalesDocumentView> {
    const repository = this.repository(principal);
    await repository.setStatus(existing.id, 'CONFIRMED');
    const queued = await this.enqueuePush(principal, { ...existing, status: 'CONFIRMED' });
    const order = await repository.view(SQL_TRUE, existing.id);
    if (order === null) throw AppError.notFound('Sales order', existing.id);
    this.auditContext.record({
      action: 'sales.order.confirmed',
      entityType: 'sales_document',
      entityId: existing.id,
      before: auditView(existing),
      after: { ...auditView(order), queued },
    });
    return order;
  }

  /** The button on the order itself decides the inbox request, so the framework's rules hold whichever door the approver came through. */
  async approve(principal: Principal, id: string): Promise<SalesDocumentView> {
    if (!hasPermission(principal, PERMISSIONS.SALES_DISCOUNT_APPROVE)) throw AppError.forbidden('Approving a discount needs sales.discount.approve.');
    const existing = await this.find(principal, id);
    if (existing.status !== 'PENDING_APPROVAL') throw AppError.conflict(`${existing.number} is not awaiting approval.`);
    const row = await this.db.execute<{ approval_request_id: string | null }>(sql`SELECT approval_request_id FROM sales_documents WHERE id = ${id}`);
    const approvalRequestId = row.rows[0]?.approval_request_id ?? null;
    if (approvalRequestId === null) return this.release(principal, existing);
    await this.approvals.decide(principal, approvalRequestId, 'APPROVE', null);
    return this.find(principal, id);
  }

  /** Called by the framework through the registry, inside its transaction. */
  async applyApprovalDecision(ctx: OrgContext, decision: ApprovalSubjectDecision, tx: Database): Promise<ApprovalSubjectSettlement | null> {
    const row = await tx.execute<{ id: string; status: string; number: string }>(sql`
      SELECT id, status, number FROM sales_documents WHERE org_id = ${ctx.orgId} AND id = ${decision.subjectId} AND doc_type = 'SALES_ORDER' AND deleted_at IS NULL
    `);
    const order = row.rows[0];
    if (order === undefined) throw AppError.notFound('Sales order', decision.subjectId);
    if (decision.status === 'ESCALATED') return null;
    if (order.status !== 'PENDING_APPROVAL') throw AppError.conflict(`${order.number} is ${order.status.toLowerCase()}, not awaiting approval.`);
    if (decision.status === 'REJECTED') {
      await tx.execute(sql`UPDATE sales_documents SET status = 'DRAFT', approval_request_id = NULL, updated_at = now(), updated_by = ${decision.decidedByUserId} WHERE id = ${order.id}`);
      return () => {
        this.auditContext.record({ action: 'sales.order.discount_rejected', entityType: 'sales_document', entityId: order.id, before: null, after: { reason: decision.reason } });
        return Promise.resolve();
      };
    }
    await tx.execute(sql`UPDATE sales_documents SET status = 'CONFIRMED', updated_at = now(), updated_by = ${decision.decidedByUserId} WHERE id = ${order.id}`);
    return async () => {
      // The push needs a principal-shaped actor for its audit; the decider is the actor.
      const view = await new EstimateRepository(this.db, { orgId: ctx.orgId, actorUserId: decision.decidedByUserId }, 'SALES_ORDER').view(SQL_TRUE, order.id);
      if (view !== null) await this.enqueuePush({ orgId: ctx.orgId, userId: decision.decidedByUserId } as Principal, view);
      this.auditContext.record({ action: 'sales.order.discount_approved', entityType: 'sales_document', entityId: order.id, before: null, after: { approvalRequestId: decision.approvalRequestId } });
    };
  }

  /**
   * REQ-W-07's edit path re-prices a voucher Tally has already accepted, so
   * it meets the same floor the confirm does. Without this, an order could be
   * confirmed at the list rate and altered to a tenth of it, and the altered
   * voucher would go to Tally with no reason and no approver.
   */
  private assertAboveFloor(lines: readonly SalesLineView[]): void {
    const unexplained = lines.filter((l) => isBelowFloor(l)).find((l) => l.rateOverrideReason === null || l.rateOverrideReason.trim() === '');
    if (unexplained !== undefined) throw belowFloorRefusal(unexplained);
  }

  /** The route for a discount approval: one level, the first holder of sales.discount.approve who is not the requester. */
  private async approvers(orgId: string, requesterUserId: string): Promise<string[]> {
    const rows = await this.db.execute<{ user_id: string }>(sql`
      SELECT DISTINCT u.id AS user_id, u.email
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id
        JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
       WHERE u.org_id = ${orgId} AND u.deleted_at IS NULL AND u.status = 'ACTIVE' AND p.key = ${PERMISSIONS.SALES_DISCOUNT_APPROVE}
       ORDER BY u.email
    `);
    // One level, not one per holder: the framework reads its route as a chain
    // of levels, so listing every holder would make each approve in turn.
    // The first holder who is not the requester is the level; every other
    // holder acts through the override key and browses through scope.all.
    return rows.rows.map((r) => r.user_id).filter((userId) => userId !== requesterUserId).slice(0, 1);
  }

  // ------------------------------------------------------------ settings

  async readSettings(orgId: string): Promise<SalesSettings> {
    const rows = await this.db.execute<{ value: unknown }>(sql`
      SELECT value FROM settings WHERE org_id = ${orgId} AND scope = 'ORG' AND key = ${SETTING_DISCOUNT_PCT} AND deleted_at IS NULL LIMIT 1
    `);
    const raw = rows.rows[0]?.value;
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : null;
    return { discountApprovalPct: parsed === null || !Number.isFinite(parsed) ? DEFAULT_SALES_SETTINGS.discountApprovalPct : parsed };
  }

  async writeSettings(principal: Principal, input: SalesSettings): Promise<SalesSettings> {
    const before = await this.readSettings(principal.orgId);
    await this.db.execute(sql`
      INSERT INTO settings (org_id, scope, scope_id, key, value, created_by, updated_by)
      VALUES (${principal.orgId}, 'ORG', NULL, ${SETTING_DISCOUNT_PCT}, ${JSON.stringify(input.discountApprovalPct)}::jsonb, ${principal.userId}, ${principal.userId})
      ON CONFLICT (org_id, scope, (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)), key) WHERE deleted_at IS NULL
      DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
    `);
    const after = await this.readSettings(principal.orgId);
    this.auditContext.record({ action: 'sales.settings.updated', entityType: 'organization', entityId: principal.orgId, before: { ...before }, after: { ...after } });
    return after;
  }

  /** Queue (or re-queue) the push for a confirmed order that is not in Tally. */
  async push(principal: Principal, id: string): Promise<SalesDocumentView> {
    const existing = await this.find(principal, id);
    if (existing.status !== 'CONFIRMED') throw AppError.conflict(`${existing.number} is ${existing.status.toLowerCase()}; confirm it first.`);
    if (existing.syncState === 'PUSHED') throw AppError.conflict(`${existing.number} is already in Tally. Use Alter to change it.`);
    if (existing.syncState === 'QUEUED') throw AppError.conflict(`${existing.number} is already queued for the agent.`);
    const queued = await this.enqueuePush(principal, existing);
    if (!queued) {
      throw AppError.conflict('No Tally connection can carry a push: an agent connection with a bound company and an issued token is needed.');
    }
    const order = await this.repository(principal).view(SQL_TRUE, id);
    if (order === null) throw AppError.notFound('Sales order', id);
    this.auditContext.record({ action: 'sales.order.push_requested', entityType: 'sales_document', entityId: id, before: auditView(existing), after: auditView(order) });
    return order;
  }

  /**
   * REQ-W-07: a pushed order is read-only except through this. The edit is
   * applied and re-pushed against the stored GUID; the agent alters that
   * voucher and never creates a second. Needs `sales.document.alter`.
   */
  async alter(principal: Principal, id: string, input: UpdateSalesOrderInput): Promise<SalesDocumentView> {
    if (!hasPermission(principal, PERMISSIONS.SALES_DOCUMENT_ALTER)) {
      throw AppError.forbidden('Altering an accepted document needs sales.document.alter.');
    }
    const existing = await this.find(principal, id);
    if (existing.syncState === 'QUEUED') throw AppError.conflict(`${existing.number} has a push in flight.`);
    if (existing.status !== 'CONFIRMED' || existing.syncState !== 'PUSHED' || existing.remoteGuid === null) {
      throw AppError.conflict(`${existing.number} is not in Tally; edit it as a draft, or push it first.`);
    }
    // Replacing the lines deletes them, and a line that has been picked is
    // referenced by pick_records, packs and dispatches under a RESTRICT
    // foreign key -- so the alter died inside the database and the caller got
    // a bare 500 with nothing to act on. Say what is in the way. An order
    // nothing has moved on alters as it always did.
    if (input.lines !== undefined) {
      const moved = existing.lines.filter(
        (line) => Number(line.pickedQty) > 0 || Number(line.packedQty) > 0 || Number(line.invoicedQty) > 0 || Number(line.dispatchedQty) > 0,
      );
      if (moved.length > 0) {
        throw AppError.conflict(
          `${existing.number} is being fulfilled: ${moved.map((line) => line.description).join(', ')} ` +
            `${moved.length === 1 ? 'has' : 'have'} already been picked, packed or invoiced. ` +
            'Dispatch what is packed or short-close the order before altering its lines.',
          { details: { lines: moved.map((line) => ({ lineId: line.id, description: line.description, pickedQty: line.pickedQty, packedQty: line.packedQty, dispatchedQty: line.dispatchedQty })) } },
        );
      }
    }
    const edited = await this.applyEdit(principal, existing, input, 'sales.order.altered');
    this.assertAboveFloor(edited.lines);
    // An alter that queues nothing is an alter that did not happen; saying 200
    // to it left the edit applied here and never sent to Tally.
    if (!(await this.enqueuePush(principal, edited))) {
      throw AppError.conflict(`${existing.number} could not be queued: a push for it is already open, or no Tally connection can carry one.`);
    }
    const order = await this.repository(principal).view(SQL_TRUE, id);
    if (order === null) throw AppError.notFound('Sales order', id);
    return order;
  }

  async cancel(principal: Principal, id: string): Promise<SalesDocumentView> {
    const existing = await this.find(principal, id);
    if (existing.status !== 'DRAFT' && existing.status !== 'PENDING_APPROVAL') {
      throw AppError.conflict(`${existing.number} is ${existing.status.toLowerCase()}; a confirmed order is cancelled in Tally, and the change arrives on the next pull.`);
    }
    if (existing.status === 'PENDING_APPROVAL') {
      // The inbox request goes with it, or an approver decides an order that no longer exists.
      await this.approvals.cancelForSubject(orgContextOf(principal), SALES_ORDER_SUBJECT_TYPE, id, `${existing.number} cancelled by its author.`);
      await this.db.execute(sql`UPDATE sales_documents SET approval_request_id = NULL WHERE id = ${id}`);
    }
    const repository = this.repository(principal);
    await repository.setStatus(id, 'CANCELLED');
    const order = await repository.view(SQL_TRUE, id);
    if (order === null) throw AppError.notFound('Sales order', id);
    this.auditContext.record({ action: 'sales.order.cancelled', entityType: 'sales_document', entityId: id, before: auditView(existing), after: auditView(order) });
    return order;
  }

  // ---------------------------------------------------------------- helpers

  private async applyEdit(principal: Principal, existing: SalesDocumentView, input: UpdateSalesOrderInput, action: string): Promise<SalesDocumentView> {
    const repository = this.repository(principal);
    const patch: Partial<EstimateHeaderInput> = {};
    if (input.partyId !== undefined) {
      const customer = await resolveDocumentCustomer(this.db, principal, input.partyId, null, null);
      patch.partyId = customer.partyId;
      patch.customerName = customer.name;
    }
    if (input.date !== undefined) patch.date = input.date;
    if (input.dealId !== undefined) patch.dealId = input.dealId;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.terms !== undefined) patch.terms = input.terms;
    if (input.placeOfSupply !== undefined) patch.placeOfSupply = input.placeOfSupply;
    if (input.shipTo !== undefined) patch.shipTo = input.shipTo;
    if (input.details !== undefined) patch.details = input.details;
    if (input.customerEmail !== undefined) patch.customerEmail = input.customerEmail;
    if (input.customerWhatsapp !== undefined) patch.customerWhatsapp = input.customerWhatsapp;
    if (input.ownerId !== undefined && input.ownerId !== existing.ownerId) {
      patch.ownerId = await resolveDocumentOwner(this.db, this.scopes, GRANTS, principal, input.ownerId);
    }
    const lines = input.lines === undefined ? undefined : await resolveDocumentLines(this.db, principal, input.lines);
    const updated = await repository.updateHeader(existing.id, patch, lines);
    if (!updated) throw AppError.notFound('Sales order', existing.id);
    const order = await repository.view(SQL_TRUE, existing.id);
    if (order === null) throw AppError.notFound('Sales order', existing.id);
    this.auditContext.record({ action, entityType: 'sales_document', entityId: existing.id, before: auditView(existing), after: auditView(order) });
    return order;
  }

  /**
   * One push job for one document (09 §3.3: one voucher per request). The
   * job's entity_type carries the document id so two documents queue side
   * by side while one document can never have two pushes open. The agent
   * renders the XML from the payload; the API never writes Tally XML.
   */
  private async enqueuePush(principal: Principal, order: SalesDocumentView): Promise<boolean> {
    const repository = this.repository(principal);
    const payload: VoucherPushPayload = {
      documentId: order.id,
      kind: 'SALES_ORDER',
      voucherType: PUSH_KIND_VOUCHER_TYPE.SALES_ORDER,
      reference: order.number,
      date: order.date,
      partyName: order.customerName,
      narration: `${order.notes ?? ''}\nvyuha:${order.number}:${order.id}`.trim(),
      idempotencyKey: `vyuha:${order.id}`,
      // Whatever Tally already holds for this document, always. It used to be
      // sent only from the Alter path, so a rejected alter -- which leaves the
      // GUID in place and the state FAILED -- followed by Push queued a job
      // with no GUID at all, and the agent would have created a second
      // voucher beside the one it was meant to change. A document with no
      // GUID has never been pushed and this is null, which is the create.
      remoteGuid: order.remoteGuid,
      lines: order.lines.map((line) => ({
        stockItemName: line.description,
        quantity: line.quantity,
        unit: line.unit,
        rate: line.rate,
        discountPct: line.discountPct,
        amount: line.amount,
      })),
    };
    const jobId = await this.pushQueue.enqueue(principal.orgId, principal.userId, payload, order.partyId);
    if (jobId === null) {
      // A document Tally already holds is not "not pushed" merely because a
      // job could not be queued for it -- writing that would lose the fact
      // that it is in Tally, and the next push would create a second voucher.
      if (order.remoteGuid === null) await repository.setSync(order.id, { syncState: 'NOT_PUSHED', pushJobId: null });
      return false;
    }
    await repository.setSync(order.id, { syncState: 'QUEUED', pushJobId: jobId, lastError: null });
    return true;
  }

  /** The registry's callback: the agent's word becomes the document's state (REQ-W-06). */
  private async applyOutcome(tx: Transaction, orgId: string, payload: VoucherPushPayload, outcome: PushOutcome): Promise<void> {
    if (outcome.outcome === 'rejected') {
      await tx.execute(sql`
        UPDATE sales_documents
           SET sync_state = 'FAILED', last_error = ${outcome.errorText}, updated_at = now()
         WHERE org_id = ${orgId} AND id = ${payload.documentId} AND deleted_at IS NULL
      `);
      return;
    }
    await tx.execute(sql`
      UPDATE sales_documents
         SET sync_state = 'PUSHED', remote_guid = ${outcome.remoteGuid}, remote_voucher_number = ${outcome.remoteVoucherNumber},
             last_pushed_at = now(), last_error = NULL, updated_at = now()
       WHERE org_id = ${orgId} AND id = ${payload.documentId} AND deleted_at IS NULL
    `);
  }

  /**
   * REQ-W-09 / REQ-Y-03: the party's exposure the way the credit cycle report
   * counts it — debits less credits over the classified voucher types — plus
   * the money already committed in confirmed Vyuha orders that have not yet
   * become invoices. Overdue-by-bill waits on bill-wise allocations (P6b-5);
   * until then the limit is the rule and credit days are shown, not enforced.
   */
  async creditPositionOf(principal: Principal, id: string): Promise<CreditPosition | null> {
    const order = await this.find(principal, id);
    return order.partyId === null ? null : this.creditPosition(principal.orgId, order.partyId);
  }

  async creditPosition(orgId: string, partyId: string): Promise<CreditPosition | null> {
    const rows = await this.db.execute<{ id: string; name: string; credit_limit: string | null; credit_days: number | null; exposure: string; open_orders: string }>(sql`
      SELECT p.id, p.name, p.credit_limit::text AS credit_limit, p.credit_days,
             round(COALESCE((
               SELECT sum(CASE WHEN v.voucher_type IN ('Sales', 'Debit Note', 'Payment') THEN v.amount ELSE 0 END)
                        - sum(CASE WHEN v.voucher_type IN ('Receipt', 'Credit Note') THEN v.amount ELSE 0 END)
                 FROM vouchers v WHERE v.org_id = p.org_id AND v.party_id = p.id AND NOT v.is_cancelled
             ), 0), 2)::text AS exposure,
             round(COALESCE((
               SELECT sum((l.quantity - l.invoiced_qty) * l.rate * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100))
                 FROM sales_documents d JOIN sales_document_lines l ON l.document_id = d.id AND l.deleted_at IS NULL
                WHERE d.org_id = p.org_id AND d.party_id = p.id AND d.doc_type = 'SALES_ORDER' AND d.status = 'CONFIRMED' AND d.short_closed_at IS NULL AND d.deleted_at IS NULL
             ), 0), 2)::text AS open_orders
        FROM parties p WHERE p.org_id = ${orgId} AND p.id = ${partyId}
    `);
    const r = rows.rows[0];
    if (r === undefined) return null;
    const limit = r.credit_limit === null ? null : Number(r.credit_limit);
    // 15 REQ-AJ-10 / D-54: a broken promise is shown beside the limit and never added to it.
    // Blocking on both would give one customer two ways to be stopped, and the
    // override key would get handed out to relieve it.
    const promises = await this.collections.brokenPromises(orgId, partyId);
    return {
      partyId: r.id,
      partyName: r.name,
      creditLimit: r.credit_limit,
      creditDays: r.credit_days,
      exposure: r.exposure,
      openOrders: r.open_orders,
      headroom: limit === null || !Number.isFinite(limit) ? null : (limit - Number(r.exposure) - Number(r.open_orders)).toFixed(2),
      brokenPromises: promises.count,
      brokenPromiseAmount: promises.amount,
    };
  }

  /** REQ-AA-28: the party master's email and phone stand in wherever the order does not say. */
  private async partyContact(orgId: string, partyId: string | null, email: string | null | undefined, whatsapp: string | null | undefined): Promise<{ customerEmail: string | null; customerWhatsapp: string | null }> {
    if (partyId === null) return { customerEmail: email ?? null, customerWhatsapp: whatsapp ?? null };
    const rows = await this.db.execute<{ email: string | null; phone: string | null }>(sql`SELECT email, phone FROM parties WHERE org_id = ${orgId} AND id = ${partyId}`);
    const party = rows.rows[0];
    return { customerEmail: email ?? party?.email ?? null, customerWhatsapp: whatsapp ?? party?.phone ?? null };
  }

  private scope(principal: Principal): SQL {
    return this.scopes.resolve(principal, GRANTS, salesDocuments.ownerId).where;
  }

  private repository(principal: Principal): EstimateRepository {
    return new EstimateRepository(this.db, orgContextOf(principal), DOC_TYPE);
  }
}

function auditView(order: SalesDocumentView): Record<string, unknown> {
  return {
    number: order.number,
    status: order.status,
    date: order.date,
    partyId: order.partyId,
    customerName: order.customerName,
    ownerId: order.ownerId,
    grandTotal: order.grandTotal,
    lineCount: order.lines.length,
    syncState: order.syncState,
    remoteGuid: order.remoteGuid,
    sourceDocumentId: order.sourceDocumentId,
  };
}
