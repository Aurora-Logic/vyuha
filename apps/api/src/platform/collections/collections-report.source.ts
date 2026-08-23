import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  COLLECTIONS_REPORTS,
  PERMISSIONS,
  brokenPromiseCell,
  promisedVsCollectedCell,
  type BrokenPromiseSource,
  type PromisedVsCollectedSource,
  type ReportCellValue,
  type ReportColumnSpec,
  type ReportDefinition,
  type ReportFilters,
  type ReportKey,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { ReportSourceRegistry, type ReportSource, type ReportSourcePage } from '../export/report-source.registry.js';
import { hasPermission, type Principal } from '../rbac/principal.js';
import { ScopeService } from '../rbac/scope.service.js';

/**
 * REQ-AJ-08/09: the two reports the area exists for -- what was promised
 * against what arrived, and the promises past their date with nothing
 * against them. Both read the promise's derived state, which the sweep
 * and the service write from receipts, so a figure here can never
 * disagree with the dashboard.
 *
 * Scoped like the rest of collections: `.self` sees the parties assigned
 * to this collector, `.all` sees everyone's.
 */

const GRANTS = { self: PERMISSIONS.COLLECTIONS_VIEW_SELF, all: PERMISSIONS.COLLECTIONS_VIEW_ALL } as const;

// Type aliases, not interfaces: execute<T> wants a Record, which an interface does not satisfy.
type PromisedRow = {
  id: string;
  collector_id: string | null;
  collector_name: string | null;
  party_id: string;
  party_name: string;
  promises: number;
  promised: string;
  received: string;
  kept: number;
  partly: number;
  broken: number;
  open: number;
};

/** Both reports ride the one page shape; `reportKey` says which rows are in it. */
interface CollectionsPage extends ReportSourcePage {
  readonly reportKey: ReportKey;
  readonly rows: readonly (PromisedVsCollectedSource | BrokenPromiseSource)[];
}

type BrokenRow = {
  id: string;
  party_id: string;
  party_name: string;
  collector_name: string | null;
  amount: string;
  received: string;
  shortfall: string;
  promised_date: string;
  days_late: number;
  taken_by_name: string | null;
  bills: string | null;
};

@Injectable()
export class CollectionsReportSource implements ReportSource, OnModuleInit {
  readonly keys: readonly ReportKey[] = COLLECTIONS_REPORTS.map((r) => r.key);

  constructor(
    private readonly registry: ReportSourceRegistry,
    @InjectDatabase() private readonly db: Database,
    private readonly scopes: ScopeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  visibleDefinitions(principal: Principal): readonly ReportDefinition[] {
    return this.holds(principal) ? COLLECTIONS_REPORTS : [];
  }

  assertFiltersUsable(key: ReportKey, filters: ReportFilters): ReportFilters {
    if (!this.keys.includes(key)) throw new Error(`CollectionsReportSource does not serve "${key}".`);
    if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) {
      throw AppError.validation('The period ends before it starts.', { fields: [{ path: 'to', message: 'must not precede from' }] });
    }
    return {
      ...(filters.from === undefined ? {} : { from: filters.from }),
      ...(filters.to === undefined ? {} : { to: filters.to }),
      ...(filters.partyId === undefined ? {} : { partyId: filters.partyId }),
      ...(filters.employeeId === undefined ? {} : { employeeId: filters.employeeId }),
    };
  }

  async count(principal: Principal, key: ReportKey, filters: ReportFilters): Promise<number> {
    this.require(principal);
    const usable = this.assertFiltersUsable(key, filters);
    const rows = await this.db.execute<{ value: number }>(sql`SELECT count(*)::int AS value FROM (${this.body(principal, key, usable)}) t`);
    return Number(rows.rows[0]?.value ?? 0);
  }

  async page(principal: Principal, key: ReportKey, filters: ReportFilters & { sort?: string | undefined }, limit: number, offset: number): Promise<ReportSourcePage> {
    this.require(principal);
    const usable = this.assertFiltersUsable(key, filters);
    const total = await this.count(principal, key, usable);
    if (key === 'broken-promises') {
      const order =
        filters.sort === 'partyName' ? sql`party_name ASC` : filters.sort === 'daysLate' ? sql`days_late ASC` : filters.sort === '-daysLate' ? sql`days_late DESC` : sql`shortfall::numeric DESC, days_late DESC`;
      const rows = await this.db.execute<BrokenRow>(sql`SELECT * FROM (${this.body(principal, key, usable)}) t ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`);
      const page: CollectionsPage = {
        total,
        reportKey: key,
        rows: rows.rows.map((r): BrokenPromiseSource => ({
          id: r.id,
          partyId: r.party_id,
          partyName: r.party_name,
          collectorName: r.collector_name,
          amount: r.amount,
          received: r.received,
          shortfall: r.shortfall,
          promisedDate: r.promised_date,
          daysLate: Number(r.days_late),
          takenByName: r.taken_by_name,
          bills: r.bills,
        })),
      };
      return page;
    }
    const order =
      filters.sort === 'collectorName' ? sql`collector_name ASC NULLS LAST` : filters.sort === 'partyName' ? sql`party_name ASC` : filters.sort === 'promised' ? sql`promised::numeric ASC` : sql`promised::numeric DESC`;
    const rows = await this.db.execute<PromisedRow>(sql`SELECT * FROM (${this.body(principal, key, usable)}) t ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`);
    const page: CollectionsPage = {
      total,
      reportKey: key,
      rows: rows.rows.map((r): PromisedVsCollectedSource => ({
        id: r.id,
        collectorId: r.collector_id,
        collectorName: r.collector_name,
        partyId: r.party_id,
        partyName: r.party_name,
        promises: Number(r.promises),
        promised: r.promised,
        received: r.received,
        keptPct: Number(r.promised) > 0 ? Math.round((Number(r.received) / Number(r.promised)) * 1000) / 10 : 0,
        kept: Number(r.kept),
        partlyKept: Number(r.partly),
        broken: Number(r.broken),
        open: Number(r.open),
      })),
    };
    return page;
  }

  cells(page: ReportSourcePage, index: number, columns: readonly ReportColumnSpec[]): ReportCellValue[] {
    const typed = page as CollectionsPage;
    const row = typed.rows[index];
    if (row === undefined) throw new Error(`No row ${String(index)} on this page.`);
    return typed.reportKey === 'broken-promises'
      ? columns.map((column) => brokenPromiseCell(row as BrokenPromiseSource, column.key))
      : columns.map((column) => promisedVsCollectedCell(row as PromisedVsCollectedSource, column.key));
  }

  private body(principal: Principal, key: ReportKey, filters: ReportFilters): SQL {
    const orgId = principal.orgId;
    const scope = this.scopes.resolve(principal, GRANTS, sql`ca.collector_id`).where;
    const mine = principal.employeeId === null ? sql`FALSE` : sql`p.taken_by = ${principal.employeeId}`;
    const visible = sql`(${scope} OR ${mine})`;
    const period = sql`
      ${filters.from === undefined ? sql`` : sql`AND p.promised_date >= ${filters.from}::date`}
      ${filters.to === undefined ? sql`` : sql`AND p.promised_date <= ${filters.to}::date`}
      ${filters.partyId === undefined ? sql`` : sql`AND p.party_id = ${filters.partyId}`}
      ${filters.employeeId === undefined ? sql`` : sql`AND ca.collector_id = ${filters.employeeId}`}`;

    if (key === 'broken-promises') {
      return sql`
        SELECT p.id, p.party_id, pa.name AS party_name,
               nullif(concat_ws(' ', ce.first_name, ce.last_name), '') AS collector_name,
               p.amount::text, p.received_amount::text AS received,
               round(p.amount - p.received_amount, 2)::text AS shortfall,
               p.promised_date::text, (CURRENT_DATE - p.promised_date)::int AS days_late,
               nullif(concat_ws(' ', te.first_name, te.last_name), '') AS taken_by_name,
               nullif(array_to_string(p.bills, ', '), '') AS bills
          FROM promises_to_pay p
          JOIN parties pa ON pa.id = p.party_id
          LEFT JOIN collector_assignments ca ON ca.org_id = p.org_id AND ca.party_id = p.party_id AND ca.deleted_at IS NULL
          LEFT JOIN employees ce ON ce.id = ca.collector_id
          LEFT JOIN employees te ON te.id = p.taken_by
         WHERE p.org_id = ${orgId} AND p.deleted_at IS NULL AND p.state IN ('broken', 'partially_kept')
           AND p.promised_date < CURRENT_DATE AND ${visible} ${period}`;
    }
    return sql`
      SELECT coalesce(ca.collector_id::text, 'unassigned') || ':' || p.party_id::text AS id,
             ca.collector_id, nullif(concat_ws(' ', ce.first_name, ce.last_name), '') AS collector_name,
             p.party_id, max(pa.name) AS party_name,
             count(*)::int AS promises,
             sum(p.amount)::text AS promised,
             sum(p.received_amount)::text AS received,
             count(*) FILTER (WHERE p.state = 'kept')::int AS kept,
             count(*) FILTER (WHERE p.state = 'partially_kept')::int AS partly,
             count(*) FILTER (WHERE p.state = 'broken')::int AS broken,
             count(*) FILTER (WHERE p.state = 'open')::int AS open
        FROM promises_to_pay p
        JOIN parties pa ON pa.id = p.party_id
        LEFT JOIN collector_assignments ca ON ca.org_id = p.org_id AND ca.party_id = p.party_id AND ca.deleted_at IS NULL
        LEFT JOIN employees ce ON ce.id = ca.collector_id
       WHERE p.org_id = ${orgId} AND p.deleted_at IS NULL AND ${visible} ${period}
       GROUP BY ca.collector_id, ce.first_name, ce.last_name, p.party_id`;
  }

  private holds(principal: Principal): boolean {
    return hasPermission(principal, PERMISSIONS.COLLECTIONS_VIEW_SELF) || hasPermission(principal, PERMISSIONS.COLLECTIONS_VIEW_ALL);
  }

  private require(principal: Principal): void {
    if (!this.holds(principal)) throw AppError.forbidden('This report needs collections.view.self or collections.view.all.');
  }
}
