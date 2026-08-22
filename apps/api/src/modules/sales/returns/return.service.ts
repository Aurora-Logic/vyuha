import { Injectable } from '@nestjs/common';
import {
  DEFAULT_RETURN_REASONS_POLICY,
  PERMISSIONS,
  pageSlice,
  paginated,
  returnReasonsPolicySchema,
  type CreateReturnInput,
  type DecideReplacementInput,
  type Paginated,
  type ReplacementCharge,
  type ReturnListQuery,
  type ReturnReasonsPolicy,
  type SalesReturnSummary,
  type SalesReturnView,
  type SetDispositionInput,
  type UnlinkedCreditNote,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AuditContext } from '../../../platform/audit/audit-context.js';
import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database, type Transaction } from '../../../platform/db/db.provider.js';
import { orgToday } from '../../../platform/documents/document-support.js';
import { FileService } from '../../../platform/files/file.service.js';
import { hasPermission, orgContextOf, type Principal } from '../../../platform/rbac/principal.js';
import { EstimateRepository } from '../estimates/estimate.repository.js';

/**
 * Area AK — sales returns (15 REQ-AK-01…AK-11).
 *
 * The GRN inverted. Goods come back to the desk, and what is recorded is
 * what the person holding them can see: how many, why, in what condition,
 * and whether they go back on the shelf or in the skip (REQ-AK-03, decided
 * here rather than later in someone's head). A photograph rides with it,
 * because a damage claim without one is an argument (REQ-AK-04).
 *
 * Two things this service deliberately does *not* do.
 *
 * **It raises no credit note** (REQ-AK-05, D-01). The receipt goes into
 * `awaiting_credit_note` and appears on the accountant's queue; the credit
 * note is Tally's, and links back by its narration or by a person choosing
 * — never guessed at from party and date (REQ-AK-06).
 *
 * **It moves no stock** (REQ-AK-07). A restocked line rises in Tally as a
 * consequence of that credit note and arrives here on the following pull.
 * A `restock` disposition is an instruction to the storeman, not a ledger
 * entry.
 */

/** REQ-AK-02: the organisation's list, read from settings; the six defaults until it edits them. */
export const SETTING_RETURN_REASONS = 'sales.return_reasons';

const PHOTO_KINDS = ['goods', 'packaging', 'document'] as const;
export type ReturnPhotoKind = (typeof PHOTO_KINDS)[number];
export type ReturnPhotos = Partial<Record<ReturnPhotoKind, readonly Buffer[]>>;

type ReturnRow = {
  id: string;
  number: string;
  state: SalesReturnView['state'];
  party_id: string | null;
  customer_name: string;
  source_document_id: string | null;
  source_number: string | null;
  dispatch_id: string | null;
  dispatch_number: string | null;
  received_on: string;
  received_by: string | null;
  received_by_name: string | null;
  notes: string | null;
  replacement_charge: ReplacementCharge | null;
  cancelled_reason: string | null;
  lines: SalesReturnView['lines'];
  attachments: SalesReturnView['attachments'];
  credit_note: SalesReturnView['creditNote'];
  replacement: SalesReturnView['replacement'];
};

@Injectable()
export class ReturnService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly files: FileService,
  ) {}

  /** REQ-AK-02: what the receipt screen offers, and what a submitted reason is checked against. */
  async reasons(orgId: string): Promise<ReturnReasonsPolicy> {
    const rows = await this.db.execute<{ value: unknown }>(sql`
      SELECT value FROM settings WHERE org_id = ${orgId} AND scope = 'ORG' AND key = ${SETTING_RETURN_REASONS} AND deleted_at IS NULL LIMIT 1
    `);
    const parsed = returnReasonsPolicySchema.safeParse(rows.rows[0]?.value);
    return parsed.success ? parsed.data : DEFAULT_RETURN_REASONS_POLICY;
  }

  async list(principal: Principal, query: ReturnListQuery): Promise<Paginated<SalesReturnSummary>> {
    const { limit, offset } = pageSlice(query);
    const where = this.filters(principal.orgId, query);
    const total = await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM sales_returns r WHERE ${where}`);
    const rows = await this.db.execute<{
      id: string; number: string; state: SalesReturnSummary['state']; party_id: string | null; customer_name: string; source_number: string | null;
      received_on: string; line_count: number; quantity: string; reasons: string[]; scrap_lines: number;
      replacement_charge: ReplacementCharge | null; replacement_number: string | null; credit_note_number: string | null;
    }>(sql`
      SELECT r.id, r.number, r.state, r.party_id, r.customer_name, d.number AS source_number, r.received_on::text AS received_on,
             (SELECT count(*)::int FROM sales_return_lines l WHERE l.return_id = r.id AND l.deleted_at IS NULL) AS line_count,
             COALESCE((SELECT sum(l.quantity) FROM sales_return_lines l WHERE l.return_id = r.id AND l.deleted_at IS NULL), 0)::text AS quantity,
             COALESCE((SELECT array_agg(DISTINCT l.reason) FROM sales_return_lines l WHERE l.return_id = r.id AND l.deleted_at IS NULL), ARRAY[]::text[]) AS reasons,
             (SELECT count(*)::int FROM sales_return_lines l WHERE l.return_id = r.id AND l.deleted_at IS NULL AND l.disposition = 'scrap') AS scrap_lines,
             r.replacement_charge,
             (SELECT rd.number FROM sales_documents rd WHERE rd.return_id = r.id AND rd.deleted_at IS NULL ORDER BY rd.created_at LIMIT 1) AS replacement_number,
             (SELECT v.voucher_number FROM sales_return_credit_notes cn JOIN vouchers v ON v.id = cn.voucher_id WHERE cn.return_id = r.id LIMIT 1) AS credit_note_number
        FROM sales_returns r
        LEFT JOIN sales_documents d ON d.id = r.source_document_id
       WHERE ${where}
       ORDER BY r.received_on DESC, r.number DESC
       LIMIT ${limit} OFFSET ${offset}
    `);
    return paginated(
      rows.rows.map((r) => ({
        id: r.id,
        number: r.number,
        state: r.state,
        partyId: r.party_id,
        customerName: r.customer_name,
        sourceNumber: r.source_number,
        receivedOn: r.received_on,
        lineCount: Number(r.line_count),
        quantity: r.quantity,
        reasons: r.reasons,
        scrapLines: Number(r.scrap_lines),
        replacementCharge: r.replacement_charge,
        replacementNumber: r.replacement_number,
        creditNoteNumber: r.credit_note_number,
      })),
      query,
      Number(total.rows[0]?.n ?? 0),
    );
  }

  async find(principal: Principal, id: string): Promise<SalesReturnView> {
    const view = await this.view(principal.orgId, id);
    if (view === null) throw AppError.notFound('Return', id);
    return view;
  }

  /**
   * REQ-AK-01…AK-04: the receipt. Lines that name a document line may not
   * return more than that line sent, less what has already come back —
   * otherwise a mistyped quantity becomes a credit note for goods that
   * never left.
   */
  async create(principal: Principal, input: CreateReturnInput, photos: ReturnPhotos): Promise<SalesReturnView> {
    const ctx = orgContextOf(principal);
    const allowed = await this.reasons(ctx.orgId);
    const known = new Set(allowed.reasons.map((r) => r.toLowerCase()));
    for (const [index, line] of input.lines.entries()) {
      if (!known.has(line.reason.toLowerCase())) {
        throw AppError.validation(`"${line.reason}" is not one of this organisation's return reasons.`, {
          fields: [{ path: `lines.${String(index)}.reason`, message: `one of: ${allowed.reasons.join(', ')}` }],
        });
      }
    }
    // REQ-AK-03/AK-11: scrap is a write-off. The key that decides it is
    // needed at the desk, not only when a disposition is changed later --
    // otherwise the whole check is one dropdown away from being nothing.
    if (input.lines.some((line) => line.disposition === 'scrap') && !hasPermission(principal, PERMISSIONS.RETURNS_DISPOSITION)) {
      throw AppError.forbidden('Recording a returned line as scrap needs returns.disposition; record it as restock and ask for the change.');
    }
    await this.assertWithinDispatched(ctx.orgId, input);

    const receivedOn = input.receivedOn ?? (await orgToday(this.db, ctx.orgId));
    const id = await this.db.transaction(async (tx) => {
      const number = await this.nextNumber(tx, ctx.orgId);
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO sales_returns (org_id, number, party_id, customer_name, source_document_id, dispatch_id, received_on, received_by, notes, created_by, updated_by)
        VALUES (${ctx.orgId}, ${number}, ${input.partyId ?? null}, ${input.customerName}, ${input.sourceDocumentId ?? null}, ${input.dispatchId ?? null},
                ${receivedOn}, ${principal.employeeId}, ${input.notes ?? null}, ${ctx.actorUserId}, ${ctx.actorUserId})
        RETURNING id
      `);
      const returnId = inserted.rows[0]?.id;
      if (returnId === undefined) throw new Error('Return insert returned no row.');
      for (const [index, line] of input.lines.entries()) {
        await tx.execute(sql`
          INSERT INTO sales_return_lines (org_id, return_id, line_no, source_line_id, stock_item_id, description, unit, quantity, reason, reason_note, condition, disposition, created_by, updated_by)
          VALUES (${ctx.orgId}, ${returnId}, ${index + 1}, ${line.lineId ?? null}, ${line.stockItemId ?? null}, ${line.description}, ${line.unit ?? null},
                  ${line.quantity}, ${line.reason}, ${line.reasonNote ?? null}, ${line.condition}, ${line.disposition}, ${ctx.actorUserId}, ${ctx.actorUserId})
        `);
      }
      // REQ-AK-04: the dispatch photograph pipeline, gallery allowed — a
      // return often arrives before anyone with a company phone sees it.
      for (const kind of PHOTO_KINDS) {
        for (const bytes of photos[kind] ?? []) {
          const stored = await this.files.storeImage({ orgId: ctx.orgId, uploadedBy: ctx.actorUserId, purpose: 'DISPATCH_PHOTO', bytes, pathSegments: [returnId] });
          await tx.execute(sql`
            INSERT INTO sales_return_attachments (org_id, return_id, file_id, kind, created_by, updated_by)
            VALUES (${ctx.orgId}, ${returnId}, ${stored.id}, ${kind}, ${ctx.actorUserId}, ${ctx.actorUserId})
          `);
        }
      }
      return returnId;
    });

    this.auditContext.record({
      action: 'sales.return.received',
      entityType: 'sales_return',
      entityId: id,
      before: null,
      after: {
        customerName: input.customerName,
        sourceDocumentId: input.sourceDocumentId ?? null,
        lines: input.lines.map((l) => ({ description: l.description, quantity: l.quantity, reason: l.reason, condition: l.condition, disposition: l.disposition })),
        photos: PHOTO_KINDS.reduce<Record<string, number>>((acc, kind) => ({ ...acc, [kind]: (photos[kind] ?? []).length }), {}),
      },
    });
    return this.find(principal, id);
  }

  /**
   * REQ-AK-03 / REQ-AK-11: changing a line to scrap is its own key, and the
   * change is reasoned — it is the decision that writes goods off, and the
   * receipt is the only place it is ever recorded.
   */
  async setDisposition(principal: Principal, returnId: string, input: SetDispositionInput): Promise<SalesReturnView> {
    if (!hasPermission(principal, PERMISSIONS.RETURNS_DISPOSITION)) throw AppError.forbidden('Deciding a returned line is scrap needs returns.disposition.');
    const existing = await this.find(principal, returnId);
    if (existing.state === 'cancelled') throw AppError.conflict(`${existing.number} was cancelled.`);
    const line = existing.lines.find((l) => l.id === input.lineId);
    if (line === undefined) throw AppError.notFound('Return line', input.lineId);
    if (line.disposition === input.disposition) throw AppError.conflict(`Line ${String(line.lineNo)} is already ${input.disposition}.`);
    await this.db.execute(sql`
      UPDATE sales_return_lines SET disposition = ${input.disposition}, reason_note = concat_ws(' · ', nullif(reason_note, ''), ${input.reason}::text), updated_at = now(), updated_by = ${principal.userId}
       WHERE id = ${input.lineId} AND return_id = ${returnId} AND org_id = ${principal.orgId}
    `);
    this.auditContext.record({
      action: 'sales.return.disposition_changed',
      entityType: 'sales_return',
      entityId: returnId,
      before: { lineId: input.lineId, disposition: line.disposition },
      after: { disposition: input.disposition, reason: input.reason, number: existing.number },
    });
    return this.find(principal, returnId);
  }

  /** A receipt written in error. The goods went back or never came; the record says which. */
  async cancel(principal: Principal, returnId: string, reason: string): Promise<SalesReturnView> {
    const existing = await this.find(principal, returnId);
    if (existing.state === 'credited') throw AppError.conflict(`${existing.number} has Tally's credit note against it; cancel that in Tally first.`);
    if (existing.state === 'cancelled') throw AppError.conflict(`${existing.number} is already cancelled.`);
    if (existing.replacement !== null) throw AppError.conflict(`${existing.number} has replacement ${existing.replacement.number} against it.`);
    await this.db.execute(sql`
      UPDATE sales_returns SET state = 'cancelled', cancelled_reason = ${reason}, updated_at = now(), updated_by = ${principal.userId}
       WHERE id = ${returnId} AND org_id = ${principal.orgId}
    `);
    this.auditContext.record({ action: 'sales.return.cancelled', entityType: 'sales_return', entityId: returnId, before: { state: existing.state }, after: { reason, number: existing.number } });
    return this.find(principal, returnId);
  }

  /** REQ-AK-05: the accountant's queue — received, and still waiting on Tally. */
  async awaitingCreditNote(principal: Principal): Promise<Paginated<SalesReturnSummary>> {
    return this.list(principal, { page: 1, pageSize: 100, state: 'awaiting_credit_note' });
  }

  /**
   * REQ-AK-06: Credit Notes with no return behind them, each with the
   * party's open returns beside it. The narration pass runs first, so a
   * credit note that names its return never reaches this screen.
   */
  async unlinkedCreditNotes(principal: Principal): Promise<UnlinkedCreditNote[]> {
    await this.linkByNarration(principal.orgId, principal.userId);
    const rows = await this.db.execute<{
      id: string; voucher_number: string; voucher_date: string; party_id: string | null; party_name: string; amount: string; narration: string | null;
      candidates: { returnId: string; number: string; receivedOn: string; quantity: string }[];
    }>(sql`
      SELECT v.id, v.voucher_number, v.voucher_date, v.party_id, v.party_name, v.amount::text AS amount, v.narration,
             COALESCE((
               SELECT json_agg(json_build_object('returnId', r.id, 'number', r.number, 'receivedOn', r.received_on::text,
                                                 'quantity', COALESCE((SELECT sum(l.quantity) FROM sales_return_lines l WHERE l.return_id = r.id AND l.deleted_at IS NULL), 0)::text)
                               ORDER BY r.received_on DESC)
                 FROM sales_returns r
                WHERE r.org_id = v.org_id AND r.state = 'awaiting_credit_note' AND r.deleted_at IS NULL AND r.party_id = v.party_id
             ), '[]'::json) AS candidates
        FROM vouchers v
       WHERE v.org_id = ${principal.orgId} AND v.voucher_type = 'Credit Note' AND NOT v.is_cancelled
         AND NOT EXISTS (SELECT 1 FROM sales_return_credit_notes cn WHERE cn.voucher_id = v.id)
         AND EXISTS (SELECT 1 FROM sales_returns r WHERE r.org_id = v.org_id AND r.deleted_at IS NULL)
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
      candidateReturns: r.candidates,
    }));
  }

  /** The manual half of REQ-AK-06. */
  async linkCreditNote(principal: Principal, returnId: string, voucherId: string): Promise<SalesReturnView> {
    const existing = await this.find(principal, returnId);
    if (existing.state === 'cancelled') throw AppError.conflict(`${existing.number} was cancelled.`);
    if (existing.creditNote !== null) throw AppError.conflict(`${existing.number} already has credit note ${existing.creditNote.voucherNumber} against it.`);
    const linked = await this.link(principal.orgId, principal.userId, returnId, voucherId, 'manual');
    if (!linked) throw AppError.conflict('That voucher is not an open Credit Note of this organisation, or is already linked to a return.');
    this.auditContext.record({ action: 'sales.return.credit_note_linked', entityType: 'sales_return', entityId: returnId, before: null, after: { voucherId, method: 'manual', number: existing.number } });
    return this.find(principal, returnId);
  }

  /**
   * REQ-AK-08/AK-09 / D-51: the replacement. It is an ordinary sales order
   * with the return's number on it, so it picks, packs, invoices and
   * dispatches through the one path everything else uses. What the decision
   * changes is a single mark on its lines: chargeable lines wait for an
   * invoice as REQ-AA-14 demands, free ones have no invoice to wait for and
   * say so on the line.
   */
  async decideReplacement(principal: Principal, returnId: string, input: DecideReplacementInput): Promise<SalesReturnView> {
    // A replacement raises a sales order, so it needs the key that raises
    // orders as well as the one that manages returns. Accounts holds the
    // second and not the first, deliberately: it decides and bills.
    if (!hasPermission(principal, PERMISSIONS.SALES_DOCUMENT_CREATE)) throw AppError.forbidden('Raising a replacement order needs sales.document.create.');
    const existing = await this.find(principal, returnId);
    if (existing.state === 'cancelled') throw AppError.conflict(`${existing.number} was cancelled.`);
    if (existing.replacement !== null) throw AppError.conflict(`${existing.number} already has replacement ${existing.replacement.number}.`);
    if (existing.partyId === null) throw AppError.conflict(`${existing.number} has no Tally party; a replacement order needs one.`);
    const requested = new Map((input.lines ?? []).map((l) => [l.lineId, Number(l.quantity)]));
    const wanted = existing.lines
      .map((line) => {
        const balance = Number(line.quantity) - Number(line.replacedQty);
        const quantity = requested.size === 0 ? balance : (requested.get(line.id) ?? 0);
        if (quantity > balance + 1e-9) {
          throw AppError.validation(`Line ${String(line.lineNo)} (${line.description}) has ${balance.toFixed(3)} returned and not yet replaced.`, { lineId: line.id });
        }
        return { line, quantity };
      })
      .filter((entry) => entry.quantity > 1e-9);
    if (wanted.length === 0) throw AppError.conflict(`${existing.number} has nothing left to replace.`);

    const ctx = orgContextOf(principal);
    const orders = new EstimateRepository(this.db, ctx, 'SALES_ORDER');
    const documentId = await orders.create(
      {
        date: await orgToday(this.db, ctx.orgId),
        validUntil: null,
        partyId: existing.partyId,
        companyId: null,
        dealId: null,
        returnId,
        customerName: existing.customerName,
        ownerId: principal.employeeId,
        notes: `Replacement for return ${existing.number}${input.charge === 'free' ? ' (free of charge)' : ''}.`,
        terms: null,
      },
      wanted.map(({ line, quantity }) => ({
        stockItemId: line.stockItemId ?? null,
        description: line.description,
        quantity: quantity.toFixed(3),
        unit: line.unit,
        // Free lines are written at zero and marked; chargeable ones leave
        // the rate blank so the price lists resolve it at today's date.
        ...(input.charge === 'free' ? { rate: '0' } : {}),
        discountPct: '0',
        taxPct: '0',
        freeOfCharge: input.charge === 'free',
      })),
    );
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE sales_returns SET replacement_charge = ${input.charge}, updated_at = now(), updated_by = ${ctx.actorUserId} WHERE id = ${returnId} AND org_id = ${ctx.orgId}`);
      for (const { line, quantity } of wanted) {
        await tx.execute(sql`UPDATE sales_return_lines SET replaced_qty = replaced_qty + ${quantity.toFixed(3)}::numeric, updated_at = now() WHERE id = ${line.id} AND return_id = ${returnId}`);
      }
    });
    this.auditContext.record({
      action: 'sales.return.replacement_raised',
      entityType: 'sales_return',
      entityId: returnId,
      before: null,
      after: { charge: input.charge, documentId, number: existing.number, lines: wanted.map((w) => ({ lineId: w.line.id, quantity: w.quantity.toFixed(3) })) },
    });
    return this.find(principal, returnId);
  }

  async attachmentUrl(principal: Principal, returnId: string, fileId: string): Promise<{ url: string; expiresInSeconds: number }> {
    const view = await this.find(principal, returnId);
    if (!view.attachments.some((a) => a.fileId === fileId)) throw AppError.notFound('Attachment', fileId);
    return this.files.signedUrlFor(principal, fileId);
  }

  // ---------------------------------------------------------------- helpers

  /**
   * A line against a Vyuha document may not send back more than that line
   * dispatched, counting every earlier return against it. Nothing is checked
   * for a free-typed line: the goods are in the room, and refusing to record
   * them because Vyuha never saw the invoice would lose the receipt.
   */
  private async assertWithinDispatched(orgId: string, input: CreateReturnInput): Promise<void> {
    // Summed per line before anything is asked of the database. One receipt
    // may name the same line twice for good reason -- two reasons, two
    // conditions, two dispositions -- and checking each entry on its own
    // against the same balance let every one of them pass while together they
    // sent back more than ever went out.
    const claimed = new Map<string, { quantity: number; index: number }>();
    for (const [index, line] of input.lines.entries()) {
      if (line.lineId == null) continue;
      const seen = claimed.get(line.lineId);
      claimed.set(line.lineId, { quantity: (seen?.quantity ?? 0) + Number(line.quantity), index: seen?.index ?? index });
    }
    for (const [lineId, { quantity, index }] of claimed) {
      const rows = await this.db.execute<{ dispatched: string; returned: string; line_no: number; description: string }>(sql`
        SELECT l.dispatched_qty::text AS dispatched, l.line_no, l.description,
               COALESCE((SELECT sum(rl.quantity) FROM sales_return_lines rl
                          JOIN sales_returns r ON r.id = rl.return_id AND r.state <> 'cancelled' AND r.deleted_at IS NULL
                         WHERE rl.source_line_id = l.id AND rl.deleted_at IS NULL), 0)::text AS returned
          FROM sales_document_lines l
          JOIN sales_documents d ON d.id = l.document_id AND d.org_id = ${orgId}
         WHERE l.id = ${lineId} AND l.deleted_at IS NULL
      `);
      const row = rows.rows[0];
      if (row === undefined) throw AppError.validation('A return line names a document line that is not this organisation’s.', { lineId });
      const balance = Number(row.dispatched) - Number(row.returned);
      if (quantity > balance + 1e-9) {
        throw AppError.validation(
          `Line ${String(row.line_no)} (${row.description}) sent ${row.dispatched} and has ${row.returned} already returned; ${quantity.toFixed(3)} cannot come back.`,
          { fields: [{ path: `lines.${String(index)}.quantity`, message: 'more than went out' }] },
        );
      }
    }
  }

  private filters(orgId: string, query: ReturnListQuery): SQL {
    return sql`r.org_id = ${orgId} AND r.deleted_at IS NULL
      ${query.state === undefined ? sql`` : sql`AND r.state = ${query.state}`}
      ${query.partyId === undefined ? sql`` : sql`AND r.party_id = ${query.partyId}`}
      ${query.from === undefined ? sql`` : sql`AND r.received_on >= ${query.from}::date`}
      ${query.to === undefined ? sql`` : sql`AND r.received_on <= ${query.to}::date`}
      ${query.stockItemId === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM sales_return_lines l WHERE l.return_id = r.id AND l.deleted_at IS NULL AND l.stock_item_id = ${query.stockItemId})`}
      ${query.reason === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM sales_return_lines l WHERE l.return_id = r.id AND l.deleted_at IS NULL AND lower(l.reason) = lower(${query.reason}))`}
      ${query.q === undefined ? sql`` : sql`AND (r.number ILIKE ${`%${query.q}%`} OR r.customer_name ILIKE ${`%${query.q}%`})`}`;
  }

  private async nextNumber(tx: Transaction, orgId: string): Promise<string> {
    await tx.execute(sql`INSERT INTO document_sequences (org_id, kind, last_number) VALUES (${orgId}, 'SALES_RETURN', 0) ON CONFLICT (org_id, kind) DO NOTHING`);
    const bumped = await tx.execute<{ last_number: number }>(sql`UPDATE document_sequences SET last_number = last_number + 1 WHERE org_id = ${orgId} AND kind = 'SALES_RETURN' RETURNING last_number`);
    return `RET-${String(bumped.rows[0]?.last_number ?? 0).padStart(4, '0')}`;
  }

  /**
   * REQ-AK-06, the automatic half: a Credit Note whose narration names a
   * return number for the same party links to it. The same shape D-21 uses
   * for Sales vouchers, because it is the same handshake.
   */
  private async linkByNarration(orgId: string, actorUserId: string | null): Promise<number> {
    const pairs = await this.db.execute<{ voucher_id: string; return_id: string }>(sql`
      SELECT v.id AS voucher_id, r.id AS return_id
        FROM vouchers v
        JOIN sales_returns r
          ON r.org_id = v.org_id AND r.state = 'awaiting_credit_note' AND r.deleted_at IS NULL
         AND r.party_id = v.party_id
         AND v.narration ~ ('\\m' || r.number || '\\M')
       WHERE v.org_id = ${orgId} AND v.voucher_type = 'Credit Note' AND NOT v.is_cancelled
         AND NOT EXISTS (SELECT 1 FROM sales_return_credit_notes cn WHERE cn.voucher_id = v.id)
       LIMIT 200
    `);
    let linked = 0;
    for (const pair of pairs.rows) {
      if (await this.link(orgId, actorUserId, pair.return_id, pair.voucher_id, 'narration')) linked += 1;
    }
    return linked;
  }

  private async link(orgId: string, actorUserId: string | null, returnId: string, voucherId: string, method: 'narration' | 'manual'): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO sales_return_credit_notes (org_id, return_id, voucher_id, method, linked_by)
        SELECT ${orgId}, ${returnId}, v.id, ${method}, ${actorUserId}
          FROM vouchers v
         WHERE v.id = ${voucherId} AND v.org_id = ${orgId} AND v.voucher_type = 'Credit Note' AND NOT v.is_cancelled
           AND EXISTS (SELECT 1 FROM sales_returns r WHERE r.id = ${returnId} AND r.org_id = ${orgId} AND r.state = 'awaiting_credit_note' AND r.deleted_at IS NULL)
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      if (inserted.rows.length === 0) return false;
      // REQ-AK-07: the state moves; no stock does. The credit note raised
      // the stock in Tally, and the next pull is where Vyuha learns of it.
      await tx.execute(sql`UPDATE sales_returns SET state = 'credited', updated_at = now(), updated_by = ${actorUserId} WHERE id = ${returnId} AND org_id = ${orgId}`);
      return true;
    });
  }

  private async view(orgId: string, id: string): Promise<SalesReturnView | null> {
    const rows = await this.db.execute<ReturnRow>(sql`
      SELECT r.id, r.number, r.state, r.party_id, r.customer_name, r.source_document_id, d.number AS source_number,
             r.dispatch_id, x.number AS dispatch_number, r.received_on::text AS received_on, r.received_by,
             nullif(concat_ws(' ', e.first_name, e.last_name), '') AS received_by_name, r.notes, r.replacement_charge, r.cancelled_reason,
             COALESCE((
               SELECT json_agg(json_build_object('id', l.id, 'lineNo', l.line_no, 'sourceLineId', l.source_line_id, 'stockItemId', l.stock_item_id,
                                                 'description', l.description, 'unit', l.unit, 'quantity', l.quantity::text, 'reason', l.reason,
                                                 'reasonNote', l.reason_note, 'condition', l.condition, 'disposition', l.disposition, 'replacedQty', l.replaced_qty::text)
                               ORDER BY l.line_no)
                 FROM sales_return_lines l WHERE l.return_id = r.id AND l.deleted_at IS NULL
             ), '[]'::json) AS lines,
             COALESCE((
               SELECT json_agg(json_build_object('id', a.id, 'fileId', a.file_id, 'kind', a.kind, 'uploadedAt', a.created_at) ORDER BY a.created_at)
                 FROM sales_return_attachments a WHERE a.return_id = r.id AND a.deleted_at IS NULL
             ), '[]'::json) AS attachments,
             (SELECT json_build_object('voucherId', v.id, 'voucherNumber', v.voucher_number, 'date', v.voucher_date::text, 'amount', v.amount::text,
                                       'method', cn.method, 'linkedAt', cn.linked_at)
                FROM sales_return_credit_notes cn JOIN vouchers v ON v.id = cn.voucher_id WHERE cn.return_id = r.id LIMIT 1) AS credit_note,
             (SELECT json_build_object('documentId', rd.id, 'number', rd.number, 'status', rd.status, 'grandTotal', rd.grand_total::text,
                                       'dispatchCount', (SELECT count(*)::int FROM dispatches dp WHERE dp.document_id = rd.id AND dp.deleted_at IS NULL))
                FROM sales_documents rd WHERE rd.return_id = r.id AND rd.deleted_at IS NULL ORDER BY rd.created_at LIMIT 1) AS replacement
        FROM sales_returns r
        LEFT JOIN sales_documents d ON d.id = r.source_document_id
        LEFT JOIN dispatches x ON x.id = r.dispatch_id
        LEFT JOIN employees e ON e.id = r.received_by
       WHERE r.org_id = ${orgId} AND r.id = ${id} AND r.deleted_at IS NULL
    `);
    const row = rows.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      number: row.number,
      state: row.state,
      partyId: row.party_id,
      customerName: row.customer_name,
      sourceDocumentId: row.source_document_id,
      sourceNumber: row.source_number,
      dispatchId: row.dispatch_id,
      dispatchNumber: row.dispatch_number,
      receivedOn: row.received_on,
      receivedById: row.received_by,
      receivedByName: row.received_by_name,
      notes: row.notes,
      replacementCharge: row.replacement_charge,
      cancelledReason: row.cancelled_reason,
      lines: row.lines,
      attachments: row.attachments.map((a) => ({ ...a, uploadedAt: new Date(a.uploadedAt).toISOString() })),
      creditNote: row.credit_note === null ? null : { ...row.credit_note, linkedAt: new Date(row.credit_note.linkedAt).toISOString() },
      replacement: row.replacement,
    };
  }
}
