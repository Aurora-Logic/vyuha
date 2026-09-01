import { BuildingsIcon, CheckCircleIcon, CircleDashedIcon, LinkSimpleIcon, PackageIcon, PaperclipIcon, TruckIcon } from '@phosphor-icons/react';

import { RecordPresence } from '@/components/shared/presence-avatars';
import { useTaskCardFields } from './card-fields';
import { PersonChip } from '@/components/shared/person';
import { KanbanBoard } from '@/components/shared/kanban-board';
import { cn } from '@/lib/utils';
import { REALTIME_RESOURCES, TASK_PRIORITY_LABELS } from '@vyuha/shared';

import { DueDate } from './due-date';
import { PILL, PRIORITY_HUES } from './task-pills';
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
          {/* The title owns its row, with presence at the end of it. Notion
              puts the name alone at the top of a card and every property
              under it; presence is not a property, it is somebody else being
              in this task right now, so it rides with the title. */}
          <span className="flex min-w-0 items-start gap-2">
            <span className={cn('min-w-0 flex-1 font-medium', task.isClosed && 'text-muted-foreground line-through')}>
              {task.title}
            </span>
            <RecordPresence resource={REALTIME_RESOURCES.TASK} recordId={task.id} />
          </span>
          {/* REQ-V-13: every detail the task carries, and any of them can be
              hidden. Which ones matter depends on the desk -- operations
              wants the supplier and the items, a manager wants the assignee
              and the date -- so no default is right for both and the reader
              chooses. Presence is never hidden: it is not a detail about the
              task, it is somebody else being in it right now. */}
          {/* One property per line, which is the whole of why a Notion card
              reads at a glance: the eye runs down a column of labels instead
              of hunting along a wrapped ribbon of them. */}
          <span className="text-muted-foreground flex flex-col items-start gap-1 text-xs font-normal">
            {/* Every level, not just high. A card that marks the urgent ones
                and says nothing about the rest cannot tell "low" from "nobody
                set one", which is the question a board is read to answer. */}
            {shown.priority ? (
              <span className={cn(PILL, PRIORITY_HUES[task.priority])}>{TASK_PRIORITY_LABELS[task.priority]}</span>
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
            {/* Every item by name (owner, 1 Sep 2026: "I want names of all the
                items"). It read "3 items" before, which is the one thing
                nobody needs the card to tell them -- they are looking at the
                card to find out WHICH items. They wrap as their own pills so
                a long list grows the card downwards rather than pushing
                anything off it. */}
            {shown.items && task.items.length > 0 ? (
              <span className="flex min-w-0 items-start gap-1">
                <PackageIcon className="mt-0.5 shrink-0" />
                <span className="flex flex-wrap gap-1">
                  {task.items.map((item) => (
                    <span key={item.itemId} className={cn(PILL, 'bg-muted text-foreground/80')}>
                      {item.itemName}
                    </span>
                  ))}
                </span>
              </span>
            ) : null}
            {shown.attachments && task.attachmentCount > 0 ? (
              <span className="flex items-center gap-1 tabular-nums">
                <PaperclipIcon className="shrink-0" />
                {task.attachmentCount}
              </span>
            ) : null}
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
