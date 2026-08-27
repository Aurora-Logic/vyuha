import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { AppError } from '../../platform/common/errors.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { type Principal } from '../../platform/rbac/principal.js';
import { istDateOf } from '../../platform/tasks/local-date.js';

/**
 * Exception reports (brief F2): the morning list of vouchers that look
 * wrong. Each row names the voucher, the party, the value and the reason;
 * a person Accepts it with a reason or sends it to Investigate as a task.
 * Every check is computed from the voucher projection; thresholds are
 * named here so a CA can read them, and move to Settings with the
 * compliance pass. The checks that need data the sync does not carry yet
 * (approvals, users on Tally edits, stock) say so rather than pretend.
 */

export interface ExceptionRow {
  readonly checkKey: string;
  readonly voucherId: string;
  readonly voucherNumber: string;
  readonly voucherType: string;
  readonly voucherDate: string;
  readonly party: string;
  readonly partyId: string | null;
  readonly amount: string;
  readonly reason: string;
  readonly review: { state: string; reason: string; reviewedAt: string } | null;
}

export interface ExceptionCheck {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly rows: readonly ExceptionRow[];
  /** Null when the check cannot run on the data the sync carries. */
  readonly available: boolean;
  readonly note?: string;
}

export interface Exceptions {
  readonly asOf: string;
  readonly from: string;
  readonly to: string;
  readonly checks: readonly ExceptionCheck[];
  readonly open: number;
}

export const EXCEPTION_STATES = ['accepted', 'investigating'] as const;
export type ExceptionState = (typeof EXCEPTION_STATES)[number];

const MATERIALITY = 25_000;
const NO_GSTIN_THRESHOLD = 50_000;
const BACKDATED_DAYS = 7;
const MONTH_END_SHARE = 0.4;

type Raw = { id: string; number: string; type: string; date: string; party: string; partyId: string | null; amount: string; extra?: string };

@Injectable()
export class ExceptionsService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(principal: Principal, from: string, to: string): Promise<Exceptions> {
    const org = principal.orgId;
    const today = istDateOf(new Date().toISOString());
    const base = sql`v.org_id = ${org} AND v.voucher_date BETWEEN ${from} AND ${to}`;
    const sel = sql`v.id, v.voucher_number AS number, v.voucher_type AS type, v.voucher_date::text AS date, v.party_name AS party, v.party_id AS "partyId", v.amount::text AS amount`;

    const duplicates = await this.db.execute<Raw>(sql`
      SELECT ${sel}, count(*) OVER (PARTITION BY v.party_name, v.voucher_date, v.amount)::text AS extra
      FROM vouchers v WHERE ${base} AND v.is_cancelled = false AND v.voucher_type = 'Sales'
    `);
    const cancelled = await this.db.execute<Raw>(sql`
      SELECT ${sel} FROM vouchers v WHERE ${base} AND v.is_cancelled = true ORDER BY v.voucher_date DESC
    `);
    const sameDay = await this.db.execute<Raw>(sql`
      SELECT ${sel}, cn.voucher_number AS extra FROM vouchers v
      JOIN vouchers cn ON cn.org_id = v.org_id AND cn.party_id = v.party_id AND cn.voucher_date = v.voucher_date
        AND cn.voucher_type = 'Credit Note' AND cn.is_cancelled = false
      WHERE ${base} AND v.is_cancelled = false AND v.voucher_type = 'Sales' AND v.party_id IS NOT NULL
    `);
    const noGstin = await this.db.execute<Raw>(sql`
      SELECT ${sel} FROM vouchers v LEFT JOIN parties p ON p.id = v.party_id
      WHERE ${base} AND v.is_cancelled = false AND v.voucher_type = 'Sales' AND v.amount >= ${NO_GSTIN_THRESHOLD}
        AND (p.gstin IS NULL OR p.gstin = '')
    `);
    const backdated = await this.db.execute<Raw>(sql`
      SELECT ${sel}, (v.created_at::date - v.voucher_date)::text AS extra FROM vouchers v
      WHERE ${base} AND v.is_cancelled = false AND v.created_at::date - v.voucher_date > ${BACKDATED_DAYS}
    `);
    const monthEnd = await this.db.execute<Raw & { share: string }>(sql`
      WITH months AS (
        SELECT date_trunc('month', voucher_date)::date AS m, sum(amount) AS total,
               sum(amount) FILTER (WHERE voucher_date >= (date_trunc('month', voucher_date) + interval '1 month' - interval '3 days')::date) AS tail
        FROM vouchers WHERE org_id = ${org} AND is_cancelled = false AND voucher_type = 'Sales' AND voucher_date BETWEEN ${from} AND ${to}
        GROUP BY 1
      )
      SELECT ${sel}, (mo.tail / nullif(mo.total, 0))::numeric(5,3)::text AS share
      FROM vouchers v JOIN months mo ON mo.m = date_trunc('month', v.voucher_date)::date
      WHERE ${base} AND v.is_cancelled = false AND v.voucher_type = 'Sales'
        AND v.voucher_date >= (mo.m + interval '1 month' - interval '3 days')::date
        AND mo.tail / nullif(mo.total, 0) > ${MONTH_END_SHARE}
    `);
    const oneOff = await this.db.execute<Raw>(sql`
      SELECT ${sel} FROM vouchers v
      WHERE ${base} AND v.is_cancelled = false AND v.voucher_type = 'Sales' AND v.amount >= ${MATERIALITY}
        AND NOT EXISTS (
          SELECT 1 FROM vouchers o WHERE o.org_id = v.org_id AND o.voucher_type = 'Sales' AND o.is_cancelled = false
            AND o.id <> v.id AND coalesce(o.party_id::text, o.party_name) = coalesce(v.party_id::text, v.party_name)
            AND o.voucher_date > (${today}::date - 365)
        )
    `);
    const dormantActive = await this.db.execute<Raw>(sql`
      SELECT ${sel}, prev.last::text AS extra FROM vouchers v
      JOIN LATERAL (
        SELECT max(o.voucher_date) AS last FROM vouchers o
        WHERE o.org_id = v.org_id AND o.voucher_type = 'Sales' AND o.is_cancelled = false
          AND o.party_id = v.party_id AND o.voucher_date < v.voucher_date
      ) prev ON true
      WHERE ${base} AND v.is_cancelled = false AND v.voucher_type = 'Sales' AND v.party_id IS NOT NULL
        AND prev.last IS NOT NULL AND v.voucher_date - prev.last >= 180
    `);
    const sequence = await this.db.execute<Raw & { previous: string | null }>(sql`
      SELECT * FROM (
        SELECT ${sel},
               lag(v.voucher_number) OVER (PARTITION BY v.voucher_type ORDER BY v.voucher_date, v.voucher_number) AS previous
        FROM vouchers v WHERE ${base} AND v.voucher_type = 'Sales'
      ) s WHERE previous IS NOT NULL
    `);

    const reviews = await this.db.execute<{ checkKey: string; voucherId: string; state: string; reason: string; reviewedAt: string }>(sql`
      SELECT check_key AS "checkKey", voucher_id AS "voucherId", state, reason, reviewed_at::text AS "reviewedAt"
      FROM cfo_exception_reviews WHERE org_id = ${org}
    `);
    const reviewOf = new Map(reviews.rows.map((r) => [`${r.checkKey}:${r.voucherId}`, r]));
    const row = (key: string, r: Raw, reason: string): ExceptionRow => {
      const review = reviewOf.get(`${key}:${r.id}`);
      return {
        checkKey: key,
        voucherId: r.id,
        voucherNumber: r.number,
        voucherType: r.type,
        voucherDate: r.date,
        party: r.party,
        partyId: r.partyId,
        amount: r.amount,
        reason,
        review: review === undefined ? null : { state: review.state, reason: review.reason, reviewedAt: review.reviewedAt },
      };
    };
    const numberTail = (n: string): number | null => {
      const m = /(\d+)\s*$/u.exec(n);
      return m?.[1] === undefined ? null : Number(m[1]);
    };
    const gaps = sequence.rows.filter((r) => {
      const a = numberTail(r.previous ?? '');
      const b = numberTail(r.number);
      return a !== null && b !== null && b - a > 1 && b - a < 1000;
    });

    const checks: ExceptionCheck[] = [
      { key: 'duplicate-invoice', label: 'Duplicate invoice', hint: 'Same party, date and value on two Sales vouchers.', available: true,
        rows: duplicates.rows.filter((r) => Number(r.extra ?? 1) > 1).map((r) => row('duplicate-invoice', r, `${r.extra ?? ''} vouchers share this party, date and value`)) },
      { key: 'cancelled', label: 'Cancelled vouchers', hint: 'Cancelled in Tally inside the period.', available: true,
        rows: cancelled.rows.map((r) => row('cancelled', r, 'Cancelled in Tally')) },
      { key: 'same-day-return', label: 'Same-day sale and return', hint: 'A credit note on the day of the sale.', available: true,
        rows: sameDay.rows.map((r) => row('same-day-return', r, `Credit note ${r.extra ?? ''} on the same day`)) },
      { key: 'no-gstin', label: 'Sales above threshold without GSTIN', hint: `Sales of ${NO_GSTIN_THRESHOLD.toLocaleString('en-IN')} or more to a party with no GSTIN.`, available: true,
        rows: noGstin.rows.map((r) => row('no-gstin', r, 'Party has no GSTIN on the master')) },
      { key: 'backdated', label: 'Backdated vouchers', hint: `Entered more than ${String(BACKDATED_DAYS)} days after the voucher date (as far as the pull can tell).`, available: true,
        rows: backdated.rows.map((r) => row('backdated', r, `Entered ${r.extra ?? ''} days after its date`)) },
      { key: 'month-end', label: 'Sales concentrated at month end', hint: `More than ${String(MONTH_END_SHARE * 100)}% of a month's sales in its last three days -- a cut-off signal.`, available: true,
        rows: monthEnd.rows.map((r) => row('month-end', r, `${String(Math.round(Number(r.share) * 100))}% of the month fell in its last three days`)) },
      { key: 'one-off', label: 'One-off customers above materiality', hint: `A single sale of ${MATERIALITY.toLocaleString('en-IN')} or more to a party with no other sale in a year.`, available: true,
        rows: oneOff.rows.map((r) => row('one-off', r, 'The only sale to this party in twelve months')) },
      { key: 'dormant-active', label: 'Dormant ledger suddenly active', hint: 'A party quiet for 180 days or more, billed again.', available: true,
        rows: dormantActive.rows.map((r) => row('dormant-active', r, `Previous sale ${r.extra ?? ''}`)) },
      { key: 'sequence-gap', label: 'Invoice numbering gaps', hint: 'A jump in the running number between consecutive Sales vouchers.', available: true,
        rows: gaps.map((r) => row('sequence-gap', r, `Follows ${r.previous ?? ''}`)) },
      { key: 'modified-after-approval', label: 'Modified after approval', hint: 'Needs the user and timestamp of Tally edits.', available: false, rows: [], note: 'The sync carries alter ids, not the editing user; arrives with the Tally audit feature.' },
      { key: 'price-override', label: 'Price override without approval', hint: 'Needs the approval trail on the voucher.', available: false, rows: [], note: 'Arrives with the pricing approval flow.' },
      { key: 'negative-stock', label: 'Negative stock', hint: 'Needs stock balances by godown.', available: false, rows: [], note: 'The sync does not carry godown stock yet (K2).' },
      { key: 'credit-note-unlinked', label: 'Credit note with no linked invoice', hint: 'Needs bill references on credit notes.', available: false, rows: [], note: 'Awaits M4 (credit note linkage).' },
    ];
    const open = checks.reduce((n, c) => n + c.rows.filter((r) => r.review === null).length, 0);
    return { asOf: today, from, to, checks, open };
  }

  async review(principal: Principal, checkKey: string, voucherId: string, state: ExceptionState, reason: string): Promise<void> {
    if (state === 'accepted' && reason.trim() === '') throw AppError.validation('Accepting an exception needs a reason.');
    const voucher = await this.db.execute<{ id: string }>(sql`SELECT id FROM vouchers WHERE org_id = ${principal.orgId} AND id = ${voucherId}`);
    if (voucher.rows[0] === undefined) throw AppError.notFound('voucher', voucherId);
    await this.db.execute(sql`
      INSERT INTO cfo_exception_reviews (org_id, check_key, voucher_id, state, reason, reviewed_by)
      VALUES (${principal.orgId}, ${checkKey}, ${voucherId}, ${state}, ${reason.trim()}, ${principal.userId})
      ON CONFLICT (org_id, check_key, voucher_id) DO UPDATE SET state = ${state}, reason = ${reason.trim()}, reviewed_by = ${principal.userId}, reviewed_at = now()
    `);
    await this.audit.write({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'cfo.exception.reviewed',
      entityType: 'voucher',
      entityId: voucherId,
      before: null,
      after: { checkKey, state, reason: reason.trim() },
    });
  }
}
