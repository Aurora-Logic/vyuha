import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  NOTIFICATION_EVENTS,
  PERMISSIONS,
  PUSH_KIND_VOUCHER_TYPE,
  pageSlice,
  paginated,
  type AllocateReceiptInput,
  type CreateGrnInput,
  type CreatePurchaseOrderInput,
  DEFAULT_PURCHASE_SETTINGS,
  type GrnView,
  type ItemVendorView,
  type Paginated,
  type PurchaseHistoryEntry,
  type PurchaseHistoryQuery,
  type PurchaseLineInput,
  type PurchaseOrderFromRequirementsInput,
  type PurchaseOrderListQuery,
  type PurchaseOrderSummary,
  type PurchaseOrderView,
  type PurchaseSettings,
  type PutItemSettingsInput,
  type PutItemVendorsInput,
  type UpdatePurchaseOrderInput,
  type VoucherPushPayload,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { ApprovalService } from '../../../platform/approvals/approval.service.js';
import type { ApprovalSubjectDecision, ApprovalSubjectSettlement } from '../../../platform/approvals/approval-subject.registry.js';
import { AuditContext } from '../../../platform/audit/audit-context.js';
import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database, type Transaction } from '../../../platform/db/db.provider.js';
import { orgToday, resolveDocumentLines } from '../../../platform/documents/document-support.js';
import { NotificationDispatcher } from '../../../platform/notifications/notification.dispatcher.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import { hasPermission, orgContextOf, type Principal } from '../../../platform/rbac/principal.js';
import { PushOutcomeRegistry, type PushMirror, type PushOutcome } from '../../../platform/sync/push-outcome.registry.js';
import { PushQueueService } from '../../../platform/sync/push-queue.service.js';

/**
 * Purchase orders and GRNs (13 §4.2–4.4; 08 REQ-X-01…X-05). A PO is built
 * from selected requirements or standalone; confirming it pushes a Purchase
 * Order voucher (REQ-X-17) unless its value crosses the approval threshold
 * (REQ-X-16), in which case a holder of `purchase.document.approve` releases
 * it. A GRN receives against the PO — received and rejected, with a reason
 * (REQ-X-21) — pushes as a Receipt Note (REQ-X-22), and satisfies the
 * requirements the lines took up. Where one receipt is short of several
 * waiting orders, allocation is a person's decision (REQ-X-27, D-30); where
 * only one waits it is automatic; the order's owner is told (REQ-X-28).
 *
 * The approval is a status and a key here rather than an approvals-inbox
 * subject: the inbox integration is a follow-up recorded in the progress
 * document, and nothing about it changes who may release a PO.
 */

const SETTING_THRESHOLD = 'purchase.approvalThreshold';
const SETTING_INVOICE_WAITING_HOURS = 'sales.invoiceWaitingHours';
/** `snake_case`, the approval framework's spelling (see APPROVAL_SUBJECT_TYPES). */
export const PURCHASE_ORDER_SUBJECT_TYPE = 'purchase_order';

@Injectable()
export class PurchaseOrderService implements OnModuleInit {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly pushQueue: PushQueueService,
    private readonly pushOutcomes: PushOutcomeRegistry,
    private readonly notifications: NotificationDispatcher,
    private readonly approvals: ApprovalService,
  ) {}

  onModuleInit(): void {
    this.pushOutcomes.register({
      kind: 'PURCHASE_ORDER',
      onOutcome: (tx, orgId, payload, outcome) => this.applyOutcome(tx, orgId, 'purchase_orders', payload, outcome),
      onMirror: (tx, orgId, documentId, mirror) => this.applyMirror(tx, orgId, 'purchase_orders', documentId, mirror),
    });
    this.pushOutcomes.register({
      kind: 'RECEIPT_NOTE',
      onOutcome: (tx, orgId, payload, outcome) => this.applyOutcome(tx, orgId, 'grns', payload, outcome),
      onMirror: (tx, orgId, documentId, mirror) => this.applyMirror(tx, orgId, 'grns', documentId, mirror),
    });
  }

  /**
   * The pushed voucher came back on the pull. Tally's number is the number;
   * a PO cancelled in Tally is cancelled here (nothing received against it
   * yet is undone — a receipt is a fact); a Receipt Note voided there is
   * noted in Tally's words, since the goods are on the shelf either way.
   */
  private async applyMirror(tx: Transaction, orgId: string, table: 'purchase_orders' | 'grns', documentId: string, mirror: PushMirror): Promise<void> {
    const t = table === 'grns' ? sql`grns` : sql`purchase_orders`;
    await tx.execute(sql`
      UPDATE ${t} SET remote_voucher_number = COALESCE(${mirror.remoteVoucherNumber}, remote_voucher_number), remote_guid = ${mirror.remoteGuid}, updated_at = now()
       WHERE org_id = ${orgId} AND id = ${documentId}
    `);
    if (!mirror.isCancelled) return;
    if (table === 'purchase_orders') {
      // The status is claimed by the write, and the requirements are given
      // back only if this write is the one that cancelled it. A PO that was
      // already short-closed has given them back once; releasing again would
      // subtract the same quantity twice, so `short_closed_at IS NULL` is part
      // of the claim rather than a separate check.
      const cancelled = await tx.execute<{ number: string; short_closed_at: Date | null }>(sql`
        UPDATE purchase_orders SET status = 'CANCELLED', updated_at = now()
         WHERE id = ${documentId} AND org_id = ${orgId} AND status = 'CONFIRMED' AND deleted_at IS NULL
        RETURNING number, short_closed_at
      `);
      const po = cancelled.rows[0];
      if (po !== undefined) {
        if (po.short_closed_at === null) await this.releaseRequirementsWithin(tx, documentId);
        this.auditContext.record({ action: 'purchase.order.cancelled_in_tally', entityType: 'purchase_order', entityId: documentId, before: { status: 'CONFIRMED' }, after: { number: po.number, remoteGuid: mirror.remoteGuid } });
      }
      return;
    }
    await tx.execute(sql`UPDATE grns SET last_error = 'Cancelled in Tally', updated_at = now() WHERE id = ${documentId}`);
  }

  // -------------------------------------------------------- purchase orders

  async list(principal: Principal, query: PurchaseOrderListQuery): Promise<Paginated<PurchaseOrderSummary>> {
    const { limit, offset } = pageSlice(query);
    const where = sql`po.org_id = ${principal.orgId} AND po.deleted_at IS NULL
      ${query.q === undefined ? sql`` : sql`AND (po.number ILIKE ${`%${query.q}%`} OR po.vendor_name ILIKE ${`%${query.q}%`})`}
      ${query.status === undefined ? sql`` : sql`AND po.status = ${query.status}`}
      ${query.syncState === undefined ? sql`` : sql`AND po.sync_state = ${query.syncState}`}
      ${query.partyId === undefined ? sql`` : sql`AND po.party_id = ${query.partyId}`}
      ${query.salesOrderId === undefined ? sql`` : sql`AND po.sales_order_id = ${query.salesOrderId}`}`;
    const ids = await this.db.execute<{ id: string }>(sql`SELECT po.id FROM purchase_orders po WHERE ${where} ORDER BY po.date DESC, po.created_at DESC LIMIT ${limit} OFFSET ${offset}`);
    const total = await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM purchase_orders po WHERE ${where}`);
    const rows = await Promise.all(ids.rows.map((r) => this.view(principal.orgId, r.id)));
    return paginated(
      rows.filter((r): r is PurchaseOrderView => r !== null).map(({ lines: _lines, notifications: _notifications, ...summary }) => summary),
      query,
      Number(total.rows[0]?.n ?? 0),
    );
  }

  async find(principal: Principal, id: string): Promise<PurchaseOrderView> {
    const po = await this.view(principal.orgId, id);
    if (po === null) throw AppError.notFound('Purchase order', id);
    return po;
  }

  async create(principal: Principal, input: CreatePurchaseOrderInput): Promise<PurchaseOrderView> {
    const vendor = await this.vendor(principal.orgId, input.partyId);
    const lines = await resolveDocumentLines(this.db, principal, input.lines);
    const id = await this.db.transaction(async (tx) => {
      const number = await this.nextNumber(tx, principal.orgId, 'PURCHASE_ORDER', 'PO');
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO purchase_orders (org_id, number, date, party_id, vendor_name, sales_order_id, expected_date, owner_id, notes, vendor_email, vendor_whatsapp, terms, details, ship_to, created_by, updated_by)
        VALUES (${principal.orgId}, ${number}, ${input.date ?? (await orgToday(this.db, principal.orgId))}, ${input.partyId}, ${vendor}, ${input.salesOrderId ?? null},
                ${input.expectedDate ?? null}, ${input.ownerId ?? principal.employeeId}, ${input.notes ?? null}, ${input.vendorEmail ?? null}, ${input.vendorWhatsapp ?? null},
                ${input.terms ?? null}, ${jsonOrNull(input.details)}, ${jsonOrNull(input.shipTo)}, ${principal.userId}, ${principal.userId})
        RETURNING id
      `);
      const poId = inserted.rows[0]?.id;
      if (poId === undefined) throw new Error('Purchase order insert returned no row.');
      // Built from the resolved lines and given back their requirement ids,
      // rather than spread over the input by index -- an indexed read can be
      // undefined, which quietly put back the unresolved tax percentage.
      await this.replaceLines(tx, principal, poId, lines.map((line, i) => ({ ...line, requirementIds: input.lines[i]?.requirementIds ?? [] })));
      return poId;
    });
    this.auditContext.record({ action: 'purchase.order.created', entityType: 'purchase_order', entityId: id, before: null, after: { partyId: input.partyId, lines: input.lines.length } });
    return this.find(principal, id);
  }

  /** REQ-X-13: one line per item, quantities summed across the chosen requirements, each linked. */
  async createFromRequirements(principal: Principal, input: PurchaseOrderFromRequirementsInput): Promise<PurchaseOrderView> {
    const rows = await this.db.execute<{ id: string; stock_item_id: string; open: string; name: string; unit: string }>(sql`
      SELECT r.id, r.stock_item_id, (r.quantity - r.ordered_qty)::text AS open, s.name, s.unit
        FROM procurement_requirements r JOIN stock_items s ON s.id = r.stock_item_id
       WHERE r.org_id = ${principal.orgId} AND r.state = 'open' AND r.deleted_at IS NULL
         AND r.id = ANY(${sql.raw(`ARRAY[${input.requirementIds.map((id) => `'${id}'::uuid`).join(',')}]`)})
    `);
    if (rows.rows.length === 0) throw AppError.validation('None of those requirements is open.', { requirementIds: input.requirementIds });
    const byItem = new Map<string, { name: string; unit: string; qty: number; requirementIds: string[] }>();
    for (const r of rows.rows) {
      const entry = byItem.get(r.stock_item_id) ?? { name: r.name, unit: r.unit, qty: 0, requirementIds: [] };
      entry.qty += Number(r.open);
      entry.requirementIds.push(r.id);
      byItem.set(r.stock_item_id, entry);
    }
    const lines: PurchaseLineInput[] = [...byItem.entries()].map(([stockItemId, entry]) => ({
      stockItemId,
      description: entry.name,
      quantity: entry.qty.toFixed(3),
      unit: entry.unit,
      rate: '0',
      discountPct: '0',
      taxPct: '0',
      requirementIds: entry.requirementIds,
    }));
    return this.create(principal, { partyId: input.partyId, expectedDate: input.expectedDate ?? null, lines });
  }

  async update(principal: Principal, id: string, input: UpdatePurchaseOrderInput): Promise<PurchaseOrderView> {
    const existing = await this.find(principal, id);
    if (existing.status !== 'DRAFT') throw AppError.conflict(`${existing.number} is ${existing.status.toLowerCase()}; only a draft is edited.`);
    const vendor = input.partyId === undefined ? null : await this.vendor(principal.orgId, input.partyId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE purchase_orders SET
          party_id = COALESCE(${input.partyId ?? null}, party_id), vendor_name = COALESCE(${vendor}, vendor_name),
          date = COALESCE(${input.date ?? null}, date), expected_date = ${input.expectedDate === undefined ? sql`expected_date` : (input.expectedDate ?? null)},
          sales_order_id = ${input.salesOrderId === undefined ? sql`sales_order_id` : (input.salesOrderId ?? null)},
          notes = ${input.notes === undefined ? sql`notes` : (input.notes ?? null)},
          vendor_email = ${input.vendorEmail === undefined ? sql`vendor_email` : (input.vendorEmail ?? null)},
          vendor_whatsapp = ${input.vendorWhatsapp === undefined ? sql`vendor_whatsapp` : (input.vendorWhatsapp ?? null)},
          terms = ${input.terms === undefined ? sql`terms` : (input.terms ?? null)},
          details = ${input.details === undefined ? sql`details` : jsonOrNull(input.details)},
          ship_to = ${input.shipTo === undefined ? sql`ship_to` : jsonOrNull(input.shipTo)},
          updated_at = now(), updated_by = ${principal.userId}
         WHERE id = ${id} AND org_id = ${principal.orgId}
      `);
      const requested = input.lines;
      if (requested !== undefined) {
        const resolved = await resolveDocumentLines(this.db, principal, requested);
        await this.replaceLines(tx, principal, id, resolved.map((line, i) => ({ ...line, requirementIds: requested[i]?.requirementIds ?? [] })));
      }
    });
    this.auditContext.record({ action: 'purchase.order.updated', entityType: 'purchase_order', entityId: id, before: { grandTotal: existing.grandTotal }, after: null });
    return this.find(principal, id);
  }

  /**
   * Draft → confirmed and pushed, or → awaiting approval when the value
   * crosses the threshold (REQ-X-16). The wait is a request in the approvals
   * inbox, routed to every holder of purchase.document.approve, and the PO
   * moves only when that request is decided — the same ledger leave uses,
   * so a purchase is never approved in two places.
   */
  async confirm(principal: Principal, id: string): Promise<PurchaseOrderView> {
    const existing = await this.find(principal, id);
    if (existing.status !== 'DRAFT') throw AppError.conflict(`${existing.number} is already ${existing.status.toLowerCase()}.`);
    if (existing.approvalRequired && !hasPermission(principal, PERMISSIONS.PURCHASE_DOCUMENT_APPROVE)) {
      const approvers = await this.approvers(principal.orgId, principal.userId);
      const ctx = orgContextOf(principal);
      await this.db.transaction(async (tx) => {
        const approval = await this.approvals.raise(
          ctx,
          {
            type: 'PURCHASE_ORDER',
            subjectType: PURCHASE_ORDER_SUBJECT_TYPE,
            subjectId: id,
            subject: `${existing.number} · ${existing.vendorName} · ${existing.grandTotal}`,
            requesterUserId: principal.userId,
            approverUserIds: approvers,
          },
          tx,
        );
        await tx.execute(sql`UPDATE purchase_orders SET status = 'PENDING_APPROVAL', approval_request_id = ${approval.id}, updated_at = now(), updated_by = ${principal.userId} WHERE id = ${id}`);
      });
      this.auditContext.record({ action: 'purchase.order.submitted_for_approval', entityType: 'purchase_order', entityId: id, before: null, after: { grandTotal: existing.grandTotal } });
      return this.find(principal, id);
    }
    return this.release(principal, id, existing.number, existing.approvalRequired ? 'purchase.order.approved' : 'purchase.order.confirmed');
  }

  /**
   * The button on the PO itself. It decides the inbox request rather than
   * moving the PO directly, so the framework's rules — the requester may
   * not approve their own, the route is honoured, the ledger is written —
   * hold whichever door the approver came through.
   */
  async approve(principal: Principal, id: string): Promise<PurchaseOrderView> {
    if (!hasPermission(principal, PERMISSIONS.PURCHASE_DOCUMENT_APPROVE)) throw AppError.forbidden('Approving a purchase order needs purchase.document.approve.');
    const existing = await this.find(principal, id);
    if (existing.status !== 'PENDING_APPROVAL') throw AppError.conflict(`${existing.number} is not awaiting approval.`);
    const row = await this.db.execute<{ approval_request_id: string | null }>(sql`SELECT approval_request_id FROM purchase_orders WHERE id = ${id}`);
    const approvalRequestId = row.rows[0]?.approval_request_id ?? null;
    if (approvalRequestId !== null) {
      await this.approvals.decide(principal, approvalRequestId, 'APPROVE', null);
      return this.find(principal, id);
    }
    return this.release(principal, id, existing.number, 'purchase.order.approved');
  }

  /** Called by the framework through the registry, inside its transaction. */
  async applyApprovalDecision(ctx: OrgContext, decision: ApprovalSubjectDecision, tx: Database): Promise<ApprovalSubjectSettlement | null> {
    const row = await tx.execute<{ id: string; status: string; number: string }>(sql`
      SELECT id, status, number FROM purchase_orders WHERE org_id = ${ctx.orgId} AND id = ${decision.subjectId} AND deleted_at IS NULL
    `);
    const po = row.rows[0];
    if (po === undefined) throw AppError.notFound('Purchase order', decision.subjectId);
    if (decision.status === 'ESCALATED') return null;
    if (po.status !== 'PENDING_APPROVAL') throw AppError.conflict(`${po.number} is ${po.status.toLowerCase()}, not awaiting approval.`);
    if (decision.status === 'REJECTED') {
      await tx.execute(sql`UPDATE purchase_orders SET status = 'DRAFT', approval_request_id = NULL, updated_at = now(), updated_by = ${decision.decidedByUserId} WHERE id = ${po.id}`);
      return () => {
        this.auditContext.record({ action: 'purchase.order.rejected', entityType: 'purchase_order', entityId: po.id, before: null, after: { reason: decision.reason } });
        return Promise.resolve();
      };
    }
    await this.releaseWithin(tx, ctx.orgId, po.id, po.number, decision.decidedByUserId);
    return async () => {
      await this.enqueuePush({ orgId: ctx.orgId, userId: decision.decidedByUserId }, po.id);
      this.auditContext.record({ action: 'purchase.order.approved', entityType: 'purchase_order', entityId: po.id, before: null, after: { approvalRequestId: decision.approvalRequestId } });
    };
  }

  private async release(principal: Principal, id: string, number: string, action: string): Promise<PurchaseOrderView> {
    await this.db.transaction(async (tx) => {
      await this.releaseWithin(tx, principal.orgId, id, number, principal.userId);
    });
    await this.enqueuePush(principal, id);
    this.auditContext.record({ action, entityType: 'purchase_order', entityId: id, before: null, after: null });
    return this.find(principal, id);
  }

  private async releaseWithin(tx: Database, orgId: string, id: string, number: string, actorUserId: string | null): Promise<void> {
    // The status this transition depends on is asserted by the write itself.
    // It was read before the transaction opened, so two confirms racing --
    // the button and the approval landing together -- both passed the check
    // and both ran the block below, adding the ordered quantity twice and
    // sending the vendor two copies of the same order.
    const claimed = await tx.execute<{ id: string }>(sql`
      UPDATE purchase_orders SET status = 'CONFIRMED', updated_at = now(), updated_by = ${actorUserId}
       WHERE org_id = ${orgId} AND id = ${id} AND deleted_at IS NULL AND status IN ('DRAFT', 'PENDING_APPROVAL')
      RETURNING id
    `);
    if (claimed.rows.length === 0) throw AppError.conflict(`${number} is already confirmed.`);
    // REQ-X-18: the vendor's copy, composed now and sent by hand until the channel lands (REQ-AA-26).
    const po = await this.view(orgId, id);
    if (po !== null) {
      const text = composeVendorText(po);
      for (const [channel, recipient] of [['email', po.vendorEmail], ['whatsapp', po.vendorWhatsapp]] as const) {
        await tx.execute(sql`
          INSERT INTO purchase_order_notifications (org_id, purchase_order_id, channel, recipient, status, composed_text, created_by, updated_by)
          VALUES (${orgId}, ${id}, ${channel}, ${recipient}, 'pending', ${text}, ${actorUserId}, ${actorUserId})
        `);
      }
    }
    // REQ-X-10: the requirements this PO took up move to `ordered`.
    await tx.execute(sql`
      UPDATE procurement_requirements r SET ordered_qty = r.ordered_qty + t.qty, state = CASE WHEN r.ordered_qty + t.qty >= r.quantity THEN 'ordered' ELSE r.state END, updated_at = now()
        FROM (SELECT plr.requirement_id, sum(plr.quantity) AS qty FROM po_line_requirements plr JOIN purchase_order_lines pl ON pl.id = plr.purchase_order_line_id WHERE pl.purchase_order_id = ${id} GROUP BY plr.requirement_id) t
       WHERE r.id = t.requirement_id
    `);
  }

  /** The route for a PO approval: one level, the first holder of purchase.document.approve who is not the requester. */
  private async approvers(orgId: string, requesterUserId: string): Promise<string[]> {
    const rows = await this.db.execute<{ user_id: string }>(sql`
      SELECT DISTINCT u.id AS user_id, u.email
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id
        JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
       WHERE u.org_id = ${orgId} AND u.deleted_at IS NULL AND u.status = 'ACTIVE' AND p.key = ${PERMISSIONS.PURCHASE_DOCUMENT_APPROVE}
       ORDER BY u.email
    `);
    // One level, not one per holder: the framework reads its route as a chain
    // of levels, so listing every holder would make each approve in turn.
    // The first holder who is not the requester is the level; every other
    // holder acts through the override key and browses through scope.all.
    return rows.rows.map((r) => r.user_id).filter((userId) => userId !== requesterUserId).slice(0, 1);
  }

  /** REQ-X-18 / REQ-AA-26: a person sent it and says so. */
  async markNotification(principal: Principal, id: string, notificationId: string, status: 'sent' | 'failed', error: string | null): Promise<PurchaseOrderView> {
    const po = await this.find(principal, id);
    const rows = await this.db.execute<{ id: string }>(sql`
      UPDATE purchase_order_notifications SET status = ${status}, sent_at = ${status === 'sent' ? sql`now()` : sql`NULL`}, sent_by = ${principal.userId}, error = ${error}, updated_at = now(), updated_by = ${principal.userId}
       WHERE id = ${notificationId} AND purchase_order_id = ${id} AND org_id = ${principal.orgId}
      RETURNING id
    `);
    if (rows.rows.length === 0) throw AppError.notFound('Notification', notificationId);
    this.auditContext.record({ action: `purchase.order.notification_${status}`, entityType: 'purchase_order', entityId: id, before: null, after: { notificationId, number: po.number } });
    return this.find(principal, id);
  }

  // ------------------------------------------------------------ settings

  async readSettings(orgId: string): Promise<PurchaseSettings> {
    const rows = await this.db.execute<{ key: string; value: unknown }>(sql`
      SELECT key, value FROM settings WHERE org_id = ${orgId} AND scope = 'ORG' AND key IN (${SETTING_THRESHOLD}, ${SETTING_INVOICE_WAITING_HOURS}) AND deleted_at IS NULL
    `);
    const byKey = new Map(rows.rows.map((r) => [r.key, r.value]));
    const threshold = byKey.get(SETTING_THRESHOLD);
    const hours = byKey.get(SETTING_INVOICE_WAITING_HOURS);
    const parsedHours = typeof hours === 'number' ? hours : typeof hours === 'string' ? Number(hours) : DEFAULT_PURCHASE_SETTINGS.invoiceWaitingHours;
    return {
      approvalThreshold: threshold === undefined || threshold === null || Number(threshold) <= 0 ? null : Number(threshold).toFixed(2),
      invoiceWaitingHours: Number.isFinite(parsedHours) ? parsedHours : DEFAULT_PURCHASE_SETTINGS.invoiceWaitingHours,
    };
  }

  async writeSettings(principal: Principal, input: PurchaseSettings): Promise<PurchaseSettings> {
    const before = await this.readSettings(principal.orgId);
    for (const [key, value] of [
      [SETTING_THRESHOLD, input.approvalThreshold === null ? 0 : Number(input.approvalThreshold)],
      [SETTING_INVOICE_WAITING_HOURS, input.invoiceWaitingHours],
    ] as const) {
      await this.db.execute(sql`
        INSERT INTO settings (org_id, scope, scope_id, key, value, created_by, updated_by)
        VALUES (${principal.orgId}, 'ORG', NULL, ${key}, ${JSON.stringify(value)}::jsonb, ${principal.userId}, ${principal.userId})
        ON CONFLICT (org_id, scope, (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)), key) WHERE deleted_at IS NULL
        DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
      `);
    }
    const after = await this.readSettings(principal.orgId);
    this.auditContext.record({ action: 'purchase.settings.updated', entityType: 'organization', entityId: principal.orgId, before: { ...before }, after: { ...after } });
    return after;
  }

  async push(principal: Principal, id: string): Promise<PurchaseOrderView> {
    const existing = await this.find(principal, id);
    if (existing.status !== 'CONFIRMED') throw AppError.conflict(`${existing.number} is ${existing.status.toLowerCase()}; confirm it first.`);
    if (existing.syncState === 'PUSHED' || existing.syncState === 'QUEUED') throw AppError.conflict(`${existing.number} is already ${existing.syncState === 'PUSHED' ? 'in Tally' : 'queued'}.`);
    if (!(await this.enqueuePush(principal, id))) throw AppError.conflict('No Tally connection can carry a push.');
    return this.find(principal, id);
  }

  /** REQ-X-23: the vendor will not supply the balance. */
  async shortClose(principal: Principal, id: string, reason: string): Promise<PurchaseOrderView> {
    if (!hasPermission(principal, PERMISSIONS.PURCHASE_DOCUMENT_APPROVE)) throw AppError.forbidden('Short-closing a purchase order needs purchase.document.approve.');
    const existing = await this.find(principal, id);
    if (existing.status !== 'CONFIRMED') throw AppError.conflict(`${existing.number} is ${existing.status.toLowerCase()}.`);
    if (existing.shortClosedAt !== null) throw AppError.conflict(`${existing.number} is already short-closed.`);
    await this.db.transaction(async (tx) => {
      // The mark is the claim: short-closing twice used to subtract the same
      // quantity from the requirements twice, so an order short-closed by two
      // people at once -- or by one person who pressed the button again --
      // left its requirements believing less was on order than really was,
      // and the sweep reordered goods already coming.
      const marked = await tx.execute<{ id: string }>(sql`
        UPDATE purchase_orders SET short_closed_at = now(), short_close_reason = ${reason}, updated_at = now(), updated_by = ${principal.userId}
         WHERE id = ${id} AND org_id = ${principal.orgId} AND short_closed_at IS NULL
        RETURNING id
      `);
      if (marked.rows.length === 0) throw AppError.conflict(`${existing.number} is already short-closed.`);
      await this.releaseRequirementsWithin(tx, id);
    });
    this.auditContext.record({ action: 'purchase.order.short_closed', entityType: 'purchase_order', entityId: id, before: null, after: { reason } });
    return this.find(principal, id);
  }

  /**
   * Give back what this order had spoken for.
   *
   * Called when an order stops being a promise of goods -- short-closed here,
   * or cancelled in Tally, which is the same fact arriving from the other
   * direction. The Tally path used to mark the order CANCELLED and leave its
   * requirements sitting in `ordered`, so the buyer went on believing the
   * goods were coming and the nightly sweep raised nothing.
   *
   * `state <> 'closed'` keeps a requirement somebody has already finished
   * with; GREATEST(0, ...) keeps the arithmetic from going negative if two
   * orders covered one requirement between them.
   */
  private async releaseRequirementsWithin(tx: Database, purchaseOrderId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE procurement_requirements r SET ordered_qty = GREATEST(0, r.ordered_qty - t.qty), state = CASE WHEN r.received_qty >= r.quantity THEN r.state ELSE 'open' END, updated_at = now()
        FROM (SELECT plr.requirement_id, sum(plr.quantity - plr.allocated_qty) AS qty FROM po_line_requirements plr JOIN purchase_order_lines pl ON pl.id = plr.purchase_order_line_id WHERE pl.purchase_order_id = ${purchaseOrderId} GROUP BY plr.requirement_id) t
       WHERE r.id = t.requirement_id AND r.state <> 'closed'
    `);
  }

  async cancel(principal: Principal, id: string): Promise<PurchaseOrderView> {
    const existing = await this.find(principal, id);
    if (existing.status !== 'DRAFT' && existing.status !== 'PENDING_APPROVAL') throw AppError.conflict(`${existing.number} is confirmed; short-close it instead.`);
    if (existing.status === 'PENDING_APPROVAL') {
      // The inbox request goes with it, or an approver decides a PO that no longer exists.
      await this.approvals.cancelForSubject(orgContextOf(principal), PURCHASE_ORDER_SUBJECT_TYPE, id, `${existing.number} cancelled by its author.`);
    }
    await this.db.execute(sql`UPDATE purchase_orders SET status = 'CANCELLED', approval_request_id = NULL, updated_at = now(), updated_by = ${principal.userId} WHERE id = ${id}`);
    this.auditContext.record({ action: 'purchase.order.cancelled', entityType: 'purchase_order', entityId: id, before: null, after: null });
    return this.find(principal, id);
  }

  // -------------------------------------------------------------------- GRN

  async listGrns(principal: Principal, purchaseOrderId: string | undefined): Promise<GrnView[]> {
    const ids = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM grns WHERE org_id = ${principal.orgId} AND deleted_at IS NULL ${purchaseOrderId === undefined ? sql`` : sql`AND purchase_order_id = ${purchaseOrderId}`}
      ORDER BY received_at DESC LIMIT 200
    `);
    const rows = await Promise.all(ids.rows.map((r) => this.grnView(principal.orgId, r.id)));
    return rows.filter((r): r is GrnView => r !== null);
  }

  async findGrn(principal: Principal, id: string): Promise<GrnView> {
    const grn = await this.grnView(principal.orgId, id);
    if (grn === null) throw AppError.notFound('GRN', id);
    return grn;
  }

  /**
   * REQ-X-19…X-22: received and rejected against the PO's lines under the
   * CHECK; then each line's requirements take their share — automatically
   * when one waits, by a person when several do (REQ-X-27).
   */
  async receive(principal: Principal, purchaseOrderId: string, input: CreateGrnInput): Promise<GrnView> {
    const po = await this.find(principal, purchaseOrderId);
    if (po.status !== 'CONFIRMED') throw AppError.conflict(`${po.number} is ${po.status.toLowerCase()}; only a confirmed order receives.`);
    if (po.shortClosedAt !== null) throw AppError.conflict(`${po.number} was short-closed.`);
    const byId = new Map(po.lines.map((l) => [l.id, l]));
    for (const [index, entry] of input.lines.entries()) {
      const line = byId.get(entry.purchaseOrderLineId);
      if (line === undefined) throw AppError.validation('A GRN line names a line that is not on this order.', { purchaseOrderLineId: entry.purchaseOrderLineId });
      const outstanding = Number(line.quantity) - Number(line.receivedQty) - Number(line.rejectedQty);
      if (Number(entry.receivedQty) + Number(entry.rejectedQty) > outstanding + 1e-9) {
        throw AppError.validation(`Line ${String(line.lineNo)} (${line.description}) has ${outstanding.toFixed(3)} outstanding.`, { fields: [{ path: `lines.${String(index)}.receivedQty`, message: 'exceeds the outstanding quantity' }] });
      }
      if (Number(entry.rejectedQty) > 0 && !entry.rejectionReason) {
        throw AppError.validation('A rejected quantity needs a reason.', { fields: [{ path: `lines.${String(index)}.rejectionReason`, message: 'is required' }] });
      }
    }
    const grnId = await this.db.transaction(async (tx) => {
      const number = await this.nextNumber(tx, principal.orgId, 'GRN', 'GRN');
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO grns (org_id, number, purchase_order_id, received_by, vendor_invoice_ref, notes, created_by, updated_by)
        VALUES (${principal.orgId}, ${number}, ${purchaseOrderId}, ${principal.employeeId}, ${input.vendorInvoiceRef ?? null}, ${input.notes ?? null}, ${principal.userId}, ${principal.userId})
        RETURNING id
      `);
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error('GRN insert returned no row.');
      for (const entry of input.lines) {
        await tx.execute(sql`
          INSERT INTO grn_lines (org_id, grn_id, purchase_order_line_id, received_qty, rejected_qty, rejection_reason, created_by, updated_by)
          VALUES (${principal.orgId}, ${id}, ${entry.purchaseOrderLineId}, ${entry.receivedQty}, ${entry.rejectedQty}, ${entry.rejectionReason ?? null}, ${principal.userId}, ${principal.userId})
        `);
        await tx.execute(sql`
          UPDATE purchase_order_lines SET received_qty = received_qty + ${entry.receivedQty}::numeric, rejected_qty = rejected_qty + ${entry.rejectedQty}::numeric, updated_at = now()
           WHERE id = ${entry.purchaseOrderLineId}
        `);
        // Automatic allocation when exactly one requirement waits on this line.
        const waiting = await tx.execute<{ requirement_id: string; outstanding: string }>(sql`
          SELECT plr.requirement_id, (plr.quantity - plr.allocated_qty)::text AS outstanding
            FROM po_line_requirements plr JOIN procurement_requirements r ON r.id = plr.requirement_id
           WHERE plr.purchase_order_line_id = ${entry.purchaseOrderLineId} AND plr.quantity > plr.allocated_qty AND r.state <> 'closed'
        `);
        if (waiting.rows.length === 1 && waiting.rows[0] !== undefined) {
          const share = Math.min(Number(entry.receivedQty), Number(waiting.rows[0].outstanding));
          if (share > 0) await this.allocate(tx, principal, id, entry.purchaseOrderLineId, waiting.rows[0].requirement_id, share.toFixed(3));
        }
      }
      return id;
    });
    await this.enqueueGrnPush(principal, grnId);
    this.auditContext.record({ action: 'purchase.grn.created', entityType: 'grn', entityId: grnId, before: null, after: { purchaseOrderId, lines: input.lines } });
    return this.findGrn(principal, grnId);
  }

  /** REQ-X-27 / D-30: the explicit decision, by a holder of the approve key. */
  async allocateReceipt(principal: Principal, grnId: string, input: AllocateReceiptInput): Promise<GrnView> {
    if (!hasPermission(principal, PERMISSIONS.PURCHASE_DOCUMENT_APPROVE)) throw AppError.forbidden('Allocating a receipt across waiting orders needs purchase.document.approve.');
    const grn = await this.findGrn(principal, grnId);
    await this.db.transaction(async (tx) => {
      for (const allocation of input.allocations) {
        const pending = grn.pendingAllocations.find((p) => p.waiting.some((w) => w.requirementId === allocation.requirementId));
        if (pending === undefined) throw AppError.validation('That requirement is not waiting on this receipt.', { requirementId: allocation.requirementId });
        // How much is left is read inside the transaction, not from the
        // snapshot this request was built against -- see `allocate`.
        await this.allocate(tx, principal, grnId, pending.purchaseOrderLineId, allocation.requirementId, allocation.quantity);
      }
    });
    this.auditContext.record({ action: 'purchase.grn.allocated', entityType: 'grn', entityId: grnId, before: null, after: { allocations: input.allocations } });
    return this.findGrn(principal, grnId);
  }

  private async allocate(tx: Transaction, principal: Principal, grnId: string, purchaseOrderLineId: string, requirementId: string, quantity: string): Promise<void> {
    /*
     * Two ceilings, both read here with the rows locked rather than from the
     * view the caller was looking at.
     *
     * The receipt's own: what arrived on this line, less everything already
     * allocated from it. Two people allocating at once each read the whole
     * receipt as free and both spent it, and so did one request naming the
     * same line twice -- the snapshot was taken before the loop began and
     * never moved as the loop allocated.
     *
     * And the requirement's: what this order is still waiting for on this
     * line. Nothing capped that at all, so a requirement short by three could
     * be allocated ten and read as received, with the seven belonging to
     * whoever else was waiting quietly taken.
     */
    const room = await tx.execute<{ line_free: string; requirement_left: string; item: string }>(sql`
      SELECT (pl.received_qty - COALESCE((SELECT sum(x.allocated_qty) FROM po_line_requirements x WHERE x.purchase_order_line_id = pl.id), 0))::text AS line_free,
             (plr.quantity - plr.allocated_qty)::text AS requirement_left,
             pl.description AS item
        FROM po_line_requirements plr JOIN purchase_order_lines pl ON pl.id = plr.purchase_order_line_id
       WHERE plr.purchase_order_line_id = ${purchaseOrderLineId} AND plr.requirement_id = ${requirementId}
       FOR UPDATE OF plr, pl
    `);
    const room0 = room.rows[0];
    if (room0 === undefined) throw AppError.validation('That requirement is not waiting on this receipt.', { requirementId });
    const asked = Number(quantity);
    if (asked > Number(room0.line_free) + 1e-9) {
      throw AppError.validation(`Only ${Number(room0.line_free).toFixed(3)} of ${room0.item} is left to allocate.`, { requirementId });
    }
    if (asked > Number(room0.requirement_left) + 1e-9) {
      throw AppError.validation(`That order is waiting for only ${Number(room0.requirement_left).toFixed(3)} of ${room0.item}.`, { requirementId });
    }
    await tx.execute(sql`UPDATE po_line_requirements SET allocated_qty = allocated_qty + ${quantity}::numeric WHERE purchase_order_line_id = ${purchaseOrderLineId} AND requirement_id = ${requirementId}`);
    const updated = await tx.execute<{ sales_order_id: string | null; stock_item_id: string; state: string; received: string; quantity: string }>(sql`
      UPDATE procurement_requirements SET received_qty = received_qty + ${quantity}::numeric,
             state = CASE WHEN received_qty + ${quantity}::numeric >= quantity THEN 'received' ELSE state END, updated_at = now()
       WHERE id = ${requirementId}
      RETURNING sales_order_id, stock_item_id, state, received_qty::text AS received, quantity::text AS quantity
    `);
    const row = updated.rows[0];
    if (row?.sales_order_id) {
      // REQ-X-25/X-28: the order is packable again; its owner hears so.
      const order = await tx.execute<{ owner_id: string | null; number: string; grn: string; item: string }>(sql`
        SELECT d.owner_id, d.number, (SELECT number FROM grns WHERE id = ${grnId}) AS grn, (SELECT name FROM stock_items WHERE id = ${row.stock_item_id}) AS item
          FROM sales_documents d WHERE d.id = ${row.sales_order_id}
      `);
      const o = order.rows[0];
      if (o?.owner_id) {
        await this.notifications.emit({
          orgId: principal.orgId,
          type: NOTIFICATION_EVENTS.PROCUREMENT_STOCK_ARRIVED,
          audience: { kind: 'employees', employeeIds: [o.owner_id] },
          payload: { orderId: row.sales_order_id, orderNumber: o.number, grnNumber: o.grn, stockItemName: o.item, quantity },
          idempotencyKey: `stock-arrived-${grnId}-${requirementId}`,
        });
      }
    }
  }

  // ------------------------------------------------ item facts and history

  async itemVendors(orgId: string, stockItemId: string): Promise<ItemVendorView[]> {
    const rows = await this.db.execute<{ party_id: string; name: string; is_preferred: boolean; lead_time_days: number | null }>(sql`
      SELECT v.party_id, p.name, v.is_preferred, v.lead_time_days FROM item_vendors v JOIN parties p ON p.id = v.party_id
       WHERE v.org_id = ${orgId} AND v.stock_item_id = ${stockItemId} AND v.deleted_at IS NULL ORDER BY v.is_preferred DESC, p.name
    `);
    return rows.rows.map((r) => ({ partyId: r.party_id, partyName: r.name, isPreferred: r.is_preferred, leadTimeDays: r.lead_time_days }));
  }

  /** D-27: the whole set replaces the old — one preferred at most, held by the index. */
  async putItemVendors(principal: Principal, stockItemId: string, input: PutItemVendorsInput): Promise<ItemVendorView[]> {
    if (input.vendors.filter((v) => v.isPreferred).length > 1) throw AppError.validation('One preferred vendor per item.', { fields: [{ path: 'vendors', message: 'more than one preferred' }] });
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE item_vendors SET deleted_at = now(), updated_at = now() WHERE org_id = ${principal.orgId} AND stock_item_id = ${stockItemId} AND deleted_at IS NULL`);
      for (const v of input.vendors) {
        await tx.execute(sql`
          INSERT INTO item_vendors (org_id, stock_item_id, party_id, is_preferred, lead_time_days, created_by, updated_by)
          VALUES (${principal.orgId}, ${stockItemId}, ${v.partyId}, ${v.isPreferred}, ${v.leadTimeDays ?? null}, ${principal.userId}, ${principal.userId})
        `);
      }
    });
    this.auditContext.record({ action: 'purchase.item_vendors.set', entityType: 'stock_item', entityId: stockItemId, before: null, after: { vendors: input.vendors } });
    return this.itemVendors(principal.orgId, stockItemId);
  }

  /** D-28: reorder level and minimum order quantity, Vyuha's for now. */
  async putItemSettings(principal: Principal, stockItemId: string, input: PutItemSettingsInput): Promise<void> {
    /*
     * The item id arrives from the path and was trusted. `item_settings` is
     * unique on `stock_item_id` alone, so an id belonging to another
     * organisation did not collide -- it matched, and the ON CONFLICT branch
     * wrote this organisation's reorder level over that one's row. Stock item
     * ids are uuids and not meant to be guessable, which made it unlikely
     * rather than impossible; an id that appears in a shared export or a
     * support ticket is enough.
     *
     * Two things now stand in the way: the item must be this organisation's,
     * and the update may only touch a row that already is.
     */
    const owns = await this.db.execute<{ one: number }>(sql`
      SELECT 1 AS one FROM stock_items WHERE id = ${stockItemId} AND org_id = ${principal.orgId}
    `);
    if (owns.rows.length === 0) throw AppError.notFound('Stock item', stockItemId);

    await this.db.execute(sql`
      INSERT INTO item_settings (org_id, stock_item_id, reorder_level, minimum_order_qty, created_by, updated_by)
      VALUES (${principal.orgId}, ${stockItemId}, ${input.reorderLevel ?? null}, ${input.minimumOrderQty ?? null}, ${principal.userId}, ${principal.userId})
      ON CONFLICT (stock_item_id) DO UPDATE SET reorder_level = EXCLUDED.reorder_level, minimum_order_qty = EXCLUDED.minimum_order_qty, updated_at = now(), updated_by = EXCLUDED.updated_by, deleted_at = NULL
       WHERE item_settings.org_id = ${principal.orgId}
    `);
    this.auditContext.record({ action: 'purchase.item_settings.set', entityType: 'stock_item', entityId: stockItemId, before: null, after: { ...input } });
  }

  /** REQ-X-14: Purchase vouchers and earlier POs for this item, this vendor. */
  async purchaseHistory(orgId: string, query: PurchaseHistoryQuery): Promise<PurchaseHistoryEntry[]> {
    const vouchers = await this.db.execute<{ date: string; number: string; vendor: string; qty: string | null; rate: string | null; amount: string | null }>(sql`
      SELECT v.voucher_date AS date, v.voucher_number AS number, v.party_name AS vendor, l.billed_qty AS qty, l.rate::text AS rate, l.amount::text AS amount
        FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
       WHERE l.org_id = ${orgId} AND l.stock_item_id = ${query.stockItemId} AND v.voucher_type = 'Purchase' AND NOT v.is_cancelled
         ${query.partyId === undefined ? sql`` : sql`AND v.party_id = ${query.partyId}`}
       ORDER BY v.voucher_date DESC LIMIT ${query.limit}
    `);
    const orders = await this.db.execute<{ date: string; number: string; vendor: string; qty: string; rate: string; amount: string }>(sql`
      SELECT po.date, po.number, po.vendor_name AS vendor, pl.quantity::text AS qty, pl.rate::text AS rate, pl.amount::text AS amount
        FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.purchase_order_id
       WHERE pl.org_id = ${orgId} AND pl.stock_item_id = ${query.stockItemId} AND pl.deleted_at IS NULL AND po.deleted_at IS NULL AND po.status <> 'CANCELLED'
         ${query.partyId === undefined ? sql`` : sql`AND po.party_id = ${query.partyId}`}
       ORDER BY po.date DESC LIMIT ${query.limit}
    `);
    return [
      ...vouchers.rows.map((r): PurchaseHistoryEntry => ({ source: 'voucher', date: r.date, reference: `Purchase ${r.number}`, vendorName: r.vendor, quantity: r.qty, rate: r.rate, amount: r.amount })),
      ...orders.rows.map((r): PurchaseHistoryEntry => ({ source: 'purchase_order', date: r.date, reference: r.number, vendorName: r.vendor, quantity: r.qty, rate: r.rate, amount: r.amount })),
    ]
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, query.limit);
  }

  // ---------------------------------------------------------------- helpers

  private async vendor(orgId: string, partyId: string): Promise<string> {
    const rows = await this.db.execute<{ name: string; parent_group: string }>(sql`SELECT name, parent_group FROM parties WHERE org_id = ${orgId} AND id = ${partyId}`);
    const row = rows.rows[0];
    if (row === undefined) throw AppError.validation('The vendor was not found among the parties.', { partyId });
    return row.name;
  }

  /**
   * `taxPct` is required rather than optional: it is bound straight into SQL
   * below, where the compiler cannot see it, and a NOT NULL column would take
   * the null at runtime. `resolveDocumentLines` is what fills it in.
   */
  private async replaceLines(tx: Transaction, principal: Principal, poId: string, lines: readonly (PurchaseLineInput & { taxPct: string })[]): Promise<void> {
    await tx.execute(sql`DELETE FROM purchase_order_lines WHERE purchase_order_id = ${poId}`);
    for (const [index, line] of lines.entries()) {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO purchase_order_lines (org_id, purchase_order_id, line_no, stock_item_id, description, quantity, unit, rate, discount_pct, tax_pct, hsn_code, amount, tax_amount, created_by, updated_by)
        VALUES (${principal.orgId}, ${poId}, ${index + 1}, ${line.stockItemId ?? null}, ${line.description}, ${line.quantity}, ${line.unit ?? null}, ${line.rate}, ${line.discountPct}, ${line.taxPct}, ${line.hsnCode ?? null},
                round(${line.quantity}::numeric * ${line.rate}::numeric * (1 - ${line.discountPct}::numeric / 100), 2),
                round(round(${line.quantity}::numeric * ${line.rate}::numeric * (1 - ${line.discountPct}::numeric / 100), 2) * ${line.taxPct}::numeric / 100, 2), ${principal.userId}, ${principal.userId})
        RETURNING id
      `);
      const lineId = inserted.rows[0]?.id;
      if (lineId === undefined) throw new Error('Purchase order line insert returned no row.');
      let remaining = Number(line.quantity);
      for (const requirementId of line.requirementIds) {
        if (remaining <= 0) break;
        const req = await tx.execute<{ open: string }>(sql`SELECT (quantity - ordered_qty)::text AS open FROM procurement_requirements WHERE id = ${requirementId} AND org_id = ${principal.orgId} AND state = 'open' AND deleted_at IS NULL`);
        const open = Number(req.rows[0]?.open ?? '0');
        if (open <= 0) continue;
        const take = Math.min(open, remaining);
        await tx.execute(sql`INSERT INTO po_line_requirements (org_id, purchase_order_line_id, requirement_id, quantity) VALUES (${principal.orgId}, ${lineId}, ${requirementId}, ${take.toFixed(3)})`);
        remaining -= take;
      }
    }
    // `subtotal` is gross, before the discount, which is what `sales_documents`
    // means by the same word and what the Subtotal / Discount / Tax / Total
    // block on the export adds up. It used to store the net -- the discount
    // already taken off -- while `view()` reported `discountTotal` beside it,
    // so the four figures did not reconcile and a reader subtracting the
    // discount took it off twice. The total itself is unchanged: it is still
    // net plus tax.
    await tx.execute(sql`
      UPDATE purchase_orders po SET subtotal = t.gross, tax_total = t.tax, grand_total = t.net + t.tax, updated_at = now()
        FROM (
          SELECT COALESCE(sum(round(quantity * rate, 2)), 0) AS gross,
                 COALESCE(sum(amount), 0) AS net,
                 COALESCE(sum(tax_amount), 0) AS tax
            FROM purchase_order_lines WHERE purchase_order_id = ${poId} AND deleted_at IS NULL
        ) t
       WHERE po.id = ${poId}
    `);
  }

  /** REQ-X-16: the value above which a PO waits for approval; zero (the default) means none does. */
  private async threshold(orgId: string): Promise<number> {
    const rows = await this.db.execute<{ value: unknown }>(sql`
      SELECT value FROM settings WHERE org_id = ${orgId} AND scope = 'ORG' AND key = ${SETTING_THRESHOLD} AND deleted_at IS NULL LIMIT 1
    `);
    const value = rows.rows[0]?.value;
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async enqueuePush(principal: Pick<Principal, 'orgId' | 'userId'> | { orgId: string; userId: string | null }, id: string): Promise<boolean> {
    const po = await this.view(principal.orgId, id);
    if (po === null) throw AppError.notFound('Purchase order', id);
    const payload: VoucherPushPayload = {
      documentId: po.id,
      kind: 'PURCHASE_ORDER',
      voucherType: PUSH_KIND_VOUCHER_TYPE.PURCHASE_ORDER,
      reference: po.number,
      date: po.date,
      partyName: po.vendorName,
      narration: `${po.notes ?? ''}\nvyuha:${po.number}:${po.id}`.trim(),
      idempotencyKey: `vyuha:${po.id}`,
      remoteGuid: null,
      lines: po.lines.map((l) => ({ stockItemName: l.description, quantity: l.quantity, unit: l.unit, rate: l.rate, discountPct: l.discountPct, amount: l.amount })),
    };
    const jobId = await this.pushQueue.enqueue(principal.orgId, principal.userId, payload, po.partyId);
    await this.db.execute(sql`UPDATE purchase_orders SET sync_state = ${jobId === null ? 'NOT_PUSHED' : 'QUEUED'}, push_job_id = ${jobId}, last_error = NULL, updated_at = now() WHERE id = ${id}`);
    return jobId !== null;
  }

  private async enqueueGrnPush(principal: Principal, grnId: string): Promise<boolean> {
    const grn = await this.findGrn(principal, grnId);
    const payload: VoucherPushPayload = {
      documentId: grn.id,
      kind: 'RECEIPT_NOTE',
      voucherType: PUSH_KIND_VOUCHER_TYPE.RECEIPT_NOTE,
      reference: grn.number,
      date: grn.receivedAt.slice(0, 10),
      partyName: grn.vendorName,
      narration: `${grn.purchaseOrderNumber}${grn.vendorInvoiceRef ? ` ${grn.vendorInvoiceRef}` : ''}\nvyuha:${grn.number}:${grn.id}`,
      idempotencyKey: `vyuha:${grn.id}`,
      remoteGuid: null,
      lines: grn.lines.filter((l) => Number(l.receivedQty) > 0).map((l) => ({ stockItemName: l.description, quantity: l.receivedQty, unit: null, rate: '0', discountPct: '0', amount: '0' })),
    };
    if (payload.lines.length === 0) return false;
    // The purchase order names the vendor, and the vendor names the Tally
    // company this receipt belongs in.
    const owner = await this.db.execute<{ party_id: string | null }>(
      sql`SELECT party_id FROM purchase_orders WHERE id = ${grn.purchaseOrderId} AND org_id = ${principal.orgId}`,
    );
    const jobId = await this.pushQueue.enqueue(principal.orgId, principal.userId, payload, owner.rows[0]?.party_id ?? null);
    await this.db.execute(sql`UPDATE grns SET sync_state = ${jobId === null ? 'NOT_PUSHED' : 'QUEUED'}, push_job_id = ${jobId}, last_error = NULL, updated_at = now() WHERE id = ${grnId}`);
    return jobId !== null;
  }

  private async applyOutcome(tx: Transaction, orgId: string, table: 'purchase_orders' | 'grns', payload: VoucherPushPayload, outcome: PushOutcome): Promise<void> {
    const t = sql.raw(table);
    if (outcome.outcome === 'rejected') {
      await tx.execute(sql`UPDATE ${t} SET sync_state = 'FAILED', last_error = ${outcome.errorText}, updated_at = now() WHERE org_id = ${orgId} AND id = ${payload.documentId}`);
      return;
    }
    await tx.execute(sql`UPDATE ${t} SET sync_state = 'PUSHED', remote_guid = ${outcome.remoteGuid}, remote_voucher_number = ${outcome.remoteVoucherNumber}, last_pushed_at = now(), last_error = NULL, updated_at = now() WHERE org_id = ${orgId} AND id = ${payload.documentId}`);
  }

  private async nextNumber(tx: Transaction, orgId: string, kind: string, prefix: string): Promise<string> {
    await tx.execute(sql`INSERT INTO document_sequences (org_id, kind, last_number) VALUES (${orgId}, ${kind}, 0) ON CONFLICT (org_id, kind) DO NOTHING`);
    const bumped = await tx.execute<{ last_number: number }>(sql`UPDATE document_sequences SET last_number = last_number + 1 WHERE org_id = ${orgId} AND kind = ${kind} RETURNING last_number`);
    return `${prefix}-${String(bumped.rows[0]?.last_number ?? 0).padStart(4, '0')}`;
  }

  private async view(orgId: string, id: string): Promise<PurchaseOrderView | null> {
    const threshold = await this.threshold(orgId);
    const rows = await this.db.execute<{
      id: string; number: string; status: PurchaseOrderView['status']; date: string; party_id: string; vendor_name: string; sales_order_id: string | null; expected_date: string | null;
      owner_id: string | null; owner_name: string | null; notes: string | null; subtotal: string; tax_total: string; grand_total: string; sync_state: PurchaseOrderView['syncState'];
      remote_guid: string | null; remote_voucher_number: string | null; last_error: string | null; short_closed_at: Date | null; short_close_reason: string | null; created_at: Date; updated_at: Date;
      vendor_email: string | null; vendor_whatsapp: string | null; terms: string | null; details: PurchaseOrderView['details']; ship_to: PurchaseOrderView['shipTo']; discount_total: string;
      lines: PurchaseOrderView['lines'];
      notifications: { id: string; channel: 'email' | 'whatsapp'; recipient: string | null; status: 'pending' | 'sent' | 'failed'; composedText: string; sentAt: string | null; error: string | null }[];
    }>(sql`
      SELECT po.id, po.number, po.status, po.date, po.party_id, po.vendor_name, po.sales_order_id, po.expected_date, po.owner_id,
             CASE WHEN e.id IS NULL THEN NULL ELSE concat_ws(' ', e.first_name, e.last_name) END AS owner_name,
             po.notes, po.subtotal::text AS subtotal, po.tax_total::text AS tax_total, po.grand_total::text AS grand_total,
             po.sync_state, po.remote_guid, po.remote_voucher_number, po.last_error, po.short_closed_at, po.short_close_reason, po.created_at, po.updated_at,
             po.vendor_email, po.vendor_whatsapp, po.terms, po.details, po.ship_to,
             COALESCE((SELECT sum(round(pl.quantity * pl.rate, 2) - pl.amount) FROM purchase_order_lines pl WHERE pl.purchase_order_id = po.id AND pl.deleted_at IS NULL), 0)::text AS discount_total,
             COALESCE((SELECT json_agg(json_build_object('id', n.id, 'channel', n.channel, 'recipient', n.recipient, 'status', n.status, 'composedText', n.composed_text, 'sentAt', n.sent_at, 'error', n.error) ORDER BY n.channel)
                         FROM purchase_order_notifications n WHERE n.purchase_order_id = po.id AND n.deleted_at IS NULL), '[]'::json) AS notifications,
             COALESCE((
               SELECT json_agg(json_build_object(
                 'id', pl.id, 'lineNo', pl.line_no, 'stockItemId', pl.stock_item_id, 'description', pl.description, 'quantity', pl.quantity::text, 'unit', pl.unit,
                 'rate', pl.rate::text, 'discountPct', pl.discount_pct::text, 'taxPct', pl.tax_pct::text, 'hsnCode', pl.hsn_code, 'amount', pl.amount::text, 'taxAmount', pl.tax_amount::text,
                 'receivedQty', pl.received_qty::text, 'rejectedQty', pl.rejected_qty::text,
                 'requirements', COALESCE((
                   SELECT json_agg(json_build_object('requirementId', plr.requirement_id, 'quantity', plr.quantity::text, 'salesOrderNumber', d.number, 'customerName', d.customer_name))
                     FROM po_line_requirements plr JOIN procurement_requirements r ON r.id = plr.requirement_id LEFT JOIN sales_documents d ON d.id = r.sales_order_id
                    WHERE plr.purchase_order_line_id = pl.id
                 ), '[]'::json)
               ) ORDER BY pl.line_no)
                 FROM purchase_order_lines pl WHERE pl.purchase_order_id = po.id AND pl.deleted_at IS NULL
             ), '[]'::json) AS lines
        FROM purchase_orders po LEFT JOIN employees e ON e.id = po.owner_id
       WHERE po.org_id = ${orgId} AND po.id = ${id} AND po.deleted_at IS NULL
    `);
    const r = rows.rows[0];
    if (r === undefined) return null;
    const lines = r.lines;
    const fulfilment: PurchaseOrderView['fulfilment'] =
      r.short_closed_at !== null
        ? 'short_closed'
        : lines.length > 0 && lines.every((l) => Number(l.receivedQty) + Number(l.rejectedQty) >= Number(l.quantity))
          ? 'received'
          : lines.some((l) => Number(l.receivedQty) + Number(l.rejectedQty) > 0)
            ? 'partially_received'
            : 'open';
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      fulfilment,
      date: r.date,
      partyId: r.party_id,
      vendorName: r.vendor_name,
      salesOrderId: r.sales_order_id,
      expectedDate: r.expected_date,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      notes: r.notes,
      terms: r.terms,
      details: r.details,
      shipTo: r.ship_to,
      subtotal: r.subtotal,
      discountTotal: r.discount_total,
      taxTotal: r.tax_total,
      grandTotal: r.grand_total,
      approvalRequired: threshold > 0 && Number(r.grand_total) > threshold,
      syncState: r.sync_state,
      remoteGuid: r.remote_guid,
      remoteVoucherNumber: r.remote_voucher_number,
      lastError: r.last_error,
      shortClosedAt: r.short_closed_at === null ? null : new Date(r.short_closed_at).toISOString(),
      shortCloseReason: r.short_close_reason,
      vendorEmail: r.vendor_email,
      vendorWhatsapp: r.vendor_whatsapp,
      lines,
      notifications: r.notifications.map((n) => ({ ...n, sentAt: n.sentAt === null ? null : new Date(n.sentAt).toISOString() })),
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  private async grnView(orgId: string, id: string): Promise<GrnView | null> {
    const rows = await this.db.execute<{
      id: string; number: string; purchase_order_id: string; po_number: string; vendor_name: string; received_by: string | null; received_by_name: string | null; received_at: Date;
      vendor_invoice_ref: string | null; notes: string | null; sync_state: GrnView['syncState']; remote_guid: string | null; remote_voucher_number: string | null; last_error: string | null;
      lines: GrnView['lines']; pending: GrnView['pendingAllocations'];
    }>(sql`
      SELECT g.id, g.number, g.purchase_order_id, po.number AS po_number, po.vendor_name, g.received_by,
             CASE WHEN e.id IS NULL THEN NULL ELSE concat_ws(' ', e.first_name, e.last_name) END AS received_by_name,
             g.received_at, g.vendor_invoice_ref, g.notes, g.sync_state, g.remote_guid, g.remote_voucher_number, g.last_error,
             COALESCE((SELECT json_agg(json_build_object('purchaseOrderLineId', gl.purchase_order_line_id, 'description', pl.description, 'receivedQty', gl.received_qty::text, 'rejectedQty', gl.rejected_qty::text, 'rejectionReason', gl.rejection_reason) ORDER BY pl.line_no)
                         FROM grn_lines gl JOIN purchase_order_lines pl ON pl.id = gl.purchase_order_line_id WHERE gl.grn_id = g.id), '[]'::json) AS lines,
             COALESCE((
               SELECT json_agg(json_build_object(
                 'purchaseOrderLineId', pl.id, 'stockItemName', pl.description,
                 'unallocatedQty', (pl.received_qty - COALESCE((SELECT sum(plr2.allocated_qty) FROM po_line_requirements plr2 WHERE plr2.purchase_order_line_id = pl.id), 0))::text,
                 'waiting', COALESCE((
                   SELECT json_agg(json_build_object('requirementId', plr.requirement_id, 'salesOrderNumber', d.number, 'customerName', d.customer_name, 'outstandingQty', (plr.quantity - plr.allocated_qty)::text))
                     FROM po_line_requirements plr JOIN procurement_requirements r ON r.id = plr.requirement_id LEFT JOIN sales_documents d ON d.id = r.sales_order_id
                    WHERE plr.purchase_order_line_id = pl.id AND plr.quantity > plr.allocated_qty AND r.state <> 'closed'
                 ), '[]'::json)
               ))
                 FROM purchase_order_lines pl
                WHERE pl.purchase_order_id = g.purchase_order_id AND pl.deleted_at IS NULL
                  AND pl.received_qty > COALESCE((SELECT sum(plr3.allocated_qty) FROM po_line_requirements plr3 WHERE plr3.purchase_order_line_id = pl.id), 0)
                  AND (SELECT count(*) FROM po_line_requirements plr4 JOIN procurement_requirements r4 ON r4.id = plr4.requirement_id WHERE plr4.purchase_order_line_id = pl.id AND plr4.quantity > plr4.allocated_qty AND r4.state <> 'closed') > 0
             ), '[]'::json) AS pending
        FROM grns g JOIN purchase_orders po ON po.id = g.purchase_order_id LEFT JOIN employees e ON e.id = g.received_by
       WHERE g.org_id = ${orgId} AND g.id = ${id} AND g.deleted_at IS NULL
    `);
    const r = rows.rows[0];
    if (r === undefined) return null;
    return {
      id: r.id,
      number: r.number,
      purchaseOrderId: r.purchase_order_id,
      purchaseOrderNumber: r.po_number,
      vendorName: r.vendor_name,
      receivedById: r.received_by,
      receivedByName: r.received_by_name,
      receivedAt: new Date(r.received_at).toISOString(),
      vendorInvoiceRef: r.vendor_invoice_ref,
      notes: r.notes,
      syncState: r.sync_state,
      remoteGuid: r.remote_guid,
      remoteVoucherNumber: r.remote_voucher_number,
      lastError: r.last_error,
      lines: r.lines,
      pendingAllocations: r.pending,
    };
  }
}

/** Raw SQL does not serialise jsonb the way the query builder does: the value goes in as text and is cast. */
function jsonOrNull(value: unknown): SQL {
  return value === null || value === undefined ? sql`NULL` : sql`${JSON.stringify(value)}::jsonb`;
}

/** REQ-X-18: what the vendor receives — the PO in words a supplier can act on, one line per item. */
function composeVendorText(po: PurchaseOrderView): string {
  // The way a person writes it: 40, not 40.000.
  const lines = po.lines.map((l) => `- ${l.description}: ${String(Number(l.quantity))}${l.unit === null ? '' : ` ${l.unit}`} @ ${l.rate}`).join('\n');
  return [
    `Purchase order ${po.number} dated ${po.date}`,
    `To: ${po.vendorName}`,
    lines,
    `Total: ${po.grandTotal}`,
    po.expectedDate === null ? null : `Expected by: ${po.expectedDate}`,
    po.notes === null || po.notes === '' ? null : `Notes: ${po.notes}`,
    'Please confirm receipt of this order.',
  ]
    .filter((part): part is string => part !== null)
    .join('\n');
}
