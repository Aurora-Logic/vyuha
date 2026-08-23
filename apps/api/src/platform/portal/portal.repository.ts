import { sql } from 'drizzle-orm';
import type { PortalDispatchView, PortalInvoiceView, PortalOrderView, PortalPromiseView, PortalStatementRow } from '@vyuha/shared';

import type { Database } from '../db/db.provider.js';

/**
 * REQ-AL-04: the party scope lives here, and only here.
 *
 * The repository is constructed with the organisation and the party the
 * link key names, and **no method takes a party id**. That is the whole
 * point of the class: there is no signature a caller could pass a
 * different party to, so a controller cannot assemble the scope, a query
 * string cannot influence it, and a future method cannot forget it. The
 * requirement's test — "a repository method that would return a different
 * party's rows if handed a different id is a defect" — is answered by
 * there being nothing to hand.
 *
 * Raw SQL because the portal reads across modules (sales documents,
 * dispatches, the Tally projection, collections) and the platform may not
 * import a module. Every statement carries `org_id` as well as the party:
 * a party id is a uuid from another organisation's table until both match.
 */
export class PortalRepository {
  constructor(
    private readonly db: Database,
    private readonly orgId: string,
    private readonly partyId: string,
  ) {}

  /** REQ-AL-01: orders with what is still to go out. */
  async orders(): Promise<PortalOrderView[]> {
    const rows = await this.db.execute<{
      number: string; date: string; status: string; grand_total: string; lines_open: number; ordered: string; dispatched: string;
    }>(sql`
      SELECT d.number, d.date::text AS date, d.status, d.grand_total::text AS grand_total,
             (SELECT count(*)::int FROM sales_document_lines l WHERE l.document_id = d.id AND l.deleted_at IS NULL AND l.dispatched_qty < l.quantity) AS lines_open,
             COALESCE((SELECT sum(l.quantity) FROM sales_document_lines l WHERE l.document_id = d.id AND l.deleted_at IS NULL), 0)::text AS ordered,
             COALESCE((SELECT sum(l.dispatched_qty) FROM sales_document_lines l WHERE l.document_id = d.id AND l.deleted_at IS NULL), 0)::text AS dispatched
        FROM sales_documents d
       WHERE d.org_id = ${this.orgId} AND d.party_id = ${this.partyId} AND d.deleted_at IS NULL
         AND d.doc_type = 'SALES_ORDER' AND d.status IN ('CONFIRMED', 'CANCELLED')
       ORDER BY d.date DESC, d.number DESC
       LIMIT 200
    `);
    return rows.rows.map((r) => ({
      number: r.number,
      date: r.date,
      status: r.status,
      grandTotal: r.grand_total,
      linesOpen: Number(r.lines_open),
      quantityOrdered: r.ordered,
      quantityDispatched: r.dispatched,
      fulfilment: Number(r.dispatched) <= 0 ? 'Not yet dispatched' : Number(r.lines_open) === 0 ? 'Complete' : 'Part sent',
    }));
  }

  /** REQ-AL-01: dispatches with their LR and their photographs — ids only (REQ-AL-08). */
  async dispatches(): Promise<PortalDispatchView[]> {
    const rows = await this.db.execute<{
      number: string; order_number: string; dispatched_at: Date | string; mode: string; lr_number: string | null; transporter_name: string | null;
      vehicle_number: string | null; expected_delivery_date: string | null; delivered_at: Date | string | null; received_by: string | null;
      lines: { description: string; quantity: string; unit: string | null }[]; photos: { fileId: string; kind: string }[];
    }>(sql`
      SELECT x.number, d.number AS order_number, x.dispatched_at, x.mode, x.lr_number, x.transporter_name, x.vehicle_number,
             x.expected_delivery_date::text AS expected_delivery_date, x.delivered_at, x.received_by,
             COALESCE((
               SELECT json_agg(json_build_object('description', l.description, 'quantity', xl.quantity::text, 'unit', l.unit) ORDER BY l.line_no)
                 FROM dispatch_lines xl JOIN sales_document_lines l ON l.id = xl.line_id
                WHERE xl.dispatch_id = x.id AND xl.deleted_at IS NULL
             ), '[]'::json) AS lines,
             COALESCE((
               SELECT json_agg(json_build_object('fileId', a.file_id, 'kind', a.kind) ORDER BY a.created_at)
                 FROM dispatch_attachments a WHERE a.dispatch_id = x.id AND a.deleted_at IS NULL
             ), '[]'::json) AS photos
        FROM dispatches x
        JOIN sales_documents d ON d.id = x.document_id
       WHERE x.org_id = ${this.orgId} AND d.party_id = ${this.partyId} AND x.deleted_at IS NULL AND d.deleted_at IS NULL
       ORDER BY x.dispatched_at DESC
       LIMIT 200
    `);
    return rows.rows.map((r) => ({
      number: r.number,
      orderNumber: r.order_number,
      dispatchedAt: new Date(r.dispatched_at).toISOString(),
      mode: r.mode,
      lrNumber: r.lr_number,
      transporterName: r.transporter_name,
      vehicleNumber: r.vehicle_number,
      expectedDeliveryDate: r.expected_delivery_date,
      deliveredAt: r.delivered_at === null ? null : new Date(r.delivered_at).toISOString(),
      receivedBy: r.received_by,
      lines: r.lines,
      photos: r.photos,
    }));
  }

  /** REQ-AL-01: the invoices Tally raised against them. */
  async invoices(): Promise<PortalInvoiceView[]> {
    const rows = await this.db.execute<{ voucher_number: string; voucher_date: string; amount: string; narration: string | null }>(sql`
      SELECT v.voucher_number, v.voucher_date::text AS voucher_date, v.amount::text AS amount, v.narration
        FROM vouchers v
       WHERE v.org_id = ${this.orgId} AND v.party_id = ${this.partyId} AND v.voucher_type = 'Sales' AND NOT v.is_cancelled
       ORDER BY v.voucher_date DESC, v.voucher_number DESC
       LIMIT 200
    `);
    return rows.rows.map((r) => ({ voucherNumber: r.voucher_number, date: r.voucher_date, amount: r.amount, reference: r.narration }));
  }

  /**
   * REQ-AL-01: the statement, as the receivables screen computes it — a
   * sale is a debit, a receipt or credit note a credit, and the running
   * figure is what the customer is being told they owe.
   */
  async statement(): Promise<{ rows: PortalStatementRow[]; outstanding: string }> {
    const rows = await this.db.execute<{
      voucher_date: string; voucher_type: string; voucher_number: string; narration: string | null; debit: string | null; credit: string | null; running: string;
    }>(sql`
      SELECT voucher_date::text AS voucher_date, voucher_type, voucher_number, narration,
             CASE WHEN sign > 0 THEN amount::text END AS debit,
             CASE WHEN sign < 0 THEN amount::text END AS credit,
             sum(sign * amount) OVER (ORDER BY voucher_date, voucher_number, id)::text AS running
        FROM (
          SELECT v.id, v.voucher_date, v.voucher_type, v.voucher_number, v.narration, abs(v.amount) AS amount,
                 CASE WHEN v.voucher_type IN ('Receipt', 'Credit Note') THEN -1 ELSE 1 END AS sign
            FROM vouchers v
           WHERE v.org_id = ${this.orgId} AND v.party_id = ${this.partyId} AND NOT v.is_cancelled
             AND v.voucher_type IN ('Sales', 'Receipt', 'Credit Note', 'Debit Note')
        ) t
       ORDER BY voucher_date DESC, voucher_number DESC
       LIMIT 200
    `);
    const total = await this.db.execute<{ outstanding: string }>(sql`
      SELECT COALESCE(sum(CASE WHEN v.voucher_type IN ('Receipt', 'Credit Note') THEN -abs(v.amount) ELSE abs(v.amount) END), 0)::text AS outstanding
        FROM vouchers v
       WHERE v.org_id = ${this.orgId} AND v.party_id = ${this.partyId} AND NOT v.is_cancelled
         AND v.voucher_type IN ('Sales', 'Receipt', 'Credit Note', 'Debit Note')
    `);
    return {
      rows: rows.rows.map((r) => ({
        date: r.voucher_date,
        voucherType: r.voucher_type,
        voucherNumber: r.voucher_number,
        narration: r.narration,
        debit: r.debit,
        credit: r.credit,
        running: r.running,
      })),
      outstanding: total.rows[0]?.outstanding ?? '0',
    };
  }

  /** REQ-AL-01: open promises, "where they exist" — the customer's own word back to them. */
  async promises(): Promise<PortalPromiseView[]> {
    const rows = await this.db.execute<{ promised_date: string; amount: string; received_amount: string; state: string }>(sql`
      SELECT p.promised_date::text AS promised_date, p.amount::text AS amount, p.received_amount::text AS received_amount, p.state
        FROM promises_to_pay p
       WHERE p.org_id = ${this.orgId} AND p.party_id = ${this.partyId} AND p.deleted_at IS NULL AND p.state = 'open'
       ORDER BY p.promised_date
       LIMIT 50
    `);
    return rows.rows.map((r) => ({ promisedDate: r.promised_date, amount: r.amount, receivedAmount: r.received_amount, state: r.state }));
  }

  /**
   * The party's own name, and proof the key still points at a party of this
   * organisation. `parties` is a projection and has no soft delete: a
   * ledger withdrawn from Tally is marked `absent_in_tally` and keeps its
   * history (REQ-R-06), which the customer is still entitled to read.
   */
  async partyName(): Promise<string | null> {
    const rows = await this.db.execute<{ name: string }>(sql`
      SELECT name FROM parties WHERE org_id = ${this.orgId} AND id = ${this.partyId}
    `);
    return rows.rows[0]?.name ?? null;
  }

  /**
   * REQ-AL-08: a photograph is served only if it hangs off a dispatch of
   * *this* party's orders. Without this the portal would be an oracle for
   * every file id in the organisation.
   */
  async ownsPhoto(fileId: string): Promise<boolean> {
    const rows = await this.db.execute<{ one: number }>(sql`
      SELECT 1 AS one
        FROM dispatch_attachments a
        JOIN dispatches x ON x.id = a.dispatch_id
        JOIN sales_documents d ON d.id = x.document_id
       WHERE a.org_id = ${this.orgId} AND a.file_id = ${fileId} AND a.deleted_at IS NULL
         AND d.party_id = ${this.partyId} AND d.deleted_at IS NULL AND x.deleted_at IS NULL
       LIMIT 1
    `);
    return rows.rows.length > 0;
  }
}
