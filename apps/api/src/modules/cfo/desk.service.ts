import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PERMISSIONS } from '@vyuha/shared';

import { AppError } from '../../platform/common/errors.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { hasPermission, type Principal } from '../../platform/rbac/principal.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { CreditControlService, type WorkListRow } from './credit-control.service.js';
import { DESK_THEMES, REASON_PRIORITY, THEME_LISTS, deskScore, type DeskScore, type DeskThemeKey } from './desk-score.js';
import { readDelta, type DeltaReading } from './robustness.js';

/**
 * The Director's Desk (brief Part O): twenty work lists collapsed into one
 * ranked, deduplicated, capped list -- a name, a reason, a rupee figure, an
 * owner. One customer appears once a day with their single loudest reason
 * and every other reason underneath (O1). Outcomes are the list's memory
 * (O4.1): they feed the cooldown and the yesterday strip, and without them
 * the list would be a static report within a month.
 *
 * K3 at the door: a director sees the whole list; a salesperson sees the
 * names in their own book.
 */

export const DESK_OUTCOMES = [
  'ORDER_PLACED',
  'PROMISE_TO_PAY',
  'PARTIAL_PAYMENT',
  'NO_RESPONSE',
  'DISPUTE_RAISED',
  'NOT_INTERESTED',
  'WRONG_CONTACT',
  'CALL_AGAIN',
] as const;
export type DeskOutcome = (typeof DESK_OUTCOMES)[number];

export interface DeskReason {
  readonly key: string;
  readonly label: string;
  readonly reason: string;
  readonly amount: string;
}

export interface DeskRow {
  readonly rank: number;
  readonly partyId: string;
  readonly party: string;
  readonly ownerRef: string | null;
  readonly ownerLabel: string;
  readonly primary: DeskReason;
  readonly others: readonly DeskReason[];
  readonly atStake: string;
  readonly score: number;
  readonly breakdown: DeskScore['breakdown'];
  readonly lastContact: { on: string; outcome: string } | null;
}

export interface DeskToday {
  readonly date: string;
  readonly theme: { key: DeskThemeKey; label: string; hint: string };
  readonly mixed: boolean;
  readonly cap: number;
  readonly strip: { called: number; outcomes: number; collected: string; orders: number; orderValue: string };
  readonly rows: readonly DeskRow[];
  /** Names that qualified today before the cap and the rotation rules. */
  readonly qualified: number;
}

export interface CallSheet {
  readonly party: { id: string; name: string; ownerLabel: string; creditLimit: string | null; since: string | null };
  readonly why: { primary: DeskReason | null; others: readonly DeskReason[] };
  readonly numbers: {
    thisYear: string;
    lastYear: string;
    delta: DeltaReading;
    outstanding: string;
    overdue: string;
    ageing: Record<string, string>;
    maxDaysOverdue: number;
    delayCostPerYear: string;
    promisesMade: number;
    promisesKept: number;
  };
  readonly buys: {
    top: readonly { group: string; share: number; net: string }[];
    stopped: readonly { group: string; lastYear: string }[];
    /** Cross-sell arrives with Phase 5; null says so rather than guessing. */
    shouldBuy: null;
  };
  readonly lastContact: { on: string; outcome: string; notes: string; ownerLabel: string } | null;
  readonly asks: readonly string[];
  readonly recent: readonly { on: string; outcome: string; amount: string | null; nextDate: string | null; notes: string }[];
}

const MATERIALITY_FLOOR = 25_000;
const COOLDOWN_DAYS = 14;
const NO_REPEAT_DAYS = 7;
const OWNER_SHARE_CAP = 0.4;
const BUCKETS = ['current', '0-30', '31-60', '61-90', '91-180', '180+'] as const;

const dayGap = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const shiftDays = (day: string, n: number): string => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);

@Injectable()
export class DeskService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly credit: CreditControlService,
  ) {}

  /** Current owner per party, the owner map first, the RM assignment behind it. */
  private async ownersOf(principal: Principal): Promise<Map<string, { ref: string; label: string }>> {
    const rows = await this.db.execute<{ partyId: string; ref: string; email: string | null; source: number }>(sql`
      SELECT party_id AS "partyId", owner_ref AS ref, u.email, 1 AS source
      FROM customer_owner_map m LEFT JOIN users u ON u.id::text = substr(m.owner_ref, 6)
      WHERE m.org_id = ${principal.orgId} AND m.effective_from <= now()::date
        AND (m.effective_to IS NULL OR m.effective_to >= now()::date)
      UNION ALL
      SELECT pm.party_id, 'user:' || u.id, u.email, 2
      FROM party_managers pm JOIN users u ON u.employee_id = pm.manager_id
      WHERE pm.org_id = ${principal.orgId} AND pm.deleted_at IS NULL
      ORDER BY 4
    `);
    const owners = new Map<string, { ref: string; label: string }>();
    for (const row of rows.rows) {
      if (owners.has(row.partyId)) continue;
      const label = row.ref === 'HOUSE' ? 'House' : (row.email?.split('@')[0] ?? 'Former user');
      owners.set(row.partyId, { ref: row.ref, label });
    }
    return owners;
  }

  private async myBook(principal: Principal): Promise<Set<string> | null> {
    if (hasPermission(principal, PERMISSIONS.CFO_TEAM_VIEW)) return null;
    const rows = await this.db.execute<{ partyId: string }>(sql`
      SELECT party_id AS "partyId" FROM customer_owner_map
      WHERE org_id = ${principal.orgId} AND owner_ref = ${'user:' + principal.userId}
        AND effective_from <= now()::date AND (effective_to IS NULL OR effective_to >= now()::date)
      UNION
      SELECT pm.party_id FROM party_managers pm JOIN users u ON u.employee_id = pm.manager_id
      WHERE pm.org_id = ${principal.orgId} AND pm.deleted_at IS NULL AND u.id = ${principal.userId}
    `);
    return new Set(rows.rows.map((r) => r.partyId));
  }

  async today(principal: Principal, options: { cap: number; mixed: boolean }): Promise<DeskToday> {
    const today = istDateOf(new Date().toISOString());
    const weekday = new Date(Date.parse(today)).getUTCDay();
    const themed = weekday >= 1 && weekday <= 5 ? DESK_THEMES[weekday as 1 | 2 | 3 | 4 | 5] : null;
    const mixed = options.mixed || themed === null;
    const theme = mixed
      ? { key: 'mixed' as const, label: weekday === 6 ? 'Week close' : 'Mixed', hint: 'The top names by score, whatever the reason.' }
      : { key: themed.key, label: themed.label, hint: themed.hint };

    const lists = await this.credit.workLists(principal);
    const listLabel = new Map(lists.lists.map((l) => [l.key, l.label]));
    const allowed = mixed ? null : new Set(THEME_LISTS[theme.key as keyof typeof THEME_LISTS]);

    // One customer, every reason.
    const reasons = new Map<string, { party: string; reasons: DeskReason[] }>();
    for (const list of lists.lists) {
      if (allowed !== null && !allowed.has(list.key)) continue;
      for (const row of list.rows) {
        if (row.partyId === null) continue;
        const entry = reasons.get(row.partyId) ?? { party: row.party, reasons: [] };
        entry.reasons.push({ key: list.key, label: listLabel.get(list.key) ?? list.key, reason: row.reason, amount: row.amount });
        reasons.set(row.partyId, entry);
      }
    }
    const book = await this.myBook(principal);
    const candidates = [...reasons.entries()].filter(([partyId]) => book === null || book.has(partyId));
    const qualified = candidates.length;
    if (candidates.length === 0) {
      return { date: today, theme, mixed, cap: options.cap, strip: await this.strip(principal, today), rows: [], qualified };
    }

    const ids = candidates.map(([id]) => id);
    const signals = await this.signals(principal, ids, today);
    const owners = await this.ownersOf(principal);
    const served = await this.db.execute<{ partyId: string; reason: string }>(sql`
      SELECT party_id AS "partyId", reason FROM cfo_desk_served
      WHERE org_id = ${principal.orgId} AND party_id IN ${ids}
        AND served_on BETWEEN ${shiftDays(today, -NO_REPEAT_DAYS)} AND ${shiftDays(today, -1)}
    `);
    const servedReason = new Map(served.rows.map((r) => [r.partyId, r.reason]));

    const scored = candidates
      .map(([partyId, entry]) => {
        const ordered = [...entry.reasons].sort((a, b) => REASON_PRIORITY.indexOf(a.key) - REASON_PRIORITY.indexOf(b.key));
        const primary = ordered[0];
        if (primary === undefined) return null;
        const sig = signals.get(partyId);
        const contact = sig?.lastContact ?? null;
        // CALL_AGAIN with a date: not before that date, and never on cooldown after it.
        if (contact?.outcome === 'CALL_AGAIN' && contact.nextDate !== null && contact.nextDate > today) return null;
        const escalated = contact?.outcome === 'CALL_AGAIN' && contact.nextDate !== null && contact.nextDate <= today;
        const onCooldown = !escalated && contact !== null && dayGap(contact.on, today) < COOLDOWN_DAYS && contact.outcome !== 'ORDER_PLACED' && contact.outcome !== 'PARTIAL_PAYMENT';
        // No repeat within a week unless the primary reason escalated.
        const lastServedReason = servedReason.get(partyId);
        if (lastServedReason !== undefined && !escalated && REASON_PRIORITY.indexOf(primary.key) >= REASON_PRIORITY.indexOf(lastServedReason)) return null;
        const score = deskScore({
          value12m: sig?.value12m ?? 0,
          maxValue12m: signals.max,
          daysOverdue: sig?.daysOverdue ?? 0,
          daysPastGap: sig?.daysPastGap ?? 0,
          brokenPromises: sig?.brokenPromises ?? 0,
          utilisationPct: sig?.utilisationPct ?? 0,
          opportunityValue: 0,
          maxOpportunityValue: 0,
          onCooldown,
        });
        const owner = owners.get(partyId) ?? null;
        return {
          partyId,
          party: entry.party,
          ownerRef: owner?.ref ?? null,
          ownerLabel: owner?.label ?? 'Unassigned',
          primary,
          others: ordered.slice(1),
          atStake: primary.amount,
          score: score.score,
          breakdown: score.breakdown,
          lastContact: contact === null ? null : { on: contact.on, outcome: contact.outcome },
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score);

    // Owner balance: no owner takes more than 40% of the day. Dormant
    // injection: at least one quiet name a day if any qualified.
    const cap = options.cap;
    const perOwnerCap = Math.max(1, Math.floor(cap * OWNER_SHARE_CAP));
    const taken = new Map<string, number>();
    const chosen: typeof scored = [];
    const dormant = scored.find((r) => r.primary.key === 'silent-churn');
    if (dormant !== undefined) {
      chosen.push(dormant);
      taken.set(dormant.ownerRef ?? 'UNASSIGNED', 1);
    }
    for (const row of scored) {
      if (chosen.length >= cap) break;
      if (chosen.includes(row)) continue;
      const key = row.ownerRef ?? 'UNASSIGNED';
      if ((taken.get(key) ?? 0) >= perOwnerCap && key !== 'UNASSIGNED') continue;
      chosen.push(row);
      taken.set(key, (taken.get(key) ?? 0) + 1);
    }
    const rows: DeskRow[] = chosen.sort((a, b) => b.score - a.score).map((r, index) => ({ ...r, rank: index + 1 }));

    // The served log is what tomorrow's rotation reads.
    for (const row of rows) {
      await this.db.execute(sql`
        INSERT INTO cfo_desk_served (org_id, party_id, served_on, score, reason)
        VALUES (${principal.orgId}, ${row.partyId}, ${today}, ${row.score}, ${row.primary.key})
        ON CONFLICT (org_id, served_on, party_id) DO UPDATE SET score = ${row.score}, reason = ${row.primary.key}
      `);
    }

    return { date: today, theme, mixed, cap, strip: await this.strip(principal, today), rows, qualified };
  }

  /** O5.1's strip: what yesterday's list produced. */
  private async strip(principal: Principal, today: string): Promise<DeskToday['strip']> {
    const yesterday = shiftDays(today, -1);
    const rows = await this.db.execute<{ called: number; outcomes: number; collected: string | null; orders: number; orderValue: string | null }>(sql`
      SELECT count(DISTINCT party_id)::int AS called, count(*)::int AS outcomes,
             sum(amount) FILTER (WHERE outcome IN ('PARTIAL_PAYMENT'))::numeric(16,2)::text AS collected,
             count(*) FILTER (WHERE outcome = 'ORDER_PLACED')::int AS orders,
             sum(amount) FILTER (WHERE outcome = 'ORDER_PLACED')::numeric(16,2)::text AS "orderValue"
      FROM cfo_desk_outcomes WHERE org_id = ${principal.orgId} AND logged_on = ${yesterday}
    `);
    const r = rows.rows[0];
    return {
      called: r?.called ?? 0,
      outcomes: r?.outcomes ?? 0,
      collected: r?.collected ?? '0.00',
      orders: r?.orders ?? 0,
      orderValue: r?.orderValue ?? '0.00',
    };
  }

  private async signals(principal: Principal, ids: readonly string[], today: string): Promise<
    Map<string, { value12m: number; daysOverdue: number; daysPastGap: number; brokenPromises: number; utilisationPct: number; lastContact: { on: string; outcome: string; nextDate: string | null } | null }> & { max: number }
  > {
    const value = await this.db.execute<{ partyId: string; net: string }>(sql`
      SELECT party_id AS "partyId",
             sum(CASE WHEN voucher_type = 'Sales' THEN amount ELSE -amount END)::numeric(16,2)::text AS net
      FROM vouchers WHERE org_id = ${principal.orgId} AND is_cancelled = false AND party_id IS NOT NULL
        AND voucher_type IN ('Sales', 'Credit Note') AND voucher_date > (${today}::date - 365)
      GROUP BY 1
    `);
    const overdue = await this.db.execute<{ partyId: string; days: number; outstanding: string; creditLimit: string | null }>(sql`
      WITH latest AS (SELECT max(snapshot_date) AS d FROM fact_receivable_snapshot WHERE org_id = ${principal.orgId})
      SELECT f.party_id AS "partyId", max(f.days_overdue)::int AS days, sum(f.outstanding)::numeric(16,2)::text AS outstanding,
             max(p.credit_limit)::text AS "creditLimit"
      FROM fact_receivable_snapshot f LEFT JOIN parties p ON p.id = f.party_id, latest
      WHERE f.org_id = ${principal.orgId} AND f.snapshot_date = latest.d AND f.party_id IN ${ids}
      GROUP BY 1
    `);
    const gaps = await this.db.execute<{ partyId: string; days: string[] }>(sql`
      SELECT party_id AS "partyId", array_agg(voucher_date::text ORDER BY voucher_date) AS days
      FROM vouchers WHERE org_id = ${principal.orgId} AND voucher_type = 'Sales' AND is_cancelled = false
        AND party_id IN ${ids} AND voucher_date > (${today}::date - 365)
      GROUP BY 1
    `);
    const broken = await this.db.execute<{ partyId: string; n: number }>(sql`
      SELECT party_id AS "partyId", count(*)::int AS n FROM promises_to_pay
      WHERE org_id = ${principal.orgId} AND deleted_at IS NULL AND state = 'broken' AND party_id IN ${ids}
      GROUP BY 1
    `);
    const contacts = await this.db.execute<{ partyId: string; on: string; outcome: string; nextDate: string | null }>(sql`
      SELECT DISTINCT ON (party_id) party_id AS "partyId", logged_on AS "on", outcome, next_date AS "nextDate"
      FROM cfo_desk_outcomes WHERE org_id = ${principal.orgId} AND party_id IN ${ids}
      ORDER BY party_id, logged_on DESC, created_at DESC
    `);

    const valueOf = new Map(value.rows.map((r) => [r.partyId, Number(r.net)]));
    const max = Math.max(0, ...value.rows.map((r) => Number(r.net)));
    const overdueOf = new Map(overdue.rows.map((r) => [r.partyId, r]));
    const brokenOf = new Map(broken.rows.map((r) => [r.partyId, r.n]));
    const contactOf = new Map(contacts.rows.map((r) => [r.partyId, r]));
    const gapOf = new Map<string, number>();
    for (const row of gaps.rows) {
      const days = row.days;
      if (days.length < 5) continue;
      const diffs = days.slice(1).map((d, i) => dayGap(days[i] ?? d, d)).sort((a, b) => a - b);
      const med = diffs[Math.floor(diffs.length / 2)] ?? 0;
      const since = dayGap(days.at(-1) ?? today, today);
      gapOf.set(row.partyId, Math.max(0, since - med));
    }

    const map = new Map() as Map<string, { value12m: number; daysOverdue: number; daysPastGap: number; brokenPromises: number; utilisationPct: number; lastContact: { on: string; outcome: string; nextDate: string | null } | null }> & { max: number };
    for (const id of ids) {
      const od = overdueOf.get(id);
      const limit = od?.creditLimit === null || od?.creditLimit === undefined ? 0 : Number(od.creditLimit);
      const contact = contactOf.get(id);
      map.set(id, {
        value12m: valueOf.get(id) ?? 0,
        daysOverdue: od?.days ?? 0,
        daysPastGap: gapOf.get(id) ?? 0,
        brokenPromises: brokenOf.get(id) ?? 0,
        utilisationPct: limit > 0 && od !== undefined ? Math.round((Number(od.outstanding) / limit) * 100) : 0,
        lastContact: contact === undefined ? null : { on: contact.on, outcome: contact.outcome, nextDate: contact.nextDate },
      });
    }
    map.max = max;
    return map;
  }

  /** O4: the one-page brief. Every figure already exists elsewhere; this assembles it. */
  async callSheet(principal: Principal, partyId: string): Promise<CallSheet> {
    const book = await this.myBook(principal);
    if (book !== null && !book.has(partyId)) throw AppError.forbidden('This customer is not in your book.');
    const today = istDateOf(new Date().toISOString());
    const party = await this.db.execute<{ id: string; name: string; creditLimit: string | null; since: string | null }>(sql`
      SELECT p.id, p.name, p.credit_limit::text AS "creditLimit",
             (SELECT min(voucher_date)::text FROM vouchers v WHERE v.org_id = p.org_id AND v.party_id = p.id AND v.voucher_type = 'Sales') AS since
      FROM parties p WHERE p.org_id = ${principal.orgId} AND p.id = ${partyId} LIMIT 1
    `);
    const p = party.rows[0];
    if (p === undefined) throw AppError.notFound('party', partyId);
    const owner = (await this.ownersOf(principal)).get(partyId);
    const rate = (await this.settings.read(principal)).interest.annualRatePct;

    const lists = await this.credit.workLists(principal);
    const reasons: DeskReason[] = [];
    for (const list of lists.lists) {
      const row: WorkListRow | undefined = list.rows.find((r) => r.partyId === partyId);
      if (row !== undefined) reasons.push({ key: list.key, label: list.label, reason: row.reason, amount: row.amount });
    }
    reasons.sort((a, b) => REASON_PRIORITY.indexOf(a.key) - REASON_PRIORITY.indexOf(b.key));

    const fyStart = (() => {
      const [y, m] = today.split('-').map(Number);
      return `${String((m ?? 1) >= 4 ? y : (y ?? 0) - 1)}-04-01`;
    })();
    const lyStart = `${String(Number(fyStart.slice(0, 4)) - 1)}-04-01`;
    const lyEnd = `${String(Number(today.slice(0, 4)) - 1)}${today.slice(4)}`;
    const years = await this.db.execute<{ kind: string; net: string }>(sql`
      SELECT CASE WHEN voucher_date >= ${fyStart} THEN 'ty' ELSE 'ly' END AS kind,
             sum(CASE WHEN voucher_type = 'Sales' THEN amount ELSE -amount END)::numeric(16,2)::text AS net
      FROM vouchers WHERE org_id = ${principal.orgId} AND party_id = ${partyId} AND is_cancelled = false
        AND voucher_type IN ('Sales', 'Credit Note')
        AND (voucher_date BETWEEN ${fyStart} AND ${today} OR voucher_date BETWEEN ${lyStart} AND ${lyEnd})
      GROUP BY 1
    `);
    const ty = Number(years.rows.find((r) => r.kind === 'ty')?.net ?? 0);
    const ly = Number(years.rows.find((r) => r.kind === 'ly')?.net ?? 0);

    const ageingRows = await this.db.execute<{ bucket: string; value: string; days: number }>(sql`
      WITH latest AS (SELECT max(snapshot_date) AS d FROM fact_receivable_snapshot WHERE org_id = ${principal.orgId})
      SELECT bucket, sum(outstanding)::numeric(16,2)::text AS value, max(days_overdue)::int AS days
      FROM fact_receivable_snapshot, latest
      WHERE org_id = ${principal.orgId} AND snapshot_date = latest.d AND party_id = ${partyId}
      GROUP BY 1
    `);
    const ageing: Record<string, string> = {};
    let outstanding = 0;
    let overdue = 0;
    let maxDays = 0;
    for (const bucket of BUCKETS) {
      const row = ageingRows.rows.find((r) => r.bucket === bucket);
      ageing[bucket] = row?.value ?? '0.00';
      outstanding += Number(row?.value ?? 0);
      if (bucket !== 'current') overdue += Number(row?.value ?? 0);
      maxDays = Math.max(maxDays, row?.days ?? 0);
    }

    const promises = await this.db.execute<{ made: number; kept: number }>(sql`
      SELECT count(*)::int AS made, count(*) FILTER (WHERE state IN ('kept', 'partially_kept'))::int AS kept
      FROM promises_to_pay WHERE org_id = ${principal.orgId} AND deleted_at IS NULL AND party_id = ${partyId}
    `);

    // What they buy: item groups this FY, and groups bought last FY but not this.
    const groups = await this.db.execute<{ group: string; ty: string; ly: string }>(sql`
      SELECT coalesce(s.parent_group, 'Ungrouped') AS "group",
             sum(CASE WHEN v.voucher_date >= ${fyStart} THEN abs(l.amount) ELSE 0 END)::numeric(16,2)::text AS ty,
             sum(CASE WHEN v.voucher_date < ${fyStart} THEN abs(l.amount) ELSE 0 END)::numeric(16,2)::text AS ly
      FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id LEFT JOIN stock_items s ON s.id = l.stock_item_id
      WHERE v.org_id = ${principal.orgId} AND v.party_id = ${partyId} AND v.is_cancelled = false
        AND v.voucher_type = 'Sales' AND l.kind = 'inventory' AND v.voucher_date >= ${lyStart}
      GROUP BY 1
    `);
    const tyTotal = groups.rows.reduce((sum, g) => sum + Number(g.ty), 0);
    const top = groups.rows
      .filter((g) => Number(g.ty) > 0)
      .sort((a, b) => Number(b.ty) - Number(a.ty))
      .slice(0, 5)
      .map((g) => ({ group: g.group, share: tyTotal === 0 ? 0 : Math.round((Number(g.ty) / tyTotal) * 100), net: g.ty }));
    const stopped = groups.rows
      .filter((g) => Number(g.ty) === 0 && Number(g.ly) > 0)
      .sort((a, b) => Number(b.ly) - Number(a.ly))
      .map((g) => ({ group: g.group, lastYear: g.ly }));

    const recent = await this.db.execute<{ on: string; outcome: string; amount: string | null; nextDate: string | null; notes: string; ownerRef: string }>(sql`
      SELECT logged_on AS "on", outcome, amount::text AS amount, next_date AS "nextDate", notes, owner_ref AS "ownerRef"
      FROM cfo_desk_outcomes WHERE org_id = ${principal.orgId} AND party_id = ${partyId}
      ORDER BY logged_on DESC, created_at DESC LIMIT 5
    `);
    const last = recent.rows[0];
    const lastOwner = last === undefined ? null : await this.db.execute<{ email: string }>(sql`
      SELECT email FROM users WHERE id::text = substr(${last.ownerRef}, 6) LIMIT 1
    `);

    // Suggested asks, from the same figures: the largest overdue bucket to
    // collect, the largest stopped line to reopen.
    const asks: string[] = [];
    const heaviest = (['31-60', '61-90', '91-180', '180+', '0-30'] as const)
      .map((b) => ({ b, v: Number(ageing[b] ?? 0) }))
      .sort((a, b) => b.v - a.v)[0];
    if (heaviest !== undefined && heaviest.v > 0) asks.push(`Collect ${money(heaviest.v)} (the ${heaviest.b} bucket) before month end`);
    const firstStopped = stopped[0];
    if (firstStopped !== undefined) asks.push(`Reopen ${firstStopped.group} — ${money(Number(firstStopped.lastYear))} last year`);
    if (p.creditLimit !== null && Number(p.creditLimit) > 0 && outstanding > Number(p.creditLimit)) {
      asks.push(`Hold new confirmations until below the ${money(Number(p.creditLimit))} limit`);
    }

    return {
      party: { id: p.id, name: p.name, ownerLabel: owner?.label ?? 'Unassigned', creditLimit: p.creditLimit, since: p.since },
      why: { primary: reasons[0] ?? null, others: reasons.slice(1) },
      numbers: {
        thisYear: ty.toFixed(2),
        lastYear: ly.toFixed(2),
        delta: readDelta(ty, ly, MATERIALITY_FLOOR),
        outstanding: outstanding.toFixed(2),
        overdue: overdue.toFixed(2),
        ageing,
        maxDaysOverdue: maxDays,
        delayCostPerYear: ((overdue * rate) / 100).toFixed(2),
        promisesMade: promises.rows[0]?.made ?? 0,
        promisesKept: promises.rows[0]?.kept ?? 0,
      },
      buys: { top, stopped, shouldBuy: null },
      lastContact: last === undefined ? null : { on: last.on, outcome: last.outcome, notes: last.notes, ownerLabel: lastOwner?.rows[0]?.email.split('@')[0] ?? 'Former user' },
      asks,
      recent: recent.rows.map((r) => ({ on: r.on, outcome: r.outcome, amount: r.amount, nextDate: r.nextDate, notes: r.notes })),
    };
  }

  /** O4.1: the outcome, mandatory before a name is done. */
  async logOutcome(
    principal: Principal,
    partyId: string,
    body: { outcome: DeskOutcome; amount?: string; nextDate?: string; notes?: string },
  ): Promise<void> {
    const book = await this.myBook(principal);
    if (book !== null && !book.has(partyId)) throw AppError.forbidden('This customer is not in your book.');
    if (body.outcome === 'CALL_AGAIN' && body.nextDate === undefined) throw AppError.validation('Call again needs a date.');
    const exists = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM parties WHERE org_id = ${principal.orgId} AND id = ${partyId} LIMIT 1
    `);
    if (exists.rows[0] === undefined) throw AppError.notFound('party', partyId);
    const today = istDateOf(new Date().toISOString());
    await this.db.execute(sql`
      INSERT INTO cfo_desk_outcomes (org_id, party_id, owner_ref, outcome, amount, next_date, notes, logged_on)
      VALUES (${principal.orgId}, ${partyId}, ${'user:' + principal.userId}, ${body.outcome},
              ${body.amount ?? null}::numeric, ${body.nextDate ?? null}, ${body.notes ?? ''}, ${today})
    `);
    await this.audit.write({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'cfo.desk.outcome',
      entityType: 'party',
      entityId: partyId,
      before: null,
      after: { outcome: body.outcome, amount: body.amount ?? null, nextDate: body.nextDate ?? null },
    });
  }
}

function money(value: number): string {
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}
