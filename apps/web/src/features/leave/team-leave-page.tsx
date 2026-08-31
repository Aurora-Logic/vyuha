import { useState } from 'react';
import {
  CaretLeftIcon,
  CaretRightIcon,
  GiftIcon,
  TreePalmIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { addMonths, format, isSameMonth, parse, startOfMonth } from 'date-fns';
import { useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { PersonChip } from '@/components/shared/person';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  Empty,
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
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { toDateParam } from '@/features/attendance/format';
import { MonthField } from '@/features/attendance/pickers';
import { useDepartments } from '@/features/employees/use-departments';
import { ApiError } from '@/lib/api/client';
import { formatDate } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { apiErrorCopy } from './api-error-copy';
import { AbsenceMonthCalendar } from './absence-month-calendar';
import { CompOffGrantSheet } from './comp-off-grant-sheet';
import {
  PORTION_LABELS,
  awayCount,
  entriesByDate,
  monthBounds,
  warningSentence,
  type LeaveCalendarEntry,
} from './team-calendar';
import { useLeaveCalendar } from './use-team-leave';

/**
 * REQ-G-12: "Team leave calendar: month view showing who is away, with a
 * per-department concurrent-absence warning threshold."
 *
 * The reason this screen exists is a decision: an approver holding a request
 * for the 14th needs to know that two people are already off that day before
 * they click Approve. So the warning is the first thing on the page, above the
 * grid, named by date and department — not a tint somebody has to notice.
 *
 * Scope is the server's. `GET /leave/calendar` resolves the caller through the
 * same scope predicate the rest of leave uses, so a manager sees their own
 * reporting line and HR sees the organisation. Nothing here filters by person.
 *
 * Month, department and the selected day live in the query string for the same
 * reason the muster's filters do: a manager pastes this link into a message.
 */

const ALL_DEPARTMENTS = 'ALL';
const MONTH_PARAM_FORMAT = 'yyyy-MM';

/** `?month=2026-08` as a date, falling back to this month when it is nonsense. */
function readMonth(raw: string | null): Date {
  if (raw === null) return startOfMonth(new Date());
  const parsed = parse(raw, MONTH_PARAM_FORMAT, new Date());
  if (Number.isNaN(parsed.getTime())) return startOfMonth(new Date());
  return startOfMonth(parsed);
}

/** `?date=2026-08-14`, only honoured when it falls inside the month on screen. */
function readSelected(raw: string | null, month: Date): Date | undefined {
  if (raw === null) return undefined;
  const parsed = parse(raw, 'yyyy-MM-dd', new Date());
  if (Number.isNaN(parsed.getTime()) || !isSameMonth(parsed, month)) return undefined;
  return parsed;
}

const COLUMNS: RecordColumn<LeaveCalendarEntry>[] = [
  {
    key: 'employee',
    header: 'Employee',
    cell: (row) => <PersonChip name={row.employee.name} className="font-medium" />,
  },
  {
    key: 'date',
    header: 'Date',
    cell: (row) => formatDate(row.date),
    className: 'tabular-nums',
  },
  {
    key: 'portion',
    header: 'Portion',
    cell: (row) => PORTION_LABELS[row.portion],
  },
  {
    key: 'leaveType',
    header: 'Type',
    cell: (row) => row.leaveType.name,
  },
  {
    key: 'department',
    header: 'Department',
    cell: (row) => row.department?.name ?? '—',
    secondary: true,
  },
];

function CalendarSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading the team leave calendar"
      className="flex flex-col gap-3 border p-3"
    >
      <Skeleton className="mx-auto h-5 w-36" />
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: 42 }, (_, index) => (
          <Skeleton key={index} aria-hidden className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

export function TeamLeavePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  // The endpoint admits `leave.apply.self` as well as the two approver keys,
  // and answers a plain employee with their own days only. The sidebar hides
  // this screen from them, but a pasted link still reaches it — so say what
  // they are looking at rather than let a screen called "Team leave" imply
  // the team has one person in it.
  const canSeeTeam = usePermission(PERMISSIONS.LEAVE_APPROVE_TEAM);

  const month = readMonth(searchParams.get('month'));
  const selected = readSelected(searchParams.get('date'), month);
  const departmentParam = searchParams.get('departmentId');
  const departmentId = departmentParam === null || departmentParam === '' ? null : departmentParam;

  const bounds = monthBounds(month);
  const query = useLeaveCalendar({ from: bounds.from, to: bounds.to, departmentId });
  // A failed picker must not take the calendar with it: no options simply
  // means no department filter is offered.
  const departments = useDepartments().data ?? [];

  const entries = query.data?.entries ?? [];
  const warnings = query.data?.warnings ?? [];
  const threshold = query.data?.threshold ?? 0;

  const byDate = entriesByDate(entries);
  const selectedKey = selected === undefined ? null : toDateParam(selected);
  const listed = selectedKey === null ? entries : (byDate.get(selectedKey) ?? []);

  function setParam(key: string, value: string | null) {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (value === null) params.delete(key);
        else params.set(key, value);
        return params;
      },
      // Replace, so Back leaves the screen rather than walking backwards
      // through every month that was stepped through to reach this one.
      { replace: true },
    );
  }

  function setMonth(next: Date) {
    const first = startOfMonth(next);
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (isSameMonth(first, new Date())) params.delete('month');
        else params.set('month', format(first, MONTH_PARAM_FORMAT));
        // A day chosen in August means nothing in September, and leaving it
        // set would show an empty list that reads as "nobody is away".
        params.delete('date');
        return params;
      },
      { replace: true },
    );
  }

  function setSelected(next: Date | undefined) {
    setParam('date', next === undefined ? null : format(next, 'yyyy-MM-dd'));
  }

  const atCurrentMonth = isSameMonth(month, new Date());

  // PRD §6.4: F2 changes the date. On a month view that means the month — the
  // same binding My Attendance and Holidays use for the same control.
  useShortcut({
    id: 'team-leave.change-month',
    keys: 'f2',
    label: 'Change month',
    scope: 'screen',
    run: () => {
      setMonthPickerOpen(true);
    },
  });

  // PRD §6.4: Alt+C creates a master on the fly. A comp-off credit is the one
  // record this screen creates.
  useShortcut({
    id: 'team-leave.grant-comp-off',
    keys: 'alt+c',
    label: 'Grant comp-off',
    scope: 'screen',
    allowInInput: true,
    when: () => canSeeTeam,
    run: () => {
      setGrantOpen(true);
    },
  });

  const copy = apiErrorCopy(query.error, {
    subject: 'team leave',
    permission: 'leave.approve.team',
  });

  return (
    <>
      {/* "Approved" is not a hedge: `GET /leave/calendar` counts approved days
          only, so a request still in the inbox does not appear here and the
          description has to say so rather than let a reader assume the month
          is complete. */}
      <PageHeader
        description={
          canSeeTeam
            ? 'Approved leave this month, and which days are already thin.'
            : 'Approved leave this month. Without the leave.approve.team permission this shows your own leave only.'
        }
        action={
          // REQ-G-11 grants live here rather than on a screen of their own:
          // the person who grants a credit for a worked holiday is the same
          // approver reading this month, and the key is the same one.
          canSeeTeam ? (
            <Button
              onClick={() => {
                setGrantOpen(true);
              }}
            >
              <GiftIcon data-icon="inline-start" />
              Grant comp-off
              <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs">
              Granting comp-off needs the leave.approve.team permission.
            </span>
          )
        }
      />

      {/* Toolbar row (PRD §6.2), the same shape Holidays uses: what is being
          read first, then when. */}
      <div className="flex flex-wrap items-center gap-2">
        {departments.length > 1 ? (
          <Select
            value={departmentId ?? ALL_DEPARTMENTS}
            onValueChange={(next: string | null) => {
              setParam('departmentId', next === null || next === ALL_DEPARTMENTS ? null : next);
            }}
          >
            <SelectTrigger
              aria-label="Filter by department"
              className="w-full sm:w-56"
            >
              <SelectValue>
                {(value: string) =>
                  departments.find((entry) => entry.id === value)?.name ?? 'All departments'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL_DEPARTMENTS}>All departments</SelectItem>
                {departments.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}

        <ButtonGroup>
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous month"
            onClick={() => {
              setMonth(addMonths(month, -1));
            }}
          >
            <CaretLeftIcon />
          </Button>
          {/* Open state is owned here rather than inside the field, because F2
              has to open it without a click (PRD §6.4). */}
          <MonthField
            value={month}
            onValueChange={setMonth}
            label="Month"
            open={monthPickerOpen}
            onOpenChange={setMonthPickerOpen}
            hint={<ShortcutHint keys="f2" className="ml-1 hidden md:inline-flex" />}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="Next month"
            onClick={() => {
              setMonth(addMonths(month, 1));
            }}
          >
            <CaretRightIcon />
          </Button>
        </ButtonGroup>

        {atCurrentMonth ? null : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMonth(new Date());
            }}
          >
            This month
          </Button>
        )}
      </div>

      {query.isError ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription>
            {copy.description}
            {query.error instanceof ApiError && query.error.requestId ? (
              <span className="mt-1 block font-mono text-[0.6875rem]">
                Request {query.error.requestId}
              </span>
            ) : null}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void query.refetch();
              }}
            >
              <ACTION_ICONS.retry data-icon="inline-start" />
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {/* The warning is the point of the screen, so it is above the grid and
          spelled out by date. Buried as a tint, it would be noticed after the
          decision rather than before it. */}
      {warnings.length > 0 ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>
            {warnings.length === 1
              ? 'One day this month is already at the absence threshold'
              : `${String(warnings.length)} days this month are already at the absence threshold`}
          </AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-0.5">
              {warnings.map((warning) => (
                <li key={`${warning.date}-${warning.department?.id ?? 'org'}`}>
                  <span className="font-medium tabular-nums">{formatDate(warning.date)}</span>{' '}
                  {warningSentence(warning)}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {query.isPending ? (
        <CalendarSkeleton />
      ) : (
        <AbsenceMonthCalendar
          month={month}
          onMonthChange={setMonth}
          selected={selected}
          onSelect={setSelected}
          entries={entries}
          warnings={warnings}
        />
      )}

      <Separator />

      <section className="flex flex-col gap-3">
        <SectionHeading
          title={selectedKey === null ? 'Away this month' : `Away on ${formatDate(selectedKey)}`}
          note={
            threshold > 0
              ? `A day is flagged once ${String(threshold)} or more people in a department are away.`
              : 'No concurrent-absence threshold is set, so no day is flagged.'
          }
          action={
            selectedKey === null ? null : (
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="tabular-nums">
                  {awayCount(listed)} away
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelected(undefined);
                  }}
                >
                  Show the month
                </Button>
              </div>
            )
          }
        />

        {query.isPending ? <ListSkeleton rows={4} label="Loading who is away" /> : null}

        {query.isSuccess && listed.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TreePalmIcon />
              </EmptyMedia>
              <EmptyTitle>
                {selectedKey === null ? 'Nobody is away this month' : 'Nobody is away that day'}
              </EmptyTitle>
              <EmptyDescription>
                {selectedKey === null
                  ? 'Approved leave for your team appears here. A request still waiting on a decision is not counted until it is approved.'
                  : 'Pick another day, or show the whole month.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {listed.length > 0 ? (
          <RecordTable
            columns={COLUMNS}
            rows={[...listed]}
            rowKey={(row) => `${row.leaveRequestId}-${row.date}`}
            mobilePrimary={(row) => row.employee.name}
            mobileStatus={(row) => <Badge variant="secondary">{row.leaveType.code}</Badge>}
            mobileSupporting={(row) =>
              `${formatDate(row.date)} · ${PORTION_LABELS[row.portion]}${row.department ? ` · ${row.department.name}` : ''}`
            }
          />
        ) : null}
      </section>

      {/* Pre-filled with the day on screen when one is chosen: the reason an
          approver opens this sheet is almost always a date they are looking
          at. */}
      <CompOffGrantSheet
        open={grantOpen}
        onOpenChange={setGrantOpen}
        defaultDate={selected ?? month}
      />
    </>
  );
}
