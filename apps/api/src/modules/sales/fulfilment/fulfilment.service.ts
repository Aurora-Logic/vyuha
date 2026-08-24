import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DEFAULT_PURCHASE_SETTINGS,
  NOTIFICATION_EVENTS,
  PERMISSIONS,
  pageSlice,
  paginated,
  type AwaitingInvoiceEntry,
  type CreatePackRecordInput,
  type CreatePickRecordInput,
  type PackListQuery,
  type PackRecordView,
  type Paginated,
  type PickQueueEntry,
  type PickRecordView,
  type SalesDocumentView,
  type UnlinkedInvoice,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AuditContext } from '../../../platform/audit/audit-context.js';
import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { JobRegistry, type JobContext, type JobHandler, type JobResult } from '../../../platform/jobs/job-handler.js';
import type { JobPayloads } from '../../../platform/jobs/queue.registry.js';
import { NotificationDispatcher } from '../../../platform/notifications/notification.dispatcher.js';
import { RequirementsService } from '../../../platform/procurement/requirements.service.js';
import { hasPermission, orgContextOf, type Principal } from '../../../platform/rbac/principal.js';
import { ScopeService } from '../../../platform/rbac/scope.service.js';
import { EstimateRepository } from '../estimates/estimate.repository.js';
import { salesDocuments } from '../schema/index.js';

/**
 * Pick, pack, and the billing handshake (12 §3.2, §3.3). Quantities are the
 * state: packing adds to `packed_qty` under the database's own CHECK chain,
 * linking an invoice adds to `invoiced_qty`, and the fulfilment word is
 * derived from those on every read. A short pack raises a procurement
 * requirement for the balance (REQ-X-08, D-31); a pack that completes the
 * line closes it.
 *
 * REQ-AA-12 / D-21: the accountant bills in Tally; when the Sales voucher
 * arrives on a pull carrying the order number in its narration, it links to
 * that order and its item lines advance `invoiced_qty`. An invoice with no
 * item lines is taken to cover everything packed and uninvoiced at link
 * time. Anything unresolvable waits on the unlinked screen (REQ-AA-13) —
 * never guessed by party and date.
 */

const GRANTS = { self: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF, all: PERMISSIONS.SALES_DOCUMENT_VIEW_ALL };

@Injectable()
export class FulfilmentService implements JobHandler<'link-sales-invoices'>, OnModuleInit {
  readonly jobName = 'link-sales-invoices' as const;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly scopes: ScopeService,
    private readonly requirements: RequirementsService,
    private readonly jobs: JobRegistry,
    private readonly notifications: NotificationDispatcher,
  ) {}

  onModuleInit(): void {
    this.jobs.register(this);
  }

  /** The sweep: link what the narration names, then remind accounts of what has waited too long (REQ-AA-15), for every organisation. */
  async run(_payload: JobPayloads['link-sales-invoices'], _context: JobContext): Promise<JobResult> {
    const orgs = await this.db.execute<{ id: string }>(sql`SELECT id FROM organizations WHERE deleted_at IS NULL`);
    let linked = 0;
    let reminded = 0;
    for (const org of orgs.rows) {
      linked += await this.linkByNarration(org.id, null);
      reminded += await this.remindWaiting(org.id);
    }
    return { linked, reminded };
  }

  /**
   * REQ-AA-15: once per order, when its packed goods have waited longer than
   * the configured hours (`sales.invoiceWaitingHours`, 0 disables). Sent to
   * every holder of receivables.view — accounts — and stamped on the order
   * so the next sweep does not send it again.
   */
  private async remindWaiting(orgId: string): Promise<number> {
    const setting = await this.db.execute<{ value: unknown }>(sql`
      SELECT value FROM settings WHERE org_id = ${orgId} AND scope = 'ORG' AND key = 'sales.invoiceWaitingHours' AND deleted_at IS NULL LIMIT 1
    `);
    const raw = setting.rows[0]?.value;
    const hours = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : DEFAULT_PURCHASE_SETTINGS.invoiceWaitingHours;
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    const rows = await this.db.execute<{ id: string; number: string; customer_name: string; qty: string; since: Date }>(sql`
      SELECT d.id, d.number, d.customer_name, sum(l.packed_qty - l.invoiced_qty)::text AS qty,
             COALESCE((SELECT min(p.packed_at) FROM pack_records p WHERE p.document_id = d.id AND p.deleted_at IS NULL
                          AND p.packed_at > COALESCE((SELECT max(i.linked_at) FROM sales_order_invoices i WHERE i.document_id = d.id), 'epoch'::timestamptz)),
                      d.updated_at) AS since
        FROM sales_documents d JOIN sales_document_lines l ON l.document_id = d.id AND l.deleted_at IS NULL
       WHERE d.org_id = ${orgId} AND d.doc_type = 'SALES_ORDER' AND d.status = 'CONFIRMED'
         AND d.short_closed_at IS NULL AND d.deleted_at IS NULL AND d.invoice_reminder_sent_at IS NULL
       GROUP BY d.id
      HAVING sum(l.packed_qty - l.invoiced_qty) > 0
         AND COALESCE((SELECT min(p.packed_at) FROM pack_records p WHERE p.document_id = d.id AND p.deleted_at IS NULL
                          AND p.packed_at > COALESCE((SELECT max(i.linked_at) FROM sales_order_invoices i WHERE i.document_id = d.id), 'epoch'::timestamptz)),
                      d.updated_at) < now() - make_interval(hours => ${hours})
       LIMIT 200
    `);
    let sent = 0;
    for (const r of rows.rows) {
      const waitingHours = Math.max(0, Math.floor((Date.now() - new Date(r.since).getTime()) / 3_600_000));
      await this.notifications.emit({
        orgId,
        type: NOTIFICATION_EVENTS.SALES_INVOICE_WAITING,
        audience: { kind: 'permission', key: PERMISSIONS.RECEIVABLES_VIEW },
        payload: { orderId: r.id, orderNumber: r.number, customerName: r.customer_name, packedUninvoicedQty: r.qty, waitingSince: new Date(r.since).toISOString().slice(0, 10), waitingHours },
        idempotencyKey: `invoice-waiting-${r.id}`,
      });
      await this.db.execute(sql`UPDATE sales_documents SET invoice_reminder_sent_at = now() WHERE id = ${r.id}`);
      sent += 1;
    }
    return sent;
  }

  // -------------------------------------------------------------- picking

  /** REQ-AA-06: confirmed orders with something left to pack, oldest first (D-26: a shared queue). */
  async pickQueue(principal: Principal): Promise<PickQueueEntry[]> {
    // The queries below alias the table as `d`, so the scope names it that way.
    const scope = this.scopes.resolve(principal, GRANTS, sql`d.owner_id`).where;
    const rows = await this.db.execute<{
      id: string; number: string; customer_name: string; date: string; balance_lines: number; balance_qty: string; waiting: number; fulfilment: string;
    }>(sql`
      SELECT d.id, d.number, d.customer_name, d.date,
             count(l.id) FILTER (WHERE l.quantity > l.packed_qty)::int AS balance_lines,
             COALESCE(sum(l.quantity - l.packed_qty), 0)::text AS balance_qty,
             (SELECT count(*)::int FROM procurement_requirements r WHERE r.sales_order_id = d.id AND r.state IN ('open','ordered') AND r.deleted_at IS NULL) AS waiting,
             CASE WHEN sum(l.packed_qty) > 0 THEN 'picking' ELSE 'open' END AS fulfilment
        FROM sales_documents d
        JOIN sales_document_lines l ON l.document_id = d.id AND l.deleted_at IS NULL
       WHERE d.org_id = ${principal.orgId} AND d.doc_type = 'SALES_ORDER' AND d.status = 'CONFIRMED'
         AND d.short_closed_at IS NULL AND d.deleted_at IS NULL AND ${scope}
       GROUP BY d.id
      HAVING sum(l.quantity - l.packed_qty) > 0
       ORDER BY d.date, d.created_at
       LIMIT 200
    `);
    return rows.rows.map((r) => ({
      documentId: r.id,
      number: r.number,
      customerName: r.customer_name,
      date: r.date,
      fulfilment: r.fulfilment === 'picking' ? 'picking' : 'open',
      balanceLines: Number(r.balance_lines),
      balanceQty: r.balance_qty,
      waitingOnRequirements: Number(r.waiting),
    }));
  }

  async listPacks(principal: Principal, documentId: string): Promise<PackRecordView[]> {
    await this.order(principal, documentId);
    return this.packRecords(principal, sql`p.document_id = ${documentId}`);
  }

  /** One pack record by id: the packing slip's page and its workbook read it without the order. */
  async findPack(principal: Principal, id: string): Promise<PackRecordView> {
    const rows = await this.packRecords(principal, sql`p.id = ${id}`);
    const pack = rows[0];
    if (pack === undefined) throw AppError.notFound('Pack record', id);
    // The order's own read applies the view scope (self or all) to the pack.
    await this.order(principal, pack.documentId);
    return pack;
  }

  /**
   * D-47: the slip's number is the order number and the last four characters
   * of the pack id ("SO-0007/AB12"), because that is what the paper prints
   * and the phone scans. The suffix alone is not unique; with the order it is.
   */
  async findPackBySlip(principal: Principal, slipNumber: string): Promise<PackRecordView> {
    const match = /^(.+)\/([0-9A-Fa-f]{4})$/u.exec(slipNumber.trim());
    if (match === null) throw AppError.notFound('Packing slip', slipNumber);
    const [, orderNumber = '', suffix = ''] = match;
    const rows = await this.packRecords(
      principal,
      sql`p.document_id = (SELECT id FROM sales_documents WHERE org_id = ${principal.orgId} AND number = ${orderNumber} AND deleted_at IS NULL LIMIT 1)
          AND upper(right(p.id::text, 4)) = ${suffix.toUpperCase()}`,
    );
    const pack = rows[0];
    if (pack === undefined) throw AppError.notFound('Packing slip', slipNumber);
    await this.order(principal, pack.documentId);
    return pack;
  }

  /** D-47: the Packed screen — every pack across the orders this person may see, newest first. */
  async listAllPacks(principal: Principal, query: PackListQuery): Promise<Paginated<PackRecordView>> {
    const scope = this.scopes.resolve(principal, GRANTS, sql`d.owner_id`).where;
    const needle = query.q === undefined ? null : `%${query.q}%`;
    const where = sql`${scope} AND d.deleted_at IS NULL${needle === null ? sql`` : sql` AND (d.number ILIKE ${needle} OR d.customer_name ILIKE ${needle})`}`;
    const counted = await this.db.execute<{ total: number }>(sql`
      SELECT count(*)::int AS total FROM pack_records p JOIN sales_documents d ON d.id = p.document_id
       WHERE p.org_id = ${principal.orgId} AND p.deleted_at IS NULL AND ${where}
    `);
    const { limit, offset } = pageSlice(query);
    const rows = await this.packRecords(principal, where, sql`ORDER BY p.packed_at DESC LIMIT ${limit} OFFSET ${offset}`);
    return paginated(rows, query, counted.rows[0]?.total ?? 0);
  }

  private async packRecords(principal: Principal, where: SQL, order: SQL = sql`ORDER BY p.packed_at`): Promise<PackRecordView[]> {
    const rows = await this.db.execute<{
      id: string; document_id: string; order_number: string; customer_name: string; box_count: number; packed_by: string | null; packed_by_name: string | null; packed_at: Date; comment: string | null;
      lines: { lineId: string; description: string; quantity: string; comment: string | null }[];
    }>(sql`
      SELECT p.id, p.document_id, d.number AS order_number, d.customer_name, p.box_count, p.packed_by,
             CASE WHEN e.id IS NULL THEN NULL ELSE concat_ws(' ', e.first_name, e.last_name) END AS packed_by_name,
             p.packed_at, p.comment,
             COALESCE((
               SELECT json_agg(json_build_object('lineId', pl.line_id, 'description', l.description, 'quantity', pl.quantity::text, 'comment', pl.comment) ORDER BY l.line_no)
                 FROM pack_record_lines pl JOIN sales_document_lines l ON l.id = pl.line_id WHERE pl.pack_record_id = p.id
             ), '[]'::json) AS lines
        FROM pack_records p JOIN sales_documents d ON d.id = p.document_id LEFT JOIN employees e ON e.id = p.packed_by
       WHERE p.org_id = ${principal.orgId} AND ${where} AND p.deleted_at IS NULL
       ${order}
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      orderNumber: r.order_number,
      customerName: r.customer_name,
      slipNumber: `${r.order_number}/${r.id.slice(-4).toUpperCase()}`,
      boxCount: Number(r.box_count),
      packedById: r.packed_by,
      packedByName: r.packed_by_name,
      packedAt: new Date(r.packed_at).toISOString(),
      comment: r.comment,
      lines: r.lines,
    }));
  }

  /**
   * REQ-AA-07/AA-08/AA-09: one packing session. Each named line's packed
   * quantity advances; the CHECK chain refuses more than ordered, and the
   * refusal is turned into a sentence that names the line. Then, per line,
   * the unpacked balance becomes (or updates, or closes) its shortage
   * requirement (REQ-X-08).
   */
  /** D-48: a picking session — the balance moves ordered → picked; a line packs only what it has picked. */
  async pick(principal: Principal, documentId: string, input: CreatePickRecordInput): Promise<PickRecordView> {
    const order = await this.order(principal, documentId);
    if (order.status !== 'CONFIRMED') throw AppError.conflict(`${order.number} is ${order.status.toLowerCase()}; only a confirmed order is picked.`);
    if (order.shortClosedAt !== null) throw AppError.conflict(`${order.number} was short-closed.`);
    const byId = new Map(order.lines.map((line) => [line.id, line]));
    for (const entry of input.lines) {
      const line = byId.get(entry.lineId);
      if (line === undefined) throw AppError.validation('A pick line names a line that is not on this order.', { lineId: entry.lineId });
      const balance = Number(line.quantity) - Number(line.pickedQty);
      if (Number(entry.quantity) > balance + 1e-9) {
        throw AppError.validation(`Line ${String(line.lineNo)} (${line.description}) has ${balance.toFixed(3)} left to pick, not ${entry.quantity}.`, {
          fields: [{ path: `lines.${String(input.lines.indexOf(entry))}.quantity`, message: 'exceeds the balance' }],
        });
      }
    }
    const ctx = orgContextOf(principal);
    const pickId = await this.db.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO pick_records (org_id, document_id, picked_by, comment, created_by, updated_by)
        VALUES (${ctx.orgId}, ${documentId}, ${principal.employeeId}, ${input.comment ?? null}, ${ctx.actorUserId}, ${ctx.actorUserId})
        RETURNING id
      `);
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error('Pick record insert returned no row.');
      for (const entry of input.lines) {
        await tx.execute(sql`INSERT INTO pick_record_lines (org_id, pick_record_id, line_id, quantity, comment, created_by, updated_by) VALUES (${ctx.orgId}, ${id}, ${entry.lineId}, ${entry.quantity}, ${entry.comment ?? null}, ${ctx.actorUserId}, ${ctx.actorUserId})`);
        await tx.execute(sql`UPDATE sales_document_lines SET picked_qty = picked_qty + ${entry.quantity}::numeric, updated_at = now(), updated_by = ${ctx.actorUserId} WHERE id = ${entry.lineId} AND document_id = ${documentId}`);
      }
      return id;
    });
    this.auditContext.record({ action: 'sales.order.picked', entityType: 'sales_document', entityId: documentId, before: null, after: { pickRecordId: pickId, lines: input.lines } });
    const picks = await this.listPicks(principal, documentId);
    const created = picks.find((p) => p.id === pickId);
    if (created === undefined) throw new Error('Pick record vanished after insert.');
    return created;
  }

  /** REQ-AA-31 for picks: every picking session against one order. */
  async listPicks(principal: Principal, documentId: string): Promise<PickRecordView[]> {
    await this.order(principal, documentId);
    const rows = await this.db.execute<{
      id: string; document_id: string; picked_by: string | null; picked_by_name: string | null; picked_at: Date; comment: string | null;
      lines: { lineId: string; description: string; quantity: string; comment: string | null }[];
    }>(sql`
      SELECT p.id, p.document_id, p.picked_by,
             CASE WHEN e.id IS NULL THEN NULL ELSE concat_ws(' ', e.first_name, e.last_name) END AS picked_by_name,
             p.picked_at, p.comment,
             COALESCE((SELECT json_agg(json_build_object('lineId', pl.line_id, 'description', l.description, 'quantity', pl.quantity::text, 'comment', pl.comment) ORDER BY l.line_no)
                         FROM pick_record_lines pl JOIN sales_document_lines l ON l.id = pl.line_id WHERE pl.pick_record_id = p.id), '[]'::json) AS lines
        FROM pick_records p LEFT JOIN employees e ON e.id = p.picked_by
       WHERE p.org_id = ${principal.orgId} AND p.document_id = ${documentId} AND p.deleted_at IS NULL
       ORDER BY p.picked_at
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      pickedById: r.picked_by,
      pickedByName: r.picked_by_name,
      pickedAt: new Date(r.picked_at).toISOString(),
      comment: r.comment,
      lines: r.lines,
    }));
  }

  async pack(principal: Principal, documentId: string, input: CreatePackRecordInput): Promise<PackRecordView> {
    const order = await this.order(principal, documentId);
    if (order.status !== 'CONFIRMED') throw AppError.conflict(`${order.number} is ${order.status.toLowerCase()}; only a confirmed order is picked.`);
    if (order.shortClosedAt !== null) throw AppError.conflict(`${order.number} was short-closed.`);
    const byId = new Map(order.lines.map((line) => [line.id, line]));
    for (const entry of input.lines) {
      const line = byId.get(entry.lineId);
      if (line === undefined) throw AppError.validation('A pack line names a line that is not on this order.', { lineId: entry.lineId });
      // D-48: pack only what is picked; the constraint packed <= picked enforces it, this names it.
      const balance = Number(line.pickedQty) - Number(line.packedQty);
      if (Number(entry.quantity) > balance + 1e-9) {
        throw AppError.validation(`Line ${String(line.lineNo)} (${line.description}) has ${balance.toFixed(3)} picked and not yet packed, not ${entry.quantity}.`, {
          fields: [{ path: `lines.${String(input.lines.indexOf(entry))}.quantity`, message: 'exceeds the balance' }],
        });
      }
    }
    const ctx = orgContextOf(principal);
    const packId = await this.db.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO pack_records (org_id, document_id, box_count, packed_by, comment, created_by, updated_by)
        VALUES (${ctx.orgId}, ${documentId}, ${input.boxCount}, ${principal.employeeId}, ${input.comment ?? null}, ${ctx.actorUserId}, ${ctx.actorUserId})
        RETURNING id
      `);
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error('Pack record insert returned no row.');
      for (const entry of input.lines) {
        await tx.execute(sql`
          INSERT INTO pack_record_lines (org_id, pack_record_id, line_id, quantity, comment, created_by, updated_by)
          VALUES (${ctx.orgId}, ${id}, ${entry.lineId}, ${entry.quantity}, ${entry.comment ?? null}, ${ctx.actorUserId}, ${ctx.actorUserId})
        `);
        await tx.execute(sql`
          UPDATE sales_document_lines SET packed_qty = packed_qty + ${entry.quantity}::numeric, updated_at = now(), updated_by = ${ctx.actorUserId}
           WHERE id = ${entry.lineId} AND document_id = ${documentId}
        `);
      }
      // D-31: the balance of every touched line becomes its requirement, or closes it.
      for (const entry of input.lines) {
        const line = byId.get(entry.lineId);
        if (line === undefined || line.stockItemId === null) continue;
        const after = await tx.execute<{ balance: string }>(sql`SELECT (quantity - packed_qty)::text AS balance FROM sales_document_lines WHERE id = ${entry.lineId}`);
        await this.requirements.raiseShortage(tx, ctx.orgId, ctx.actorUserId, {
          stockItemId: line.stockItemId,
          salesOrderId: documentId,
          salesOrderLineId: entry.lineId,
          balanceQty: after.rows[0]?.balance ?? '0',
          neededBy: null,
        });
      }
      return id;
    });
    this.auditContext.record({
      action: 'sales.order.packed',
      entityType: 'sales_document',
      entityId: documentId,
      before: null,
      after: { packRecordId: packId, boxCount: input.boxCount, lines: input.lines },
    });
    const packs = await this.listPacks(principal, documentId);
    const created = packs.find((p) => p.id === packId);
    if (created === undefined) throw new Error('Pack record vanished after insert.');
    return created;
  }

  // ------------------------------------------------------- the handshake

  /** REQ-AA-11/AA-15: packed and uninvoiced, and for how long. Links by narration first. */
  async awaitingInvoice(principal: Principal): Promise<AwaitingInvoiceEntry[]> {
    await this.linkByNarration(principal.orgId, principal.userId);
    const scope = this.scopes.resolve(principal, GRANTS, sql`d.owner_id`).where;
    const rows = await this.db.execute<{ id: string; number: string; customer_name: string; qty: string; since: Date }>(sql`
      SELECT d.id, d.number, d.customer_name,
             sum(l.packed_qty - l.invoiced_qty)::text AS qty,
             COALESCE((SELECT min(p.packed_at) FROM pack_records p WHERE p.document_id = d.id AND p.deleted_at IS NULL
                          AND p.packed_at > COALESCE((SELECT max(i.linked_at) FROM sales_order_invoices i WHERE i.document_id = d.id), 'epoch'::timestamptz)),
                      d.updated_at) AS since
        FROM sales_documents d JOIN sales_document_lines l ON l.document_id = d.id AND l.deleted_at IS NULL
       WHERE d.org_id = ${principal.orgId} AND d.doc_type = 'SALES_ORDER' AND d.status = 'CONFIRMED'
         AND d.short_closed_at IS NULL AND d.deleted_at IS NULL AND ${scope}
       GROUP BY d.id
      HAVING sum(l.packed_qty - l.invoiced_qty) > 0
       ORDER BY since
       LIMIT 200
    `);
    const now = Date.now();
    return rows.rows.map((r) => ({
      documentId: r.id,
      number: r.number,
      customerName: r.customer_name,
      packedUninvoicedQty: r.qty,
      waitingSince: new Date(r.since).toISOString(),
      // Never negative: the database clock and this one may disagree by a moment.
      waitingHours: Math.max(0, Math.floor((now - new Date(r.since).getTime()) / 3_600_000)),
    }));
  }

  /** REQ-AA-13: Sales vouchers with a party and no order behind them, with the party's open orders beside each. */
  async unlinkedInvoices(principal: Principal): Promise<UnlinkedInvoice[]> {
    await this.linkByNarration(principal.orgId, principal.userId);
    const rows = await this.db.execute<{
      id: string; voucher_number: string; voucher_date: string; party_id: string | null; party_name: string; amount: string; narration: string | null;
      candidates: { documentId: string; number: string; date: string; grandTotal: string }[];
    }>(sql`
      SELECT v.id, v.voucher_number, v.voucher_date, v.party_id, v.party_name, v.amount::text AS amount, v.narration,
             COALESCE((
               SELECT json_agg(json_build_object('documentId', d.id, 'number', d.number, 'date', d.date, 'grandTotal', d.grand_total::text) ORDER BY d.date DESC)
                 FROM sales_documents d
                WHERE d.org_id = v.org_id AND d.doc_type = 'SALES_ORDER' AND d.status = 'CONFIRMED' AND d.short_closed_at IS NULL AND d.deleted_at IS NULL
                  AND d.party_id = v.party_id
                  AND EXISTS (SELECT 1 FROM sales_document_lines l WHERE l.document_id = d.id AND l.deleted_at IS NULL AND l.packed_qty > l.invoiced_qty)
             ), '[]'::json) AS candidates
        FROM vouchers v
       WHERE v.org_id = ${principal.orgId} AND v.voucher_type = 'Sales' AND NOT v.is_cancelled
         AND NOT EXISTS (SELECT 1 FROM sales_order_invoices i WHERE i.voucher_id = v.id)
         AND NOT EXISTS (
           SELECT 1 FROM external_refs xv JOIN external_refs xi ON xi.external_guid = xv.external_guid AND xi.internal_type = 'SALES_INVOICE' AND xi.deleted_at IS NULL
            WHERE xv.internal_id = v.id AND xv.internal_type = 'voucher' AND xv.deleted_at IS NULL
         )
         AND EXISTS (SELECT 1 FROM sales_documents d WHERE d.org_id = v.org_id AND d.doc_type = 'SALES_ORDER' AND d.deleted_at IS NULL)
       ORDER BY v.voucher_date DESC, v.voucher_number DESC
       LIMIT 200
    `);
    return rows.rows.map((r) => ({
      voucherId: r.id,
      voucherNumber: r.voucher_number,
      date: r.voucher_date,
      partyId: r.party_id,
      partyName: r.party_name,
      amount: r.amount,
      narration: r.narration,
      candidateOrders: r.candidates,
    }));
  }

  /** The manual half of D-21. */
  async linkInvoice(principal: Principal, documentId: string, voucherId: string): Promise<SalesDocumentView> {
    const order = await this.order(principal, documentId);
    const linked = await this.link(principal.orgId, principal.userId, documentId, voucherId, 'manual');
    if (!linked) throw AppError.conflict('That voucher is not an open Sales voucher of this organisation, or is already linked.');
    this.auditContext.record({ action: 'sales.order.invoice_linked', entityType: 'sales_document', entityId: documentId, before: null, after: { voucherId, method: 'manual', number: order.number } });
    return this.order(principal, documentId);
  }

  /** REQ-AA-05 / D-24: the balance written off, with a reason, by `sales.document.alter`. */
  async shortClose(principal: Principal, documentId: string, reason: string): Promise<SalesDocumentView> {
    if (!hasPermission(principal, PERMISSIONS.SALES_DOCUMENT_ALTER)) throw AppError.forbidden('Short-closing an order needs sales.document.alter.');
    const order = await this.order(principal, documentId);
    if (order.status !== 'CONFIRMED') throw AppError.conflict(`${order.number} is ${order.status.toLowerCase()}.`);
    if (order.shortClosedAt !== null) throw AppError.conflict(`${order.number} is already short-closed.`);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE sales_documents SET short_closed_at = now(), short_close_reason = ${reason}, updated_at = now(), updated_by = ${principal.userId}
         WHERE id = ${documentId} AND org_id = ${principal.orgId}
      `);
      await this.requirements.closeForSalesOrder(tx, principal.orgId, documentId, `Order short-closed: ${reason}`);
    });
    this.auditContext.record({ action: 'sales.order.short_closed', entityType: 'sales_document', entityId: documentId, before: { fulfilment: order.fulfilment }, after: { reason } });
    return this.order(principal, documentId);
  }

  // ---------------------------------------------------------------- helpers

  /**
   * D-21, the automatic half: a Sales voucher whose narration names an order
   * number for the same party links to it. One statement finds the pairs;
   * each is linked through the same path the manual screen uses.
   */
  private async linkByNarration(orgId: string, actorUserId: string | null): Promise<number> {
    // D-38: a Vyuha-raised invoice's own voucher, pulled back, attaches to
    // its link and is not a second invoice. `external_refs` holds the GUID.
    await this.db.execute(sql`
      UPDATE sales_order_invoices i SET voucher_id = v.id
        FROM external_refs x JOIN vouchers v ON v.org_id = x.org_id AND v.connection_id = x.connection_id
       WHERE i.invoice_document_id = x.internal_id AND x.internal_type = 'SALES_INVOICE' AND x.entity_type = 'voucher_push' AND x.deleted_at IS NULL
         AND i.voucher_id IS NULL AND i.org_id = ${orgId}
         AND EXISTS (SELECT 1 FROM external_refs xv WHERE xv.internal_id = v.id AND xv.internal_type = 'voucher' AND xv.external_guid = x.external_guid AND xv.deleted_at IS NULL)
    `);
    const pairs = await this.db.execute<{ voucher_id: string; document_id: string }>(sql`
      SELECT v.id AS voucher_id, d.id AS document_id
        FROM vouchers v
        JOIN sales_documents d
          ON d.org_id = v.org_id AND d.doc_type = 'SALES_ORDER' AND d.status = 'CONFIRMED' AND d.deleted_at IS NULL
         AND d.party_id = v.party_id
         AND v.narration ~ ('\\m' || d.number || '\\M')
       WHERE v.org_id = ${orgId} AND v.voucher_type = 'Sales' AND NOT v.is_cancelled
         AND NOT EXISTS (SELECT 1 FROM sales_order_invoices i WHERE i.voucher_id = v.id)
       LIMIT 200
    `);
    let linked = 0;
    for (const pair of pairs.rows) {
      if (await this.link(orgId, actorUserId, pair.document_id, pair.voucher_id, 'narration')) linked += 1;
    }
    return linked;
  }

  private async link(orgId: string, actorUserId: string | null, documentId: string, voucherId: string, method: 'narration' | 'manual'): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO sales_order_invoices (org_id, document_id, voucher_id, method, linked_by)
        SELECT ${orgId}, ${documentId}, v.id, ${method}, ${actorUserId}
          FROM vouchers v
         WHERE v.id = ${voucherId} AND v.org_id = ${orgId} AND v.voucher_type = 'Sales' AND NOT v.is_cancelled
        ON CONFLICT (voucher_id) DO NOTHING
        RETURNING id
      `);
      if (inserted.rows.length === 0) return false;
      // Item lines advance invoiced_qty, matched by stock item then by name,
      // never beyond what is packed; a voucher with no item lines covers all.
      const items = await tx.execute<{ stock_item_id: string | null; stock_item_name: string | null; qty: string }>(sql`
        SELECT stock_item_id, stock_item_name,
               COALESCE(NULLIF(substring(billed_qty from '^[0-9]+(?:\\.[0-9]+)?'), ''), '0') AS qty
          FROM voucher_lines WHERE voucher_id = ${voucherId} AND kind = 'inventory'
      `);
      if (items.rows.length === 0) {
        await tx.execute(sql`
          UPDATE sales_document_lines SET invoiced_qty = packed_qty, updated_at = now() WHERE document_id = ${documentId} AND deleted_at IS NULL
        `);
        return true;
      }
      for (const item of items.rows) {
        await tx.execute(sql`
          UPDATE sales_document_lines l
             SET invoiced_qty = LEAST(l.packed_qty, l.invoiced_qty + ${item.qty}::numeric), updated_at = now()
           WHERE l.id = (
             SELECT l2.id FROM sales_document_lines l2
              WHERE l2.document_id = ${documentId} AND l2.deleted_at IS NULL AND l2.packed_qty > l2.invoiced_qty
                AND (${item.stock_item_id === null ? sql`false` : sql`l2.stock_item_id = ${item.stock_item_id}`} OR l2.description = ${item.stock_item_name ?? ''})
              ORDER BY l2.line_no LIMIT 1
           )
        `);
      }
      return true;
    });
  }

  /** The order a pack or a slip belongs to, under the caller's view scope (self or all). */
  order(principal: Principal, documentId: string): Promise<SalesDocumentView> {
    const repository = new EstimateRepository(this.db, orgContextOf(principal), 'SALES_ORDER');
    const scope = this.scopes.resolve(principal, GRANTS, salesDocuments.ownerId).where;
    return repository.view(scope, documentId).then((order) => {
      if (order === null) throw AppError.notFound('Sales order', documentId);
      return order;
    });
  }
}
