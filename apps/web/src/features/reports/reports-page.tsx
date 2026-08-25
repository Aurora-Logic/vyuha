import { useState } from 'react';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CalendarPlusIcon,
  CaretDownIcon,
  ChartBarIcon,
  FunnelIcon,
  FileCsvIcon,
  FileXlsIcon,
  PrinterIcon,
  SquareSplitVerticalIcon,
  TableIcon,
  DownloadSimpleIcon,
  ImageIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { endOfMonth, startOfMonth, subDays } from 'date-fns';
import { useSearchParams } from 'react-router';
import type { DateRange } from 'react-day-picker';

import { PageHeader } from '@/components/shared/page-header';
import type { PickerOption } from '@/components/shared/record-picker';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { usePermission } from '@/lib/session/permissions';
import { useIsMobile } from '@/hooks/use-mobile';
import { useShortcut } from '@/lib/keyboard/registry';
import { EMPTY_VALUE, formatDate, humaniseEnum } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  DEFAULT_PAGE_SIZE,
  PERMISSIONS,
  REPORT_CATEGORIES,
  REPORT_KEYS,
  REPORT_DEFINITIONS,
  defaultVisibleColumns,
  describeFilters,
  isReportKey,
  resolveColumns,
  type ExportFormat,
  type ReportColumnSpec,
  type ReportDefinition,
  type ReportFilters,
  type ReportKey,
  type SavedView,
} from '@vyuha/shared';

import {
  useDeleteView,
  useDepartmentOptions,
  useLocationOptions,
  useReportCatalogue,
  useReportRows,
  useRequestExport,
  useSavedViews,
  useSaveView,
  type ReportRowsParams,
} from './api';
import { useParties } from '@/features/masters/use-parties';

import { useChartIntro } from '@/components/shared/use-chart-motion';

import { CategoryChip } from './category-chip';
import { ColumnChooser } from './column-chooser';
import { ReportCatalogue } from './report-catalogue';
import { GenericReportChart, ReportChart, type ChartDrill } from './report-charts';
import { chartKindOf, primaryNumericColumn } from './report-series';
import { comparisonRange, deltaOf, periodForGranularity, type CompareMode, type Granularity } from '@/lib/period-compare';
import { PeriodField, ReportFilterBar, type ReportFilterState } from './filter-bar';
import { periodFor, periodModeOf, toDateParam } from './period';
import { ScheduleDialog } from './schedule-dialog';
import { isNumericColumn, renderCell } from './format';
import { PunchPhotoSheet } from './punch-photo-sheet';
import { SavedViews } from './saved-views';
import type { PunchAuditRow, ReportRowView } from './types';

/**
 * The one report shell (REQ-J-01): filter bar, column chooser, sort,
 * pagination, saved views, and an export button.
 *
 * Everything on this screen is driven by the report definition the server
 * sends -- the columns, which filters apply, what may be sorted. Adding a leave
 * report is a definition and a row source on the API, and nothing here.
 *
 * All state lives in the query string, for the reason the muster gives: a
 * filtered report has to be a link somebody can paste into a message, and has
 * to survive a reload. It is also what makes a saved view a set of query
 * parameters rather than a second source of truth.
 */

function readPositiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function fromDateParam(raw: string | null): Date | undefined {
  if (raw === null) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw);
  if (match === null) return undefined;
  // Local midnight. `new Date('2026-08-12')` reads the string as UTC and
  // yields the previous day west of Greenwich.
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** This month, which is what a reader opening a report almost always wants. */
function defaultPeriod(): DateRange {
  const now = new Date();
  return { from: startOfMonth(now), to: endOfMonth(now) };
}

function TableSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the report" className="border">
      {Array.from({ length: 10 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0"
        >
          <Skeleton className="h-3 w-20 shrink-0" />
          <Skeleton className="h-3 w-24 shrink-0" />
          <Skeleton className="hidden h-3 w-32 shrink-0 sm:block" />
          <Skeleton className="hidden h-3 w-16 shrink-0 xl:block" />
          <Skeleton className="ml-auto h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function ReportSwitcher({
  reports,
  current,
  open,
  onOpenChange,
  onSelect,
}: {
  reports: readonly ReportDefinition[];
  current: ReportKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (key: ReportKey) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* instant: this opens from Ctrl+G and the title, dozens of times a
          day; a surface used that often must not animate. */}
      <DialogContent className="overflow-hidden p-0" showCloseButton={false} instant>
        <DialogTitle className="sr-only">Switch report</DialogTitle>
        <DialogDescription className="sr-only">
          Pick the report to show. PRD section 6.4 gives this Ctrl+G.
        </DialogDescription>
        <Command>
          <CommandInput placeholder="Switch to a report" />
          <CommandList>
            <CommandEmpty>No report matches.</CommandEmpty>
            {REPORT_CATEGORIES.filter((category) => reports.some((report) => report.category === category)).map((category) => (
              <CommandGroup key={category} heading={category}>
                {reports
                  .filter((report) => report.category === category)
                  .map((report) => (
                    <CommandItem
                      key={report.key}
                      value={`${report.label} ${report.description} ${category}`}
                      onSelect={() => {
                        onSelect(report.key);
                        onOpenChange(false);
                      }}
                    >
                      <ChartBarIcon />
                      <span className={cn(report.key === current && 'font-medium')}>
                        {report.label}
                      </span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The sort as a control, not only a column header. On a phone the headers are
 * gone (PRD §6.5's stacked rows), and on a desk the toolbar's second row says
 * how the table reads; both draw this one element, so the two surfaces cannot
 * disagree about which fields may be sorted. Renders nothing when the report
 * declares no sortable column, rather than a control that quietly does nothing.
 */
function SortControl({
  definition,
  sort,
  onSortChange,
  triggerClassName,
}: {
  definition: ReportDefinition | undefined;
  sort: string;
  onSortChange: (next: string) => void;
  triggerClassName: string;
}) {
  if (definition === undefined || !definition.columns.some((column) => column.sortField !== undefined)) {
    return null;
  }
  const field = sort.startsWith('-') ? sort.slice(1) : sort;
  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={field}
        onValueChange={(value: string | null) => {
          if (value !== null) onSortChange(sort === `-${value}` ? `-${value}` : value);
        }}
      >
        <SelectTrigger className={triggerClassName} aria-label="Sort by">
          <SelectValue>
            {(value: string) => `Sort: ${definition.columns.find((column) => column.sortField === value)?.header ?? 'Default'}`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {definition.columns
            .filter((column) => column.sortField !== undefined)
            .map((column) => (
              <SelectItem key={column.sortField} value={column.sortField ?? ''}>
                {column.header}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={sort.startsWith('-') ? 'Sorted descending; switch to ascending' : 'Sorted ascending; switch to descending'}
        onClick={() => {
          if (field) onSortChange(sort.startsWith('-') ? field : `-${field}`);
        }}
      >
        {sort.startsWith('-') ? <ArrowDownIcon /> : <ArrowUpIcon />}
      </Button>
    </div>
  );
}

export function ReportsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [chooserOpen, setChooserOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [exportSheetOpen, setExportSheetOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [selectedPunch, setSelectedPunch] = useState<PunchAuditRow | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const canExport = usePermission(PERMISSIONS.REPORT_EXPORT);
  const catalogue = useReportCatalogue();
  const departments = useDepartmentOptions();
  const locations = useLocationOptions();


  const reportParam = searchParams.get('report');
  // No report chosen: the module's front door is the catalogue (REQ-AD-03), not a default report.
  const browsing = reportParam === null || !isReportKey(reportParam);
  const reportKey: ReportKey = isReportKey(reportParam ?? '')
    ? (reportParam as ReportKey)
    : REPORT_KEYS[0];

  // No fallback to the first report. The columns come from the definition and
  // the cells from `reportKey`, so a definition that is not this report's would
  // paint one report's headers over another's rows -- every cell empty, and
  // reading exactly like a quiet period. A client ahead of its server says so
  // instead.
  const definition = catalogue.data?.find((report) => report.key === reportKey);
  // Phase 6d: only asked for when a report wants a party, and only by
  // somebody who may read the masters — the picker is empty otherwise.
  const canReadParties = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const wantsParty = definition?.filters.includes('partyId') ?? false;
  const parties = useParties({ page: 1 }, { enabled: canReadParties && wantsParty });
  const partyOptions: PickerOption[] = (parties.data?.data ?? []).map((party) => ({
    id: party.id,
    label: party.name,
    ...(party.gstin === null ? {} : { hint: party.gstin }),
  }));
  const unknownReport = catalogue.isSuccess && definition === undefined;

  // --------------------------------------------------------------- state

  const periodMode = periodModeOf(definition);
  const period: DateRange = periodFor(periodMode, {
    from: fromDateParam(searchParams.get('from')) ?? defaultPeriod().from,
    to: fromDateParam(searchParams.get('to')) ?? defaultPeriod().to,
  });

  const filters: ReportFilterState = {
    period,
    departmentId: searchParams.get('departmentId'),
    locationId: searchParams.get('locationId'),
    employeeId: searchParams.get('employeeId'),
    status: searchParams.get('status'),
    flags: searchParams.get('flags'),
    punchType: searchParams.get('punchType'),
    partyId: searchParams.get('partyId'),
    groupBy: searchParams.get('groupBy'),
    voucherType: searchParams.get('voucherType'),
    ledgerName: searchParams.get('ledgerName'),
    itemName: searchParams.get('itemName'),
  };

  const sort = searchParams.get('sort') ?? definition?.defaultSort ?? '';
  const page = readPositiveInt(searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = DEFAULT_PAGE_SIZE;

  const columnsParam = searchParams.get('columns');
  const visibleColumns = resolveColumns(
    reportKey,
    columnsParam === null ? undefined : columnsParam.split(',').filter(Boolean),
  ).map((column) => column.key);

  const chosenColumns = new Set(visibleColumns);
  const columns: ReportColumnSpec[] =
    definition === undefined
      ? []
      : definition.columns.filter((column) => chosenColumns.has(column.key));

  function patchParams(apply: (params: URLSearchParams) => void, keepPage = false) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      apply(next);
      // Narrowing invalidates the page number: page 4 of three pages is an
      // empty screen that looks like no matches.
      if (!keepPage) next.delete('page');
      return next;
    });
  }

  /**
   * A chart segment drills to its own rows: the clicked value becomes the
   * matching filter and the view lands on the table (data-analyst skill §5).
   * A segment whose report has no filter for its category does nothing —
   * a drill that cannot narrow honestly should not pretend to.
   */
  function drillToSegment(drill: ChartDrill) {
    if (definition === undefined) return;
    const can = (name: string) => (definition.filters as readonly string[]).includes(name);
    if (drill.categoryKey === 'voucherType' && can('voucherType')) setFilters({ voucherType: drill.category });
    else if (drill.categoryKey === 'ledgerName' && can('ledgerName')) setFilters({ ledgerName: drill.category });
    else if ((drill.categoryKey === 'item' || drill.categoryKey === 'itemName') && can('itemName')) setFilters({ itemName: drill.category });
    else if (drill.categoryKey === 'partyName' && can('partyId') && drill.rowId !== null) setFilters({ partyId: drill.rowId });
    else return;
    setViewMode('table');
  }

  function setFilters(patch: Partial<ReportFilterState>) {
    patchParams((params) => {
      if (patch.period !== undefined) {
        if (patch.period.from) params.set('from', toDateParam(patch.period.from));
        else params.delete('from');
        if (patch.period.to) params.set('to', toDateParam(patch.period.to));
        else params.delete('to');
      }
      for (const key of ['departmentId', 'locationId', 'employeeId', 'status', 'flags', 'punchType', 'partyId', 'groupBy', 'voucherType', 'ledgerName', 'itemName'] as const) {
        if (!(key in patch)) continue;
        const value = patch[key];
        if (value === null || value === undefined) params.delete(key);
        else params.set(key, value);
      }
    });
  }

  function clearFilters() {
    patchParams((params) => {
      for (const key of ['from', 'to', 'departmentId', 'locationId', 'employeeId', 'status', 'flags', 'punchType', 'partyId', 'groupBy', 'voucherType', 'ledgerName', 'itemName'] as const) {
        params.delete(key);
      }
    });
  }

  function switchReport(next: ReportKey) {
    // A fresh set of parameters, not a patch: the previous report's columns
    // and sort do not exist on this one, and carrying them over produces a
    // table whose chooser and header disagree.
    setSearchParams(() => {
      const params = new URLSearchParams();
      params.set('report', next);
      // The period carries over, narrowed to something the next report can
      // answer for: a quarter handed to the muster grid is a refusal, and a
      // refusal on arrival reads as the report being broken.
      const carried = periodFor(periodModeOf(REPORT_DEFINITIONS[next]), period);
      if (carried.from) params.set('from', toDateParam(carried.from));
      if (carried.to) params.set('to', toDateParam(carried.to));

      /*
       * REQ-N-02: "preserving filters where they apply".
       *
       * Driven by the target's own `filters` declaration rather than a list
       * kept here, which would drift from it the first time a report declares
       * a filter this loop has not heard of. A filter the next report does not
       * declare is dropped rather than carried, because the server would
       * either refuse it or, worse, ignore it -- and a filter silently ignored
       * is a reader believing they are looking at one department when they are
       * looking at all of them.
       *
       * The period is already handled above, and handled differently: it is
       * narrowed to fit rather than passed through.
       */
      for (const name of REPORT_DEFINITIONS[next].filters) {
        if (name === 'period') continue;
        const value = searchParams.get(name);
        if (value !== null && value !== '') params.set(name, value);
      }
      return params;
    });
  }

  function setSort(next: string) {
    patchParams((params) => {
      params.set('sort', next);
    });
  }

  /**
   * Back to the hub. The period survives the trip -- coming back to browse
   * and opening the next report must not reset the dates the reader chose --
   * while the rest of the query is this report's alone and is dropped for
   * the reason `switchReport` gives.
   */
  function backToHub() {
    setSearchParams((current) => {
      const params = new URLSearchParams();
      for (const key of ['from', 'to'] as const) {
        const value = current.get(key);
        if (value !== null) params.set(key, value);
      }
      return params;
    });
  }

  // ----------------------------------------------------------- shortcuts

  // PRD §6.4: F12 configures the current screen.
  useShortcut({
    id: 'reports.configure',
    keys: 'f12',
    label: 'Choose columns',
    scope: 'screen',
    run: () => {
      setChooserOpen(true);
    },
  });

  // PRD §6.4: Alt+F2 changes the period.
  useShortcut({
    id: 'reports.period',
    keys: 'alt+f2',
    label: 'Change period',
    scope: 'screen',
    run: () => {
      setPeriodOpen(true);
    },
  });

  // PRD §6.4: Ctrl+G switches to another report.
  useShortcut({
    id: 'reports.switch',
    keys: 'ctrl+g',
    label: 'Switch report',
    scope: 'screen',
    run: () => {
      setSwitcherOpen(true);
    },
  });

  // ------------------------------------------------------------- queries

  const rowParams: ReportRowsParams = {
    page,
    pageSize,
    sort,
    ...(period.from ? { from: toDateParam(period.from) } : {}),
    ...(period.to ? { to: toDateParam(period.to) } : {}),
    ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
    ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
    ...(filters.status ? { status: filters.status as ReportFilters['status'] } : {}),
    ...(filters.flags ? { flags: filters.flags } : {}),
    ...(filters.punchType ? { punchType: filters.punchType as ReportFilters['punchType'] } : {}),
    ...(filters.partyId ? { partyId: filters.partyId } : {}),
    ...(filters.groupBy ? { groupBy: filters.groupBy as ReportFilters['groupBy'] } : {}),
    ...(filters.voucherType ? { voucherType: filters.voucherType } : {}),
    ...(filters.ledgerName ? { ledgerName: filters.ledgerName } : {}),
    ...(filters.itemName ? { itemName: filters.itemName } : {}),
  };

  // A report that has no answer without a filter is not asked until it has
  // one (customer statement: a party). The prompt below stands in for rows.
  const missingRequired = (definition?.requiredFilters ?? []).filter((name) => {
    if (name === 'partyId') return filters.partyId === null;
    if (name === 'period') return !period.from;
    if (name === 'ledgerName') return filters.ledgerName === null;
    return false;
  });
  // Not until the catalogue has said what the report needs: a statement asked
  // for before its definition arrived would fetch a 400 for a party nobody
  // had a chance to choose.
  const active = useReportRows(reportKey, rowParams, { enabled: !browsing && definition !== undefined && missingRequired.length === 0 });

  const isMobile = useIsMobile();
  // ------------------------------------------------- comparison (P-04)
  const hasPeriod = definition?.filters.includes('period') ?? false;
  const granularityParam = searchParams.get('granularity');
  const granularity: Granularity | null = granularityParam === 'month' || granularityParam === 'quarter' || granularityParam === 'year' ? granularityParam : null;
  const compareParam = searchParams.get('compare');
  const compare: CompareMode = compareParam === 'previous' || compareParam === 'lastYear' ? compareParam : 'off';
  const currentRange = rowParams.from !== undefined && rowParams.to !== undefined ? { from: rowParams.from, to: rowParams.to } : null;
  const compareRange = compare !== 'off' && currentRange !== null ? comparisonRange(currentRange, compare) : null;
  const comparison = useReportRows(
    reportKey,
    { ...rowParams, page: 1, pageSize: 200, ...(compareRange ?? {}) },
    { enabled: !browsing && hasPeriod && compareRange !== null && definition !== undefined && missingRequired.length === 0 },
  );

  // The chart reads the full filtered set (to the 200-row cap), never the table's page (P-06).
  const chartSource = useReportRows(
    reportKey,
    { ...rowParams, page: 1, pageSize: 200 },
    { enabled: !browsing && definition !== undefined && missingRequired.length === 0 },
  );
  const chartRows = chartSource.data?.data ?? [];
  const chartIntro = useChartIntro(chartSource.isSuccess);
  const chartKind = chartKindOf(reportKey, definition, chartRows);
  const primaryColumn = definition === undefined ? null : primaryNumericColumn(definition, active.data?.data ?? []);
  const prevById = new Map((comparison.data?.data ?? []).map((row) => [row.id, row]));

  // Table | Chart | Both, remembered per report on this device; a phone
  // starts on the table, a desk sees both (owner's pick, 21 Aug).
  const [viewModes, setViewModes] = useState<Record<string, string>>(() => {
    try {
      const raw = window.localStorage.getItem('vyuha.reports.viewModes');
      return raw === null ? {} : (JSON.parse(raw) as Record<string, string>);
    } catch {
      return {};
    }
  });
  const storedMode = viewModes[reportKey];
  const viewMode: 'table' | 'chart' | 'both' = storedMode === 'table' || storedMode === 'chart' || storedMode === 'both' ? storedMode : isMobile ? 'table' : 'both';
  function setViewMode(next: 'table' | 'chart' | 'both') {
    setViewModes((current) => {
      const merged = { ...current, [reportKey]: next };
      try {
        window.localStorage.setItem('vyuha.reports.viewModes', JSON.stringify(merged));
      } catch {
        // A locked-down browser forgets; the toggle still works for the session.
      }
      return merged;
    });
  }

  const savedViews = useSavedViews(reportKey);
  const saveView = useSaveView();
  const deleteView = useDeleteView(reportKey);
  const requestExport = useRequestExport();

  const total = active.data?.meta.total ?? 0;

  // ------------------------------------------------------------- actions

  const exportFilters: ReportFilters = {
    ...(period.from ? { from: toDateParam(period.from) } : {}),
    ...(period.to ? { to: toDateParam(period.to) } : {}),
    ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
    ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
    ...(filters.status ? { status: filters.status as ReportFilters['status'] } : {}),
    ...(filters.flags ? { flags: filters.flags } : {}),
    ...(filters.punchType ? { punchType: filters.punchType as ReportFilters['punchType'] } : {}),
    ...(filters.partyId ? { partyId: filters.partyId } : {}),
    ...(filters.groupBy ? { groupBy: filters.groupBy as ReportFilters['groupBy'] } : {}),
    ...(filters.voucherType ? { voucherType: filters.voucherType } : {}),
    ...(filters.ledgerName ? { ledgerName: filters.ledgerName } : {}),
    ...(filters.itemName ? { itemName: filters.itemName } : {}),
  };

  function startExport(format: ExportFormat) {
    if (!canExport) return;
    if (!period.from || !period.to) {
      toast.add({
        type: 'error',
        title: 'Pick a period first',
        description: 'An export always states the range it covers.',
      });
      return;
    }
    requestExport.mutate(
      {
        reportKey,
        filters: { ...exportFilters, from: toDateParam(period.from), to: toDateParam(period.to) },
        columns: visibleColumns,
        sort,
        format,
        // The comparison the screen is showing flows into the file with the
        // same range, the same column and the same header wording.
        ...(compare !== 'off' && compareRange !== null && primaryColumn !== null
          ? {
              compare: {
                ...compareRange,
                columnKey: primaryColumn.key,
                label: compare === 'lastYear' ? 'last FY' : 'previous',
              },
            }
          : {}),
      },
      {
        onSuccess: (job) => {
          toast.add({
            type: 'success',
            title: 'Export started',
            description: `${job.filename} will appear in Downloads when it is ready.`,
          });
        },
        onError: (error: Error) => {
          toast.add({ type: 'error', title: 'Export refused', description: error.message });
        },
      },
    );
  }

  // PRD §6.4: Alt+E exports.
  useShortcut({
    id: 'reports.export',
    keys: 'alt+e',
    label: 'Export',
    scope: 'screen',
    when: () => canExport,
    run: () => {
      startExport('XLSX');
    },
  });

  function applyView(view: SavedView) {
    setSearchParams(() => {
      const params = new URLSearchParams();
      params.set('report', reportKey);
      for (const [key, value] of Object.entries(view.config.filters)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
      }
      if (view.config.columns.length > 0) params.set('columns', view.config.columns.join(','));
      if (view.config.sort !== undefined) params.set('sort', view.config.sort);
      return params;
    });
    toast.add({ type: 'info', title: 'View applied', description: view.name });
  }

  // ---------------------------------------------------------- rendering

  const tableColumns: RecordColumn<ReportRowView>[] = columns.map((column) => ({
    key: column.key,
    header: column.header,
    numeric: isNumericColumn(column.type),
    secondary: column.secondary === true,
    ...(column.sortField === undefined ? {} : { sortField: column.sortField }),
    cell: (row) => renderCell(row.cells[column.key] ?? null, column.type),
  }));

  // Comparison deltas ride beside the primary numeric column: previous value,
  // the change, and the change as a share — 'new' when the base was zero,
  // never a percentage of nothing (data-analyst skill §3).
  if (compare !== 'off' && primaryColumn !== null && comparison.isSuccess) {
    const columnKey = primaryColumn.key;
    const readNumber = (row: ReportRowView | undefined): number => {
      const value = row?.cells[columnKey];
      return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) || 0 : 0;
    };
    tableColumns.push(
      {
        key: 'compare-previous',
        header: compare === 'lastYear' ? `${primaryColumn.header} (last FY)` : `${primaryColumn.header} (previous)`,
        numeric: true,
        secondary: true,
        cell: (row) => {
          const prev = prevById.get(row.id);
          return prev === undefined ? EMPTY_VALUE : renderCell(prev.cells[columnKey] ?? null, 'text');
        },
      },
      {
        key: 'compare-delta',
        header: 'Change',
        numeric: true,
        cell: (row) => {
          const delta = deltaOf(readNumber(row), readNumber(prevById.get(row.id)));
          if (delta.label === 'none') return EMPTY_VALUE;
          return (
            <span className={cn('inline-flex items-center gap-0.5 tabular-nums', delta.direction === 'up' ? 'text-success' : delta.direction === 'down' ? 'text-destructive' : 'text-muted-foreground')}>
              {delta.direction === 'up' ? <ArrowUpIcon className="size-3" /> : delta.direction === 'down' ? <ArrowDownIcon className="size-3" /> : null}
              {delta.label === 'new' ? 'new' : `${delta.absolute > 0 ? '+' : ''}${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(delta.absolute)}${delta.pct === null ? '' : ` (${String(delta.pct)}%)`}`}
            </span>
          );
        },
      },
    );
  }

  // The photo is chrome, not a column: it has no cell in the exported file and
  // must never be one, so it is added to the table rather than to the report's
  // column set (REQ-J-02).
  if (reportKey === 'punch-audit') {
    tableColumns.unshift({
      key: 'photo',
      header: 'Photo',
      className: 'w-16',
      cell: (row) =>
        row.punch === null ? null : (
          <Button
            variant="ghost"
            size="icon"
            aria-label="View the punch photo"
            onClick={(event) => {
              event.stopPropagation();
              setSelectedPunch(row.punch);
            }}
          >
            <ImageIcon />
          </Button>
        ),
    });
  }

  /**
   * PRD §6.5's line two: "two supporting fields".
   *
   * Chosen rather than "the next two columns", because line one already
   * carries the employee's name and the status pill -- repeating either is a
   * row that says one thing twice and the useful field not at all.
   */
  const supporting = columns.filter(
    (column) => !['employeeName', 'status', 'type'].includes(column.key),
  );

  const rows: ReportRowView[] = active.data?.data ?? [];
  const hasStatus = rows.some((row) => row.status !== null);

  const isFiltered =
    filters.departmentId !== null ||
    filters.locationId !== null ||
    filters.employeeId !== null ||
    filters.status !== null ||
    filters.flags !== null ||
    filters.punchType !== null ||
    filters.partyId !== null ||
    filters.groupBy !== null ||
    filters.voucherType !== null ||
    filters.ledgerName !== null ||
    filters.itemName !== null;

  /*
   * REQ-J-05: the same filters without the period.
   *
   * Stripped here rather than left to the server's schema to drop. The request
   * should say what it means, and a payload carrying 01-08 to 31-08 for a
   * schedule that will never use those dates is a payload somebody debugging
   * this will believe.
   */
  const { from: _from, to: _to, ...scheduleFilters } = exportFilters;

  // REQ-L-01, the same formatting the exported file uses, so the caption bar on
  // screen and the header block in the download agree about what a date is.
  // The party is named, not identified: the caption bar and the exported
  // file both said "Party 0192...-8f3a" when they said anything at all.
  const filterNames =
    filters.partyId === null
      ? {}
      : { [filters.partyId]: partyOptions.find((option) => option.id === filters.partyId)?.label ?? filters.partyId };
  const captions = describeFilters(exportFilters, filterNames, formatDate);

  if (browsing) {
    return (
      <ReportCatalogue
        reports={catalogue.data ?? []}
        loading={catalogue.isPending}
        error={
          catalogue.isError
            ? {
                message: catalogue.error.message,
                retry: () => {
                  void catalogue.refetch();
                },
              }
            : null
        }
      />
    );
  }

  // Rendered in the phone row and in the desktop bar; one element each, so
  // the two surfaces cannot drift apart in what they offer.
  const savedViewsControl = (
    <SavedViews
      views={savedViews.data ?? []}
      isLoading={savedViews.isPending}
      currentConfig={{ filters: exportFilters, columns: visibleColumns, sort }}
      isSaving={saveView.isPending}
      onApply={applyView}
      onSave={async (input) => {
        await saveView.mutateAsync({ reportKey, ...input });
      }}
      onDelete={async (view) => {
        await deleteView.mutateAsync(view.id);
      }}
    />
  );
  const columnChooserControl = (
    <ColumnChooser
      columns={definition?.columns ?? []}
      visible={visibleColumns}
      defaults={defaultVisibleColumns(reportKey)}
      open={chooserOpen}
      onOpenChange={setChooserOpen}
      onVisibleChange={(next) => {
        patchParams((params) => {
          params.set('columns', next.join(','));
        }, true);
      }}
      onReset={() => {
        patchParams((params) => {
          params.set('columns', defaultVisibleColumns(reportKey).join(','));
        }, true);
      }}
    />
  );

  /*
   * REQ-J-03 is titled "Excel export", so Excel is what the button does and
   * CSV is the alternative behind the caret -- rather than a format Select
   * the reader has to set before every export. Alt+E takes the primary
   * action, which is the whole point of a default. One element -- the header
   * on a phone, the end of the toolbar's second row on a desk -- so the two
   * surfaces cannot drift in what they offer.
   */
  const exportControl = (
            <ButtonGroup>
              <Button
                className="gap-2"
                disabled={!canExport || requestExport.isPending}
                onClick={() => {
                  startExport('XLSX');
                }}
              >
                <DownloadSimpleIcon data-icon="inline-start" />
                Export
                <ShortcutHint keys="alt+e" className="hidden md:inline-flex" />
              </Button>
              {isMobile ? (
                <Button
                  aria-label="Choose an export format"
                  disabled={!canExport || requestExport.isPending}
                  onClick={() => {
                    setExportSheetOpen(true);
                  }}
                >
                  <CaretDownIcon />
                </Button>
              ) : (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label="Choose an export format"
                      disabled={!canExport || requestExport.isPending}
                    >
                      <CaretDownIcon />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => {
                      startExport('XLSX');
                    }}
                  >
                    Excel workbook (.xlsx)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      startExport('CSV');
                    }}
                  >
                    Comma-separated (.csv)
                  </DropdownMenuItem>
                  {/* REQ-J-05, in the export menu rather than as a third
                      toolbar button: it is the same action on a timer, and a
                      third button crowds the header at 360px. */}
                  <DropdownMenuItem
                    onClick={() => {
                      setScheduleOpen(true);
                    }}
                  >
                    <CalendarPlusIcon data-icon="inline-start" />
                    Schedule this report
                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      window.print();
                    }}
                  >
                    <PrinterIcon />
                    Print / save as PDF
                  </DropdownMenuItem>
</DropdownMenuContent>
              </DropdownMenu>
              )}
            </ButtonGroup>
  );

  return (
    <>
      {/* The report's identity, above the toolbar (owner, 25 Aug): what it
          is, which shelf it came from, what it answers -- and the way back to
          the hub. One block, no card (CLAUDE.md §3). */}
      <div className="flex flex-col gap-1">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground -ml-2"
            onClick={backToHub}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            All reports
          </Button>
        </div>
        <PageHeader
          // The report's name is the title, and the title is the switcher:
          // one element says what this is and lets you change it (Ctrl+G).
          title={
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Button
                variant="ghost"
                className="-ml-2.5 h-auto gap-1.5 px-2.5 py-1 text-base font-semibold"
                onClick={() => {
                  setSwitcherOpen(true);
                }}
              >
                {definition?.label ?? 'Report'}
                <CaretDownIcon className="text-muted-foreground" />
                <ShortcutHint keys="ctrl+g" className="hidden md:inline-flex" />
              </Button>
              {definition === undefined ? null : <CategoryChip category={definition.category} />}
            </span>
          }
          // On a desk the export closes the toolbar's second row instead,
          // beside the other controls that shape the reading.
          action={isMobile ? exportControl : undefined}
        />
        {/* Not PageHeader's description: the identity block clamps it, so a
            two-sentence gloss cannot push the toolbar below the fold. */}
        <p className="text-muted-foreground line-clamp-2 max-w-prose text-sm">
          {definition?.description ?? 'Every report shares one shell.'}
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {!canExport ? (
          <p className="text-muted-foreground text-xs">
            Export is disabled: it needs the report export permission.
          </p>
        ) : null}

        {/* Toolbar (PRD §6.2). On a phone the filters live in a bottom sheet
            (REQ-AD-15, thumb-reach): one Filters button instead of a wall of
            full-width controls before any data. */}
        {/*
          Mounted, not merely hidden: `md:hidden` alone left both this row and
          the desktop bar in the document, so the two ColumnChoosers below
          shared one `open` state and both opened at once — and the hidden
          one, having no box to anchor to, put its popover in the top-left
          corner of the window, over the sidebar. Two copies of the same
          controls also meant two elements with the same id, so a label could
          toggle the checkbox nobody could see. One row exists at a time.
        */}
        {isMobile ? (
        <div className="md:hidden">
          <div className="flex items-center gap-2">
            <Button
              variant={isFiltered ? 'default' : 'outline'}
              onClick={() => {
                setMobileFiltersOpen(true);
              }}
            >
              <FunnelIcon data-icon="inline-start" />
              Filters
              {isFiltered ? <Badge variant="secondary" className="ml-1">on</Badge> : null}
            </Button>
            {savedViewsControl}
            {columnChooserControl}
            {chartKind !== 'none' ? (
              <ToggleGroup
                variant="outline"
                aria-label="How the report shows"
                className="ml-auto"
                value={[viewMode]}
                onValueChange={(value: string[]) => {
                  const next = value[0];
                  if (next === 'table' || next === 'chart' || next === 'both') setViewMode(next);
                }}
              >
                <ToggleGroupItem value="table" aria-label="Table view">
                  <TableIcon />
                </ToggleGroupItem>
                <ToggleGroupItem value="chart" aria-label="Chart view">
                  <ChartBarIcon />
                </ToggleGroupItem>
                <ToggleGroupItem value="both" aria-label="Both views">
                  <SquareSplitVerticalIcon />
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}
          </div>
          {/* Thumb-reach: a four-row menu on a phone arrives from the bottom
              edge, not from the top-right corner the dropdown would pin to. */}
          <Sheet open={exportSheetOpen} onOpenChange={setExportSheetOpen}>
            <SheetContent side="bottom" className="gap-0 p-0">
              <SheetHeader className="border-b">
                <SheetTitle>Export</SheetTitle>
                <SheetDescription>{definition?.label ?? 'This report'}, with the filters as they stand.</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                {(
                  [
                    { label: 'Excel workbook (.xlsx)', icon: <FileXlsIcon data-icon="inline-start" />, run: () => { startExport('XLSX'); } },
                    { label: 'Comma-separated (.csv)', icon: <FileCsvIcon data-icon="inline-start" />, run: () => { startExport('CSV'); } },
                    { label: 'Schedule this report', icon: <CalendarPlusIcon data-icon="inline-start" />, run: () => { setScheduleOpen(true); } },
                    { label: 'Print / save as PDF', icon: <PrinterIcon data-icon="inline-start" />, run: () => { window.print(); } },
                  ] as const
                ).map((action) => (
                  <Button
                    key={action.label}
                    variant="ghost"
                    className="justify-start"
                    onClick={() => {
                      setExportSheetOpen(false);
                      action.run();
                    }}
                  >
                    {action.icon}
                    {action.label}
                  </Button>
                ))}
              </div>
            </SheetContent>
          </Sheet>

          <Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
            <SheetContent side="bottom" className="max-h-[88vh] gap-0 p-0">
              <SheetHeader className="border-b">
                <SheetTitle>Filters</SheetTitle>
                <SheetDescription>{definition?.label ?? 'This report'} — period, filters, sort and columns.</SheetDescription>
              </SheetHeader>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <ReportFilterBar
                  available={definition?.filters ?? []}
                  periodMode={periodMode}
                  value={filters}
                  onChange={setFilters}
                  departments={departments.data ?? []}
                  locations={locations.data ?? []}
                  canReadParties={canReadParties}
                  periodOpen={periodOpen}
                  onPeriodOpenChange={setPeriodOpen}
                  onClear={clearFilters}
                  isFiltered={isFiltered}
                />
                {hasPeriod ? (
                  <div className="flex flex-col gap-2">
                    <Select
                      value={compare}
                      onValueChange={(value: string | null) => {
                        if (value === null) return;
                        patchParams((params) => {
                          if (value === 'previous' || value === 'lastYear') params.set('compare', value);
                          else params.delete('compare');
                        });
                      }}
                    >
                      <SelectTrigger className="w-full" aria-label="Compare against">
                        <SelectValue>{(value: string) => (value === 'previous' ? 'vs previous period' : value === 'lastYear' ? 'vs same period last FY' : 'No comparison')}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">No comparison</SelectItem>
                        <SelectItem value="previous">vs previous period</SelectItem>
                        <SelectItem value="lastYear">vs same period last FY</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                <SortControl
                  definition={definition}
                  sort={sort}
                  onSortChange={setSort}
                  triggerClassName="flex-1"
                />
              </div>
            </SheetContent>
          </Sheet>
        </div>
        ) : null}

        {/* Two quiet rows on a desk (owner, 25 Aug). The first says what the
            data covers: the period, the comparison against another one, and
            the saved views that name such coverages. The second says how it
            reads: filters, sort, columns, table or chart, and the export that
            carries the reading out. One row holding all of it at once was the
            "unorganised" the owner named. */}
        {isMobile ? null : (
        <div className="hidden flex-col gap-2 md:flex">
          <div className="flex flex-wrap items-center gap-2">
              {hasPeriod ? (
                <>
                  <PeriodField
                    mode={periodMode}
                    value={filters.period}
                    onChange={setFilters}
                    open={periodOpen}
                    onOpenChange={setPeriodOpen}
                  />
                  <Select
                    value={granularity ?? 'custom'}
                    onValueChange={(value: string | null) => {
                      if (value === null) return;
                      patchParams((params) => {
                        if (value === 'month' || value === 'quarter' || value === 'year') {
                          const range = periodForGranularity(value, new Date().toLocaleDateString('en-CA'));
                          params.set('granularity', value);
                          params.set('from', range.from);
                          params.set('to', range.to);
                        } else {
                          params.delete('granularity');
                        }
                      });
                    }}
                  >
                    <SelectTrigger className="w-36" aria-label="Period granularity">
                      <SelectValue>{(value: string) => (value === 'month' ? 'This month' : value === 'quarter' ? 'This quarter' : value === 'year' ? 'This FY' : 'Custom period')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="custom">Custom period</SelectItem>
                      <SelectItem value="month">This month</SelectItem>
                      <SelectItem value="quarter">This quarter</SelectItem>
                      <SelectItem value="year">This FY (Apr–Mar)</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={compare}
                    onValueChange={(value: string | null) => {
                      if (value === null) return;
                      patchParams((params) => {
                        if (value === 'previous' || value === 'lastYear') params.set('compare', value);
                        else params.delete('compare');
                      });
                    }}
                  >
                    <SelectTrigger className="w-44" aria-label="Compare against">
                      <SelectValue>{(value: string) => (value === 'previous' ? 'vs previous period' : value === 'lastYear' ? 'vs same period last FY' : 'No comparison')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">No comparison</SelectItem>
                      <SelectItem value="previous">vs previous period</SelectItem>
                      <SelectItem value="lastYear">vs same period last FY</SelectItem>
                    </SelectContent>
                  </Select>
                </>
              ) : null}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {savedViewsControl}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ReportFilterBar
              available={definition?.filters ?? []}
              periodMode={periodMode}
              value={filters}
              onChange={setFilters}
              departments={departments.data ?? []}
              locations={locations.data ?? []}
              canReadParties={canReadParties}
              periodOpen={periodOpen}
              onPeriodOpenChange={setPeriodOpen}
              onClear={clearFilters}
              isFiltered={isFiltered}
              hidePeriod
            />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <SortControl
                definition={definition}
                sort={sort}
                onSortChange={setSort}
                triggerClassName="w-44"
              />
              {columnChooserControl}
              {chartKind !== 'none' ? (
                <ToggleGroup
                  variant="outline"
                  aria-label="How the report shows"
                  value={[viewMode]}
                  onValueChange={(value: string[]) => {
                    const next = value[0];
                    if (next === 'table' || next === 'chart' || next === 'both') setViewMode(next);
                  }}
                >
                  <ToggleGroupItem value="table">
                    <TableIcon data-icon="inline-start" />
                    Table
                  </ToggleGroupItem>
                  <ToggleGroupItem value="chart">
                    <ChartBarIcon data-icon="inline-start" />
                    Chart
                  </ToggleGroupItem>
                  <ToggleGroupItem value="both">
                    <SquareSplitVerticalIcon data-icon="inline-start" />
                    Both
                  </ToggleGroupItem>
                </ToggleGroup>
              ) : null}
              {exportControl}
            </div>
          </div>
          {hasPeriod ? (
            <p className="text-muted-foreground text-xs tabular-nums">
              {compare !== 'off' && compareRange !== null ? (
                <span>
                  against {formatDate(compareRange.from)} – {formatDate(compareRange.to)}
                  {currentRange !== null ? ', to date' : ''}
                  {/* The party filter above scopes both periods, which is what
                      lets one customer or vendor be compared across them. */}
                  {definition?.filters.includes('partyId')
                    ? filters.partyId
                      ? `, for ${partyOptions.find((option) => option.id === filters.partyId)?.label ?? 'one party'}`
                      : ' · whole business — filter by party to compare one'
                    : ''}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
        )}

        {/* What this report is showing, in words, so a shared link explains
            itself and matches the block at the top of the exported file. */}
        <p className="text-muted-foreground text-xs">
          {captions.map((caption) => `${caption.label}: ${caption.value}`).join('  ·  ')}
        </p>

        {unknownReport ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>That report is not available to you</AlertTitle>
            <AlertDescription>
              {`"${reportKey}" is not in the catalogue this server offers you — either this build does not have it, or your role holds no permission over what it reports on. Pick another with Ctrl+G.`}
            </AlertDescription>
          </Alert>
        ) : null}

        {catalogue.isError ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>The report list could not be loaded</AlertTitle>
            <AlertDescription>
              {catalogue.error.message}
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => {
                  void catalogue.refetch();
                }}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {missingRequired.length > 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ChartBarIcon />
              </EmptyMedia>
              <EmptyTitle>{missingRequired.includes('partyId') ? 'Choose a party' : 'Choose a period'}</EmptyTitle>
              <EmptyDescription>
                {missingRequired.includes('partyId')
                  ? 'A customer statement is for one party. Pick one in the filter bar to see every voucher and the running balance.'
                  : 'This report needs a period.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {active.isPending && !unknownReport && missingRequired.length === 0 ? <TableSkeleton /> : null}

        {active.isError ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>This report could not be loaded</AlertTitle>
            <AlertDescription>
              {active.error.message}
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => {
                  void active.refetch();
                }}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {active.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ChartBarIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing in this period</EmptyTitle>
              <EmptyDescription>
                {isFiltered
                  ? 'No row matches these filters. Widen them, or move the period.'
                  : 'This report has no rows for the dates selected. Try a different period.'}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (isFiltered) clearFilters();
                  else setFilters({ period: { from: subDays(new Date(), 30), to: new Date() } });
                }}
              >
                {isFiltered ? 'Clear filters' : 'Show the last 30 days'}
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <>
            {viewMode !== 'table' && chartKind === 'bespoke' ? <ReportChart reportKey={reportKey} rows={chartRows} animate={chartIntro} compare={compare === 'off' || !comparison.isSuccess ? undefined : { rows: comparison.data.data, label: compare === 'lastYear' ? 'Last FY' : 'Previous' }} /> : null}
            {viewMode !== 'table' && chartKind === 'generic' && definition !== undefined ? (
              <GenericReportChart reportKey={reportKey} definition={definition} rows={chartRows} animate={chartIntro} compare={compare === 'off' || !comparison.isSuccess ? undefined : { rows: comparison.data.data, label: compare === 'lastYear' ? 'Last FY' : 'Previous' }} onDrill={drillToSegment} />
            ) : null}
            {viewMode !== 'table' && chartSource.isSuccess && total > 200 ? <p className="text-muted-foreground text-xs">The chart reads the top 200 rows by the current sort; the table has all {String(total)}.</p> : null}
            {viewMode === 'chart' ? null : (
            <RecordTable
              columns={tableColumns}
              sort={sort === '' ? null : { field: sort.startsWith('-') ? sort.slice(1) : sort, descending: sort.startsWith('-') }}
              onSortChange={(next) => {
                setSort(next.descending ? `-${next.field}` : next.field);
              }}
              rows={rows}
              rowKey={(row) => row.id}
              mobilePrimary={(row) => row.primary}
              {...(hasStatus
                ? {
                    mobileStatus: (row: ReportRowView) =>
                      row.status === null ? EMPTY_VALUE : humaniseEnum(row.status),
                  }
                : {})}
              mobileSupporting={(row) => {
                const render = (column: ReportColumnSpec | undefined) =>
                  column === undefined
                    ? EMPTY_VALUE
                    : renderCell(row.cells[column.key] ?? null, column.type);
                return (
                  <span className="flex items-center gap-2">
                    {render(supporting[0])}
                    <span aria-hidden>·</span>
                    {render(supporting[1])}
                  </span>
                );
              }}
              onRowActivate={
                reportKey === 'punch-audit'
                  ? (row) => {
                      setSelectedPunch(row.punch);
                    }
                  : undefined
              }
            />
            )}
            {viewMode === 'chart' ? null : <RecordPagination page={page} pageSize={pageSize} total={total} />}
          </>
        ) : null}
      </div>

      <ReportSwitcher
        reports={catalogue.data ?? []}
        current={reportKey}
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        onSelect={switchReport}
      />

      <ScheduleDialog
        reportKey={reportKey}
        filters={scheduleFilters}
        columns={visibleColumns}
        sort={sort}
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
      />

      <PunchPhotoSheet
        punch={selectedPunch}
        onOpenChange={(open) => {
          if (!open) setSelectedPunch(null);
        }}
      />
    </>
  );
}
