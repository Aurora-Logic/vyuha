import { Injectable, Logger } from '@nestjs/common';
import type {
  ReportCellValue,
  ReportColumnSpec,
  ReportDefinition,
  ReportFilters,
  ReportKey,
} from '@vyuha/shared';

import { AppError } from '../common/errors.js';
import type { Principal } from '../rbac/principal.js';

/**
 * How a module hands its reports to the export framework (REQ-P-02).
 *
 * The framework — the shell endpoints, the export job, the schedule sweep —
 * knows how to page a result, write a file, and put it in a tray. What it must
 * never know is what a report *is*: those rows are attendance's today and
 * receivables' in Phase 6d (REQ-Y-06), and technical design §1 forbids
 * `platform/` importing either. So the arrow inverts, the same way
 * `ApprovalSubjectRegistry` and `JobRegistry` already do it: the platform
 * defines this interface, each module registers its source during
 * `onModuleInit`, and nothing in `platform/export/` names a module.
 *
 * A report key with no source cannot be requested, exported or scheduled —
 * the same fail-closed property the approvals registry gives decisions.
 */

/**
 * One page of rows, opaque to the framework.
 *
 * The framework reads exactly two things: how many rows this page holds and
 * how many the whole result would. What a row *means* is the source's
 * business, which is why `cells` — the only code that looks inside — lives on
 * the source too, and is handed back the very page that source produced.
 */
export interface ReportSourcePage {
  readonly rows: ReadonlyArray<unknown>;
  readonly total: number;
  /** Sums over the whole report, for reports that declare them. */
  readonly totals?: Readonly<Record<string, string>>;
}

export interface ReportSource {
  /** Every key this source serves. Registered individually; duplicates refuse. */
  readonly keys: readonly ReportKey[];

  /**
   * The catalogue entries this caller can actually get rows out of — already
   * narrowed by the source's own scope rules, so the shell never offers a
   * report that would answer "Nothing in this period" forever.
   */
  visibleDefinitions(principal: Principal): readonly ReportDefinition[];

  /**
   * Refuses a filter set this report cannot answer for, and narrows the ones
   * whose shape depends on it. Called on the button press and again inside
   * the job, so "you asked for two months of a one-month grid" is a sentence
   * at request time, never a job that fails five times with backoff.
   */
  assertFiltersUsable(key: ReportKey, filters: ReportFilters): ReportFilters;

  /** The total on its own, so an export can refuse an oversized job before starting it. */
  count(principal: Principal, key: ReportKey, filters: ReportFilters): Promise<number>;

  page(
    principal: Principal,
    key: ReportKey,
    filters: ReportFilters & { sort?: string | undefined },
    limit: number,
    offset: number,
  ): Promise<ReportSourcePage>;

  /** Cells for one row of a page this source previously returned. */
  cells(
    page: ReportSourcePage,
    index: number,
    columns: readonly ReportColumnSpec[],
  ): ReportCellValue[];
}

@Injectable()
export class ReportSourceRegistry {
  private readonly logger = new Logger(ReportSourceRegistry.name);
  private readonly sourcesByKey = new Map<ReportKey, ReportSource>();
  private readonly sources: ReportSource[] = [];

  register(source: ReportSource): void {
    for (const key of source.keys) {
      if (this.sourcesByKey.has(key)) {
        // Two sources for one report means whichever registered second
        // silently serves nothing — or worse, serves depending on init order.
        throw new Error(`Report "${key}" already has a source registered.`);
      }
    }
    for (const key of source.keys) this.sourcesByKey.set(key, source);
    this.sources.push(source);
    this.logger.log({ msg: 'Report source registered', keys: source.keys.length });
  }

  sourceFor(key: ReportKey): ReportSource | null {
    return this.sourcesByKey.get(key) ?? null;
  }

  /** For request-time paths, where an unregistered key is the caller's 400. */
  require(key: ReportKey): ReportSource {
    const source = this.sourceFor(key);
    if (source === null) {
      // A key the shared contract knows but no module registered is a
      // catalogue entry without a row source — a build problem stated
      // plainly, not a 404 that suggests the key itself is unknown.
      throw AppError.validation(`This build has no rows for the report "${key}".`);
    }
    return source;
  }

  /** Registration order, so a source's own catalogue order survives the merge. */
  catalogue(principal: Principal): ReportDefinition[] {
    return this.sources.flatMap((source) => [...source.visibleDefinitions(principal)]);
  }
}
