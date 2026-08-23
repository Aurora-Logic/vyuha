import { useMemo, useState } from 'react';
import { CalendarXIcon, CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { endOfMonth, isSameMonth, startOfMonth } from 'date-fns';

import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { EMPTY_VALUE, formatDate } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { useMe } from '@/lib/session/use-session';
import { cn } from '@/lib/utils';

import { ChartCard } from '@/components/shared/chart-card';

import { TimekeepingChart, WorkedHoursChart } from './charts';
import { dateRange, hasValues, timekeepingByDay, workedByDay } from './chart-series';
import { DayDetailSheet } from './day-detail-sheet';
import { formatClock, formatDuration, fromDateParam, toDateParam } from './format';
import { MonthCalendar } from './month-calendar';
import { MonthField } from './pickers';
import { QueryErrorAlert } from './query-error';
import { SampleDataNotice } from './sample-data-notice';
import { AttendanceFlags, AttendanceStatusBadge } from './status-badge';
import type { AttendanceDay } from './types';
import { useAttendanceDays } from './use-attendance-days';
import { useCanViewOvertime } from './visibility';
import { useChartIntro } from './use-chart-motion';

/**
 * REQ-E-01, REQ-E-02 / PRD §5 screen 4: one employee's own month.
 *
 * Calendar and list rather than one or the other. The calendar answers "how
 * was the month" in a glance, which is what somebody opens this screen for;
 * the list answers "what happened on the 14th", which is what they open it for
 * the second time. Selecting a day in either opens the same detail sheet.
 */

const COLUMNS: RecordColumn<AttendanceDay>[] = [
  {
    key: 'date',
    header: 'Date',
    // REQ-L-01: dd-MM-yyyy, never the raw ISO string the API sends.
    cell: (row) => <span className="font-medium tabular-nums">{formatDate(row.date)}</span>,
    className: 'tabular-nums',
  },
  {
    key: 'shift',
    header: 'Shift',
    cell: (row) => row.shiftName ?? EMPTY_VALUE,
    secondary: true,
  },
  { key: 'in', header: 'In', cell: (row) => formatClock(row.firstIn), numeric: true },
  { key: 'out', header: 'Out', cell: (row) => formatClock(row.lastOut), numeric: true },
  {
    key: 'worked',
    header: 'Worked',
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
];

/**
 * The OT column is dropped, not blanked. The server sends no `otMinutes` to a
 * viewer holding only `attendance.view.self`, so a column left in place would
 * be a header over a row of dashes -- which reads as "you did no overtime"
 * rather than "this is not yours to see".
 */
function columnsFor(canSeeOvertime: boolean): RecordColumn<AttendanceDay>[] {
  return canSeeOvertime ? COLUMNS : COLUMNS.filter((column) => column.key !== 'ot');
}

/**
 * Mirrors what actually loads, in order: summary strip, calendar, list. The
 * strip was missing entirely, so the calendar a reader had started scanning
 * jumped ~120px the moment the month arrived. Dimensions are taken from the
 * loaded screen (strip cell 59px, calendar 391px at 360 / 335px at 1440),
 * not from what looked about right.
 */
function MonthSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading your attendance" className="flex flex-col gap-4">
      <div aria-hidden className="divide-border grid grid-cols-2 divide-x divide-y border sm:grid-cols-4 sm:divide-y-0">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col gap-0.5 px-3 py-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-6 w-8" />
          </div>
        ))}
      </div>
      <div aria-hidden className="flex flex-col gap-3 border p-3">
        {/* The month caption row, then seven weekday labels, then six weeks
            of day cells at the calendar's own cell size (36px, 44px coarse). */}
        <div className="flex items-center justify-between">
          <Skeleton className="pointer-coarse:size-11 size-9" />
          <Skeleton className="h-5 w-32" />
          <Skeleton className="pointer-coarse:size-11 size-9" />
        </div>
        <div className="grid min-h-10 grid-cols-7 items-center gap-1">
          {Array.from({ length: 7 }, (_, index) => (
            <Skeleton key={index} className="mx-auto h-4 w-6" />
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 42 }, (_, index) => (
            <Skeleton key={index} className="pointer-coarse:h-11 h-9" />
          ))}
        </div>
        <div className="border-t pt-3">
          <Skeleton className="h-4 w-48" />
        </div>
      </div>
      <div aria-hidden className="border">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex min-h-14 items-center gap-4 border-b px-3 py-2.5 last:border-b-0 md:min-h-9">
            <Skeleton className="h-3 w-20 shrink-0" />
            <Skeleton className="hidden h-3 w-16 shrink-0 sm:block" />
            <Skeleton className="h-3 w-12 shrink-0" />
            <Skeleton className="ml-auto h-4 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

interface Totals {
  present: number;
  halfDay: number;
  absent: number;
  leave: number;
  otMinutes: number;
}

function summarise(days: AttendanceDay[]): Totals {
  return days.reduce<Totals>(
    (totals, day) => ({
      present: totals.present + (day.status === 'PRESENT' ? 1 : 0),
      // A half day counts as half a day present, which is the number a payroll
      // operator expects to see, so it is reported separately rather than
      // folded into either column.
      halfDay: totals.halfDay + (day.status === 'HALF_DAY' ? 1 : 0),
      absent: totals.absent + (day.status === 'ABSENT' ? 1 : 0),
      leave: totals.leave + (day.status === 'ON_LEAVE' ? 1 : 0),
      otMinutes: totals.otMinutes + day.otMinutes,
    }),
    { present: 0, halfDay: 0, absent: 0, leave: 0, otMinutes: 0 },
  );
}

function SummaryStrip({ totals, showOvertime }: { totals: Totals; showOvertime: boolean }) {
  const entries: [string, string][] = [
    ['Present', String(totals.present)],
    ['Half days', String(totals.halfDay)],
    ['Absent', String(totals.absent)],
    ['On leave', String(totals.leave)],
  ];
  // Appended rather than blanked, and the column count follows it: four
  // figures in a five-column grid would leave a labelled empty cell where the
  // withheld one used to be.
  if (showOvertime) entries.push(['Overtime', formatDuration(totals.otMinutes)]);

  return (
    // A bordered strip divided by rules, not five cards. PRD §6.2 puts the
    // content directly on the page surface, and five cards inside a page is
    // the box-in-box this product does not do.
    <dl
      className={cn(
        'divide-border grid grid-cols-2 divide-x divide-y border sm:divide-y-0',
        showOvertime ? 'sm:grid-cols-5' : 'sm:grid-cols-4',
      )}
    >
      {entries.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5 px-3 py-2">
          <dt className="text-muted-foreground text-[0.6875rem]">{label}</dt>
          <dd className="text-base font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function MyAttendancePage() {
  const me = useMe();
  const canSeeOvertime = useCanViewOvertime();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selected, setSelected] = useState<AttendanceDay | null>(null);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);

  const from = toDateParam(startOfMonth(month));
  const to = toDateParam(endOfMonth(month));

  // The id comes from the session, not from a `me` sentinel. This screen used
  // to send `employeeId=me` on the belief that the server resolved it; the
  // server validates the parameter as a UUID and answered 400 on every load,
  // which the sample-data fallback did not cover because it only substitutes
  // for a missing endpoint (404), not a rejected request.
  //
  // Sending the real id is safe: every attendance query runs inside the
  // caller's scope predicate. Verified against the running API - an Employee
  // asking for a colleague's id gets 200 with zero rows, not their days.
  const employeeId = me.data?.user.employeeId ?? null;

  const query = useAttendanceDays(
    { from, to, employeeId, pageSize: 31 },
    // A user account need not be linked to an employee record - an
    // administrator created for the system itself has no attendance. Asking
    // anyway would return the whole organisation for someone holding
    // ATTENDANCE_VIEW_ALL, which is the opposite of what this screen means.
    { enabled: employeeId !== null },
  );

  const days = useMemo(() => query.data?.value.data ?? [], [query.data]);
  const totals = useMemo(() => summarise(days), [days]);
  const byDate = useMemo(() => new Map(days.map((day) => [day.date, day])), [days]);
  const columns = useMemo(() => columnsFor(canSeeOvertime), [canSeeOvertime]);

  // Every date in the month, not only the ones that came back. A month plotted
  // from returned rows alone would draw the 3rd next to the 7th and read as a
  // continuous run of work.
  const monthDates = useMemo(() => dateRange(from, to), [from, to]);
  const hoursPoints = useMemo(() => workedByDay(days, monthDates), [days, monthDates]);
  const timekeepingPoints = useMemo(
    () => timekeepingByDay(days, monthDates),
    [days, monthDates],
  );
  const workedDays = useMemo(
    () => hoursPoints.filter((point) => point.workedMinutes > 0).length,
    [hoursPoints],
  );
  const timekeepingTotal = useMemo(
    () =>
      timekeepingPoints.reduce(
        (sum, point) => sum + point.lateMinutes + point.earlyExitMinutes,
        0,
      ),
    [timekeepingPoints],
  );
  // One policy for both charts: draw once, when the first month lands. Stepping
  // to another month redraws instantly.
  const monthIntro = useChartIntro(query.isSuccess);

  // PRD §6.4: F2 changes the date. On a month view that means the month.
  useShortcut({
    id: 'my-attendance.change-month',
    keys: 'f2',
    label: 'Change month',
    scope: 'screen',
    run: () => {
      setMonthPickerOpen(true);
    },
  });

  function step(delta: number) {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  }

  const atCurrentMonth = isSameMonth(month, new Date());

  return (
    <>
      <PageHeader description="Your attendance for the month, day by day." />

      <div className="flex flex-col gap-4">
        {/* Toolbar row (PRD §6.2). Wraps rather than scrolling sideways at
            360px. */}
        <div className="flex flex-wrap items-center gap-2">
          <ButtonGroup>
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous month"
              onClick={() => {
                step(-1);
              }}
            >
              <CaretLeftIcon />
            </Button>
            {/* Open state is owned here rather than inside the field, because
                F2 has to be able to open it without a click (PRD §6.4). */}
            <MonthField
              value={month}
              onValueChange={(next) => {
                setMonth(startOfMonth(next));
              }}
              label="Month"
              open={monthPickerOpen}
              onOpenChange={setMonthPickerOpen}
              hint={<ShortcutHint keys="f2" className="ml-1 hidden md:inline-flex" />}
            />
            <Button
              variant="outline"
              size="icon"
              aria-label="Next month"
              // A month that has not happened has no attendance in it, so
              // stepping into it is disabled rather than showing an empty grid
              // that looks like a loading failure.
              disabled={atCurrentMonth}
              onClick={() => {
                step(1);
              }}
            >
              <CaretRightIcon />
            </Button>
          </ButtonGroup>

          {!atCurrentMonth ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMonth(startOfMonth(new Date()));
              }}
            >
              This month
            </Button>
          ) : null}
        </div>

        {query.data?.sample ? <SampleDataNotice what="attendance day" /> : null}

        {me.isSuccess && employeeId === null ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CalendarXIcon />
              </EmptyMedia>
              <EmptyTitle>This account has no employee record</EmptyTitle>
              <EmptyDescription>
                Attendance belongs to an employee, and this sign-in is not linked to one. An
                administrator can link it from the employee register.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {query.isPending && employeeId !== null ? <MonthSkeleton /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="attendance"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess ? (
          <>
            <SummaryStrip totals={totals} showOvertime={canSeeOvertime} />

            <MonthCalendar
              month={month}
              onMonthChange={setMonth}
              days={days}
              selected={selected ? fromDateParam(selected.date) : undefined}
              onSelectDay={(date) => {
                // A day outside the fetched month, or one before the employee
                // joined, has no record. Opening an empty sheet for it would
                // be worse than not opening one.
                const match = byDate.get(toDateParam(date));
                if (match) setSelected(match);
              }}
            />

            {/* Two readings the calendar and the strip cannot give.
                The calendar says what each day *was*; this says how long it
                ran, which is the difference between a present day and a
                present day that finished at four. The strip counts days and
                never mentions minutes at all, so neither chart restates it.

                They are here rather than only on the dashboard because the
                dashboard is fixed to the current month; this screen is the
                only place a reader can ask the same question about June. */}
            {days.length > 0 ? (
              <>
                <ChartCard
                  title="Hours worked, day by day"
                  description="Line. Minutes worked on each day of the month"
                  empty={!hasValues(hoursPoints, ['workedMinutes'])}
                  emptyNote="No hours recorded this month."
                  footnote={
                    workedDays > 0
                      ? `${String(workedDays)} day${workedDays === 1 ? '' : 's'} with hours`
                      : undefined
                  }
                >
                  <WorkedHoursChart points={hoursPoints} animate={monthIntro} />
                </ChartCard>

                <ChartCard
                  title="Minutes lost at each end of the day"
                  description="Grouped bar. Late arrivals against early exits"
                  empty={!hasValues(timekeepingPoints, ['lateMinutes', 'earlyExitMinutes'])}
                  emptyNote="Nothing late and nothing cut short this month."
                  footnote={
                    timekeepingTotal > 0 ? `${String(timekeepingTotal)} minutes in total` : undefined
                  }
                >
                  <TimekeepingChart points={timekeepingPoints} animate={monthIntro} />
                </ChartCard>
              </>
            ) : null}

            {days.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CalendarXIcon />
                  </EmptyMedia>
                  <EmptyTitle>Nothing recorded this month</EmptyTitle>
                  <EmptyDescription>
                    Days appear here once you punch, or once the nightly job closes out the date.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <RecordTable
                columns={columns}
                rows={days}
                rowKey={(row) => row.date}
                mobilePrimary={(row) => formatDate(row.date)}
                mobileStatus={(row) => <AttendanceStatusBadge status={row.status} />}
                mobileSupporting={(row) =>
                  `${formatClock(row.firstIn)}–${formatClock(row.lastOut)} · ${formatDuration(row.workedMinutes)}`
                }
                onRowActivate={setSelected}
              />
            )}
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
