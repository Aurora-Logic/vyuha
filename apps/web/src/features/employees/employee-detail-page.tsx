import { type ReactNode, createElement, useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  CalendarXIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ProhibitIcon,
  UserFocusIcon,
} from '@phosphor-icons/react';
import { endOfMonth, isSameMonth, startOfMonth } from 'date-fns';
import { Link, useParams } from 'react-router';

import { EmployeeDataExportButton } from '@/components/shared/employee-data-export-button';
import { PageHeader } from '@/components/shared/page-header';
import { RowActions } from '@/components/shared/row-actions';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { ChartCard } from '@/components/shared/chart-card';
import { SectionHeading } from '@/components/shared/section-heading';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { ACTION_ICONS } from '@/components/shared/action-icons';
import { PUNCH_SOURCE_ICONS } from '@/components/shared/entity-icons';
import { Badge } from '@/components/ui/badge';
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
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  RecordHistoryButton,
  RecordHistorySheet,
} from '@/features/audit/record-history-sheet';
import { DayDetailSheet } from '@/features/attendance/day-detail-sheet';
import { formatClock, formatDuration, toDateParam } from '@/features/attendance/format';
import { MonthField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { NEEDS_REVIEW, flagClasses, flagLabel } from '@/features/attendance/status';
import { AttendanceFlags, AttendanceStatusBadge, EarlyStreakBadge } from '@/features/attendance/status-badge';
import { employeeActions } from './employee-actions';
import { EmployeeAccessSection } from './employee-access-section';
import { EmployeeInviteDialog } from './invite-dialog';
import { EmployeeSheet } from './employee-sheet';
import { EmployeeLifecycleDialog, type LifecycleTarget } from './lifecycle-dialog';
import type { AttendanceDay } from '@/features/attendance/types';
import { ApiError } from '@/lib/api/client';
import { EMPTY_VALUE, formatDate, humaniseEnum } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermissions } from '@/lib/session/permissions';
import { useMe } from '@/lib/session/use-session';
import { cn } from '@/lib/utils';
import { employeeDisplayName, PERMISSIONS, type EmployeeDetail } from '@vyuha/shared';

import {
  attendanceVisibility,
  emptyRangeReason,
  summariseRange,
  toFlagTally,
  toLateSeries,
  toStatusSlices,
  toWorkedSeries,
  type AttendanceVisibility,
  type EmptyRangeReason,
  type RangeTotals,
} from './attendance-analysis';
import { LateMinutesChart, StatusSplitChart, WorkedHoursChart } from './attendance-charts';
import { CHART_STAGGER_MS } from './use-chart-motion';
import { STATUS_LABELS, STATUS_VARIANT } from './status';
import { useEmployee } from './use-employee';
import {
  useEmployeeAttendanceDays,
  useEmployeePunches,
  type EmployeePunch,
} from './use-employee-attendance';

/**
 * REQ-A-03 / PRD §5 screen 10, the detail half: one employee's record, and
 * how their month went (REQ-E-01, REQ-E-02, REQ-E-04).
 *
 * Reached by activating a row on the register. The record itself is a handful
 * of facts and needs no more than a strip; the reason to open this screen is
 * the analysis underneath it, so the facts are stated once, compactly, and the
 * page spends its height on the month.
 *
 * Two things this screen deliberately does not show, because there is no
 * endpoint that would let it show them honestly: leave balances, and this
 * person's approval history. Both exist for the signed-in user only today, and
 * inventing a per-employee view of either would mean drawing numbers nothing
 * on the server agrees with.
 *
 * The month is local state rather than a query parameter. The register keeps
 * its filters in the URL because a filtered list is a link somebody sends;
 * "Varun Tiwari, August" is not — the link people send is the person, and the
 * month they want is almost always the current one.
 */

// -------------------------------------------------------------------- facts

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2">
      <dt className="text-muted-foreground text-[0.6875rem]">{label}</dt>
      <dd className="truncate text-xs font-medium">{children}</dd>
    </div>
  );
}

/**
 * Who this is, and the employment facts REQ-A-03 records.
 *
 * A bordered strip divided by rules rather than a grid of cards. One card per
 * fact would be six boxes inside the page, which is the box-in-box this
 * product does not do (CLAUDE.md §3 rule 3).
 *
 * The name is an h2, not an h1: the app header already emits the page's only
 * h1 from the breadcrumb, and a second one would give the document two titles.
 */
function EmployeeFacts({ employee }: { employee: EmployeeDetail }) {
  const name = employeeDisplayName(employee.firstName, employee.lastName);
  const where = [
    employee.employeeCode,
    employee.department?.name,
    employee.designation?.name,
    employee.location?.name,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="text-base font-semibold">{name}</h2>
          <Badge variant={STATUS_VARIANT[employee.status]}>
            {STATUS_LABELS[employee.status]}
          </Badge>
          {/* REQ-D-08: a field-staff exemption changes how every punch below
              is judged, so it belongs beside the name and not in a fact cell
              somebody has to go looking for. */}
          {employee.isFieldStaff ? <Badge variant="outline">Field staff</Badge> : null}
        </div>
        <p className="text-muted-foreground text-xs">{where.join(' · ')}</p>
      </div>

      <dl className="divide-border grid grid-cols-2 divide-x divide-y border sm:grid-cols-3 xl:grid-cols-6">
        <Fact label="Employment">{humaniseEnum(employee.employmentType)}</Fact>
        {/* REQ-L-01: dd-MM-yyyy, never the raw ISO string the API sends. */}
        <Fact label="Joined">
          <span className="tabular-nums">{formatDate(employee.dateOfJoining)}</span>
        </Fact>
        {/* REQ-A-05: only present once somebody has a last working date, so an
            active employee is not given an empty cell to read as a fault. */}
        {employee.dateOfLeaving === null ? null : (
          <Fact label="Last working day">
            <span className="tabular-nums">{formatDate(employee.dateOfLeaving)}</span>
          </Fact>
        )}
        <Fact label="Reports to">{employee.reportingManager?.name ?? EMPTY_VALUE}</Fact>
        <Fact label="Work email">{employee.workEmail ?? EMPTY_VALUE}</Fact>
        <Fact label="Mobile">
          <span className="tabular-nums">{employee.mobile ?? EMPTY_VALUE}</span>
        </Fact>
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ summary

/**
 * The totals above the charts.
 *
 * Deliberately not the status counts: those are the status chart a screen
 * below, and repeating them here would make that chart decoration rather than
 * information.
 */
function RangeSummary({ totals }: { totals: RangeTotals }) {
  const entries: [string, string][] = [
    ['Days recorded', String(totals.daysRecorded)],
    ['Worked', formatDuration(totals.workedMinutes)],
    ['Overtime', formatDuration(totals.overtimeMinutes)],
    ['Late by', formatDuration(totals.lateMinutes)],
    ['Late arrivals', String(totals.lateDays)],
  ];

  return (
    <dl className="divide-border grid grid-cols-2 divide-x divide-y border sm:grid-cols-5 sm:divide-y-0">
      {entries.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5 px-3 py-2">
          <dt className="text-muted-foreground text-[0.6875rem]">{label}</dt>
          <dd className="text-base font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ------------------------------------------------------------------- tables

const DAY_COLUMNS: RecordColumn<AttendanceDay>[] = [
  {
    key: 'date',
    header: 'Date',
    cell: (row) => <span className="font-medium tabular-nums">{formatDate(row.date)}</span>,
    className: 'tabular-nums',
  },
  { key: 'shift', header: 'Shift', cell: (row) => row.shiftName ?? EMPTY_VALUE, secondary: true },
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

const PUNCH_COLUMNS: RecordColumn<EmployeePunch>[] = [
  {
    key: 'date',
    header: 'Date',
    cell: (row) => (
      <span className="font-medium tabular-nums">{formatDate(row.attendanceDate)}</span>
    ),
    className: 'tabular-nums',
  },
  {
    key: 'time',
    // REQ-D-05: the server's clock is the authority, so this is the time shown.
    header: 'Time',
    cell: (row) => formatClock(row.serverTime),
    numeric: true,
  },
  {
    key: 'type',
    header: 'Direction',
    cell: (row) => (
      <Badge variant={row.type === 'IN' ? 'secondary' : 'outline'}>
        {row.type === 'IN' ? 'In' : 'Out'}
      </Badge>
    ),
  },
  {
    key: 'source',
    header: 'Source',
    cell: (row) => (
      <span className="inline-flex items-center gap-1.5 [&_svg]:size-3.5">
        {createElement(PUNCH_SOURCE_ICONS[row.source], { 'aria-hidden': true, className: 'text-muted-foreground' })}
        {humaniseEnum(row.source)}
      </span>
    ),
    secondary: true,
  },
  {
    key: 'flags',
    header: 'Flags',
    headerIcon: <ACTION_ICONS.flag />,
    cell: (row) =>
      row.flags.length > 0 ? <AttendanceFlags flags={[...row.flags]} /> : EMPTY_VALUE,
  },
];

// -------------------------------------------------------------- empty states

interface EmptyCopy {
  title: string;
  description: string;
}

/**
 * What an empty month means, said precisely.
 *
 * `GET /attendance/days` applies its scope predicate in SQL and answers an
 * out-of-scope request with zero rows and a 200, so "you may not see this" and
 * "this person did not come to work" arrive as the same response. Printing the
 * second when the first is true accuses somebody of absence on the strength of
 * a permission boundary, which is the worst thing this screen could do.
 */
function emptyRangeCopy(reason: EmptyRangeReason, employee: EmployeeDetail): EmptyCopy {
  const name = employeeDisplayName(employee.firstName, employee.lastName);

  switch (reason) {
    case 'no-permission':
      return {
        title: 'You cannot see attendance records',
        description:
          'Reading attendance needs one of the attendance view permissions and this sign-in holds none of them, so this section is empty for every employee. Ask an administrator.',
      };
    case 'outside-scope':
      return {
        title: `You cannot see ${name}'s attendance`,
        description:
          'Your permissions cover your own attendance only. Nothing is shown here because you may not read it, not because nothing was recorded.',
      };
    case 'maybe-outside-scope':
      return {
        title: 'Nothing to show for this month',
        description:
          'Either no day was recorded, or this person sits outside the team your permissions cover. The server answers both the same way, so this screen cannot tell you which.',
      };
    case 'joined-after-range':
      return {
        title: 'Before they joined',
        description: `${name} joined on ${formatDate(employee.dateOfJoining)}, which is after this month. Step forward to a month they were employed in.`,
      };
    case 'left-before-range':
      return {
        title: 'After they left',
        description: `${name} left on ${formatDate(employee.dateOfLeaving)}, which is before this month. Step back to a month they were employed in.`,
      };
    case 'nothing-recorded':
      return {
        title: 'Nothing recorded this month',
        description:
          'Days appear here once they punch, or once the nightly job closes out the date.',
      };
  }
}

function EmptyRange({
  employee,
  isSelf,
  visibility,
  from,
  to,
}: {
  employee: EmployeeDetail;
  isSelf: boolean;
  visibility: AttendanceVisibility;
  from: string;
  to: string;
}) {
  const copy = emptyRangeCopy(
    emptyRangeReason({
      visibility,
      isSelf,
      dateOfJoining: employee.dateOfJoining,
      dateOfLeaving: employee.dateOfLeaving,
      from,
      to,
    }),
    employee,
  );

  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CalendarXIcon />
        </EmptyMedia>
        <EmptyTitle>{copy.title}</EmptyTitle>
        <EmptyDescription>{copy.description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

// ------------------------------------------------------------------ skeletons

/** Mirrors the strip and the charts it stands in for, so nothing resizes. */
function AnalysisSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading this employee's attendance"
      className="flex flex-col gap-6"
    >
      <div aria-hidden className="grid grid-cols-2 border sm:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex flex-col gap-1.5 border-r px-3 py-2 last:border-r-0">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-4 w-12" />
          </div>
        ))}
      </div>
      <div aria-hidden className="flex flex-col gap-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-56 w-full" />
      </div>
    </div>
  );
}

function RecordSkeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="border">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0"
        >
          <Skeleton className="h-3 w-20 shrink-0" />
          <Skeleton className="hidden h-3 w-16 shrink-0 sm:block" />
          <Skeleton className="h-3 w-12 shrink-0" />
          <Skeleton className="ml-auto h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- the screen

export function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const permissions = usePermissions();

  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<AttendanceDay | null>(null);

  const from = toDateParam(startOfMonth(month));
  const to = toDateParam(endOfMonth(month));

  const employee = useEmployee(id);
  // Fired alongside the record rather than after it. Serialising the two would
  // cost a round trip on every open for no gain: a request for an id nobody can
  // see comes back empty, which is the state this screen already renders.
  const range = { employeeId: id ?? '', from, to };
  const enabled = typeof id === 'string' && id.length > 0;
  const daysQuery = useEmployeeAttendanceDays(range, { enabled });
  const punchesQuery = useEmployeePunches(range, { enabled });

  // PRD §6.4: F2 changes the date. On a month view that means the month.
  useShortcut({
    id: 'employee-detail.change-month',
    keys: 'f2',
    label: 'Change month',
    scope: 'screen',
    run: () => {
      setMonthPickerOpen(true);
    },
  });

  const days = useMemo(() => daysQuery.data?.data ?? [], [daysQuery.data]);
  // Owner, 21 Aug 2026: the streak as of the latest computed day in view.
  const latestStreak = useMemo(() => {
    const latest = [...days].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    return latest?.earlyStreak ?? 0;
  }, [days]);
  const totals = useMemo(() => summariseRange(days), [days]);
  const workedSeries = useMemo(() => toWorkedSeries(days), [days]);
  const statusSlices = useMemo(() => toStatusSlices(days), [days]);
  const lateSeries = useMemo(() => toLateSeries(days), [days]);
  const flags = useMemo(() => toFlagTally(days), [days]);

  const [sheet, setSheet] = useState<EmployeeDetail | 'new' | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleTarget | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inviting, setInviting] = useState<EmployeeDetail | null>(null);
  const canManage = permissions.has(PERMISSIONS.EMPLOYEE_MANAGE);
  const canReadTrail = permissions.has(PERMISSIONS.AUDIT_VIEW);
  // REQ-B-07. Deliberately not `employee.manage`: HR editing a person's
  // department must not be able to make them an administrator.
  const canManageRoles = permissions.has(PERMISSIONS.ROLES_MANAGE);

  const punches = punchesQuery.data?.punches ?? [];
  const atCurrentMonth = isSameMonth(month, new Date());

  function step(delta: number) {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  }

  // The same actions the register offers, from the same rules, so the two
  // cannot come to different conclusions about what an on-notice employee may
  // have done to them. Somebody who has drilled into a person is the most
  // likely to want to act on them, and until now this was the one screen where
  // they could not.
  const record = employee.data ?? null;
  const actions =
    record === null
      ? []
      : employeeActions({
          employee: record,
          canManage,
          onEdit: () => {
            setSheet(record);
          },
          onLifecycle: setLifecycle,
          onInvite: () => {
            setInviting(record);
          },
        });

  const backToRegister = (
    // Wraps rather than scrolling at 360px, and the row keeps its order:
    // record-scoped actions first, the way out last.
    <div className="flex flex-wrap items-center gap-2">
      {actions.length > 0 ? (
        <RowActions label={`Actions for ${record?.firstName ?? 'this employee'}`} actions={actions} />
      ) : null}
      {/* REQ-M-02. Only offered once the record has loaded: a history button
          that opens an empty sheet while the id is still unknown would look
          like the trail was empty rather than not yet asked for. */}
      {canReadTrail && record !== null ? (
        <RecordHistoryButton
          onClick={() => {
            setHistoryOpen(true);
          }}
        />
      ) : null}
      {/* REQ-M-05, beside the history button because they answer two halves of
          the same question: what this product holds about one person, and who
          has looked at it. The button hides itself without employee.manage, so
          the guard here is only the loaded record -- requesting an export for
          an id that is still unknown would produce a job for nobody. */}
      {record !== null ? (
        <EmployeeDataExportButton
          employeeId={record.id}
          employeeName={employeeDisplayName(record.firstName, record.lastName)}
        />
      ) : null}
      <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/employees" />}>
        <ArrowLeftIcon data-icon="inline-start" />
        Employee register
      </Button>
    </div>
  );

  // Two failures on this route are answers rather than faults, and both deserve
  // a stated reason rather than a red alert. A 404 is returned both for an id
  // that names nobody and for one outside the reader's scope — deliberately
  // indistinguishable, because a 403 there would confirm that the id names a
  // real person. A 403 is the different case: the route policy refused before
  // any record was looked at, so it says nothing about this id at all.
  const failure = employee.error instanceof ApiError ? employee.error : null;
  const notFound = failure?.status === 404;
  const refused = failure?.code === 'FORBIDDEN' || failure?.code === 'OUT_OF_SCOPE';

  return (
    <>
      <PageHeader
        description="One employee's record, and how their attendance reads over a month."
        action={backToRegister}
      />
      {latestStreak > 0 ? (
        <div className="flex items-center gap-2">
          <EarlyStreakBadge streak={latestStreak} />
          <span className="text-muted-foreground text-xs">Consecutive working days punched in ahead of the shift.</span>
        </div>
      ) : null}

      {employee.isPending ? (
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading this employee"
          className="flex flex-col gap-3"
        >
          <Skeleton aria-hidden className="h-5 w-48" />
          <Skeleton aria-hidden className="h-3 w-64" />
          <Skeleton aria-hidden className="h-14 w-full" />
        </div>
      ) : null}

      {/* The wrapper is load-bearing. `Empty` carries `flex-1`, and these two
          are direct children of the page column, which is itself `flex-1` —
          so without something between them the panel grew to fill the whole
          viewport and a two-line message rendered inside a 750px box. Caught
          by looking at a screenshot, not by reading the markup. */}
      {employee.isError && refused ? (
        <div>
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ProhibitIcon />
              </EmptyMedia>
              <EmptyTitle>You cannot open employee records</EmptyTitle>
              <EmptyDescription>
                Reading an employee record needs the employee.view permission, and this sign-in
                does not have it. Ask an administrator to grant it.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{backToRegister}</EmptyContent>
          </Empty>
        </div>
      ) : null}

      {employee.isError && notFound ? (
        <div>
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UserFocusIcon />
              </EmptyMedia>
              <EmptyTitle>No employee at this address</EmptyTitle>
              <EmptyDescription>
                Either there is no such record, or it sits outside the people your permissions
                cover. The server answers both the same way, so this screen cannot tell you which.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{backToRegister}</EmptyContent>
          </Empty>
        </div>
      ) : null}

      {employee.isError && !notFound && !refused ? (
        <QueryErrorAlert
          error={employee.error}
          subject="employee"
          onRetry={() => {
            void employee.refetch();
          }}
        />
      ) : null}

      {employee.isSuccess ? (
        <>
          <EmployeeFacts employee={employee.data} />

          <Separator />

          {/* REQ-B-07's assignment control. Above the month analysis rather
              than below it: "what can this person do" is a question about the
              record, and burying it under three charts would put it past the
              point anyone scrolls.

              Hidden rather than disabled for a reader without roles.manage,
              which CLAUDE.md §4 allows. The sidebar already filters the Roles
              screen out of their navigation entirely, so a permanent refusal
              panel on every employee they open would be the only place in the
              product that told them about a screen they cannot reach. */}
          {canManageRoles ? (
            <>
              <EmployeeAccessSection employee={employee.data} />
              <Separator />
            </>
          ) : null}

          <div className="flex flex-col gap-6">
            {/* Toolbar row (PRD §6.2). Wraps rather than scrolling sideways at
                360px, and matches My Attendance key for key so a month means
                the same gesture wherever it is chosen. */}
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
                {/* Open state is owned here rather than inside the field,
                    because F2 has to open it without a click (PRD §6.4). */}
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
                  // stepping into it is disabled rather than showing an empty
                  // analysis that reads as a loading failure.
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

            {daysQuery.isPending ? <AnalysisSkeleton /> : null}

            {daysQuery.isError ? (
              <QueryErrorAlert
                error={daysQuery.error}
                subject="attendance"
                onRetry={() => {
                  void daysQuery.refetch();
                }}
              />
            ) : null}

            {daysQuery.isSuccess && days.length === 0 ? (
              <EmptyRange
                employee={employee.data}
                isSelf={me.data?.user.employeeId === employee.data.id}
                visibility={attendanceVisibility(permissions)}
                from={from}
                to={to}
              />
            ) : null}

            {days.length > 0 ? (
              // While a new month loads, the previous month's rows are kept so
              // the charts do not blink out and back (`keepPreviousData`). That
              // leaves the picker naming one month while the analysis still
              // draws another, so the analysis says it is stale rather than
              // letting the two quietly disagree. Opacity only, and short
              // enough not to read as a fade — the global reduced-motion rule
              // in index.css collapses the transition to nothing.
              <div
                aria-busy={daysQuery.isPlaceholderData}
                className={cn(
                  'flex flex-col gap-6 transition-opacity duration-200 ease-out',
                  daysQuery.isPlaceholderData && 'opacity-50',
                )}
              >
                <RangeSummary totals={totals} />

                <ChartCard
                  title="Worked hours"
                  description="One bar per day, with overtime carved out of the top of it. The dashed line is the rostered span, which runs door to door — worked time has the break taken out, so a full day sits just under the line."
                >
                  <WorkedHoursChart points={workedSeries} />
                </ChartCard>

                <ChartCard
                  title="Days by status"
                  description="How the month divides. Same colours as the pills in the table below."
                >
                  <StatusSplitChart slices={statusSlices} delayMs={CHART_STAGGER_MS} />
                </ChartCard>

                {/* An axis of nothing is not a finding, and it costs a third
                    of a phone screen to say so -- the card's own empty state
                    says it in a line. */}
                <ChartCard
                  title="Late arrivals"
                  description="Minutes past the rostered start, day by day."
                  empty={totals.lateMinutes === 0}
                  emptyNote="No late arrival this month."
                >
                  <LateMinutesChart points={lateSeries} delayMs={CHART_STAGGER_MS * 2} />
                </ChartCard>

                {flags.length > 0 ? (
                  <section className="flex flex-col gap-3">
                    <SectionHeading
                      icon={<ACTION_ICONS.flag />}
                      title="Flags raised"
                      note="What this month's days were flagged for, commonest first. The ones that need somebody to look are marked out."
                    />
                    <ul className="flex flex-wrap items-center gap-1.5 border p-3">
                      {flags.map(({ flag, count }) => (
                        <li key={flag}>
                          <Badge
                            variant="ghost"
                            className={cn('border gap-1.5', flagClasses(flag).text, flagClasses(flag).border, flagClasses(flag).fill)}
                          >
                            <ACTION_ICONS.flag aria-hidden weight={NEEDS_REVIEW.has(flag) ? 'fill' : 'regular'} />
                            {flagLabel(flag)}
                            <span className="tabular-nums">{count}</span>
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                <section className="flex flex-col gap-3">
                  <SectionHeading
                    title="Days"
                    note="Activate a row for the full day, including its flags."
                  />
                  <RecordTable
                    columns={DAY_COLUMNS}
                    rows={days}
                    rowKey={(row) => row.date}
                    mobilePrimary={(row) => formatDate(row.date)}
                    mobileStatus={(row) => <AttendanceStatusBadge status={row.status} />}
                    mobileSupporting={(row) =>
                      `${formatClock(row.firstIn)}–${formatClock(row.lastOut)} · ${formatDuration(row.workedMinutes)}`
                    }
                    onRowActivate={setSelectedDay}
                  />
                </section>

                <section className="flex flex-col gap-3">
                  <SectionHeading
                    title="Punches"
                    note={
                      punchesQuery.data?.hasMore === true
                        ? 'The first punches of the month, newest first. There are more than this page holds.'
                        : 'Every punch behind the days above, newest first.'
                    }
                  />

                  {punchesQuery.isPending ? (
                    <RecordSkeleton rows={4} label="Loading punches" />
                  ) : null}

                  {/* A failed punch feed must not take the analysis with it:
                      the days above came from a different endpoint and are
                      still true. */}
                  {punchesQuery.isError ? (
                    <QueryErrorAlert
                      error={punchesQuery.error}
                      subject="punches"
                      onRetry={() => {
                        void punchesQuery.refetch();
                      }}
                    />
                  ) : null}

                  {punchesQuery.isSuccess ? (
                    <RecordTable
                      columns={PUNCH_COLUMNS}
                      rows={punches}
                      rowKey={(row) => row.id}
                      mobilePrimary={(row) =>
                        `${formatDate(row.attendanceDate)} · ${formatClock(row.serverTime)}`
                      }
                      mobileStatus={(row) => (
                        <Badge variant={row.type === 'IN' ? 'secondary' : 'outline'}>
                          {row.type === 'IN' ? 'In' : 'Out'}
                        </Badge>
                      )}
                      mobileSupporting={(row) =>
                        [humaniseEnum(row.source), ...row.flags.map(flagLabel)].join(' · ')
                      }
                      emptyState={
                        <Empty>
                          <EmptyHeader>
                            <EmptyTitle>No punch recorded this month</EmptyTitle>
                            <EmptyDescription>
                              A day can exist without one: the nightly job writes a row for every
                              rostered date, whether or not anybody punched.
                            </EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      }
                    />
                  ) : null}
                </section>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <DayDetailSheet
        day={selectedDay}
        onOpenChange={(open) => {
          if (!open) setSelectedDay(null);
        }}
      />

      {/* The same two surfaces the register uses, so an edit made here and an
          edit made there are the same form with the same validation. */}
      <EmployeeSheet
        target={sheet}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
      />
      <EmployeeLifecycleDialog
        target={lifecycle}
        onOpenChange={(open) => {
          if (!open) setLifecycle(null);
        }}
      />
      {/* Same dialog as the register's, from the same action list, so the two
          screens cannot come to different conclusions about who may be
          invited. */}
      <EmployeeInviteDialog
        employee={inviting}
        onOpenChange={(open) => {
          if (!open) setInviting(null);
        }}
      />

      <RecordHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        entityType="employee"
        entityId={record?.id ?? null}
        title={
          record === null ? '' : employeeDisplayName(record.firstName, record.lastName)
        }
        description="Every change recorded against this employee record, newest first."
      />
    </>
  );
}
