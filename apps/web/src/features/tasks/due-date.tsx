import { isToday, parseISO } from 'date-fns';

import { EMPTY_VALUE, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import { isOverdue } from './types';

/** A due date, coloured by how late it is — REQ-V-07's "due today or overdue" at a glance. */
export function DueDate({ value, closed }: { value: string | null; closed: boolean }) {
  if (value === null) return <span className="text-muted-foreground">{EMPTY_VALUE}</span>;
  const date = parseISO(value);
  const overdue = isOverdue({ isClosed: closed, dueDate: value });
  const today = !closed && isToday(date);
  return (
    <span
      className={cn('tabular-nums', overdue && 'text-destructive font-medium', today && 'font-medium')}
      title={overdue ? 'Overdue' : today ? 'Due today' : undefined}
    >
      {overdue ? 'Overdue · ' : today ? 'Today · ' : ''}
      {formatDate(value)}
    </span>
  );
}
