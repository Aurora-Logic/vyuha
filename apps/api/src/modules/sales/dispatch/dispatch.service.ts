import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DISPATCH_MODE_LABELS,
  PERMISSIONS,
  PUSH_KIND_VOUCHER_TYPE,
  pageSlice,
  paginated,
  type CreateDispatchInput,
  type DeliverDispatchInput,
  type DispatchListQuery,
  type DispatchView,
  type Paginated,
  type SalesDocumentView,
  type VoucherPushPayload,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { AuditContext } from '../../../platform/audit/audit-context.js';
import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database, type Transaction } from '../../../platform/db/db.provider.js';
import { FileService } from '../../../platform/files/file.service.js';
import { CustomerNoticeService } from './customer-notice.service.js';
import { orgContextOf, type Principal } from '../../../platform/rbac/principal.js';
import { ScopeService } from '../../../platform/rbac/scope.service.js';
import { PushOutcomeRegistry, type PushMirror, type PushOutcome } from '../../../platform/sync/push-outcome.registry.js';
import { PushQueueService } from '../../../platform/sync/push-queue.service.js';
import { EstimateRepository } from '../estimates/estimate.repository.js';

/**
 * Dispatch (12 §3.4, §3.5). A dispatch is its own record with its own lines
 * (REQ-AA-16); its quantities advance `dispatched_qty` under the CHECK that
 * nothing leaves ahead of the invoice (REQ-AA-14: `dispatched ≤ invoiced`,
 * refused by the database and turned into a sentence here). Outstation
 * needs an LR and both photographs; the photographs go through the files
 * pipeline with the gallery allowed (REQ-AA-20/AA-21). It pushes as a
 * Delivery Note (REQ-AA-22) and composes the customer's notification for
 * the `manual` channel from day one (REQ-AA-24…AA-27).
 */

const GRANTS = { self: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF, all: PERMISSIONS.SALES_DOCUMENT_VIEW_ALL };

export interface DispatchPhotos {
  readonly box: readonly Buffer[];
  readonly lr: readonly Buffer[];
}

@Injectable()
export class DispatchService implements OnModuleInit {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly scopes: ScopeService,
    private readonly files: FileService,
    private readonly notices: CustomerNoticeService,
    private readonly pushQueue: PushQueueService,
    private readonly pushOutcomes: PushOutcomeRegistry,
  ) {}

  onModuleInit(): void {
    this.pushOutcomes.register({
      kind: 'DELIVERY_NOTE',
      onOutcome: (tx, orgId, payload, outcome) => this.applyOutcome(tx, orgId, payload, outcome),
      onMirror: (tx, orgId, documentId, mirror) => this.applyMirror(tx, orgId, documentId, mirror),
    });
  }

  /**
   * The Delivery Note came back on the pull. Its number is Tally's to give;
   * a cancellation there is Tally's own words on the record — the goods left,
   * and no quantity here is undone by an accountant's void.
   */
  private async applyMirror(tx: Transaction, orgId: string, documentId: string, mirror: PushMirror): Promise<void> {
    const before = await tx.execute<{ last_error: string | null; number: string }>(sql`
      SELECT last_error, number FROM dispatches WHERE org_id = ${orgId} AND id = ${documentId}
    `);
    await tx.execute(sql`
      UPDATE dispatches SET remote_voucher_number = COALESCE(${mirror.remoteVoucherNumber}, remote_voucher_number), remote_guid = ${mirror.remoteGuid},
                            last_error = ${mirror.isCancelled ? 'Cancelled in Tally' : null}, updated_at = now()
       WHERE org_id = ${orgId} AND id = ${documentId}
    `);
    // The goods left the door either way; the void is Tally's word about the
    // books, and it used to arrive silently. One audit row, on the pull that
    // learned of it, not on every pull that repeats it.
    if (mirror.isCancelled && before.rows[0] !== undefined && before.rows[0].last_error !== 'Cancelled in Tally') {
      this.auditContext.record({ action: 'sales.dispatch.cancelled_in_tally', entityType: 'dispatch', entityId: documentId, before: null, after: { number: before.rows[0].number, remoteGuid: mirror.remoteGuid } });
    }
  }

  async list(principal: Principal, query: DispatchListQuery & { delivered?: 'yes' | 'no' }): Promise<Paginated<DispatchView>> {
    const scope = this.scopes.resolve(principal, GRANTS, sql`d.owner_id`).where;
    const { limit, offset } = pageSlice(query);
    const where = sql`x.org_id = ${principal.orgId} AND x.deleted_at IS NULL AND ${scope}
      ${query.documentId === undefined ? sql`` : sql`AND x.document_id = ${query.documentId}`}
      ${query.mode === undefined ? sql`` : sql`AND x.mode = ${query.mode}`}
      ${query.syncState === undefined ? sql`` : sql`AND x.sync_state = ${query.syncState}`}
      ${query.delivered === undefined ? sql`` : query.delivered === 'yes' ? sql`AND x.delivered_at IS NOT NULL` : sql`AND x.delivered_at IS NULL`}
      ${query.q === undefined ? sql`` : sql`AND (x.number ILIKE ${`%${query.q}%`} OR d.number ILIKE ${`%${query.q}%`} OR d.customer_name ILIKE ${`%${query.q}%`} OR x.lr_number ILIKE ${`%${query.q}%`})`}`;
    const ids = await this.db.execute<{ id: string }>(sql`
      SELECT x.id FROM dispatches x JOIN sales_documents d ON d.id = x.document_id WHERE ${where}
      ORDER BY x.dispatched_at DESC LIMIT ${limit} OFFSET ${offset}
    `);
    const total = await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM dispatches x JOIN sales_documents d ON d.id = x.document_id WHERE ${where}`);
    const rows = await Promise.all(ids.rows.map((r) => this.view(principal.orgId, r.id)));
    return paginated(rows.filter((r): r is DispatchView => r !== null), query, Number(total.rows[0]?.n ?? 0));
  }

  async find(principal: Principal, id: string): Promise<DispatchView> {
    const dispatch = await this.view(principal.orgId, id);
    if (dispatch === null) throw AppError.notFound('Dispatch', id);
    // Visibility follows the order's.
    await this.order(principal, dispatch.documentId);
    return dispatch;
  }

  /**
   * One dispatch: lines within the invoiced balance, mode fields as the
   * schema demands, photographs as REQ-AA-20 demands, then the Delivery Note
   * queued and the notification composed.
   */
  async create(principal: Principal, documentId: string, input: CreateDispatchInput, photos: DispatchPhotos): Promise<DispatchView> {
    const order = await this.order(principal, documentId);
    if (order.status !== 'CONFIRMED') throw AppError.conflict(`${order.number} is ${order.status.toLowerCase()}; only a confirmed order dispatches.`);
    if (order.shortClosedAt !== null) throw AppError.conflict(`${order.number} was short-closed.`);
    if (input.mode === 'outstation') {
      const missing: { path: string; message: string }[] = [];
      if (photos.box.length === 0) missing.push({ path: 'box', message: 'a photograph of the packed boxes is required for outstation' });
      if (photos.lr.length === 0) missing.push({ path: 'lr', message: 'a photograph of the LR is required for outstation' });
      if (missing.length > 0) throw AppError.validation('An outstation dispatch needs its photographs.', { fields: missing });
    }
    const byId = new Map(order.lines.map((line) => [line.id, line]));
    for (const [index, entry] of input.lines.entries()) {
      const line = byId.get(entry.lineId);
      if (line === undefined) throw AppError.validation('A dispatch line names a line that is not on this order.', { lineId: entry.lineId });
      // 15 REQ-AK-09: a free replacement line has no invoice to wait for, so
      // what limits it is what was packed. The database's CHECK reads the
      // same mark; this is only the sentence in front of it.
      const invoicedBalance = (line.freeOfCharge ? Number(line.packedQty) : Number(line.invoicedQty)) - Number(line.dispatchedQty);
      if (Number(entry.quantity) > invoicedBalance + 1e-9) {
        if (line.freeOfCharge) {
          throw AppError.validation(
            `Line ${String(line.lineNo)} (${line.description}) has ${invoicedBalance.toFixed(3)} packed and not yet dispatched.`,
            { fields: [{ path: `lines.${String(index)}.quantity`, message: 'exceeds the packed balance' }] },
          );
        }
        // REQ-AA-14: goods do not leave ahead of the paperwork.
        throw AppError.validation(
          `Line ${String(line.lineNo)} (${line.description}) has ${invoicedBalance.toFixed(3)} invoiced and not yet dispatched; ${entry.quantity} cannot leave until an invoice covers it.`,
          { fields: [{ path: `lines.${String(index)}.quantity`, message: 'exceeds the invoiced balance' }] },
        );
      }
    }

    const ctx = orgContextOf(principal);
    const dispatchId = await this.db.transaction(async (tx) => {
      const number = await this.nextNumber(tx, ctx.orgId);
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO dispatches (org_id, document_id, number, mode, dispatched_by, lr_number, transporter_name, transporter_contact, vehicle_number, driver_name, expected_delivery_date, notes, created_by, updated_by)
        VALUES (${ctx.orgId}, ${documentId}, ${number}, ${input.mode}, ${principal.employeeId}, ${input.lrNumber ?? null}, ${input.transporterName ?? null}, ${input.transporterContact ?? null},
                ${input.vehicleNumber ?? null}, ${input.driverName ?? null}, ${input.expectedDeliveryDate ?? null}, ${input.notes ?? null}, ${ctx.actorUserId}, ${ctx.actorUserId})
        RETURNING id
      `);
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error('Dispatch insert returned no row.');
      for (const entry of input.lines) {
        await tx.execute(sql`INSERT INTO dispatch_lines (org_id, dispatch_id, line_id, quantity, created_by, updated_by) VALUES (${ctx.orgId}, ${id}, ${entry.lineId}, ${entry.quantity}, ${ctx.actorUserId}, ${ctx.actorUserId})`);
        await tx.execute(sql`UPDATE sales_document_lines SET dispatched_qty = dispatched_qty + ${entry.quantity}::numeric, updated_at = now() WHERE id = ${entry.lineId} AND document_id = ${documentId}`);
      }
      // REQ-AA-20/AA-21: the punch pipeline, gallery allowed, no stamp — an LR is a document.
      for (const [kind, buffers] of [['box', photos.box], ['lr', photos.lr]] as const) {
        for (const bytes of buffers) {
          const stored = await this.files.storeImage({ orgId: ctx.orgId, uploadedBy: ctx.actorUserId, purpose: 'DISPATCH_PHOTO', bytes, pathSegments: [id] });
          await tx.execute(sql`INSERT INTO dispatch_attachments (org_id, dispatch_id, file_id, kind, created_by, updated_by) VALUES (${ctx.orgId}, ${id}, ${stored.id}, ${kind}, ${ctx.actorUserId}, ${ctx.actorUserId})`);
        }
      }
      // REQ-AA-28: the order's contact overrides the party's; this dispatch's overrides both.
      const email = input.customerEmail ?? order.customerEmail;
      const whatsapp = input.customerWhatsapp ?? order.customerWhatsapp;
      const text = this.compose(order, number, input, byId);
      for (const [channel, recipient] of [['email', email], ['whatsapp', whatsapp]] as const) {
        await tx.execute(sql`
          INSERT INTO dispatch_notifications (org_id, dispatch_id, channel, event, recipient, status, composed_text, created_by, updated_by)
          VALUES (${ctx.orgId}, ${id}, ${channel}, 'dispatched', ${recipient ?? null}, 'pending', ${text}, ${ctx.actorUserId}, ${ctx.actorUserId})
        `);
      }
      return id;
    });

    await this.enqueuePush(principal, dispatchId);
    this.auditContext.record({
      action: 'sales.dispatch.created',
      entityType: 'dispatch',
      entityId: dispatchId,
      before: null,
      after: { documentId, mode: input.mode, lines: input.lines, lrNumber: input.lrNumber ?? null, photos: { box: photos.box.length, lr: photos.lr.length } },
    });
    const view = await this.view(principal.orgId, dispatchId);
    if (view === null) throw new Error('Dispatch vanished after insert.');
    // D-47: the email goes by itself; the view is re-read so the caller sees sent or failed.
    await this.notices.send(principal.orgId, view, 'dispatched', null);
    return (await this.view(principal.orgId, dispatchId)) ?? view;
  }

  /** REQ-AA-26: the person sent it (or could not); the record says so. */
  /**
   * D-47: the door step. Marks the dispatch delivered with who received it
   * and the photograph taken there, then composes the delivered notice for
   * the same recipients the dispatch notice had. Once; a second call is a
   * conflict, not a silent overwrite of the proof.
   */
  async deliver(principal: Principal, dispatchId: string, input: DeliverDispatchInput, photos: readonly Buffer[]): Promise<DispatchView> {
    const existing = await this.view(principal.orgId, dispatchId);
    if (existing === null) throw AppError.notFound('Dispatch', dispatchId);
    await this.order(principal, existing.documentId);
    if (existing.deliveredAt !== null) throw AppError.conflict(`${existing.number} was already marked delivered.`);
    if (photos.length === 0) {
      throw AppError.validation('A delivery needs its photograph.', { fields: [{ path: 'photo', message: 'a photograph at the door is required' }] });
    }
    const ctx = orgContextOf(principal);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE dispatches SET delivered_at = now(), delivered_by = ${ctx.actorUserId}, received_by = ${input.receivedBy}, delivery_note = ${input.note ?? null}, updated_at = now(), updated_by = ${ctx.actorUserId}
         WHERE id = ${dispatchId} AND org_id = ${ctx.orgId}
      `);
      for (const bytes of photos) {
        const stored = await this.files.storeImage({ orgId: ctx.orgId, uploadedBy: ctx.actorUserId, purpose: 'DISPATCH_PHOTO', bytes, pathSegments: [dispatchId] });
        await tx.execute(sql`INSERT INTO dispatch_attachments (org_id, dispatch_id, file_id, kind, created_by, updated_by) VALUES (${ctx.orgId}, ${dispatchId}, ${stored.id}, 'delivery', ${ctx.actorUserId}, ${ctx.actorUserId})`);
      }
      const text = this.composeDelivered(existing, input.receivedBy);
      for (const channel of ['email', 'whatsapp'] as const) {
        const recipient = existing.notifications.find((n) => n.channel === channel)?.recipient ?? null;
        await tx.execute(sql`
          INSERT INTO dispatch_notifications (org_id, dispatch_id, channel, event, recipient, status, composed_text, created_by, updated_by)
          VALUES (${ctx.orgId}, ${dispatchId}, ${channel}, 'delivered', ${recipient}, 'pending', ${text}, ${ctx.actorUserId}, ${ctx.actorUserId})
        `);
      }
    });
    this.auditContext.record({
      action: 'sales.dispatch.delivered',
      entityType: 'dispatch',
      entityId: dispatchId,
      before: { deliveredAt: null },
      after: { receivedBy: input.receivedBy, note: input.note ?? null, photos: photos.length },
    });
    const view = await this.view(principal.orgId, dispatchId);
    if (view === null) throw new Error('Dispatch vanished after delivery.');
    await this.notices.send(principal.orgId, view, 'delivered', null);
    return (await this.view(principal.orgId, dispatchId)) ?? view;
  }

  private composeDelivered(dispatch: DispatchView, receivedBy: string): string {
    const lines = dispatch.lines.map((line) => `- ${line.description}: ${line.quantity}${line.unit ? ` ${line.unit}` : ''}`);
    return [
      `Dear ${dispatch.customerName},`,
      `Your order ${dispatch.orderNumber} (${dispatch.number}) has been delivered and received by ${receivedBy}.`,
      '',
      ...lines,
      '',
      'If anything is short or damaged, please reply within two working days quoting the dispatch number.',
    ].join('\n');
  }

  async markNotification(principal: Principal, dispatchId: string, notificationId: string, status: 'sent' | 'failed', error: string | null): Promise<DispatchView> {
    const dispatch = await this.find(principal, dispatchId);
    const rows = await this.db.execute<{ id: string }>(sql`
      UPDATE dispatch_notifications SET status = ${status}, sent_at = ${status === 'sent' ? sql`now()` : sql`NULL`}, sent_by = ${principal.userId}, error = ${error}, updated_at = now(), updated_by = ${principal.userId}
       WHERE id = ${notificationId} AND dispatch_id = ${dispatchId} AND org_id = ${principal.orgId}
      RETURNING id
    `);
    if (rows.rows.length === 0) throw AppError.notFound('Notification', notificationId);
    this.auditContext.record({ action: `sales.dispatch.notification_${status}`, entityType: 'dispatch', entityId: dispatchId, before: null, after: { notificationId, number: dispatch.number } });
    const view = await this.view(principal.orgId, dispatchId);
    if (view === null) throw AppError.notFound('Dispatch', dispatchId);
    return view;
  }

  async push(principal: Principal, dispatchId: string): Promise<DispatchView> {
    const dispatch = await this.find(principal, dispatchId);
    if (dispatch.syncState === 'PUSHED') throw AppError.conflict(`${dispatch.number} is already in Tally.`);
    if (dispatch.syncState === 'QUEUED') throw AppError.conflict(`${dispatch.number} is already queued.`);
    const queued = await this.enqueuePush(principal, dispatchId);
    if (!queued) throw AppError.conflict('No Tally connection can carry a push: an agent connection with a bound company and an issued token is needed.');
    const view = await this.view(principal.orgId, dispatchId);
    if (view === null) throw AppError.notFound('Dispatch', dispatchId);
    return view;
  }

  /** A signed URL for one photograph, through the files policy (DISPATCH_PHOTO). */
  async attachmentUrl(principal: Principal, dispatchId: string, fileId: string): Promise<{ url: string; expiresInSeconds: number }> {
    const dispatch = await this.find(principal, dispatchId);
    if (!dispatch.attachments.some((a) => a.fileId === fileId)) throw AppError.notFound('Attachment', fileId);
    return this.files.signedUrlFor(principal, fileId);
  }

  // ---------------------------------------------------------------- helpers

  /**
   * REQ-AA-24: what the customer is told — reference, invoice, what went,
   * what remains, how it travels, and where the photographs are (signed
   * links, minted when the message is opened for sending).
   */
  private compose(order: SalesDocumentView, number: string, input: CreateDispatchInput, byId: Map<string, SalesDocumentView['lines'][number]>): string {
    const lines = input.lines.map((entry) => {
      const line = byId.get(entry.lineId);
      return `- ${line?.description ?? entry.lineId}: ${entry.quantity}${line?.unit ? ` ${line.unit}` : ''}`;
    });
    const balance = order.lines
      .map((line) => {
        const sent = input.lines.find((e) => e.lineId === line.id);
        const remaining = Number(line.quantity) - Number(line.dispatchedQty) - Number(sent?.quantity ?? 0);
        // The way a person writes it: 40, not 40.000; 2.5, not 2.500.
        return remaining > 1e-9 ? `- ${line.description}: ${String(Number(remaining.toFixed(3)))}${line.unit ? ` ${line.unit}` : ''} to follow` : null;
      })
      .filter((s): s is string => s !== null);
    const invoices = order.invoices.map((i) => i.voucherNumber).join(', ');
    const transport =
      input.mode === 'outstation'
        ? `By ${input.transporterName ?? 'transporter'}, LR ${input.lrNumber ?? ''}${input.vehicleNumber ? `, vehicle ${input.vehicleNumber}` : ''}${input.expectedDeliveryDate ? `, expected ${input.expectedDeliveryDate}` : ''}`
        : input.mode === 'local_own_vehicle'
          ? `Our vehicle ${input.vehicleNumber ?? ''} with ${input.driverName ?? ''}`
          : input.mode === 'customer_collects'
            ? 'Packed and ready to collect at our counter — show the packing slip barcode'
            : 'Local delivery by auto';
    return [
      `Dear ${order.customerName},`,
      `Your order ${order.number}${invoices ? ` (invoice ${invoices})` : ''} has been dispatched (${number}, ${DISPATCH_MODE_LABELS[input.mode]}).`,
      'Sent today:',
      ...lines,
      ...(balance.length > 0 ? ['Balance:', ...balance] : ['This completes the order.']),
      transport,
      ...(input.notes ? [input.notes] : []),
      'Photographs are attached where applicable.',
    ].join('\n');
  }

  private async enqueuePush(principal: Principal, dispatchId: string): Promise<boolean> {
    const dispatch = await this.view(principal.orgId, dispatchId);
    if (dispatch === null) return false;
    const payload: VoucherPushPayload = {
      documentId: dispatch.id,
      kind: 'DELIVERY_NOTE',
      voucherType: PUSH_KIND_VOUCHER_TYPE.DELIVERY_NOTE,
      reference: dispatch.number,
      date: dispatch.dispatchedAt.slice(0, 10),
      partyName: dispatch.customerName,
      narration: `${dispatch.orderNumber}${dispatch.lrNumber ? ` LR ${dispatch.lrNumber}` : ''}\nvyuha:${dispatch.number}:${dispatch.id}`,
      idempotencyKey: `vyuha:${dispatch.id}`,
      remoteGuid: null,
      lines: dispatch.lines.map((line) => ({ stockItemName: line.description, quantity: line.quantity, unit: line.unit, rate: '0', discountPct: '0', amount: '0' })),
    };
    // The order names the party, and the party names the Tally company this
    // voucher belongs in.
    const owner = await this.db.execute<{ party_id: string | null }>(
      sql`SELECT party_id FROM sales_documents WHERE id = ${dispatch.documentId} AND org_id = ${principal.orgId}`,
    );
    const jobId = await this.pushQueue.enqueue(principal.orgId, principal.userId, payload, owner.rows[0]?.party_id ?? null);
    await this.db.execute(sql`
      UPDATE dispatches SET sync_state = ${jobId === null ? 'NOT_PUSHED' : 'QUEUED'}, push_job_id = ${jobId}, last_error = NULL, updated_at = now() WHERE id = ${dispatchId}
    `);
    return jobId !== null;
  }

  private async applyOutcome(tx: Transaction, orgId: string, payload: VoucherPushPayload, outcome: PushOutcome): Promise<void> {
    if (outcome.outcome === 'rejected') {
      await tx.execute(sql`UPDATE dispatches SET sync_state = 'FAILED', last_error = ${outcome.errorText}, updated_at = now() WHERE org_id = ${orgId} AND id = ${payload.documentId}`);
      return;
    }
    await tx.execute(sql`
      UPDATE dispatches SET sync_state = 'PUSHED', remote_guid = ${outcome.remoteGuid}, remote_voucher_number = ${outcome.remoteVoucherNumber}, last_pushed_at = now(), last_error = NULL, updated_at = now()
       WHERE org_id = ${orgId} AND id = ${payload.documentId}
    `);
  }

  private async nextNumber(tx: Transaction, orgId: string): Promise<string> {
    await tx.execute(sql`INSERT INTO document_sequences (org_id, kind, last_number) VALUES (${orgId}, 'DISPATCH', 0) ON CONFLICT (org_id, kind) DO NOTHING`);
    const bumped = await tx.execute<{ last_number: number }>(sql`UPDATE document_sequences SET last_number = last_number + 1 WHERE org_id = ${orgId} AND kind = 'DISPATCH' RETURNING last_number`);
    return `DN-${String(bumped.rows[0]?.last_number ?? 0).padStart(4, '0')}`;
  }

  private async view(orgId: string, id: string): Promise<DispatchView | null> {
    const rows = await this.db.execute<{
      id: string; number: string; document_id: string; order_number: string; customer_name: string; mode: DispatchView['mode']; dispatched_by: string | null; dispatched_by_name: string | null;
      dispatched_at: Date; lr_number: string | null; transporter_name: string | null; transporter_contact: string | null; vehicle_number: string | null; driver_name: string | null;
      expected_delivery_date: string | null; notes: string | null; sync_state: DispatchView['syncState']; remote_guid: string | null; remote_voucher_number: string | null; last_error: string | null;
      delivered_at: Date | null; delivered_by_name: string | null; received_by: string | null; delivery_note: string | null;
      lines: DispatchView['lines']; attachments: DispatchView['attachments']; notifications: DispatchView['notifications'];
    }>(sql`
      SELECT x.id, x.number, x.document_id, d.number AS order_number, d.customer_name, x.mode, x.dispatched_by,
             CASE WHEN e.id IS NULL THEN NULL ELSE concat_ws(' ', e.first_name, e.last_name) END AS dispatched_by_name,
             x.dispatched_at, x.lr_number, x.transporter_name, x.transporter_contact, x.vehicle_number, x.driver_name, x.expected_delivery_date, x.notes,
             x.sync_state, x.remote_guid, x.remote_voucher_number, x.last_error,
             x.delivered_at, x.received_by, x.delivery_note,
             (SELECT concat_ws(' ', de.first_name, de.last_name) FROM users du LEFT JOIN employees de ON de.id = du.employee_id WHERE du.id = x.delivered_by) AS delivered_by_name,
             COALESCE((SELECT json_agg(json_build_object('lineId', dl.line_id, 'description', l.description, 'quantity', dl.quantity::text, 'unit', l.unit) ORDER BY l.line_no)
                         FROM dispatch_lines dl JOIN sales_document_lines l ON l.id = dl.line_id WHERE dl.dispatch_id = x.id), '[]'::json) AS lines,
             COALESCE((SELECT json_agg(json_build_object('fileId', a.file_id, 'kind', a.kind) ORDER BY a.created_at) FROM dispatch_attachments a WHERE a.dispatch_id = x.id AND a.deleted_at IS NULL), '[]'::json) AS attachments,
             COALESCE((SELECT json_agg(json_build_object('id', n.id, 'channel', n.channel, 'event', n.event, 'recipient', n.recipient, 'status', n.status, 'composedText', n.composed_text, 'sentAt', n.sent_at, 'error', n.error) ORDER BY n.created_at, n.channel)
                         FROM dispatch_notifications n WHERE n.dispatch_id = x.id AND n.deleted_at IS NULL), '[]'::json) AS notifications
        FROM dispatches x JOIN sales_documents d ON d.id = x.document_id LEFT JOIN employees e ON e.id = x.dispatched_by
       WHERE x.org_id = ${orgId} AND x.id = ${id} AND x.deleted_at IS NULL
    `);
    const r = rows.rows[0];
    if (r === undefined) return null;
    return {
      id: r.id,
      number: r.number,
      documentId: r.document_id,
      orderNumber: r.order_number,
      customerName: r.customer_name,
      mode: r.mode,
      dispatchedById: r.dispatched_by,
      dispatchedByName: r.dispatched_by_name,
      dispatchedAt: new Date(r.dispatched_at).toISOString(),
      lrNumber: r.lr_number,
      transporterName: r.transporter_name,
      transporterContact: r.transporter_contact,
      vehicleNumber: r.vehicle_number,
      driverName: r.driver_name,
      expectedDeliveryDate: r.expected_delivery_date,
      notes: r.notes,
      status: r.delivered_at === null ? 'shipped' : 'delivered',
      deliveredAt: r.delivered_at === null ? null : new Date(r.delivered_at).toISOString(),
      deliveredByName: r.delivered_by_name === null || r.delivered_by_name === '' ? null : r.delivered_by_name,
      receivedBy: r.received_by,
      deliveryNote: r.delivery_note,
      syncState: r.sync_state,
      remoteGuid: r.remote_guid,
      remoteVoucherNumber: r.remote_voucher_number,
      lastError: r.last_error,
      lines: r.lines,
      attachments: r.attachments,
      notifications: r.notifications.map((n) => ({ ...n, sentAt: n.sentAt === null ? null : new Date(n.sentAt).toISOString() })),
    };
  }

  private order(principal: Principal, documentId: string): Promise<SalesDocumentView> {
    const repository = new EstimateRepository(this.db, orgContextOf(principal), 'SALES_ORDER');
    const scope = this.scopes.resolve(principal, GRANTS, sql`"sales_documents"."owner_id"`).where;
    return repository.view(scope, documentId).then((order) => {
      if (order === null) throw AppError.notFound('Sales order', documentId);
      return order;
    });
  }
}
