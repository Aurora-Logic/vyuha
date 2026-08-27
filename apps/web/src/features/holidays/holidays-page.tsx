import { useState } from 'react';
import {
  CalendarDotsIcon,
  CaretLeftIcon,
  CaretRightIcon,
  PencilSimpleIcon,
  PlusIcon,
  UploadSimpleIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { addMonths, format, isSameMonth, parseISO, startOfMonth } from 'date-fns';
import { useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { RowActions } from '@/components/shared/row-actions';
import { SectionHeading } from '@/components/shared/section-heading';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MonthField } from '@/features/attendance/pickers';
import { DeleteMasterDialog, type DeleteTarget } from '@/features/org-masters';
import { apiErrorCopy } from '@/features/leave/api-error-copy';
import { SampleDataNotice } from '@/features/leave/sample-data-notice';
import { ApiError } from '@/lib/api/client';
import { formatDate } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { PERMISSIONS } from '@vyuha/shared';
import { usePermission } from '@/lib/session/permissions';

import { CalendarSheet } from './calendar-sheet';
import { DeleteHolidayDialog } from './delete-holiday-dialog';
import {
  draftFromCalendar,
  draftFromHoliday,
  newCalendarDraft,
  newHolidayDraft,
  type CalendarDraft,
  type HolidayDraft,
} from './drafts';
import { HolidayMonthCalendar } from './holiday-month-calendar';
import { HolidaySheet } from './holiday-sheet';
import { ImportSheet } from './import-sheet';
import { allowanceOf, type Holiday, type HolidayCalendar } from './types';
import { useHolidayCalendars } from './use-holidays';

/**
 * REQ-H-01…H-04 / PRD §5 screen 13: the holiday calendars.
 *
 * Calendars are stacked rather than put behind tabs. There are two or three of
 * them, they are compared against each other constantly ("is Diwali on the
 * same day in both offices?"), and a tab strip both hides that comparison and
 * is the first thing to overflow at 360px.
 */

/** Two years back and one forward is the range anyone edits or checks. */
function yearOptions(current: number): number[] {
  return [current - 2, current - 1, current, current + 1];
}

/**
 * The stepper and the menu have to agree on the range, or an arrow walks to a
 * year the menu cannot show and the trigger renders a value with no option
 * behind it.
 */
function yearBounds(current: number): { earliest: number; latest: number } {
  const options = yearOptions(current);
  return { earliest: Math.min(...options), latest: Math.max(...options) };
}

/**
 * `yyyy-MM` from the URL, or this month. Parsed by hand rather than through
 * `new Date(raw)`, which accepts most of a string and returns Invalid Date for
 * the rest — a hand-edited URL should land on this month, never on NaN.
 */
function readMonth(raw: string | null): Date {
  const now = startOfMonth(new Date());
  if (raw === null) return now;
  const match = /^(\d{4})-(\d{2})$/u.exec(raw);
  if (!match) return now;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return now;
  return new Date(year, month - 1, 1);
}

const BASE_COLUMNS: RecordColumn<Holiday>[] = [
  {
    key: 'date',
    header: 'Date',
    cell: (row) => <span className="font-medium">{formatDate(row.date)}</span>,
    className: 'tabular-nums',
  },
  {
    key: 'day',
    header: 'Day',
    // A holiday that lands on a weekly off is worth seeing at a glance: it
    // changes nothing for attendance and everything for a comp-off claim.
    cell: (row) => format(parseISO(row.date), 'EEEE'),
    secondary: true,
  },
  { key: 'name', header: 'Holiday', cell: (row) => row.name },
  {
    key: 'restricted',
    header: 'Type',
    cell: (row) =>
      row.restricted ? (
        <Badge variant="outline">Restricted</Badge>
      ) : (
        <Badge variant="secondary">Public</Badge>
      ),
  },
];

/**
 * One calendar, shown a month at a time.
 *
 * The grid answers "how does this month fall" — which long weekend, which
 * holiday lands on a weekly off — and the list underneath answers "what is it
 * called". A list on its own could not do the first, which is the question
 * somebody planning leave actually has.
 */
function CalendarSection({
  calendar,
  month,
  onMonthChange,
  canManage,
  onEditCalendar,
  onDeleteCalendar,
  onAddHoliday,
  onEditHoliday,
  onDeleteHoliday,
}: {
  calendar: HolidayCalendar;
  month: Date;
  onMonthChange: (month: Date) => void;
  canManage: boolean;
  onEditCalendar: () => void;
  onDeleteCalendar: () => void;
  onAddHoliday: () => void;
  onEditHoliday: (holiday: Holiday) => void;
  onDeleteHoliday: (holiday: Holiday) => void;
}) {
  const restricted = calendar.holidays.filter((holiday) => holiday.restricted).length;
  const allowance = allowanceOf(calendar);
  const monthKey = format(month, 'yyyy-MM');
  const inMonth = calendar.holidays.filter((holiday) => holiday.date.startsWith(monthKey));

  const blocked = canManage
    ? undefined
    : 'Needs the holiday.manage permission, which your account does not hold.';

  /**
   * The two verbs each dated holiday offers.
   *
   * Rendered in a trailing column above 768px and in the stacked row's action
   * slot below it, so a phone is not left with a date it can read and not
   * change (PRD §6.5).
   */
  const actionsFor = (row: Holiday) => (
    <RowActions
      label={`Actions for ${row.name}`}
      actions={[
        {
          key: 'edit',
          label: 'Edit holiday',
          icon: ACTION_ICONS.edit,
          onSelect: () => {
            onEditHoliday(row);
          },
          ...(blocked === undefined ? {} : { unavailableReason: blocked }),
        },
        {
          key: 'delete',
          label: 'Remove holiday',
          icon: ACTION_ICONS.remove,
          destructive: true,
          onSelect: () => {
            onDeleteHoliday(row);
          },
          ...(blocked === undefined ? {} : { unavailableReason: blocked }),
        },
      ]}
    />
  );

  const columns: RecordColumn<Holiday>[] = [
    ...BASE_COLUMNS,
    { key: 'actions', header: 'Actions', className: 'w-12 text-right', cell: actionsFor },
  ];

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title={calendar.name}
        note={
          `${String(calendar.holidays.length)} holidays` +
          (restricted > 0
            ? `, ${String(restricted)} restricted · ${String(allowance)} allowed each`
            : '') +
          (calendar.locations.length > 0 ? ` · ${calendar.locations.join(', ')}` : '')
        }
        action={
          <>
            <Button variant="outline" size="sm" disabled={!canManage} onClick={onEditCalendar}>
              <PencilSimpleIcon data-icon="inline-start" />
              Edit calendar
            </Button>
            {/* The delete sits in the menu rather than beside Edit: a
                destructive control a few pixels from an ordinary one is the
                classic mis-tap, and this one takes a whole year of dates. */}
            <RowActions
              label={`More actions for ${calendar.name}`}
              actions={[
                {
                  key: 'delete',
                  label: 'Delete calendar',
                  icon: ACTION_ICONS.remove,
                  destructive: true,
                  onSelect: onDeleteCalendar,
                  ...(blocked === undefined ? {} : { unavailableReason: blocked }),
                },
              ]}
            />
          </>
        }
      />

      <HolidayMonthCalendar
        month={month}
        onMonthChange={onMonthChange}
        holidays={calendar.holidays}
      />

      {inMonth.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarDotsIcon />
            </EmptyMedia>
            <EmptyTitle>No holidays in {format(month, 'MMMM yyyy')}</EmptyTitle>
            <EmptyDescription>
              {calendar.holidays.length === 0
                ? 'Holidays are entered or imported for each year; nothing is assumed.'
                : 'Step to another month, or use the grid above to see where this year’s holidays fall.'}
            </EmptyDescription>
          </EmptyHeader>
          {canManage ? (
            <EmptyContent>
              <Button onClick={onAddHoliday}>
                <PlusIcon data-icon="inline-start" />
                Add a holiday
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <RecordTable
          columns={columns}
          rows={inMonth}
          rowKey={(row) => row.id}
          mobilePrimary={(row) => row.name}
          // The whole row is deliberately no longer clickable. A gesture with
          // nothing on screen announcing it is why an administrator could not
          // find edit or delete at all, and nesting a button inside a clickable
          // row would announce one control as two.
          mobileStatus={(row) => (
            <div className="flex items-center gap-1">
              {row.restricted ? <Badge variant="outline">Restricted</Badge> : null}
              {actionsFor(row)}
            </div>
          )}
          mobileSupporting={(row) => `${formatDate(row.date)} · ${format(parseISO(row.date), 'EEEE')}`}
        />
      )}
    </section>
  );
}

export function HolidaysPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  // Technical design §10: the UI reflects the server's rule, it does not
  // replace it. Every write below is refused by `@RequirePermission` too.
  const canManage = usePermission(PERMISSIONS.HOLIDAY_MANAGE);
  const [calendarDraft, setCalendarDraft] = useState<CalendarDraft | null>(null);
  const [holidayDraft, setHolidayDraft] = useState<HolidayDraft | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deletingCalendar, setDeletingCalendar] = useState<DeleteTarget | null>(null);
  const [deletingHoliday, setDeletingHoliday] = useState<Holiday | null>(null);

  // The month lives in the URL rather than in state: a month somebody is
  // looking at is a link worth pasting, and it survives a reload. The year the
  // query needs is derived from it, so there is one source of truth for
  // "when".
  const month = readMonth(searchParams.get('month'));
  const year = month.getFullYear();
  const { earliest: earliestYear, latest: latestYear } = yearBounds(new Date().getFullYear());

  const query = useHolidayCalendars(year);
  const calendars = query.data?.data ?? [];
  const sample = query.data?.sample ?? false;

  const activeId = searchParams.get('calendar');
  const active = calendars.find((entry) => entry.id === activeId) ?? calendars[0] ?? null;

  function setParam(key: string, value: string | null) {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (value === null) params.delete(key);
        else params.set(key, value);
        return params;
      },
      { replace: true },
    );
  }

  function setMonth(next: Date) {
    const first = startOfMonth(next);
    setParam('month', isSameMonth(first, new Date()) ? null : format(first, 'yyyy-MM'));
  }

  const atCurrentMonth = isSameMonth(month, new Date());
  // The stepper is bounded by the years the API is asked for, so an arrow
  // cannot walk into a year nothing was ever fetched for and show an empty
  // grid that reads as a loading failure.
  const atEarliest = year <= earliestYear && month.getMonth() === 0;
  const atLatest = year >= latestYear && month.getMonth() === 11;

  // PRD §6.4: F2 changes the date. On a month view that means the month —
  // the same binding My Attendance uses for the same control.
  useShortcut({
    id: 'holidays.change-month',
    keys: 'f2',
    label: 'Change month',
    scope: 'screen',
    run: () => {
      setMonthPickerOpen(true);
    },
  });

  const copy = apiErrorCopy(query.error, {
    subject: 'holiday calendars',
    permission: 'holiday.manage',
  });

  return (
    <>
      {sample ? <SampleDataNotice endpoint="/api/v1/holiday-calendars" /> : null}

      <PageHeader
        description="Each calendar is a named list of dated holidays. Employees inherit one from their location."
        action={
          canManage ? (
            <Button
              onClick={() => {
                setCalendarDraft(newCalendarDraft(year));
              }}
            >
              <PlusIcon data-icon="inline-start" />
              New calendar
            </Button>
          ) : null
        }
      />

      {/* Toolbar row (PRD §6.2), the same shape My Attendance uses: a stepper
          either side of the period, and a reset that appears only when there
          is something to reset to. The calendar picker sits first because it
          chooses *what* is being read; the month chooses *when*. */}
      <div className="flex flex-wrap items-center gap-2">
        {calendars.length > 1 ? (
          <Select
            value={active?.id ?? null}
            onValueChange={(next: string | null) => {
              setParam('calendar', next);
            }}
          >
            <SelectTrigger
              id="holiday-calendar"
              aria-label="Holiday calendar"
              className="w-full sm:w-56"
            >
              <SelectValue>
                {(value: string | null) =>
                  calendars.find((entry) => entry.id === value)?.name ?? 'Choose a calendar'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {calendars.map((entry) => (
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
            disabled={atEarliest}
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
            disabled={atLatest}
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

        {/* The two write actions belong to the calendar on screen, so they sit
            at the far end of the same row rather than in the page header,
            which names the screen and not the calendar. Both disappear
            entirely without holiday.manage: there is no calendar to act on and
            a disabled pair would be two dead controls on a phone. */}
        {canManage && active ? (
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setImportOpen(true);
              }}
            >
              <UploadSimpleIcon data-icon="inline-start" />
              Import
            </Button>
            <Button
              onClick={() => {
                setHolidayDraft(newHolidayDraft(active.id, active.year, month));
              }}
            >
              <PlusIcon data-icon="inline-start" />
              Add holiday
            </Button>
          </div>
        ) : null}
      </div>

      {query.isPending ? <ListSkeleton rows={4} heading label="Loading holiday calendars" /> : null}

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
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {query.isSuccess && calendars.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarDotsIcon />
            </EmptyMedia>
            <EmptyTitle>No calendars for {year}</EmptyTitle>
            <EmptyDescription>
              Create a calendar per location or state, then enter or import that year&apos;s dates.
            </EmptyDescription>
          </EmptyHeader>
          {canManage ? (
            <EmptyContent>
              <Button
                onClick={() => {
                  setCalendarDraft(newCalendarDraft(year));
                }}
              >
                <PlusIcon data-icon="inline-start" />
                New calendar for {year}
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : null}

      {/* One calendar at a time, chosen in the toolbar. Stacking every
          calendar as a grid would put three month views on one screen and
          leave the reader comparing three things nobody asked to compare. */}
      {active ? (
        <CalendarSection
          calendar={active}
          month={month}
          onMonthChange={setMonth}
          canManage={canManage}
          onEditCalendar={() => {
            setCalendarDraft(draftFromCalendar(active));
          }}
          onDeleteCalendar={() => {
            setDeletingCalendar({
              entityType: 'holidayCalendar',
              id: active.id,
              name: `${active.name} ${String(active.year)}`,
              consequences: [
                `All ${String(active.holidays.length)} dates in it go with it.`,
                'Employees who inherit it lose their holiday list, and their days are judged as ordinary working days.',
              ],
            });
          }}
          onAddHoliday={() => {
            setHolidayDraft(newHolidayDraft(active.id, active.year, month));
          }}
          onEditHoliday={(holiday) => {
            setHolidayDraft(draftFromHoliday(holiday, active.id, active.year));
          }}
          onDeleteHoliday={setDeletingHoliday}
        />
      ) : null}

      <CalendarSheet
        draft={calendarDraft}
        onOpenChange={(open) => {
          if (!open) setCalendarDraft(null);
        }}
      />
      <HolidaySheet
        draft={holidayDraft}
        onOpenChange={(open) => {
          if (!open) setHolidayDraft(null);
        }}
      />
      <ImportSheet
        calendarId={importOpen && active ? active.id : null}
        calendarName={active?.name ?? ''}
        year={active?.year ?? year}
        onOpenChange={setImportOpen}
      />
      <DeleteMasterDialog
        target={deletingCalendar}
        onOpenChange={(open) => {
          if (!open) setDeletingCalendar(null);
        }}
      />
      <DeleteHolidayDialog
        holiday={deletingHoliday}
        calendarName={active?.name ?? 'this calendar'}
        onOpenChange={(open) => {
          if (!open) setDeletingHoliday(null);
        }}
      />
    </>
  );
}
