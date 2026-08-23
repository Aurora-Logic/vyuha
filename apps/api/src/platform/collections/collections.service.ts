import { Injectable } from '@nestjs/common';
import {
  PERMISSIONS,
  type AssignCollectorInput,
  type AssignmentListQuery,
  type CollectorAssignmentView,
  type CollectorDashboard,
  type CollectorDashboardRow,
  type CreatePromiseInput,
  type DashboardQuery,
  type Paginated,
  type PromiseListQuery,
  type PromiseState,
  type PromiseView,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { hasPermission, orgContextOf, type Principal } from '../rbac/principal.js';
import { ScopeService } from '../rbac/scope.service.js';

/**
 * Area AJ: promises to pay, collector assignments, and the collector's
 * morning. A promise's state is read from the receipts Tally sent against
 * the named bills since it was taken (REQ-AJ-02) -- `against` allocation
 * rows are negative, so received is their sum negated -- and written back
 * only as a materialisation for the reports and the sweep. Nothing here
 * writes to a balance (REQ-AJ-12).
 *
 * Scope: `collections.view.self` is the parties assigned to me and the
 * promises I took; `.all` is everyone's. Resolved through ScopeService on
 * the collector, the way every other family is.
 */

const GRANTS = { self: PERMISSIONS.COLLECTIONS_VIEW_SELF, all: PERMISSIONS.COLLECTIONS_VIEW_ALL } as const;

type PromiseRow = {
  id: string;
  party_id: string;
  party_name: string;
  amount: string;
  promised_date: string;
  bills: string[] | null;
  taken_by: string | null;
  taken_by_name: string | null;
  taken_on: string;
  notes: string | null;
  received: string;
  received_on: string | null;
  collector_id: string | null;
  collector_name: string | null;
  created_at: Date | string;
};

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function money(value: string | number): string {
  return Number(value).toFixed(2);
}

/** REQ-AJ-02, the rule itself: open until the date; then kept, partly kept, or broken by what arrived. */
export function promiseStateOf(amount: number, received: number, promisedDate: string, today: string): PromiseState {
  if (received >= amount - 0.005) return 'kept';
  if (today <= promisedDate) return 'open';
  return received > 0.005 ? 'partially_kept' : 'broken';
}

@Injectable()
export class CollectionsService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly scopes: ScopeService,
    private readonly auditContext: AuditContext,
  ) {}

  // -------------------------------------------------------------- promises

  async takePromise(principal: Principal, input: CreatePromiseInput): Promise<PromiseView> {
    const ctx = orgContextOf(principal);
    const party = await this.db.execute<{ id: string }>(sql`SELECT id FROM parties WHERE org_id = ${ctx.orgId} AND id = ${input.partyId}`).then((r) => r.rows[0]);
    if (party === undefined) throw AppError.notFound('Party', input.partyId);
    const takenOn = input.takenOn ?? new Date().toISOString().slice(0, 10);
    if (input.promisedDate < takenOn) throw AppError.validation('A promise is for a date on or after the day it was taken.', { fields: [{ path: 'promisedDate', message: 'before the day taken' }] });
    // Spelled as ARRAY[...] rather than a bound JS array: the driver's own
    // array serialisation is one more thing between the input and the column,
    // and this way each bill name is its own parameter.
    const bills = input.bills.length === 0 ? sql`'{}'::text[]` : sql`ARRAY[${sql.join(input.bills.map((bill) => sql`${bill}`), sql`, `)}]::text[]`;
    const inserted = await this.db.execute<{ id: string }>(sql`
      INSERT INTO promises_to_pay (org_id, party_id, amount, promised_date, bills, taken_by, taken_on, notes, created_by, updated_by)
      VALUES (${ctx.orgId}, ${input.partyId}, ${input.amount}, ${input.promisedDate}, ${bills}, ${principal.employeeId}, ${takenOn}, ${input.notes ?? null}, ${ctx.actorUserId}, ${ctx.actorUserId})
      RETURNING id
    `);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('Promise insert returned no row.');
    this.auditContext.record({ action: 'collections.promise.taken', entityType: 'promise_to_pay', entityId: id, before: null, after: { partyId: input.partyId, amount: input.amount, promisedDate: input.promisedDate, bills: input.bills } });
    const view = await this.findPromise(principal, id);
    await this.materialise([view]);
    return view;
  }

  async findPromise(principal: Principal, id: string): Promise<PromiseView> {
    const page = await this.promises(principal, { page: 1, pageSize: 1 }, sql`p.id = ${id}`);
    const found = page.data[0];
    if (found === undefined) throw AppError.notFound('Promise', id);
    return found;
  }

  async listPromises(principal: Principal, query: PromiseListQuery): Promise<Paginated<PromiseView>> {
    return this.promises(principal, query, sql`TRUE`);
  }

  private async promises(principal: Principal, query: PromiseListQuery, extra: SQL): Promise<Paginated<PromiseView>> {
    const orgId = principal.orgId;
    const offset = (query.page - 1) * query.pageSize;
    const scope = this.scopeWhere(principal);
    // The state is derived rather than written, but it is derived from
    // columns -- so it is derived in SQL, which is where a filter on it has
    // to be applied. Deriving it in JavaScript after LIMIT and OFFSET
    // filtered a single page: asking for the broken promises returned
    // whichever of the first twenty happened to be broken, above a total that
    // counted only those, so the list looked short and the count agreed with
    // it. Both now read the whole set. `promiseStateOf` still states the rule
    // for the sweep and the credit flag; the test below pins the two to the
    // same answer.
    const today = new Date().toISOString().slice(0, 10);
    const where = sql`p.org_id = ${orgId} AND p.deleted_at IS NULL AND ${extra} AND ${scope}
      ${query.partyId === undefined ? sql`` : sql`AND p.party_id = ${query.partyId}`}
      ${query.collectorId === undefined ? sql`` : sql`AND ca.collector_id = ${query.collectorId}`}
      ${query.from === undefined ? sql`` : sql`AND p.promised_date >= ${query.from}::date`}
      ${query.to === undefined ? sql`` : sql`AND p.promised_date <= ${query.to}::date`}`;
    const body = sql`
      SELECT p.id, p.party_id, pa.name AS party_name, p.amount::text, p.promised_date::text, p.bills, p.taken_by,
             nullif(concat_ws(' ', te.first_name, te.last_name), '') AS taken_by_name, p.taken_on::text, p.notes, p.created_at,
             ca.collector_id, nullif(concat_ws(' ', ce.first_name, ce.last_name), '') AS collector_name,
             r.received::text AS received, r.received_on::text AS received_on,
             CASE
               WHEN coalesce(r.received, 0) >= p.amount - 0.005 THEN 'kept'
               WHEN ${today}::date <= p.promised_date THEN 'open'
               WHEN coalesce(r.received, 0) > 0.005 THEN 'partially_kept'
               ELSE 'broken' END AS state
        FROM promises_to_pay p
        JOIN parties pa ON pa.id = p.party_id
        LEFT JOIN employees te ON te.id = p.taken_by
        LEFT JOIN collector_assignments ca ON ca.org_id = p.org_id AND ca.party_id = p.party_id AND ca.deleted_at IS NULL
        LEFT JOIN employees ce ON ce.id = ca.collector_id
        LEFT JOIN LATERAL (${this.receiptsFor()}) r ON TRUE
       WHERE ${where}`;
    const stateFilter = query.state === undefined ? sql`TRUE` : sql`t.state = ${query.state}`;
    const [rows, total] = await Promise.all([
      this.db.execute<PromiseRow>(sql`SELECT * FROM (${body}) t WHERE ${stateFilter} ORDER BY t.promised_date DESC, t.created_at DESC LIMIT ${query.pageSize} OFFSET ${offset}`),
      // Counted through the same body, so the count and the rows can never
      // disagree about which promises exist.
      this.db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM (${body}) t WHERE ${stateFilter}`),
    ]);
    const data = rows.rows.map((r): PromiseView => {
      const received = Number(r.received);
      const state = promiseStateOf(Number(r.amount), received, r.promised_date, today);
      return {
        id: r.id,
        partyId: r.party_id,
        partyName: r.party_name,
        amount: money(r.amount),
        promisedDate: r.promised_date,
        bills: r.bills ?? [],
        takenById: r.taken_by,
        takenByName: r.taken_by_name,
        takenOn: r.taken_on,
        notes: r.notes,
        state,
        receivedAmount: money(received),
        receivedOn: r.received_on,
        evaluatedAt: new Date().toISOString(),
        collectorId: r.collector_id,
        collectorName: r.collector_name,
        createdAt: iso(r.created_at) ?? '',
      };
    });
    return { data, meta: { page: query.page, pageSize: query.pageSize, total: total.rows[0]?.count ?? 0 } };
  }

  /** What arrived against the promise's bills (or from the party, when no bill was named) since it was taken: `against` rows negated. */
  private receiptsFor(): SQL {
    return sql`
      SELECT coalesce(sum(-b.amount), 0) AS received, max(v.voucher_date) AS received_on
        FROM bill_allocations b JOIN vouchers v ON v.id = b.voucher_id
       WHERE b.org_id = p.org_id AND b.party_id = p.party_id AND b.ref_type = 'against' AND NOT v.is_cancelled
         AND v.voucher_date >= p.taken_on
         AND (cardinality(p.bills) = 0 OR b.bill_name = ANY(p.bills))`;
  }

  /** REQ-AJ-02's materialisation: the derived state written back for the reports, the sweep and the credit flag. */
  async materialise(promises: readonly PromiseView[]): Promise<void> {
    for (const promise of promises) {
      await this.db.execute(sql`
        UPDATE promises_to_pay SET state = ${promise.state}, received_amount = ${promise.receivedAmount}, received_on = ${promise.receivedOn}, evaluated_at = now(), updated_at = now()
         WHERE id = ${promise.id}
      `);
    }
  }

  /**
   * Every promise in the organisation, re-read and written; the morning
   * sweep's work.
   *
   * `kept` used to be excluded, which made it absorbing: Tally is the system
   * of record and a receipt can be cancelled there, but a promise already
   * marked kept was never looked at again, so it stayed kept against money
   * that had gone away. Nothing here is a state machine -- every state is
   * derived from what the allocations say today.
   */
  async evaluateAll(orgId: string): Promise<{ evaluated: number; broken: number }> {
    const rows = await this.db.execute<PromiseRow>(sql`
      SELECT p.id, p.party_id, '' AS party_name, p.amount::text, p.promised_date::text, p.bills, p.taken_by, NULL AS taken_by_name, p.taken_on::text, p.notes, p.created_at,
             NULL AS collector_id, NULL AS collector_name, r.received::text AS received, r.received_on::text AS received_on
        FROM promises_to_pay p LEFT JOIN LATERAL (${this.receiptsFor()}) r ON TRUE
       WHERE p.org_id = ${orgId} AND p.deleted_at IS NULL
    `);
    const today = new Date().toISOString().slice(0, 10);
    let broken = 0;
    for (const r of rows.rows) {
      const received = Number(r.received);
      const state = promiseStateOf(Number(r.amount), received, r.promised_date, today);
      if (state === 'broken') broken += 1;
      await this.db.execute(sql`UPDATE promises_to_pay SET state = ${state}, received_amount = ${money(received)}, received_on = ${r.received_on}, evaluated_at = now(), updated_at = now() WHERE id = ${r.id}`);
    }
    return { evaluated: rows.rows.length, broken };
  }

  /** REQ-AJ-10 / D-54: the count and amount behind the credit check's flag; never a block. */
  async brokenPromises(orgId: string, partyId: string): Promise<{ count: number; amount: string }> {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.db.execute<{ amount: string; received: string; promised_date: string }>(sql`
      SELECT p.amount::text, r.received::text AS received, p.promised_date::text
        FROM promises_to_pay p LEFT JOIN LATERAL (${this.receiptsFor()}) r ON TRUE
       WHERE p.org_id = ${orgId} AND p.party_id = ${partyId} AND p.deleted_at IS NULL AND p.promised_date < ${today}::date
    `);
    let count = 0;
    let amount = 0;
    for (const r of rows.rows) {
      const state = promiseStateOf(Number(r.amount), Number(r.received), r.promised_date, today);
      if (state === 'broken' || state === 'partially_kept') {
        count += 1;
        amount += Number(r.amount) - Number(r.received);
      }
    }
    return { count, amount: money(amount) };
  }

  // ----------------------------------------------------------- assignments

  /** REQ-AJ-03: assign, or replace the party's current collector; the old row is retired, not edited. */
  async assign(principal: Principal, input: AssignCollectorInput): Promise<CollectorAssignmentView> {
    const ctx = orgContextOf(principal);
    const collector = await this.db.execute<{ id: string }>(sql`SELECT id FROM employees WHERE org_id = ${ctx.orgId} AND id = ${input.collectorId} AND deleted_at IS NULL`).then((r) => r.rows[0]);
    if (collector === undefined) throw AppError.notFound('Collector', input.collectorId);
    const party = await this.db.execute<{ id: string }>(sql`SELECT id FROM parties WHERE org_id = ${ctx.orgId} AND id = ${input.partyId}`).then((r) => r.rows[0]);
    if (party === undefined) throw AppError.notFound('Party', input.partyId);
    await this.db.transaction(async (tx) => {
      const previous = await tx.execute<{ id: string; collector_id: string }>(sql`SELECT id, collector_id FROM collector_assignments WHERE org_id = ${ctx.orgId} AND party_id = ${input.partyId} AND deleted_at IS NULL`).then((r) => r.rows[0]);
      if (previous !== undefined) {
        await tx.execute(sql`UPDATE collector_assignments SET deleted_at = now(), updated_at = now(), updated_by = ${ctx.actorUserId} WHERE id = ${previous.id}`);
      }
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO collector_assignments (org_id, party_id, collector_id, target_amount, period_from, period_to, created_by, updated_by)
        VALUES (${ctx.orgId}, ${input.partyId}, ${input.collectorId}, ${input.targetAmount ?? null}, ${input.periodFrom}, ${input.periodTo ?? null}, ${ctx.actorUserId}, ${ctx.actorUserId})
        RETURNING id
      `);
      const created = inserted.rows[0]?.id;
      if (created === undefined) throw new Error('Assignment insert returned no row.');
      this.auditContext.record({ action: 'collections.collector.assigned', entityType: 'collector_assignment', entityId: created, before: previous === undefined ? null : { collectorId: previous.collector_id }, after: { partyId: input.partyId, collectorId: input.collectorId, targetAmount: input.targetAmount ?? null } });
      return created;
    });
    const page = await this.listAssignments(principal, { page: 1, pageSize: 1, partyId: input.partyId });
    const view = page.data[0];
    if (view === undefined) throw new Error('Assignment vanished after insert.');
    return view;
  }

  async unassign(principal: Principal, id: string): Promise<void> {
    const ctx = orgContextOf(principal);
    const row = await this.db.execute<{ id: string; party_id: string; collector_id: string }>(sql`SELECT id, party_id, collector_id FROM collector_assignments WHERE org_id = ${ctx.orgId} AND id = ${id} AND deleted_at IS NULL`).then((r) => r.rows[0]);
    if (row === undefined) throw AppError.notFound('Collector assignment', id);
    await this.db.execute(sql`UPDATE collector_assignments SET deleted_at = now(), updated_at = now(), updated_by = ${ctx.actorUserId} WHERE id = ${id}`);
    this.auditContext.record({ action: 'collections.collector.unassigned', entityType: 'collector_assignment', entityId: id, before: { partyId: row.party_id, collectorId: row.collector_id }, after: null });
  }

  async listAssignments(principal: Principal, query: AssignmentListQuery): Promise<Paginated<CollectorAssignmentView>> {
    const orgId = principal.orgId;
    const offset = (query.page - 1) * query.pageSize;
    const scope = this.scopes.resolve(principal, GRANTS, sql`ca.collector_id`).where;
    const where = sql`ca.org_id = ${orgId} AND ca.deleted_at IS NULL AND ${scope}
      ${query.collectorId === undefined ? sql`` : sql`AND ca.collector_id = ${query.collectorId}`}
      ${query.partyId === undefined ? sql`` : sql`AND ca.party_id = ${query.partyId}`}`;
    const [rows, total] = await Promise.all([
      this.db.execute<{ id: string; party_id: string; party_name: string; collector_id: string; collector_name: string; target_amount: string | null; period_from: string; period_to: string | null; created_at: Date | string }>(sql`
        SELECT ca.id, ca.party_id, pa.name AS party_name, ca.collector_id, concat_ws(' ', e.first_name, e.last_name) AS collector_name,
               ca.target_amount::text, ca.period_from::text, ca.period_to::text, ca.created_at
          FROM collector_assignments ca JOIN parties pa ON pa.id = ca.party_id JOIN employees e ON e.id = ca.collector_id
         WHERE ${where} ORDER BY pa.name LIMIT ${query.pageSize} OFFSET ${offset}
      `),
      this.db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM collector_assignments ca WHERE ${where}`),
    ]);
    return {
      data: rows.rows.map((r) => ({ id: r.id, partyId: r.party_id, partyName: r.party_name, collectorId: r.collector_id, collectorName: r.collector_name, targetAmount: r.target_amount === null ? null : money(r.target_amount), periodFrom: r.period_from, periodTo: r.period_to, createdAt: iso(r.created_at) ?? '' })),
      meta: { page: query.page, pageSize: query.pageSize, total: total.rows[0]?.count ?? 0 },
    };
  }

  // ------------------------------------------------------------- dashboard

  /** REQ-AJ-07: the collector's morning -- their parties, what is owed and overdue, the promises, collected against target. */
  async dashboard(principal: Principal, query: DashboardQuery): Promise<CollectorDashboard> {
    const orgId = principal.orgId;
    const today = new Date().toISOString().slice(0, 10);
    const from = query.from ?? `${today.slice(0, 7)}-01`;
    const to = query.to ?? today;
    const scope = this.scopes.resolve(principal, GRANTS, sql`ca.collector_id`).where;
    const collectorClause = query.collectorId === undefined ? sql`` : sql`AND ca.collector_id = ${query.collectorId}`;
    const rows = await this.db.execute<{
      party_id: string; party_name: string; collector_id: string | null; collector_name: string | null; outstanding: string; overdue: string;
      cluster_outstanding: string | null; open_promises: number; broken_promises: number; next_promise_date: string | null; last_reminder_at: Date | string | null; target_amount: string | null;
    }>(sql`
      WITH bills AS (
        SELECT b.party_id, b.bill_name, max(b.due_date) AS due_date, min(b.bill_date) AS bill_date, round(sum(b.amount), 2) AS outstanding
          FROM bill_allocations b WHERE b.org_id = ${orgId} AND b.ref_type IN ('new', 'against') GROUP BY b.party_id, b.bill_name HAVING round(sum(b.amount), 2) <> 0
      ), owed AS (
        SELECT bi.party_id, sum(bi.outstanding) AS outstanding,
               sum(bi.outstanding) FILTER (WHERE (bi.due_date IS NOT NULL AND ${today}::date > bi.due_date) OR (bi.due_date IS NULL AND bi.bill_date IS NOT NULL AND pa.credit_days IS NOT NULL AND ${today}::date > bi.bill_date + pa.credit_days)) AS overdue
          FROM bills bi JOIN parties pa ON pa.id = bi.party_id GROUP BY bi.party_id
      ), promises AS (
        SELECT p.party_id,
               count(*) FILTER (WHERE p.state = 'open')::int AS open_promises,
               count(*) FILTER (WHERE p.state IN ('broken', 'partially_kept') AND p.promised_date < ${today}::date)::int AS broken_promises,
               min(p.promised_date) FILTER (WHERE p.state = 'open') AS next_promise_date
          FROM promises_to_pay p WHERE p.org_id = ${orgId} AND p.deleted_at IS NULL GROUP BY p.party_id
      )
      SELECT ca.party_id, pa.name AS party_name, ca.collector_id, concat_ws(' ', e.first_name, e.last_name) AS collector_name,
             coalesce(o.outstanding, 0)::text AS outstanding, coalesce(o.overdue, 0)::text AS overdue,
             (SELECT sum(o2.outstanding)::text FROM duplicate_cluster_members m JOIN duplicate_clusters c ON c.id = m.cluster_id
               JOIN duplicate_cluster_members m2 ON m2.cluster_id = c.id JOIN owed o2 ON o2.party_id = m2.entity_id
              WHERE m.org_id = ${orgId} AND m.entity_type = 'party' AND m.entity_id = ca.party_id AND c.state IN ('open', 'sent_to_tally')) AS cluster_outstanding,
             coalesce(pr.open_promises, 0) AS open_promises, coalesce(pr.broken_promises, 0) AS broken_promises, pr.next_promise_date::text AS next_promise_date,
             (SELECT max(rn.sent_at) FROM reminder_notices rn WHERE rn.org_id = ${orgId} AND rn.party_id = ca.party_id AND rn.status = 'sent') AS last_reminder_at,
             ca.target_amount::text
        FROM collector_assignments ca
        JOIN parties pa ON pa.id = ca.party_id
        JOIN employees e ON e.id = ca.collector_id
        LEFT JOIN owed o ON o.party_id = ca.party_id
        LEFT JOIN promises pr ON pr.party_id = ca.party_id
       WHERE ca.org_id = ${orgId} AND ca.deleted_at IS NULL AND ${scope} ${collectorClause}
       ORDER BY coalesce(o.overdue, 0) DESC, coalesce(o.outstanding, 0) DESC, pa.name
    `);
    const partyIds = rows.rows.map((r) => r.party_id);
    const [collected, dueToday, collector] = await Promise.all([
      partyIds.length === 0
        ? Promise.resolve('0')
        : this.db
            .execute<{ value: string }>(sql`
              SELECT coalesce(sum(v.amount), 0)::text AS value FROM vouchers v
               WHERE v.org_id = ${orgId} AND v.voucher_type = 'Receipt' AND NOT v.is_cancelled AND v.voucher_date BETWEEN ${from}::date AND ${to}::date
                 AND v.party_id IN (${sql.join(partyIds.map((id) => sql`${id}::uuid`), sql`, `)})
            `)
            .then((r) => r.rows[0]?.value ?? '0'),
      partyIds.length === 0
        ? Promise.resolve(0)
        : this.db
            .execute<{ value: number }>(sql`
              SELECT count(*)::int AS value FROM promises_to_pay p WHERE p.org_id = ${orgId} AND p.deleted_at IS NULL AND p.state = 'open' AND p.promised_date = ${today}::date
                 AND p.party_id IN (${sql.join(partyIds.map((id) => sql`${id}::uuid`), sql`, `)})
            `)
            .then((r) => r.rows[0]?.value ?? 0),
      query.collectorId === undefined
        ? Promise.resolve(null)
        : this.db.execute<{ id: string; name: string }>(sql`SELECT id, concat_ws(' ', first_name, last_name) AS name FROM employees WHERE org_id = ${orgId} AND id = ${query.collectorId}`).then((r) => r.rows[0] ?? null),
    ]);
    const dashboardRows: CollectorDashboardRow[] = rows.rows.map((r) => ({
      partyId: r.party_id,
      partyName: r.party_name,
      collectorId: r.collector_id,
      collectorName: r.collector_name,
      outstanding: money(r.outstanding),
      overdue: money(r.overdue),
      clusterOutstanding: r.cluster_outstanding === null ? null : money(r.cluster_outstanding),
      openPromises: r.open_promises,
      brokenPromises: r.broken_promises,
      nextPromiseDate: r.next_promise_date,
      lastReminderAt: iso(r.last_reminder_at),
    }));
    const targets = rows.rows.map((r) => (r.target_amount === null ? null : Number(r.target_amount))).filter((t): t is number => t !== null);
    return {
      collector,
      period: { from, to },
      assignedParties: dashboardRows.length,
      totalOutstanding: money(dashboardRows.reduce((s, r) => s + Number(r.outstanding), 0)),
      overdue: money(dashboardRows.reduce((s, r) => s + Number(r.overdue), 0)),
      promisesOpen: dashboardRows.reduce((s, r) => s + r.openPromises, 0),
      promisesDueToday: dueToday,
      promisesBroken: dashboardRows.reduce((s, r) => s + r.brokenPromises, 0),
      collectedThisPeriod: money(collected),
      target: targets.length === 0 ? null : money(targets.reduce((s, t) => s + t, 0)),
      rows: dashboardRows,
    };
  }

  // ----------------------------------------------------------------- scope

  /** Self is the parties assigned to me and the promises I took; all is everyone's. */
  /**
   * May this caller work this party at all: everyone's, anyone's to act on,
   * or their own.
   *
   * A fragment rather than a check, so it costs no extra round trip and there
   * is no error path to get wrong -- a party outside the scope yields no rows,
   * which is also the right shape: it answers the same way for a party that
   * does not exist, so nothing here is an oracle for which ids are real.
   *
   * Every other collections read narrows by the collector scope; the party's
   * bills and its reminder history did not, so a holder of
   * `collections.view.self` could read the open bills of any party in the
   * organisation by passing its id -- and the party list hands those ids out.
   *
   * `collections.manage` passes because that key already pulls the identical
   * bill table out of `POST /collections/reminders`; refusing the read while
   * allowing the write would be a rule that protects nothing. The
   * `promises_to_pay` arm mirrors `scopeWhere`'s own `OR p.taken_by`, so the
   * two definitions of "mine" cannot drift apart.
   */
  partyVisible(principal: Principal, partyColumn: SQL): SQL {
    if (hasPermission(principal, PERMISSIONS.COLLECTIONS_VIEW_ALL) || hasPermission(principal, PERMISSIONS.COLLECTIONS_MANAGE)) return sql`true`;
    const resolved = this.scopes.resolve(principal, GRANTS, sql`ca.collector_id`);
    if (resolved.scope === 'none' || principal.employeeId === null) return sql`false`;
    return sql`(EXISTS (SELECT 1 FROM collector_assignments ca WHERE ca.org_id = ${principal.orgId} AND ca.party_id = ${partyColumn} AND ca.deleted_at IS NULL AND ${resolved.where})
            OR EXISTS (SELECT 1 FROM promises_to_pay pr WHERE pr.org_id = ${principal.orgId} AND pr.party_id = ${partyColumn} AND pr.deleted_at IS NULL AND pr.taken_by = ${principal.employeeId}))`;
  }

  private scopeWhere(principal: Principal): SQL {
    const resolved = this.scopes.resolve(principal, GRANTS, sql`ca.collector_id`);
    if (resolved.scope === 'all' || principal.employeeId === null) return resolved.where;
    return sql`(${resolved.where} OR p.taken_by = ${principal.employeeId})`;
  }
}
