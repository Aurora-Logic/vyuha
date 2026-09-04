import { createContext, useContext, useMemo, useState, type ComponentProps } from 'react';

import { Calendar, CalendarDayButton } from '@/components/ui/calendar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toDateParam } from '@/features/attendance/format';
import { toneClasses } from '@/features/attendance/status';
import { cn } from '@/lib/utils';

import { dayLoads, undated, type DayLoad } from './calendar-series';
import { DueDate } from './due-date';
import type { Task } from './types';

/**
 * REQ-V-16: the task board as a month (owner, 1 Sep 2026, choosing Calendar
 * first of Notion's views).
 *
 * A grid rather than titles written into the cells, which is what Notion does
 * on a desktop and cannot do on a phone. The three month calendars already in
 * this product — attendance, holidays, team absence — settled that argument:
 * seven cells at the 44px touch floor need 308px and a padded 360px container
 * offers 286, so a cell holds a count, and the day's tasks are listed under
 * the grid where there is room to read them. Copying that shape also means a
 * fourth calendar does not look like a different product.
 *
 * Tones come from the same six families those three use: a day with open work
 * is outlined info, a day with something already late is filled destructive —
 * and late wins, because that is the day a decision turns on.
 */

const DUE_TONE = toneClasses('info', 'outline');
const LATE_TONE = toneClasses('destructive', 'filled');

const LoadContext = createContext<Map<string, DayLoad>>(new Map());

function loadTitle(load: DayLoad): string {
  const shown = load.titles.slice(0, 4).join(', ');
  const rest = load.titles.length - 4;
  return `${shown}${rest > 0 ? ` and ${String(rest)} more` : ''}`;
}

function TaskDayButton(props: ComponentProps<typeof CalendarDayButton>) {
  const byDate = useContext(LoadContext);
  // An outside day belongs to the neighbouring month; tinting one would report
  // a load the month on screen does not carry.
  const load = props.modifiers.outside ? undefined : byDate.get(toDateParam(props.day.date));
  const carries = load !== undefined && load.open > 0;

  return (
    <CalendarDayButton
      {...props}
      title={load === undefined ? undefined : loadTitle(load)}
      className={cn(
        'aspect-auto h-full tabular-nums',
        !carries ? undefined : load.overdue > 0 ? LATE_TONE : DUE_TONE,
        props.className,
      )}
    >
      {props.children}
      {!carries ? null : (
        // Positioned rather than a second span: the day button styles
        // `[&>span]` at a specificity that would dim the date to match.
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0.5 text-center text-[0.625rem] leading-none font-semibold"
        >
          {load.open}
        </span>
      )}
    </CalendarDayButton>
  );
}

const CALENDAR_COMPONENTS = { DayButton: TaskDayButton };

export function TaskCalendar({
  tasks,
  onOpen,
  /** Injected so the overdue boundary is the caller's, and a test's is fixed. */
  today = toDateParam(new Date()),
}: {
  readonly tasks: readonly Task[];
  readonly onOpen: (task: Task) => void;
  readonly today?: string;
}) {
  const [month, setMonth] = useState(new Date());
  const [selected, setSelected] = useState<Date | undefined>(undefined);

  const loads = useMemo(() => dayLoads(tasks, today), [tasks, today]);
  const withoutDate = useMemo(() => undated(tasks), [tasks]);

  const selectedKey = selected === undefined ? null : toDateParam(selected);
  // No day picked lists the whole month, which is the useful default: the
  // grid answers "which day", the list answers "what".
  const listed = tasks.filter((task) => {
    if (task.dueDate === null) return false;
    const day = task.dueDate.slice(0, 10);
    return selectedKey === null ? day.slice(0, 7) === toDateParam(month).slice(0, 7) : day === selectedKey;
  });

  return (
    <div className="flex flex-col gap-4">
      {/* The side padding goes at 360px for the reason the holiday grid
          documents: seven cells at the coarse-pointer floor need 308px and a
          padded container offers 286, so the last column arrives half-cut. */}
      <div className="flex flex-col gap-3 border py-3 max-sm:px-0 sm:p-3">
        <LoadContext.Provider value={loads}>
          <Calendar
            mode="single"
            month={month}
            onMonthChange={setMonth}
            selected={selected}
            onSelect={setSelected}
            weekStartsOn={1}
            components={CALENDAR_COMPONENTS}
            className="w-full [--cell-size:--spacing(10)] pointer-coarse:[--cell-size:--spacing(11)]"
            classNames={{
              root: 'w-full',
              month: 'w-full',
              day: 'group/day relative h-(--cell-size) w-full p-0 text-center select-none',
            }}
          />
        </LoadContext.Provider>
      </div>

      {listed.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {selectedKey === null ? 'Nothing is due this month.' : 'Nothing is due that day.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y border">
          {listed.map((task) => (
            <li key={task.id}>
              {/* A row, not a card: this list sits under a bordered grid and
                  a card here would be a box inside a box (CLAUDE.md 3.3).
                  `min-h-11` is the touch floor the button-height guard allows;
                  the height itself stays the primitive's. */}
              <Button
                variant="ghost"
                className="h-auto min-h-11 w-full justify-start gap-3 rounded-none px-3 py-2 text-left font-normal"
                onClick={() => {
                  onOpen(task);
                }}
              >
                <span className={cn('min-w-0 flex-1 truncate text-sm', task.isClosed && 'text-muted-foreground line-through')}>
                  {task.title}
                </span>
                <DueDate value={task.dueDate} closed={task.isClosed} />
                <Badge variant="outline" className="shrink-0 font-normal">
                  {task.columnName}
                </Badge>
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* A calendar cannot place a task with no due date, and dropping it
          silently is how work goes missing. */}
      {withoutDate.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {withoutDate.length === 1
            ? '1 task has no due date and is not on this grid.'
            : `${String(withoutDate.length)} tasks have no due date and are not on this grid.`}
        </p>
      ) : null}
    </div>
  );
}
