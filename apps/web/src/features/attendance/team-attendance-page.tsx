import { useEffect, useMemo, useState } from 'react';
import { CaretLeftIcon, CaretRightIcon, InfoIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { addDays, isToday, startOfDay } from 'date-fns';
import { useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { PageHeader } from '@/components/shared/page-header';
import { PersonChip } from '@/components/shared/person';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SearchField } from '@/components/shared/search-field';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EMPTY_VALUE, formatDate } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { cn } from '@/lib/utils';
import {
  ATTENDANCE_STATUSES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type AttendanceStatus,
} from '@vyuha/shared';

import { ChartCard } from '@/components/shared/chart-card';

import { StatusBandsChart } from './charts';
import { dateRange, statusBands } from './chart-series';
import { DayDetailSheet } from './day-detail-sheet';
import { formatClock, formatDuration, fromDateParam, toDateParam } from './format';
import { DateField } from './pickers';
import { QueryErrorAlert } from './query-error';
import { SampleDataNotice } from './sample-data-notice';
import { AttendanceFlags, AttendanceStatusBadge, EarlyStreakBadge } from './status-badge';
import { statusClasses, statusLabel } from './status';
import type { AttendanceDay } from './types';
import { useAttendanceDays, useDepartments } from './use-attendance-days';
import { useCanViewOvertime } from './visibility';
import { useAttendancePeriod } from './use-attendance-period';
import { useChartIntro } from './use-chart-motion';

/**
 * PRD §5 screen 7 / REQ-J-01 "Daily Muster": one row per employee for a date.
 *
 * Filter state lives in the query string for the same reason it does on the
 * employee register — a filtered muster has to be a link somebody can paste
 * into a message, and has to survive a reload.
 */

const ALL = 'ALL';

function isAttendanceStatus(value: string | null): value is AttendanceStatus {
  return value !== null && (ATTENDANCE_STATUSES as readonly string[]).includes(value);
}

function readPositiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  // Number('') is 0 and Number('abc') is NaN. Both are somebody hand-editing
  // the URL, and both should land on the default rather than on page NaN.
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** `?date=` as a Date, falling back to today when it is missing or nonsense. */
function readDate(raw: string | null): Date {
  if (raw === null) return startOfDay(new Date());
  const parsed = fromDateParam(raw);
  if (Number.isNaN(parsed.getTime())) return startOfDay(new Date());
  return parsed;
}

const COLUMNS: RecordColumn<AttendanceDay>[] = [
  {
    key: 'employee',
    header: 'Employee',
    cell: (row) => <PersonChip name={row.employee.name} className="font-medium" />,
  },
  { key: 'shift', header: 'Shift', cell: (row) => row.shiftName ?? EMPTY_VALUE },
  { key: 'in', header: 'In', cell: (row) => formatClock(row.firstIn), numeric: true },
  { key: 'out', header: 'Out', cell: (row) => formatClock(row.lastOut), numeric: true },
  {
    key: 'hours',
    header: 'Hours',
    cell: (row) => formatDuration(row.workedMinutes),
    numeric: true,
  },
  {
    key: 'ot',
    header: 'OT',
    cell: (row) => formatDuration(row.otMinutes),
    numeric: true,
    secondary: true,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <AttendanceStatusBadge status={row.status} />,
  },
  {
    key: 'flags',
    header: 'Flags',
    headerIcon: <ACTION_ICONS.flag />,
    cell: (row) => (row.flags.length > 0 ? <AttendanceFlags flags={row.flags} /> : EMPTY_VALUE),
    secondary: true,
  },
  {
    key: 'streak',
    header: 'Early streak',
    cell: (row) => (row.earlyStreak > 0 ? <EarlyStreakBadge streak={row.earlyStreak} /> : EMPTY_VALUE),
    numeric: true,
    secondary: true,
  },
];

/**
 * Reaching this screen needs `attendance.view.team`, which is also the key that
 * grants overtime -- so in practice the column always survives. It is filtered
 * on the same predicate anyway: the muster must not be the one screen that
 * would print a column of dashes if the two rules ever came apart.
 */
function columnsFor(canSeeOvertime: boolean): RecordColumn<AttendanceDay>[] {
  return canSeeOvertime ? COLUMNS : COLUMNS.filter((column) => column.key !== 'ot');
}

/**
 * How the day went, above the rows that say it person by person.
 *
 * My Attendance answers "how was the month" with a coloured grid before it
 * answers "what happened on the 14th". This is the same glance for a
 * population rather than a month: the shape of the day first, the detail
 * underneath. Same families and labels as the grid and the badges, so a colour
 * means one thing everywhere in the product.
 *
 * Only the statuses present are shown. A fixed list of eight would spend a
 * third of a 360px screen naming states this day does not contain.
 *
 * The count is of the loaded rows, which is not the whole day when the muster
 * is paginated — and a summary that silently describes a page while looking
 * like it describes a day is worse than no summary. So it says which it is.
 */
function StatusStrip({ rows, total }: { rows: AttendanceDay[]; total: number }) {
  const counts = useMemo(() => {
    const tally = new Map<AttendanceStatus, number>();
    for (const row of rows) tally.set(row.status, (tally.get(row.status) ?? 0) + 1);
    return ATTENDANCE_STATUSES.filter((status) => tally.has(status)).map((status) => ({
      status,
      count: tally.get(status) ?? 0,
    }));
  }, [rows]);

  if (counts.length === 0) return null;
  const partial = rows.length < total;

  return (
    <ul
      aria-label={partial ? 'Status counts for this page' : 'Status counts for the day'}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border p-3"
    >
      {counts.map(({ status, count }) => (
        <li key={status} className="flex items-center gap-1.5 text-xs">
          <span aria-hidden className={cn('size-3 shrink-0 border', statusClasses(status))} />
          <span className="font-medium tabular-nums">{count}</span>
          <span className="text-muted-foreground">{statusLabel(status)}</span>
        </li>
      ))}
      {partial ? (
        <li className="text-muted-foreground ml-auto text-[0.6875rem] tabular-nums">
          this page of {total}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * How many days of context sit behind the muster.
 *
 * A fortnight rather than a week: a week cannot show a weekly pattern, because
 * every weekday appears once and there is nothing to compare it against. Two
 * weeks gives each weekday a pair, which is the smallest window in which
 * "Mondays are bad" is visible at all.
 */
const CONTEXT_DAYS = 14;

function MusterSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the muster" className="border">
      {Array.from({ length: 10 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0"
        >
          <Skeleton className="h-3 w-32 shrink-0" />
          <Skeleton className="hidden h-3 w-20 shrink-0 sm:block" />
          <Skeleton className="h-3 w-12 shrink-0" />
          <Skeleton className="h-3 w-12 shrink-0" />
          <Skeleton className="hidden h-3 w-16 shrink-0 xl:block" />
          <Skeleton className="ml-auto h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function TeamAttendancePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<AttendanceDay | null>(null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  const date = readDate(searchParams.get('date'));
  const page = readPositiveInt(searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = readPositiveInt(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const q = searchParams.get('q')?.trim() ?? '';
  const departmentId = searchParams.get('departmentId');
  const statusParam = searchParams.get('status');
  const status = isAttendanceStatus(statusParam) ? statusParam : null;

  // The search box is typed into continuously and committed to the URL on a
  // pause, so it needs a local value. `syncedQ` is what makes the two agree
  // again when the URL moves on its own — a Back press, or Clear filters.
  const [draft, setDraft] = useState(q);
  const [syncedQ, setSyncedQ] = useState(q);
  if (syncedQ !== q) {
    setSyncedQ(q);
    if (draft.trim() !== q) setDraft(q);
  }

  useEffect(() => {
    if (draft.trim() === q) return undefined;
    const timer = window.setTimeout(() => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          const value = draft.trim();
          if (value) next.set('q', value);
          else next.delete('q');
          // Narrowing the list invalidates the page number: page 4 of three
          // pages of results is an empty screen that looks like no matches.
          next.delete('page');
          return next;
        },
        // Replace, so Back leaves the search rather than walking backwards
        // through every prefix that was typed to reach it.
        { replace: true },
      );
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [draft, q, setSearchParams]);

  function patchParams(apply: (params: URLSearchParams) => void) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      apply(next);
      next.delete('page');
      return next;
    });
  }

  function setDate(next: Date) {
    patchParams((params) => {
      params.set('date', toDateParam(next));
    });
  }

  function clearFilters() {
    setDraft('');
    patchParams((params) => {
      params.delete('q');
      params.delete('status');
      params.delete('departmentId');
    });
  }

  // PRD §6.4: F2 changes the date.
  useShortcut({
    id: 'team-attendance.change-date',
    keys: 'f2',
    label: 'Change date',
    scope: 'screen',
    run: () => {
      setDatePickerOpen(true);
    },
  });

  const dateParam = toDateParam(date);
  const query = useAttendanceDays({
    from: dateParam,
    to: dateParam,
    departmentId,
    status,
    q,
    page,
    pageSize,
  });
  const departments = useDepartments();

  // The fortnight behind the muster. Department-scoped like the table, but
  // deliberately not narrowed by the status filter or the search box: this is
  // the context the day is read against, and a context filtered to "Absent" or
  // to one surname would answer a different question from the one it asks.
  const contextFrom = toDateParam(addDays(date, -(CONTEXT_DAYS - 1)));
  const context = useAttendancePeriod({ from: contextFrom, to: dateParam, departmentId });

  const rows = query.data?.value.data ?? [];
  const total = query.data?.value.meta.total ?? 0;
  const filtered = q.length > 0 || status !== null || departmentId !== null;
  const departmentOptions = departments.data?.value.data ?? [];
  const canSeeOvertime = useCanViewOvertime();
  const columns = useMemo(() => columnsFor(canSeeOvertime), [canSeeOvertime]);

  const contextDates = useMemo(() => dateRange(contextFrom, dateParam), [contextFrom, dateParam]);
  const contextDays = useMemo(() => context.data?.value.days ?? [], [context.data]);
  const bandPoints = useMemo(
    () => statusBands(contextDays, contextDates),
    [contextDays, contextDates],
  );
  const contextComplete = context.data?.value.complete ?? true;
  const contextIntro = useChartIntro(context.isSuccess);
  const departmentName = departmentOptions.find((option) => option.id === departmentId)?.name;

  return (
    <>
      <PageHeader description="Who worked, when, and what needs looking at — one row per employee for the day." />

      <div className="flex flex-col gap-4">
        {/* Toolbar row (PRD §6.2). Wraps to three rows at 360px rather than
            scrolling sideways. */}
        <div className="flex flex-wrap items-center gap-2">
          <ButtonGroup>
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous day"
              onClick={() => {
                setDate(addDays(date, -1));
              }}
            >
              <CaretLeftIcon />
            </Button>
            <DateField
              value={date}
              onValueChange={setDate}
              label="Muster date"
              open={datePickerOpen}
              onOpenChange={setDatePickerOpen}
              // A future date has no attendance in it. Blocking it in the
              // picker beats returning an empty muster that reads as a fault.
              disabled={(candidate) => candidate > startOfDay(new Date())}
              hint={<ShortcutHint keys="f2" className="ml-1 hidden md:inline-flex" />}
            />
            <Button
              variant="outline"
              size="icon"
              aria-label="Next day"
              disabled={isToday(date)}
              onClick={() => {
                setDate(addDays(date, 1));
              }}
            >
              <CaretRightIcon />
            </Button>
          </ButtonGroup>

          {!isToday(date) ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDate(startOfDay(new Date()));
              }}
            >
              Today
            </Button>
          ) : null}

          <SearchField
            id="muster-search"
            label="Search employees"
            placeholder="Code or name"
            value={draft}
            onValueChange={setDraft}
            className="w-full sm:w-56"
          />

          <Select
            value={departmentId ?? ALL}
            onValueChange={(next: string | null) => {
              patchParams((params) => {
                if (next === null || next === ALL) params.delete('departmentId');
                else params.set('departmentId', next);
              });
            }}
          >
            <SelectTrigger
              aria-label="Filter by department"
              className="w-full sm:w-44"
            >
              <SelectValue>
                {(value: string) =>
                  departmentOptions.find((option) => option.id === value)?.name ??
                  'All departments'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All departments</SelectItem>
                {departmentOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select
            value={status ?? ALL}
            onValueChange={(next: string | null) => {
              patchParams((params) => {
                if (next === null || next === ALL) params.delete('status');
                else params.set('status', next);
              });
            }}
          >
            <SelectTrigger
              aria-label="Filter by status"
              className="w-full sm:w-40"
            >
              <SelectValue>
                {(value: string) =>
                  isAttendanceStatus(value) ? statusLabel(value) : 'All statuses'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {ATTENDANCE_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {statusLabel(value)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          {filtered ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <ACTION_ICONS.clearFilters data-icon="inline-start" />
              Clear filters
            </Button>
          ) : null}
        </div>

        {query.data?.sample ? <SampleDataNotice what="attendance day" /> : null}

        {query.isPending ? <MusterSkeleton /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="team attendance"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersThreeIcon />
              </EmptyMedia>
              <EmptyTitle>
                {filtered ? 'No matching rows' : `Nothing recorded for ${formatDate(dateParam)}`}
              </EmptyTitle>
              <EmptyDescription>
                {filtered
                  ? 'No employee matches this search, department and status. Widen the filters to see more.'
                  : 'The day engine writes a row for every active employee. If this date is before anyone joined, there is nothing to show.'}
              </EmptyDescription>
            </EmptyHeader>
            {filtered ? (
              <EmptyContent>
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  <ACTION_ICONS.clearFilters data-icon="inline-start" />
                  Clear filters
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : null}

        {rows.length > 0 ? <StatusStrip rows={rows} total={total} /> : null}

        {/* The fortnight the day sits in. The muster answers "what happened
            today"; this answers "is today normal", which is the question a
            manager actually opens the screen with and which no table of one
            date can answer. It renders whether or not the day itself has rows,
            because a day with nothing recorded is exactly when the run-up
            matters most. */}
        {context.isPending ? (
          <ChartCard
            title={`The fortnight to ${formatDate(dateParam)}`}
            description="Stacked bar. How the status bands moved over the run-up"
            pending
          >
            <span />
          </ChartCard>
        ) : null}

        {context.isError ? (
          <QueryErrorAlert
            error={context.error}
            subject="the fortnight behind this date"
            onRetry={() => {
              void context.refetch();
            }}
          />
        ) : null}

        {context.isSuccess && !contextComplete ? (
          <Alert>
            <InfoIcon />
            <AlertTitle>Too many days to chart the fortnight</AlertTitle>
            <AlertDescription>
              {`The list endpoint holds ${String(context.data.value.total)} days for these ${String(CONTEXT_DAYS)}, which is more than this screen reads in one go. Filter to a department to bring it back. Charting the part that arrived would show a real collapse where the data simply stopped.`}
            </AlertDescription>
          </Alert>
        ) : null}

        {context.isSuccess && contextComplete ? (
          <ChartCard
            title={`The fortnight to ${formatDate(dateParam)}`}
            description="Stacked bar. How the status bands moved over the run-up"
            empty={contextDays.length === 0}
            emptyNote={`Nothing recorded in the ${String(CONTEXT_DAYS)} days to this date.`}
            footnote={departmentName ?? 'Everyone you may see'}
          >
            <StatusBandsChart points={bandPoints} animate={contextIntro} />
          </ChartCard>
        ) : null}

        {rows.length > 0 ? (
          <>
            <RecordTable
              columns={columns}
              rows={rows}
              rowKey={(row) => `${row.employee.id}:${row.date}`}
              mobilePrimary={(row) => row.employee.name}
              mobileStatus={(row) => <AttendanceStatusBadge status={row.status} />}
              mobileSupporting={(row) =>
                `${formatClock(row.firstIn)}–${formatClock(row.lastOut)} · ${formatDuration(row.workedMinutes)}`
              }
              onRowActivate={setSelected}
            />
            <RecordPagination page={page} pageSize={pageSize} total={total} />
          </>
        ) : null}
      </div>

      <DayDetailSheet
        day={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </>
  );
}
