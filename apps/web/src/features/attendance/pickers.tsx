import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { CalendarBlankIcon, ClockIcon } from '@phosphor-icons/react';
import type { DateRange } from 'react-day-picker';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import { formatClock, formatDuration, toDateParam } from './format';

/**
 * Date, month, range and time entry, composed from shadcn primitives.
 *
 * CLAUDE.md §3 is explicit that these are the single most common place the
 * rule gets broken, and equally explicit about why: a native date or time
 * input renders differently in every browser and is close to unusable on a
 * phone. So there is no `<input type="date">` and no picker library anywhere
 * in this module - these four controls are it, and every screen uses them.
 *
 * They live here rather than in `components/shared` only because that
 * directory is locked while three agents are editing this app; they are
 * general-purpose and belong there.
 */

/**
 * Optional external control of the open state.
 *
 * PRD §6.4 gives F2 and Alt+F2 to "change date" and "change period", which
 * means a keystroke has to be able to open a picker that the reader has not
 * clicked. Uncontrolled by default so the common case stays a one-line
 * control, controlled when a shortcut owns it.
 */
interface OpenControl {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface PickerSurfaceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The control that opens the surface. Rendered as the trigger. */
  trigger: ReactElement;
  title: string;
  description: string;
  children: ReactNode;
  /** Rendered pinned to the bottom edge of the phone sheet only. */
  footer?: ReactNode;
}

/**
 * The same picker, arriving from the right place for the device.
 *
 * CLAUDE.md §3: a picker opens as a bottom Sheet on small screens rather than
 * a desktop popover. That is a markup difference, not a styling one - the two
 * surfaces have different structure and different dismissal - so it switches
 * on `useIsMobile()` rather than on a CSS breakpoint.
 */
function PickerSurface({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
}: PickerSurfaceProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger render={trigger} />
        {/* A flex column with a scrolling middle: the title and the actions
            stay pinned while a twelve-month year list moves past them. */}
        <SheetContent side="bottom" className="max-h-[85vh] gap-0">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          {/* min-h-0 is load-bearing: a flex child defaults to min-height:auto
              and would push the footer off the sheet instead of scrolling. */}
          <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto p-4">
            {children}
          </div>
          {footer ? <SheetFooter className="shrink-0 border-t">{footer}</SheetFooter> : null}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-auto">
        {/* Named for assistive technology even though the calendar beneath is
            self-explanatory to a sighted reader. */}
        <PopoverTitle className="sr-only">{title}</PopoverTitle>
        <PopoverDescription className="sr-only">{description}</PopoverDescription>
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Cell sizing for a calendar a thumb has to hit.
 *
 * The component ships `--cell-size: 28px` for a dense desktop, which is the
 * right default here and far too small on a phone. The pointer query raises
 * the whole grid rather than only the button, because the global 44px floor in
 * `index.css` raises the button's height alone and would leave 28px-wide
 * columns with overlapping hit areas.
 */
const TOUCH_CALENDAR = 'pointer-coarse:[--cell-size:--spacing(11)]';

/** Uncontrolled unless the caller passes `open`, in which case it defers. */
function useOpenState(control: OpenControl): [boolean, (next: boolean) => void] {
  const [internal, setInternal] = useState(false);
  const open = control.open ?? internal;
  return [
    open,
    (next: boolean) => {
      setInternal(next);
      control.onOpenChange?.(next);
    },
  ];
}

interface DateFieldProps extends OpenControl {
  value: Date;
  onValueChange: (value: Date) => void;
  /** The accessible name, e.g. "Muster date". */
  label: string;
  /**
   * Renders `label` as text above the control, the way every Input on a form
   * carries one. Off by default: a toolbar's date needs no column of labels
   * above it, and a form's does -- a date sitting beside a labelled field
   * with no label of its own is the row that reads as broken.
   */
  showLabel?: boolean;
  /** Rendered inside the trigger, before the date. */
  hint?: ReactNode;
  disabled?: (date: Date) => boolean;
  className?: string;
  /**
   * How far back the year dropdown reaches, in years before today.
   *
   * The default suits a date near the present -- a muster date, a period
   * boundary. A joining date does not: somebody hired in 2009 is sixteen years
   * of "previous month" away, and paging there one month at a time is the kind
   * of thing that makes a form get abandoned. `EMPLOYEE_DATE_YEARS_BACK` is the
   * value the employee form passes.
   */
  yearsBack?: number;
  /** And forward, for a date that may be in the future (a last working day). */
  yearsForward?: number;
}

/** Two years back covers a muster or a period boundary without a long list. */
const DEFAULT_YEARS_BACK = 2;
const DEFAULT_YEARS_FORWARD = 1;

/**
 * The range a joining or leaving date needs.
 *
 * Fifty years back reaches anybody still working; five forward covers a notice
 * period entered in advance.
 */
export const EMPLOYEE_DATE_YEARS_BACK = 50;
export const EMPLOYEE_DATE_YEARS_FORWARD = 5;

/** One date, written dd-MM-yyyy (REQ-L-01). */
export function DateField({
  value,
  onValueChange,
  label,
  showLabel = false,
  hint,
  disabled,
  className,
  yearsBack = DEFAULT_YEARS_BACK,
  yearsForward = DEFAULT_YEARS_FORWARD,
  ...control
}: DateFieldProps) {
  const [open, setOpen] = useOpenState(control);
  const controlId = useId();

  /*
   * The dropdowns need a bounded range; without `startMonth`/`endMonth` the
   * year list is empty and the caption falls back to a label with no way to
   * jump. Anchored on today rather than on the selected value, so the range
   * does not shift under the reader as they pick.
   */
  const today = new Date();
  const startMonth = new Date(today.getFullYear() - yearsBack, 0, 1);
  const endMonth = new Date(today.getFullYear() + yearsForward, 11, 31);

  const surface = (
    <PickerSurface
      open={open}
      onOpenChange={setOpen}
      title={label}
      description="Pick a date."
      trigger={
        <Button
          id={controlId}
          variant="outline"
          aria-label={label}
          className={cn('w-full justify-start gap-2 tabular-nums', showLabel ? '' : className)}
        >
          <CalendarBlankIcon data-icon="inline-start" />
          {formatDate(toDateParam(value))}
          {hint}
        </Button>
      }
    >
      <Calendar
        mode="single"
        required
        selected={value}
        defaultMonth={value}
        disabled={disabled}
        // Month and year as dropdowns rather than only a pair of arrows. A
        // date more than a few months away is otherwise reached one click at a
        // time, which is the single most common complaint about a date field.
        captionLayout="dropdown"
        startMonth={startMonth}
        endMonth={endMonth}
        onSelect={(next: Date) => {
          onValueChange(next);
          setOpen(false);
        }}
        className={TOUCH_CALENDAR}
      />
    </PickerSurface>
  );

  if (!showLabel) return surface;
  return (
    <Field className={className}>
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      {surface}
    </Field>
  );
}

export interface RangePreset {
  readonly label: string;
  readonly range: () => DateRange;
}

interface DateRangeFieldProps extends OpenControl {
  value: DateRange;
  onValueChange: (value: DateRange) => void;
  label: string;
  hint?: ReactNode;
  className?: string;
  /** Named ranges above the calendar; one tap sets and closes. */
  presets?: readonly RangePreset[];
}

/** A from/to range, for a roster period or a report window (Alt+F2). */
export function DateRangeField({
  value,
  onValueChange,
  label,
  hint,
  className,
  presets,
  ...control
}: DateRangeFieldProps) {
  const [open, setOpen] = useOpenState(control);

  const printed =
    value.from && value.to
      ? `${formatDate(toDateParam(value.from))} – ${formatDate(toDateParam(value.to))}`
      : 'Pick a period';

  return (
    <PickerSurface
      open={open}
      onOpenChange={setOpen}
      title={label}
      description="Pick the first and last day of the period."
      trigger={
        <Button
          variant="outline"
          aria-label={label}
          className={cn('justify-start gap-2 tabular-nums', className)}
        >
          <CalendarBlankIcon data-icon="inline-start" />
          {printed}
          {hint}
        </Button>
      }
      footer={
        <Button
          className="w-full"
          onClick={() => {
            setOpen(false);
          }}
        >
          Done
        </Button>
      }
    >
      {/*
        Presets beside the calendar, not above it.

        A row of nine chips across the top pushed the calendar down and left a
        column of empty surface to its right -- two rows where the space wanted
        one. On a phone they stay a wrapping row above, because a sheet has the
        width for chips and not for two columns.
      */}
      <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
      {presets !== undefined && presets.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-b px-1 pb-3 sm:w-40 sm:shrink-0 sm:flex-col sm:flex-nowrap sm:gap-1 sm:border-r sm:border-b-0 sm:pr-3 sm:pb-0">
          {presets.map((preset) => (
            <Button
              key={preset.label}
              variant="ghost"
              size="sm"
              className="sm:w-full sm:justify-start"
              onClick={() => {
                onValueChange(preset.range());
                setOpen(false);
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      ) : null}
      {/* The surface stays open after the first click on purpose: a range needs
          two, and closing on the first would look like the control losing the
          selection. */}
      <Calendar
        mode="range"
        selected={value}
        defaultMonth={value.from}
        onSelect={(next: DateRange | undefined) => {
          // Clicking the selected start clears the range. `from: undefined`
          // rather than `{}` because that is what the library's own type calls
          // an empty range, and the caller should not have to know two shapes.
          onValueChange(next ?? { from: undefined });
        }}
        className={TOUCH_CALENDAR}
      />
      </div>
    </PickerSurface>
  );
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

interface MonthFieldProps extends OpenControl {
  /** Any date inside the wanted month. Only year and month are read. */
  value: Date;
  onValueChange: (value: Date) => void;
  label: string;
  hint?: ReactNode;
  className?: string;
}

/**
 * A month, as two Selects rather than a calendar.
 *
 * A day grid is the wrong instrument for choosing a month - it makes the
 * reader pick an arbitrary day and hope the screen ignores it. Two lists are
 * exact, and they are two taps on a phone instead of a horizontal scroll
 * through twelve month headers.
 */
export function MonthField({
  value,
  onValueChange,
  label,
  hint,
  className,
  ...control
}: MonthFieldProps) {
  const [open, setOpen] = useOpenState(control);
  const thisYear = new Date().getFullYear();
  // A five-year window either side. Attendance history does not start before
  // the product did, and nobody rosters four years ahead.
  const years = Array.from({ length: 7 }, (_, index) => thisYear - 5 + index);

  return (
    <PickerSurface
      open={open}
      onOpenChange={setOpen}
      title={label}
      description="Pick a month and year."
      trigger={
        <Button
          variant="outline"
          aria-label={label}
          className={cn('min-w-40 justify-start gap-2', className)}
        >
          <CalendarBlankIcon data-icon="inline-start" />
          <span className="tabular-nums">
            {MONTH_NAMES[value.getMonth()]} {value.getFullYear()}
          </span>
          {hint}
        </Button>
      }
      footer={
        <Button
          className="w-full"
          onClick={() => {
            setOpen(false);
          }}
        >
          Done
        </Button>
      }
    >
      <div className="flex w-full flex-col gap-2 sm:flex-row">
        <Select
          value={String(value.getMonth())}
          onValueChange={(next: string | null) => {
            if (next === null) return;
            onValueChange(new Date(value.getFullYear(), Number(next), 1));
          }}
        >
          <SelectTrigger aria-label="Month" className="w-full sm:w-36">
            {/* The value is the 0-based month index; bare SelectValue would
                render it raw - "7" for August. */}
            <SelectValue>
              {(current: string | null) => (current === null ? null : MONTH_NAMES[Number(current)])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {MONTH_NAMES.map((name, index) => (
                <SelectItem key={name} value={String(index)}>
                  {name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <Select
          value={String(value.getFullYear())}
          onValueChange={(next: string | null) => {
            if (next === null) return;
            onValueChange(new Date(Number(next), value.getMonth(), 1));
          }}
        >
          <SelectTrigger aria-label="Year" className="w-full sm:w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {years.map((year) => (
                <SelectItem key={year} value={String(year)}>
                  {year}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </PickerSurface>
  );
}

const HOURS = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0'));
/** Five-minute steps. Shift boundaries are not set to the minute in practice. */
const MINUTES = Array.from({ length: 12 }, (_, index) => String(index * 5).padStart(2, '0'));

interface TimeFieldProps extends OpenControl {
  /** `HH:mm`. */
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  /**
   * Matches a `FieldLabel`'s `htmlFor`, so the trigger is the labelled control.
   * Optional: a toolbar use has no visible label and relies on `aria-label`
   * alone, while a use inside a `Field` needs the association to exist.
   */
  id?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A wall-clock time, as two Selects behind the same surface as the date
 * pickers. Never `<input type="time">` - see the note at the top of this file.
 */
export function TimeField({
  value,
  onValueChange,
  label,
  id,
  disabled,
  className,
  ...control
}: TimeFieldProps) {
  const [open, setOpen] = useOpenState(control);
  const [hour = '00', minute = '00'] = formatClock(value).split(':');

  return (
    <PickerSurface
      open={open}
      onOpenChange={setOpen}
      title={label}
      description="Pick an hour and a minute."
      trigger={
        <Button
          id={id}
          variant="outline"
          aria-label={label}
          disabled={disabled}
          className={cn('w-full justify-start gap-2 tabular-nums', className)}
        >
          <ClockIcon data-icon="inline-start" />
          {formatClock(value)}
        </Button>
      }
      footer={
        <Button
          className="w-full"
          onClick={() => {
            setOpen(false);
          }}
        >
          Done
        </Button>
      }
    >
      <div className="flex w-full items-center gap-2">
        <Select
          value={hour}
          onValueChange={(next: string | null) => {
            if (next !== null) onValueChange(`${next}:${minute}`);
          }}
        >
          <SelectTrigger aria-label={`${label} hour`} className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {HOURS.map((h) => (
                <SelectItem key={h} value={h} className="tabular-nums">
                  {h}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <span aria-hidden className="text-muted-foreground text-sm">
          :
        </span>

        <Select
          value={minute}
          onValueChange={(next: string | null) => {
            if (next !== null) onValueChange(`${hour}:${next}`);
          }}
        >
          <SelectTrigger aria-label={`${label} minute`} className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {MINUTES.map((m) => (
                <SelectItem key={m} value={m} className="tabular-nums">
                  {m}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </PickerSurface>
  );
}

// ------------------------------------------------------------ duration field

/** Up to a full day, which is the ceiling every policy duration shares. */
const DURATION_HOURS = Array.from({ length: 25 }, (_, index) => String(index));

interface DurationFieldProps extends OpenControl {
  /** Whole minutes. */
  value: number;
  onValueChange: (minutes: number) => void;
  label: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A duration as hours and minutes in five-minute steps, in the same surface
 * as the clock picker - so a grace window is picked the way a shift start is,
 * and nothing about a policy is typed. Values that arrive off the five-minute
 * grid (an older typed value) show rounded down to it.
 */
export function DurationField({
  value,
  onValueChange,
  label,
  id,
  disabled,
  className,
  ...control
}: DurationFieldProps) {
  const [open, setOpen] = useOpenState(control);
  const hours = String(Math.min(24, Math.floor(Math.max(0, value) / 60)));
  const minutes = String(Math.floor((Math.max(0, value) % 60) / 5) * 5).padStart(2, '0');

  return (
    <PickerSurface
      open={open}
      onOpenChange={setOpen}
      title={label}
      description="Pick hours and minutes."
      trigger={
        <Button
          id={id}
          variant="outline"
          aria-label={label}
          disabled={disabled}
          className={cn('w-full justify-start gap-2 tabular-nums', className)}
        >
          <ClockIcon data-icon="inline-start" />
          {/* Zero is a real policy value here (no grace), not an absence. */}
          {value <= 0 ? '0m' : formatDuration(value)}
        </Button>
      }
      footer={
        <Button
          className="w-full"
          onClick={() => {
            setOpen(false);
          }}
        >
          Done
        </Button>
      }
    >
      <div className="flex w-full items-center gap-2">
        <Select
          value={hours}
          onValueChange={(next: string | null) => {
            if (next !== null) onValueChange(Number(next) * 60 + Number(minutes));
          }}
        >
          <SelectTrigger aria-label={`${label} hours`} className="flex-1">
            <SelectValue>{(selected: string) => `${selected} h`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {DURATION_HOURS.map((h) => (
                <SelectItem key={h} value={h} className="tabular-nums">
                  {h} h
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={minutes}
          onValueChange={(next: string | null) => {
            if (next !== null) onValueChange(Number(hours) * 60 + Number(next));
          }}
        >
          <SelectTrigger aria-label={`${label} minutes`} className="flex-1">
            <SelectValue>{(selected: string) => `${selected} m`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {MINUTES.map((m) => (
                <SelectItem key={m} value={m} className="tabular-nums">
                  {m} m
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </PickerSurface>
  );
}
