import { BuildingsIcon, CheckCircleIcon, CircleDashedIcon, LinkSimpleIcon, PackageIcon, PaperclipIcon, TruckIcon } from '@phosphor-icons/react';

import { RecordPresence } from '@/components/shared/presence-avatars';
import { useTaskCardFields } from './card-fields';
import { PersonChip } from '@/components/shared/person';
import { KanbanBoard } from '@/components/shared/kanban-board';
import { cn } from '@/lib/utils';
import { REALTIME_RESOURCES, TASK_PRIORITY_LABELS } from '@vyuha/shared';

import { DueDate } from './due-date';
import type { BoardResponse, Task } from './types';

/**
 * REQ-V-03: the same query as the list, in lanes; a drag moves a task
 * between them and is a PATCH like any other status change (REQ-V-06).
 * The lanes wear the deal board's dress: a tint per column, cycled by
 * position, in the header chip; the done column is always green.
 */

const COLUMN_HUES = [
  'bg-tint-1/15 text-tint-1',
  'bg-tint-2/15 text-tint-2',
  'bg-tint-3/15 text-tint-3',
  'bg-tint-4/15 text-tint-4',
  'bg-tint-5/15 text-tint-5',
  'bg-tint-6/15 text-tint-6',
] as const;
const DONE_HUE = 'bg-success/15 text-success';
const PRIORITY_CHIP = 'bg-destructive/10 text-destructive rounded-none px-1 py-px text-[0.6875rem] font-medium';
export function TaskBoard({
  board,
  onOpen,
  onMove,
  moving,
}: {
  board: BoardResponse;
  onOpen: (task: Task) => void;
  onMove: (task: Task, columnId: string) => void;
  moving: boolean;
}) {
  const { shown } = useTaskCardFields();
  return (
    <KanbanBoard
      ariaLabel="Task board"
      lanes={board.lanes.map(({ column, tasks, total }, index) => ({
        id: column.id,
        label: column.name,
        accent: column.isDone ? DONE_HUE : (COLUMN_HUES[index % COLUMN_HUES.length] ?? COLUMN_HUES[0]),
        title: (
          <>
            {column.isDone ? <CheckCircleIcon className="shrink-0" /> : <CircleDashedIcon className="shrink-0" />}
            <span className="truncate">{column.name}</span>
          </>
        ),
        items: tasks,
        total,
        muted: column.isDone,
      }))}
      itemKey={(task) => task.id}
      itemLaneId={(task) => task.columnId}
      itemLabel={(task) => task.title}
      renderItem={(task) => (
        <>
          <span className={cn('font-medium', task.isClosed && 'text-muted-foreground line-through')}>{task.title}</span>
          {/* REQ-V-13: every detail the task carries, and any of them can be
              hidden. Which ones matter depends on the desk -- operations
              wants the supplier and the items, a manager wants the assignee
              and the date -- so no default is right for both and the reader
              chooses. Presence is never hidden: it is not a detail about the
              task, it is somebody else being in it right now. */}
          <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-normal">
            {shown.priority && task.priority === 'HIGH' ? (
              <span className={PRIORITY_CHIP}>{TASK_PRIORITY_LABELS.HIGH}</span>
            ) : null}
            {shown.due ? <DueDate value={task.dueDate} closed={task.isClosed} /> : null}
            {shown.assignee && task.assigneeName !== null ? <PersonChip name={task.assigneeName} tiny /> : null}
            {shown.subject && task.subjectLabel !== null ? (
              <span className="flex min-w-0 items-center gap-1">
                <LinkSimpleIcon className="shrink-0" />
                <span className="truncate">{task.subjectLabel}</span>
              </span>
            ) : null}
            {shown.party && task.partyName !== null ? (
              <span className="flex min-w-0 items-center gap-1">
                <BuildingsIcon className="shrink-0" />
                <span className="truncate">{task.partyName}</span>
              </span>
            ) : null}
            {shown.vendor && task.vendorName !== null ? (
              <span className="flex min-w-0 items-center gap-1">
                <TruckIcon className="shrink-0" />
                <span className="truncate">{task.vendorName}</span>
              </span>
            ) : null}
            {/* Items collapse to a count past the first: five names would
                push the assignee off a 360px card. The full list is in the
                title attribute for a pointer, and on the sheet for everyone. */}
            {shown.items && task.items.length > 0 ? (
              <span className="flex items-center gap-1" title={task.items.map((item) => item.itemName).join(', ')}>
                <PackageIcon className="shrink-0" />
                {task.items.length === 1 ? task.items[0]?.itemName : `${String(task.items.length)} items`}
              </span>
            ) : null}
            {shown.attachments && task.attachmentCount > 0 ? (
              <span className="flex items-center gap-1 tabular-nums">
                <PaperclipIcon className="shrink-0" />
                {task.attachmentCount}
              </span>
            ) : null}
            {/* REQ-U-10: who has this card open right now, so two people do
                not start the same task without knowing. */}
            <RecordPresence resource={REALTIME_RESOURCES.TASK} recordId={task.id} className="ml-auto" />
          </span>
        </>
      )}
      onOpen={onOpen}
      onMove={(task, laneId) => {
        onMove(task, laneId);
      }}
      moving={moving}
    />
  );
}
