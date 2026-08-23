import { Injectable, Logger } from '@nestjs/common';
import { type Paginated, type ReminderNoticeView, type SendReminderInput } from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { CollectionsService } from './collections.service.js';
import { AppError, describeError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { DocumentSettingsService } from '../documents/document-settings.service.js';
import { Mailer } from '../mail/mailer.js';
import { orgContextOf, type Principal } from '../rbac/principal.js';
import { renderReminderNotice, type ReminderBill } from './reminder-notice.js';

/**
 * REQ-AJ-05/06: a reminder with the account behind it, sent through the
 * same shape the dispatch notices use -- one row per channel, email sent
 * here, WhatsApp left pending until a person says they sent it (the
 * `manual` fallback until the API lands). Every reminder is recorded with
 * its channel, recipient, the moment, the status, and the date the
 * statement was as of, so a customer claiming they were never told has an
 * answer.
 *
 * Nothing here writes to a balance. The figures are read from
 * `bill_allocations` -- the same open-bill query the ageing report and the
 * statement read -- at the moment of sending, and stored beside the notice
 * as what the customer was shown.
 */
@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly mailer: Mailer,
    private readonly settings: DocumentSettingsService,
    private readonly auditContext: AuditContext,
    // For `partyVisible` only: the collector scope is defined once, next to
    // every other read that honours it, rather than restated here.
    private readonly collections: CollectionsService,
  ) {}

  /**
   * The open bills behind a party's balance, oldest first, with Tally's due
   * date or the party's credit days deciding overdue.
   *
   * Narrowed to the parties this caller may work. It used to take a bare
   * `orgId`, so `GET /collections/parties/:id/bills` -- and `send` below,
   * through the same method -- answered for any party in the organisation.
   * Doing it here rather than in the controller is what closes both doors
   * with one line.
   */
  async billsFor(principal: Principal, partyId: string, asOf: string): Promise<ReminderBill[]> {
    const orgId = principal.orgId;
    const rows = await this.db.execute<{ bill_name: string; bill_date: string | null; due_date: string | null; outstanding: string; overdue: boolean }>(sql`
      SELECT b.bill_name, min(b.bill_date)::text AS bill_date, max(b.due_date)::text AS due_date,
             round(sum(b.amount), 2)::text AS outstanding,
             CASE
               WHEN max(b.due_date) IS NOT NULL THEN ${asOf}::date > max(b.due_date)
               WHEN min(b.bill_date) IS NOT NULL AND max(p.credit_days) IS NOT NULL THEN ${asOf}::date > min(b.bill_date) + max(p.credit_days)
               ELSE false
             END AS overdue
        FROM bill_allocations b JOIN parties p ON p.id = b.party_id
       WHERE b.org_id = ${orgId} AND b.party_id = ${partyId} AND b.ref_type IN ('new', 'against')
         AND ${this.collections.partyVisible(principal, sql`b.party_id`)}
       GROUP BY b.bill_name
      HAVING round(sum(b.amount), 2) > 0
       ORDER BY min(b.bill_date) NULLS LAST, b.bill_name
    `);
    return rows.rows.map((r) => ({ billName: r.bill_name, billDate: r.bill_date, dueDate: r.due_date, outstanding: r.outstanding, overdue: r.overdue }));
  }

  /** REQ-AJ-05: compose and record; email goes now, WhatsApp waits for a person to say it went. */
  async send(principal: Principal, input: SendReminderInput): Promise<readonly ReminderNoticeView[]> {
    const ctx = orgContextOf(principal);
    const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
    const party = await this.db
      .execute<{ id: string; name: string; email: string | null; phone: string | null }>(sql`SELECT id, name, email, phone FROM parties WHERE org_id = ${ctx.orgId} AND id = ${input.partyId}`)
      .then((r) => r.rows[0]);
    if (party === undefined) throw AppError.notFound('Party', input.partyId);
    const bills = await this.billsFor(principal, input.partyId, asOf);
    if (bills.length === 0) throw AppError.conflict(`${party.name} has nothing outstanding as of ${asOf}; there is nothing to remind about.`);

    const [settings, org, promise] = await Promise.all([
      this.settings.read(ctx.orgId),
      this.db.execute<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${ctx.orgId}`).then((r) => r.rows[0]),
      this.db
        .execute<{ amount: string; promised_date: string }>(sql`
          SELECT amount::text, promised_date::text FROM promises_to_pay
           WHERE org_id = ${ctx.orgId} AND party_id = ${input.partyId} AND deleted_at IS NULL AND state = 'open'
           ORDER BY promised_date LIMIT 1
        `)
        .then((r) => r.rows[0] ?? null),
    ]);
    const notice = renderReminderNotice({
      orgName: org?.name ?? '',
      profile: settings.profile,
      partyName: party.name,
      contactName: null,
      asOf,
      bills,
      promise: promise === null ? null : { amount: promise.amount, promisedDate: promise.promised_date },
    });

    const channels = input.channels.length === 0 ? (['email'] as const) : input.channels;
    const created: string[] = [];
    for (const channel of channels) {
      const recipient = channel === 'email' ? party.email : channel === 'whatsapp' ? party.phone : null;
      const inserted = await this.db.execute<{ id: string }>(sql`
        INSERT INTO reminder_notices (org_id, party_id, channel, recipient, status, composed_text, statement_as_of, outstanding_at_send, created_by, updated_by)
        VALUES (${ctx.orgId}, ${input.partyId}, ${channel}, ${recipient}, 'pending', ${notice.text}, ${asOf}, ${notice.outstanding}, ${ctx.actorUserId}, ${ctx.actorUserId})
        RETURNING id
      `);
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error('Reminder insert returned no row.');
      created.push(id);
      if (channel === 'email') await this.deliver(ctx.orgId, id, recipient, notice.subject, notice.text, notice.html, settings.profile.email);
    }
    this.auditContext.record({
      action: 'collections.reminder.sent',
      entityType: 'party',
      entityId: input.partyId,
      before: null,
      after: { channels, asOf, outstanding: notice.outstanding, bills: bills.length },
    });
    return this.listFor(principal, input.partyId, created);
  }

  private async deliver(orgId: string, id: string, recipient: string | null, subject: string, text: string, html: string, replyTo: string): Promise<void> {
    if (recipient === null || recipient.trim() === '') {
      await this.db.execute(sql`UPDATE reminder_notices SET status = 'failed', error = 'The party master carries no email address.', updated_at = now() WHERE id = ${id}`);
      return;
    }
    try {
      await this.mailer.send({ to: recipient, subject, body: text, html, ...(replyTo.trim() === '' ? {} : { replyTo }) });
      await this.db.execute(sql`UPDATE reminder_notices SET status = 'sent', sent_at = now(), error = NULL, updated_at = now() WHERE id = ${id}`);
    } catch (error: unknown) {
      await this.db.execute(sql`UPDATE reminder_notices SET status = 'failed', error = ${describeError(error).slice(0, 500)}, updated_at = now() WHERE id = ${id}`);
      this.logger.error({ msg: 'Reminder could not be sent', orgId, reminderId: id });
    }
  }

  /** The manual fallback: a person says the WhatsApp went, and the record says who and when. */
  async markSent(principal: Principal, id: string): Promise<ReminderNoticeView> {
    const ctx = orgContextOf(principal);
    const row = await this.db
      .execute<{ id: string; party_id: string; channel: string; status: string }>(sql`SELECT id, party_id, channel, status FROM reminder_notices WHERE org_id = ${ctx.orgId} AND id = ${id} AND deleted_at IS NULL`)
      .then((r) => r.rows[0]);
    if (row === undefined) throw AppError.notFound('Reminder', id);
    if (row.status === 'sent') throw AppError.conflict('This reminder is already marked sent.');
    await this.db.execute(sql`UPDATE reminder_notices SET status = 'sent', sent_at = now(), sent_by = ${ctx.actorUserId}, error = NULL, updated_at = now() WHERE id = ${id}`);
    this.auditContext.record({ action: 'collections.reminder.marked_sent', entityType: 'party', entityId: row.party_id, before: { status: row.status }, after: { status: 'sent', channel: row.channel } });
    const page = await this.listFor(principal, row.party_id, [id]);
    const view = page[0];
    if (view === undefined) throw new Error('Reminder vanished after marking.');
    return view;
  }

  async list(principal: Principal, partyId: string, page: number, pageSize: number): Promise<Paginated<ReminderNoticeView>> {
    const offset = (page - 1) * pageSize;
    const [rows, total] = await Promise.all([
      this.rows(principal.orgId, sql`r.party_id = ${partyId} AND ${this.collections.partyVisible(principal, sql`r.party_id`)}`, sql`LIMIT ${pageSize} OFFSET ${offset}`),
      this.db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM reminder_notices r
         WHERE r.org_id = ${principal.orgId} AND r.party_id = ${partyId} AND r.deleted_at IS NULL
           AND ${this.collections.partyVisible(principal, sql`r.party_id`)}
      `),
    ]);
    return { data: rows, meta: { page, pageSize, total: total.rows[0]?.count ?? 0 } };
  }

  private async listFor(principal: Principal, partyId: string, ids: readonly string[]): Promise<ReminderNoticeView[]> {
    if (ids.length === 0) return [];
    return this.rows(principal.orgId, sql`r.party_id = ${partyId} AND r.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`, sql``);
  }

  private async rows(orgId: string, where: SQL, tail: SQL): Promise<ReminderNoticeView[]> {
    const rows = await this.db.execute<{
      id: string;
      party_id: string;
      party_name: string;
      channel: string;
      recipient: string | null;
      status: string;
      composed_text: string;
      statement_as_of: string;
      outstanding_at_send: string;
      sent_at: Date | string | null;
      error: string | null;
      created_at: Date | string;
    }>(sql`
      SELECT r.id, r.party_id, p.name AS party_name, r.channel, r.recipient, r.status, r.composed_text,
             r.statement_as_of::text, r.outstanding_at_send::text, r.sent_at, r.error, r.created_at
        FROM reminder_notices r JOIN parties p ON p.id = r.party_id
       WHERE r.org_id = ${orgId} AND r.deleted_at IS NULL AND ${where}
       ORDER BY r.created_at DESC ${tail}
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      partyId: r.party_id,
      partyName: r.party_name,
      channel: r.channel as ReminderNoticeView['channel'],
      recipient: r.recipient,
      status: r.status as ReminderNoticeView['status'],
      composedText: r.composed_text,
      statementAsOf: r.statement_as_of,
      outstandingAtSend: Number(r.outstanding_at_send).toFixed(2),
      sentAt: r.sent_at === null ? null : new Date(r.sent_at).toISOString(),
      error: r.error,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
}
