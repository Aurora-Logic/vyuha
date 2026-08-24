import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  ATTENDANCE_DAY_SORT_FIELDS,
  ATTENDANCE_REPORTS,
  type ReportCellValue,
  type ReportColumnSpec,
  type ReportDefinition,
  type ReportFilters,
  type ReportKey,
} from '@vyuha/shared';

import {
  ReportSourceRegistry,
  type ReportSource,
  type ReportSourcePage,
} from '../../../platform/export/report-source.registry.js';
import type { Principal } from '../../../platform/rbac/principal.js';
import { AGGREGATE_SORTS } from './report-aggregate.repository.js';
import { PUNCH_SORT_COLUMNS } from './report.repository.js';
import { ReportService, cellsFor, type ReportPage } from './report.service.js';

/**
 * Attendance's reports, handed to the export framework (REQ-P-02).
 *
 * Registered the way every cross-module attachment is — it puts itself into
 * the registry during `onModuleInit`, and `platform/export/` never imports
 * this file. The framework pages, writes and schedules; what a row *is* stays
 * here, next to the queries that produce it.
 *
 * `keys` claims `ATTENDANCE_REPORTS` — the module's own group in the shared
 * catalogue, not `ALL_REPORTS` — so Phase 6d's receivables definitions can
 * join the catalogue without this source claiming their keys.
 */
/**
 * What each attendance report can actually be ordered by, read from the same
 * constants the ORDER BY is built from rather than restated here. The two
 * day-grained reports go through `AttendanceDayRepository`, whose field list
 * is shared; the punch audit and the aggregates each own theirs.
 */
const SORTABLE: Partial<Record<ReportKey, readonly string[]>> = {
  'attendance-register': ATTENDANCE_DAY_SORT_FIELDS,
  'daily-muster': ATTENDANCE_DAY_SORT_FIELDS,
  'punch-audit': Object.keys(PUNCH_SORT_COLUMNS),
  ...Object.fromEntries(Object.entries(AGGREGATE_SORTS).map(([key, map]) => [key, Object.keys(map)])),
};

@Injectable()
export class AttendanceReportSource implements ReportSource, OnModuleInit {
  readonly keys: readonly ReportKey[] = ATTENDANCE_REPORTS.map((report) => report.key);

  constructor(
    private readonly registry: ReportSourceRegistry,
    private readonly reports: ReportService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  visibleDefinitions(principal: Principal): readonly ReportDefinition[] {
    return this.reports.catalogue(principal);
  }

  sortableFields(key: ReportKey): readonly string[] {
    return SORTABLE[key] ?? [];
  }

  assertFiltersUsable(key: ReportKey, filters: ReportFilters): ReportFilters {
    return ReportService.assertFiltersUsable(key, filters);
  }

  count(principal: Principal, key: ReportKey, filters: ReportFilters): Promise<number> {
    return this.reports.count(principal, key, filters);
  }

  page(
    principal: Principal,
    key: ReportKey,
    filters: ReportFilters & { sort?: string | undefined },
    limit: number,
    offset: number,
  ): Promise<ReportSourcePage> {
    return this.reports.page(principal, key, filters, limit, offset);
  }

  cells(
    page: ReportSourcePage,
    index: number,
    columns: readonly ReportColumnSpec[],
  ): ReportCellValue[] {
    // The framework only ever hands back a page this source produced — the
    // registry routes by key and `page` above returns a `ReportPage` — so the
    // narrowing is the contract, not a guess. `cellsFor` then switches on the
    // page's own `kind` discriminant.
    return cellsFor(page as ReportPage, index, columns);
  }
}
