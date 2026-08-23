import {
  FULFILMENT_STATES,
  SALES_DOCUMENT_TYPE_PREFIX,
  type DocumentDetails,
  type DocumentSyncState,
  type EstimateStatus,
  type EstimateSummary,
  type EstimateView,
  type ItemHistoryEntry,
  type SalesDocumentType,
  type SalesLineInput,
  type SalesLineView,
  type ShipTo,
  type SortTerm,
} from '@vyuha/shared';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';

import type { Database, Transaction } from '../../../platform/db/db.provider.js';
import { resolveRate } from '../../../platform/pricing/pricing-resolver.js';
import { employees, stockItems, voucherLines, vouchers } from '../../../platform/db/schema/index.js';
import { ScopedRepository, type OrgContext } from '../../../platform/db/scoped-repository.js';
import { masterOrderBy, masterSearch } from '../../../platform/org/master-query.js';
import { salesDocumentLines, salesDocumentSequences, salesDocuments } from '../schema/index.js';

/**
 * Estimates (REQ-W-01, W-02). Lines are replaced wholesale on save, in one
 * transaction with the header's totals — the voucher writer's approach, for
 * the same reason: a partial line set is worse than an old one.
 *
 * Arithmetic happens here, in SQL, on numeric columns: `amount = quantity ×
 * rate × (1 − discount/100)`, `tax = amount × tax/100`, each rounded to two
 * places once. The API returns the results as text and the client never
 * re-derives them.
 */

const owner = alias(employees, 'estimate_owner');

const ownerName = (person: { id: PgColumn; firstName: PgColumn; lastName: PgColumn }): SQL<string | null> =>
  sql<string | null>`CASE WHEN ${person.id} IS NULL THEN NULL ELSE concat_ws(' ', ${person.firstName}, ${person.lastName}) END`;

const SORT_COLUMNS = {
  number: salesDocuments.number,
  date: salesDocuments.date,
  grandTotal: salesDocuments.grandTotal,
  customerName: salesDocuments.customerName,
  updatedAt: salesDocuments.updatedAt,
} as const;

export interface EstimateListFilters {
  readonly q?: string | undefined;
  readonly status?: string | undefined;
  readonly syncState?: DocumentSyncState | undefined;
  readonly partyId?: string | undefined;
  readonly companyId?: string | undefined;
  readonly dealId?: string | undefined;
  readonly ownerId?: string | undefined;
  /** The order an invoice was raised from. */
  readonly sourceDocumentId?: string | undefined;
  readonly sort: readonly SortTerm[];
  readonly limit: number;
  readonly offset: number;
}

/**
 * What the repository writes, which is the request contract plus one field
 * no request may carry: 15 REQ-AK-09's free-of-charge mark, set by the
 * return that raises a replacement and by nothing else.
 */
export type RepositoryLineInput = SalesLineInput & { readonly freeOfCharge?: boolean };

export interface EstimateHeaderInput {
  /** Only on create; the estimate's DRAFT or an order's DRAFT. */
  status?: EstimateStatus | 'PENDING_APPROVAL' | 'CONFIRMED' | 'CANCELLED';
  sourceDocumentId?: string | null;
  /** 15 REQ-AK-08: the return this order replaces, when it is a replacement. */
  returnId?: string | null;
  date: string;
  validUntil: string | null;
  partyId: string | null;
  companyId: string | null;
  dealId: string | null;
  customerName: string;
  ownerId: string | null;
  notes: string | null;
  terms: string | null;
  /** REQ-AA-28: the customer's contact for notifications; the party master's by default. */
  customerEmail?: string | null;
  customerWhatsapp?: string | null;
  placeOfSupply?: string | null;
  shipTo?: ShipTo | null;
  details?: DocumentDetails | null;
}

export class EstimateRepository extends ScopedRepository<typeof salesDocuments> {
  constructor(
    db: Database,
    ctx: OrgContext,
    /** Which life the rows lead; one repository class, one table, one line editor. */
    private readonly docType: SalesDocumentType = 'ESTIMATE',
  ) {
    super(db, salesDocuments, ctx);
  }

  private headerSelection() {
    return {
      id: salesDocuments.id,
      docType: salesDocuments.docType,
      number: salesDocuments.number,
      status: salesDocuments.status,
      date: salesDocuments.date,
      validUntil: salesDocuments.validUntil,
      partyId: salesDocuments.partyId,
      companyId: salesDocuments.companyId,
      dealId: salesDocuments.dealId,
      customerName: salesDocuments.customerName,
      ownerId: salesDocuments.ownerId,
      ownerName: ownerName(owner),
      notes: salesDocuments.notes,
      terms: salesDocuments.terms,
      subtotal: salesDocuments.subtotal,
      discountTotal: salesDocuments.discountTotal,
      taxTotal: salesDocuments.taxTotal,
      grandTotal: salesDocuments.grandTotal,
      sourceDocumentId: salesDocuments.sourceDocumentId,
      syncState: salesDocuments.syncState,
      remoteGuid: salesDocuments.remoteGuid,
      remoteVoucherNumber: salesDocuments.remoteVoucherNumber,
      lastPushedAt: salesDocuments.lastPushedAt,
      lastError: salesDocuments.lastError,
      shortClosedAt: salesDocuments.shortClosedAt,
      shortCloseReason: salesDocuments.shortCloseReason,
      customerEmail: salesDocuments.customerEmail,
      customerWhatsapp: salesDocuments.customerWhatsapp,
      placeOfSupply: salesDocuments.placeOfSupply,
      shipTo: salesDocuments.shipTo,
      details: salesDocuments.details,
      // REQ-AA-02/AA-03 (+ D-34): the word derived from the lines, here and
      // nowhere else, so no column can disagree with them.
      fulfilment: sql<string | null>`CASE
        WHEN ${salesDocuments.docType} <> 'SALES_ORDER' THEN NULL
        WHEN ${salesDocuments.shortClosedAt} IS NOT NULL THEN 'short_closed'
        ELSE (
          SELECT CASE
            WHEN count(*) = 0 THEN 'open'
            WHEN bool_and(l.dispatched_qty >= l.quantity) THEN 'closed'
            WHEN sum(l.dispatched_qty) > 0 THEN 'partially_dispatched'
            WHEN sum(l.invoiced_qty - l.dispatched_qty) > 0 THEN 'ready_to_dispatch'
            WHEN sum(l.packed_qty - l.invoiced_qty) > 0 THEN 'awaiting_invoice'
            WHEN sum(l.packed_qty) > 0 THEN 'picking'
            ELSE 'open' END
            FROM sales_document_lines l
           WHERE l.document_id = ${salesDocuments.id} AND l.org_id = ${salesDocuments.orgId} AND l.deleted_at IS NULL
        ) END`,
      createdAt: salesDocuments.createdAt,
      updatedAt: salesDocuments.updatedAt,
    };
  }

  private headerQuery(where: SQL) {
    return this.db.select(this.headerSelection()).from(salesDocuments).leftJoin(owner, eq(owner.id, salesDocuments.ownerId)).where(where);
  }

  private filterPredicate(filters: EstimateListFilters): SQL | undefined {
    return and(
      eq(salesDocuments.docType, this.docType),
      filters.q === undefined ? undefined : masterSearch(filters.q, [salesDocuments.number, salesDocuments.customerName]),
      filters.status === undefined ? undefined : sql`${salesDocuments.status} = ${filters.status}`,
      filters.syncState === undefined ? undefined : eq(salesDocuments.syncState, filters.syncState),
      filters.partyId === undefined ? undefined : eq(salesDocuments.partyId, filters.partyId),
      filters.companyId === undefined ? undefined : eq(salesDocuments.companyId, filters.companyId),
      filters.dealId === undefined ? undefined : eq(salesDocuments.dealId, filters.dealId),
      filters.ownerId === undefined ? undefined : eq(salesDocuments.ownerId, filters.ownerId),
      filters.sourceDocumentId === undefined ? undefined : eq(salesDocuments.sourceDocumentId, filters.sourceDocumentId),
    );
  }

  async list(scope: SQL, filters: EstimateListFilters): Promise<{ rows: EstimateSummary[]; total: number }> {
    const predicate = this.filterPredicate(filters);
    const rows = await this.headerQuery(this.scoped(scope, predicate))
      .orderBy(...masterOrderBy(filters.sort, SORT_COLUMNS, salesDocuments.date, salesDocuments.id))
      .limit(filters.limit)
      .offset(filters.offset);
    const total = await this.count(and(scope, predicate));
    return { rows: rows.map(toSummary), total };
  }

  async view(scope: SQL, id: string): Promise<EstimateView | null> {
    const rows = await this.headerQuery(this.scoped(scope, eq(salesDocuments.id, id), eq(salesDocuments.docType, this.docType))).limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const lines = await this.db
      .select()
      .from(salesDocumentLines)
      .where(and(eq(salesDocumentLines.documentId, id), isNull(salesDocumentLines.deletedAt)))
      .orderBy(asc(salesDocumentLines.lineNo));
    // P8-2: what Vyuha-raised invoices in flight (confirmed, not yet accepted
    // by Tally, no link yet) have spoken for on each line — matched the way
    // acceptance will match them, by item then description.
    const inFlight =
      this.docType === 'SALES_ORDER'
        ? await this.db.execute<{ stock_item_id: string | null; description: string; quantity: string }>(sql`
            SELECT il.stock_item_id, il.description, il.quantity::text AS quantity
              FROM sales_documents inv JOIN sales_document_lines il ON il.document_id = inv.id AND il.deleted_at IS NULL
             WHERE inv.org_id = ${this.ctx.orgId} AND inv.doc_type = 'INVOICE' AND inv.source_document_id = ${id}
               AND inv.status = 'CONFIRMED' AND inv.sync_state <> 'PUSHED' AND inv.deleted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM sales_order_invoices i WHERE i.invoice_document_id = inv.id)
             ORDER BY inv.created_at, inv.id, il.line_no
          `)
        : { rows: [] };
    // Assigned the way acceptance assigns (invoice.service.ts): each invoice
    // line goes to the lowest-numbered order line that matches and still has
    // packed quantity left to invoice, capped at what that line can hold.
    //
    // The preview used to sum the invoice lines by item and hand the total to
    // the first order line that matched. An order with the same item on two
    // lines -- the same goods at two rates, or for two dates -- showed all of
    // it against line one, which then read as over-invoiced while line two
    // read as untouched, and the screen disagreed with what acceptance would
    // actually write.
    const invoicingByLine = new Map<string, number>();
    for (const row of inFlight.rows) {
      const spokenFor = (line: typeof lines[number]): number => Number(line.invoicedQty) + (invoicingByLine.get(line.id) ?? 0);
      const target = lines.find(
        (line) =>
          ((row.stock_item_id !== null && line.stockItemId === row.stock_item_id) || line.description === row.description) &&
          Number(line.packedQty) > spokenFor(line),
      );
      if (target === undefined) continue;
      const capacity = Number(target.packedQty) - spokenFor(target);
      invoicingByLine.set(target.id, (invoicingByLine.get(target.id) ?? 0) + Math.min(Number(row.quantity), capacity));
    }
    const invoices =
      this.docType === 'SALES_ORDER'
        ? await this.db.execute<{ voucher_id: string | null; invoice_document_id: string | null; voucher_number: string; voucher_date: string; amount: string; method: string; linked_at: Date }>(sql`
            SELECT i.voucher_id, i.invoice_document_id,
                   -- P8-1: the customer sees Tally's number; Vyuha's INV-nnnn only until Tally has answered.
                   COALESCE(v.voucher_number, d.remote_voucher_number, d.number) AS voucher_number,
                   COALESCE(v.voucher_date, d.date) AS voucher_date,
                   COALESCE(v.amount, d.grand_total)::text AS amount,
                   i.method, i.linked_at
              FROM sales_order_invoices i
              LEFT JOIN vouchers v ON v.id = i.voucher_id AND v.org_id = ${this.ctx.orgId}
              LEFT JOIN sales_documents d ON d.id = i.invoice_document_id AND d.org_id = ${this.ctx.orgId}
             WHERE i.document_id = ${id} AND i.org_id = ${this.ctx.orgId}
             ORDER BY 3, 2
          `)
        : { rows: [] };
    return {
      ...toSummary(row),
      lines: lines.map((line) => toLineView(line, invoicingByLine.get(line.id) ?? 0)),
      // Filled by SalesOrderService from the platform seam (REQ-X-26); the repository knows no purchase table.
      waitingOn: [],
      invoices: invoices.rows.map((i) => ({
        voucherId: i.voucher_id,
        invoiceDocumentId: i.invoice_document_id,
        voucherNumber: i.voucher_number,
        date: i.voucher_date,
        amount: i.amount,
        method: i.method === 'manual' ? 'manual' : i.method === 'vyuha' ? 'vyuha' : 'narration',
        linkedAt: new Date(i.linked_at).toISOString(),
      })),
    };
  }

  /**
   * Header and lines in one transaction, number issued from the sequence
   * row under `FOR UPDATE` so two estimates raised together cannot share it.
   */
  async create(header: EstimateHeaderInput, lines: readonly RepositoryLineInput[]): Promise<string> {
    return this.db.transaction(async (tx) => {
      const number = await this.nextNumber(tx);
      const inserted = await tx
        .insert(salesDocuments)
        .values({
          orgId: this.ctx.orgId,
          docType: this.docType,
          number,
          status: header.status ?? 'DRAFT',
          sourceDocumentId: header.sourceDocumentId ?? null,
          returnId: header.returnId ?? null,
          date: header.date,
          validUntil: header.validUntil,
          partyId: header.partyId,
          companyId: header.companyId,
          dealId: header.dealId,
          customerName: header.customerName,
          ownerId: header.ownerId,
          notes: header.notes,
          terms: header.terms,
          customerEmail: header.customerEmail ?? null,
          customerWhatsapp: header.customerWhatsapp ?? null,
          placeOfSupply: header.placeOfSupply ?? null,
          shipTo: header.shipTo ?? null,
          details: header.details ?? null,
          createdBy: this.ctx.actorUserId,
          updatedBy: this.ctx.actorUserId,
        })
        .returning({ id: salesDocuments.id });
      const id = inserted[0]?.id;
      if (id === undefined) throw new Error('Estimate insert returned no row.');
      await this.replaceLines(tx, id, lines);
      return id;
    });
  }

  async updateHeader(id: string, patch: Partial<EstimateHeaderInput>, lines: readonly RepositoryLineInput[] | undefined): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(salesDocuments)
        .set({ ...patch, updatedAt: new Date(), updatedBy: this.ctx.actorUserId })
        .where(this.scoped(eq(salesDocuments.id, id)))
        .returning({ id: salesDocuments.id });
      if (rows.length === 0) return false;
      if (lines !== undefined) await this.replaceLines(tx, id, lines);
      return true;
    });
  }

  /** REQ-W-06: what the agent reported, written by the results path. */
  async setSync(
    id: string,
    patch: Partial<{ syncState: DocumentSyncState; remoteGuid: string | null; remoteVoucherNumber: string | null; pushJobId: string | null; lastPushedAt: Date | null; lastError: string | null }>,
  ): Promise<boolean> {
    const rows = await this.db
      .update(salesDocuments)
      .set({ ...patch, updatedAt: new Date(), updatedBy: this.ctx.actorUserId })
      .where(this.scoped(eq(salesDocuments.id, id)))
      .returning({ id: salesDocuments.id });
    return rows.length > 0;
  }

  /** The document a push job belongs to — the results path's way back from a job id. */
  async findByPushJob(jobId: string): Promise<{ id: string; docType: SalesDocumentType } | null> {
    const rows = await this.findMany({ where: eq(salesDocuments.pushJobId, jobId), limit: 1 });
    const row = rows[0];
    return row === undefined ? null : { id: row.id, docType: row.docType };
  }

  async setStatus(id: string, status: EstimateStatus | 'PENDING_APPROVAL' | 'CONFIRMED' | 'CANCELLED'): Promise<boolean> {
    const rows = await this.db
      .update(salesDocuments)
      .set({ status, updatedAt: new Date(), updatedBy: this.ctx.actorUserId })
      .where(this.scoped(eq(salesDocuments.id, id)))
      .returning({ id: salesDocuments.id });
    return rows.length > 0;
  }

  private async nextNumber(tx: Transaction): Promise<string> {
    await tx
      .insert(salesDocumentSequences)
      .values({ orgId: this.ctx.orgId, docType: this.docType, lastNumber: 0 })
      .onConflictDoNothing();
    const bumped = await tx
      .update(salesDocumentSequences)
      .set({ lastNumber: sql`${salesDocumentSequences.lastNumber} + 1` })
      .where(and(eq(salesDocumentSequences.orgId, this.ctx.orgId), eq(salesDocumentSequences.docType, this.docType)))
      .returning({ lastNumber: salesDocumentSequences.lastNumber });
    const next = bumped[0]?.lastNumber;
    if (next === undefined) throw new Error('Document sequence returned no row.');
    return `${SALES_DOCUMENT_TYPE_PREFIX[this.docType]}-${String(next).padStart(4, '0')}`;
  }

  /** Delete-then-insert inside the caller's transaction, then the header's totals from the new lines. */
  private async replaceLines(tx: Transaction, documentId: string, lines: readonly RepositoryLineInput[]): Promise<void> {
    // 15 REQ-AK-09 / D-51: the free-of-charge mark is set by the return that
    // raised the order and by nothing else -- there is deliberately no field
    // for it on the line editor. An edit replaces every line, so input that
    // cannot carry the mark used to clear it, and a replacement the company
    // had decided to give away went back to waiting for an invoice that was
    // never coming. A line still naming the same item keeps its mark.
    const marked = await tx.execute<{ stock_item_id: string | null; description: string }>(sql`
      SELECT stock_item_id, description FROM sales_document_lines
       WHERE document_id = ${documentId} AND org_id = ${this.ctx.orgId} AND free_of_charge AND deleted_at IS NULL
    `);
    const wasFree = new Set(marked.rows.map((row) => `${row.stock_item_id ?? ''}|${row.description}`));
    await tx.delete(salesDocumentLines).where(eq(salesDocumentLines.documentId, documentId));
    if (lines.length > 0) {
      // 15 REQ-AN-13/15: the price lists resolve each item's rate at the
      // document's date; the line carries what resolved as values. A rate the
      // salesperson typed stands (the floor check happens at confirm); one
      // they left blank becomes the resolved rate.
      const head = await tx.execute<{ party_id: string | null; date: string }>(sql`SELECT party_id, date::text FROM sales_documents WHERE id = ${documentId} AND org_id = ${this.ctx.orgId}`);
      const partyId = head.rows[0]?.party_id ?? null;
      const date = head.rows[0]?.date ?? new Date().toISOString().slice(0, 10);
      const resolved = await Promise.all(
        lines.map((line) => (line.stockItemId ? resolveRate(tx, this.ctx.orgId, { partyId, stockItemId: line.stockItemId, quantity: line.quantity, date }) : Promise.resolve(null))),
      );
      await tx.insert(salesDocumentLines).values(
        lines.map((line, index) => {
          const resolution = resolved[index] ?? null;
          const rate = line.rate ?? resolution?.rate ?? '0';
          return {
            orgId: this.ctx.orgId,
            documentId,
            lineNo: index + 1,
            stockItemId: line.stockItemId ?? null,
            description: line.description,
            quantity: line.quantity,
            unit: line.unit ?? null,
            rate,
            discountPct: line.discountPct,
            taxPct: line.taxPct,
            hsnCode: line.hsnCode ?? null,
            priceListId: resolution?.priceListId ?? null,
            priceListVersion: resolution?.priceListVersion ?? null,
            resolvedRate: resolution?.rate ?? null,
            appliedDiscountPct: resolution?.discountPct ?? null,
            rateOverrideReason: line.rateOverrideReason ?? null,
            freeOfCharge: line.freeOfCharge ?? wasFree.has(`${line.stockItemId ?? ''}|${line.description}`),
            amount: sql`round(${line.quantity}::numeric * ${rate}::numeric * (1 - ${line.discountPct}::numeric / 100), 2)`,
            taxAmount: sql`round(round(${line.quantity}::numeric * ${rate}::numeric * (1 - ${line.discountPct}::numeric / 100), 2) * ${line.taxPct}::numeric / 100, 2)`,
            createdBy: this.ctx.actorUserId,
            updatedBy: this.ctx.actorUserId,
          };
        }),
      );
    }
    await tx.execute(sql`
      UPDATE sales_documents d
         SET subtotal = t.subtotal,
             discount_total = t.discount_total,
             tax_total = t.tax_total,
             grand_total = t.subtotal - t.discount_total + t.tax_total,
             updated_at = now()
        FROM (
          SELECT coalesce(sum(round(quantity * rate, 2)), 0) AS subtotal,
                 coalesce(sum(round(quantity * rate, 2) - amount), 0) AS discount_total,
                 coalesce(sum(tax_amount), 0) AS tax_total
            FROM sales_document_lines
           WHERE document_id = ${documentId} AND org_id = ${this.ctx.orgId} AND deleted_at IS NULL
        ) t
       WHERE d.id = ${documentId} AND d.org_id = ${this.ctx.orgId}
    `);
  }

  /**
   * REQ-W-02: the item's past with this customer. Vouchers when they are a
   * party; earlier estimates either way. Newest first, capped.
   */
  async itemHistory(input: {
    stockItemId: string;
    partyId: string | null;
    companyId: string | null;
    limit: number;
  }): Promise<{ stockItemName: string; currentSalePrice: string | null; entries: ItemHistoryEntry[]; vouchersAsOf: string | null } | null> {
    const item = await this.db
      .select({ name: stockItems.name, salePrice: stockItems.salePrice, lastPulledAt: stockItems.lastPulledAt })
      .from(stockItems)
      .where(and(eq(stockItems.orgId, this.ctx.orgId), eq(stockItems.id, input.stockItemId)))
      .limit(1);
    const found = item[0];
    if (found === undefined) return null;

    const entries: ItemHistoryEntry[] = [];
    if (input.partyId !== null) {
      const rows = await this.db
        .select({
          date: vouchers.voucherDate,
          voucherType: vouchers.voucherType,
          voucherNumber: vouchers.voucherNumber,
          quantity: voucherLines.billedQty,
          rate: voucherLines.rate,
          amount: voucherLines.amount,
          isCancelled: vouchers.isCancelled,
        })
        .from(voucherLines)
        .innerJoin(vouchers, eq(vouchers.id, voucherLines.voucherId))
        .where(
          and(
            eq(voucherLines.orgId, this.ctx.orgId),
            eq(voucherLines.stockItemId, input.stockItemId),
            eq(vouchers.partyId, input.partyId),
          ),
        )
        .orderBy(desc(vouchers.voucherDate), desc(vouchers.id))
        .limit(input.limit);
      for (const row of rows) {
        entries.push({
          source: 'voucher',
          date: row.date,
          reference: `${row.voucherType} ${row.voucherNumber}`.trim(),
          quantity: row.quantity,
          rate: row.rate,
          discountPct: null,
          amount: row.amount,
          status: row.isCancelled ? 'cancelled' : null,
        });
      }
    }

    const customerPredicate =
      input.partyId !== null && input.companyId !== null
        ? sql`(${salesDocuments.partyId} = ${input.partyId} OR ${salesDocuments.companyId} = ${input.companyId})`
        : input.partyId !== null
          ? eq(salesDocuments.partyId, input.partyId)
          : input.companyId !== null
            ? eq(salesDocuments.companyId, input.companyId)
            : sql`false`;
    const quoted = await this.db
      .select({
        date: salesDocuments.date,
        number: salesDocuments.number,
        status: salesDocuments.status,
        quantity: salesDocumentLines.quantity,
        rate: salesDocumentLines.rate,
        discountPct: salesDocumentLines.discountPct,
        amount: salesDocumentLines.amount,
      })
      .from(salesDocumentLines)
      .innerJoin(salesDocuments, eq(salesDocuments.id, salesDocumentLines.documentId))
      .where(
        and(
          eq(salesDocumentLines.orgId, this.ctx.orgId),
          eq(salesDocumentLines.stockItemId, input.stockItemId),
          isNull(salesDocumentLines.deletedAt),
          isNull(salesDocuments.deletedAt),
          customerPredicate,
        ),
      )
      .orderBy(desc(salesDocuments.date), desc(salesDocuments.id))
      .limit(input.limit);
    for (const row of quoted) {
      entries.push({
        source: 'estimate',
        date: row.date,
        reference: `Estimate ${row.number}`,
        quantity: row.quantity,
        rate: row.rate,
        discountPct: row.discountPct,
        amount: row.amount,
        status: row.status.toLowerCase(),
      });
    }
    entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const asOf = await this.db
      .select({ at: sql<Date | null>`max(${vouchers.lastPulledAt})` })
      .from(vouchers)
      .where(eq(vouchers.orgId, this.ctx.orgId));
    const vouchersAsOf = asOf[0]?.at ?? null;
    return {
      stockItemName: found.name,
      currentSalePrice: found.salePrice,
      entries: entries.slice(0, input.limit),
      vouchersAsOf: vouchersAsOf === null ? null : new Date(vouchersAsOf).toISOString(),
    };
  }
}

interface HeaderRow {
  id: string;
  docType: SalesDocumentType;
  number: string;
  status: EstimateStatus | 'PENDING_APPROVAL' | 'CONFIRMED' | 'CANCELLED';
  date: string;
  validUntil: string | null;
  partyId: string | null;
  companyId: string | null;
  dealId: string | null;
  customerName: string;
  ownerId: string | null;
  ownerName: string | null;
  notes: string | null;
  terms: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  sourceDocumentId: string | null;
  syncState: DocumentSyncState;
  remoteGuid: string | null;
  remoteVoucherNumber: string | null;
  lastPushedAt: Date | null;
  lastError: string | null;
  shortClosedAt: Date | null;
  shortCloseReason: string | null;
  customerEmail: string | null;
  customerWhatsapp: string | null;
  placeOfSupply: string | null;
  shipTo: ShipTo | null;
  details: DocumentDetails | null;
  fulfilment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toSummary(row: HeaderRow): EstimateSummary {
  return {
    id: row.id,
    docType: row.docType,
    number: row.number,
    status: row.status,
    date: row.date,
    validUntil: row.validUntil,
    partyId: row.partyId,
    companyId: row.companyId,
    dealId: row.dealId,
    customerName: row.customerName,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    notes: row.notes,
    terms: row.terms,
    subtotal: row.subtotal,
    discountTotal: row.discountTotal,
    taxTotal: row.taxTotal,
    grandTotal: row.grandTotal,
    sourceDocumentId: row.sourceDocumentId,
    syncState: row.syncState,
    remoteGuid: row.remoteGuid,
    remoteVoucherNumber: row.remoteVoucherNumber,
    lastPushedAt: row.lastPushedAt === null ? null : row.lastPushedAt.toISOString(),
    lastError: row.lastError,
    fulfilment: FULFILMENT_STATES.find((f) => f === row.fulfilment) ?? null,
    shortClosedAt: row.shortClosedAt === null ? null : row.shortClosedAt.toISOString(),
    shortCloseReason: row.shortCloseReason,
    customerEmail: row.customerEmail,
    customerWhatsapp: row.customerWhatsapp,
    placeOfSupply: row.placeOfSupply,
    shipTo: row.shipTo,
    details: row.details,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toLineView(row: typeof salesDocumentLines.$inferSelect, invoicing = 0): SalesLineView {
  return {
    id: row.id,
    lineNo: row.lineNo,
    stockItemId: row.stockItemId,
    description: row.description,
    quantity: row.quantity,
    unit: row.unit,
    rate: row.rate,
    discountPct: row.discountPct,
    taxPct: row.taxPct,
    amount: row.amount,
    taxAmount: row.taxAmount,
    hsnCode: row.hsnCode,
    priceListId: row.priceListId,
    priceListVersion: row.priceListVersion,
    resolvedRate: row.resolvedRate,
    appliedDiscountPct: row.appliedDiscountPct,
    rateOverrideReason: row.rateOverrideReason,
    freeOfCharge: row.freeOfCharge,
    pickedQty: row.pickedQty,
    packedQty: row.packedQty,
    invoicedQty: row.invoicedQty,
    dispatchedQty: row.dispatchedQty,
    invoicingQty: invoicing.toFixed(3),
  };
}
