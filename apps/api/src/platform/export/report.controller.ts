import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  PERMISSIONS,
  isReportKey,
  pageSlice,
  paginated,
  type ExportDownload,
  type ExportJobSummary,
  type Paginated,
  type ReportDefinition,
  type ReportKey,
  type ReportSchedule,
  type SavedView,
} from '@vyuha/shared';

import { sql } from 'drizzle-orm';

import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { CurrentUser, type Principal } from '../rbac/principal.js';
import { RequirePermission } from '../rbac/route-policy.js';
import { ExportService } from './export.service.js';
import {
  ExportListQueryDto,
  ExportRequestDto,
  ReportRowQueryDto,
  ReportScheduleInputDto,
  SavedViewInputDto,
  SavedViewQueryDto,
  SchedulePauseDto,
} from './report.dto.js';
import { ReportSourceRegistry } from './report-source.registry.js';
import { SavedViewService } from './saved-view.service.js';
import { ScheduleService } from './schedule.service.js';

/**
 * `/api/v1/reports` (REQ-J-01 … REQ-J-06).
 *
 * CLAUDE.md §6: controllers validate and delegate. Nothing here decides which
 * rows a caller may see -- that is `ScopeService`, applied inside whichever
 * module registered the report -- and nothing here formats a file.
 *
 * The rows themselves come from `ReportSourceRegistry` (REQ-P-02), which is
 * what makes this one controller the report shell for every module: a
 * receivables report registered in Phase 6d is served by these same routes,
 * and this file does not change. The row payload is therefore `unknown` to
 * the type system here — its shape is the registering module's contract with
 * the client, carried in `@vyuha/shared`, not this controller's business.
 *
 * The permission split follows the brief exactly: `report.view` reads,
 * `report.export` produces and downloads files. They are separate keys because
 * they are separate risks; a manager who may look at their team's attendance
 * on screen is not automatically someone who should be able to walk out with a
 * spreadsheet of it.
 */
@Controller('reports')
export class ReportController {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly sources: ReportSourceRegistry,
    private readonly exports: ExportService,
    private readonly views: SavedViewService,
    private readonly schedules: ScheduleService,
  ) {}

  /**
   * The report catalogue. Served rather than compiled into the client so that
   * a client one release behind still renders only the reports the server can
   * actually produce -- and narrowed to the ones this caller's keys can return
   * rows for, so `Ctrl+G` never offers a report that would answer empty forever.
   */
  @Get()
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  catalogue(@CurrentUser() principal: Principal): { data: readonly ReportDefinition[] } {
    return { data: this.sources.catalogue(principal) };
  }

  // ------------------------------------------------------------ saved views

  /**
   * Declared before `:reportKey/rows` so the literal segment wins. Nest matches
   * in declaration order, and `views` would otherwise be read as a report key.
   */
  @Get('views')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  listViews(
    @CurrentUser() principal: Principal,
    @Query() query: SavedViewQueryDto,
  ): Promise<SavedView[]> {
    return this.views.list(principal, query.reportKey);
  }

  @Post('views')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  saveView(
    @CurrentUser() principal: Principal,
    @Body() body: SavedViewInputDto,
  ): Promise<SavedView> {
    return this.views.save(principal, body);
  }

  @Delete('views/:id')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @HttpCode(HttpStatus.NO_CONTENT)
  removeView(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.views.remove(principal, id);
  }

  // --------------------------------------------------------------- exports

  /** REQ-J-03. Returns immediately with a queued job; the tray follows it. */
  @Post('exports')
  @RequirePermission(PERMISSIONS.REPORT_EXPORT)
  @HttpCode(HttpStatus.ACCEPTED)
  requestExport(
    @CurrentUser() principal: Principal,
    @Body() body: ExportRequestDto,
  ): Promise<ExportJobSummary> {
    return this.exports.request(principal, body);
  }

  /** The Downloads tray. */
  @Get('exports')
  @RequirePermission(PERMISSIONS.REPORT_EXPORT)
  async listExports(
    @CurrentUser() principal: Principal,
    @Query() query: ExportListQueryDto,
  ): Promise<{ data: ExportJobSummary[] }> {
    return { data: await this.exports.listForRequester(principal, query.limit) };
  }

  @Get('exports/:id')
  @RequirePermission(PERMISSIONS.REPORT_EXPORT)
  findExport(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ExportJobSummary> {
    return this.exports.findOne(principal, id);
  }

  /** NFR-09: a short-lived signed URL, never a storage key. */
  @Get('exports/:id/download')
  @RequirePermission(PERMISSIONS.REPORT_EXPORT)
  download(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ExportDownload> {
    return this.exports.download(principal, id);
  }

  // ------------------------------------------------------------- schedules

  /*
   * REQ-J-05. Guarded on `report.export` rather than `report.view`: a schedule
   * produces a file on a timer, which is the export risk and not the reading
   * one. Declared before `:reportKey/rows` -- Express matches in registration
   * order, and `schedules` would otherwise be read as a report key.
   */
  @Get('schedules')
  @RequirePermission(PERMISSIONS.REPORT_EXPORT)
  listSchedules(@CurrentUser() principal: Principal): Promise<ReportSchedule[]> {
    return this.schedules.list(principal);
  }

  @Post('schedules')
  @RequirePermission(PERMISSIONS.REPORT_EXPORT)
  createSchedule(
    @CurrentUser() principal: Principal,
    @Body() body: ReportScheduleInputDto,
  ): Promise<ReportSchedule> {
    return this.schedules.create(principal, body);
  }

  @Post('schedules/:id/active')
  @RequirePermission(PERMISSIONS.REPORT_EXPORT)
  pauseSchedule(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SchedulePauseDto,
  ): Promise<ReportSchedule> {
    return this.schedules.setActive(principal, id, body.isActive);
  }

  @Delete('schedules/:id')
  @RequirePermission(PERMISSIONS.REPORT_EXPORT)
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteSchedule(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.schedules.remove(principal, id);
  }

  // ------------------------------------------------------------------ rows

  @Get(':reportKey/rows')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  async rows(
    @CurrentUser() principal: Principal,
    @Param('reportKey') reportKey: string,
    @Query() query: ReportRowQueryDto,
  ): Promise<Paginated<unknown>> {
    const key = requireReportKey(reportKey);
    const source = this.sources.require(key);
    // The contract promises a source its filters arrive asserted and
    // narrowed. Attendance happens to re-assert inside page(); the first
    // source written to the interface literally would otherwise serve
    // un-narrowed reads while the export path correctly refused them.
    const filters = this.sources.usableFilters(key, query);
    const { limit, offset } = pageSlice(query);
    const page = await source.page(principal, key, { ...filters, sort: query.sort }, limit, offset);
    // REQ-AD-09: the first page of a report is an "open"; later pages and
    // refetches of page one within the same minute are the same sitting.
    // Fire-and-forget — a usage row must never slow or fail the report.
    if (offset === 0) {
      void this.db
        .execute(
          sql`INSERT INTO report_usage (org_id, user_id, report_key)
              SELECT ${principal.orgId}, ${principal.userId}, ${key}
              WHERE NOT EXISTS (
                SELECT 1 FROM report_usage
                 WHERE org_id = ${principal.orgId} AND user_id = ${principal.userId}
                   AND report_key = ${key} AND opened_at > now() - interval '1 minute'
              )`,
        )
        .catch(() => undefined);
    }
    const body = paginated<unknown>([...page.rows], query, page.total);
    return page.totals === undefined ? body : { ...body, meta: { ...body.meta, totals: page.totals } };
  }
}

/**
 * An unknown report is a 404, not a 400. The path segment names a resource,
 * and a stale bookmark to a report that was renamed should read as "that is
 * not here" rather than as a malformed request.
 */
function requireReportKey(raw: string): ReportKey {
  if (!isReportKey(raw)) throw AppError.notFound('Report', raw);
  return raw;
}
