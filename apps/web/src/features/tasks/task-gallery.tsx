import { BuildingsIcon, PackageIcon, PaperclipIcon, TruckIcon } from '@phosphor-icons/react';

import { PersonChip } from '@/components/shared/person';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { TASK_PRIORITY_LABELS } from '@vyuha/shared';

import { DueDate } from './due-date';
import { PILL, PRIORITY_HUES } from './task-pills';
import type { Task } from './types';

/**
 * REQ-V-16: the tasks as a wall of cards rather than a list of rows.
 *
 * Notion's Gallery leads each card with its cover image. Ours does not, and
 * deliberately: the task list carries an attachment *count*, not the
 * attachments, so a cover would mean one signed-URL round trip per card on
 * every render of the page. The count is shown instead, and the pictures are
 * one click away in the task itself. Giving the list a cover attachment is a
 * server change, not a screen one.
 *
 * What the wall is good for is reading a whole task at once — customer,
 * supplier, every item, who has it — which the board's narrow lane cannot
 * show without wrapping. So the card here is generous where the board's is
 * tight, and that is the only reason to have both.
 */
export function TaskGallery({
  tasks,
  onOpen,
}: {
  readonly tasks: readonly Task[];
  readonly onOpen: (task: Task) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {tasks.map((task) => (
        // One card, one level. The card is the target, so it is the button --
        // a card containing a button that fills it would be a box in a box.
        <Card key={task.id} size="sm" className="min-w-0 p-0">
          <Button
            variant="ghost"
            className="h-auto w-full flex-col items-stretch justify-start gap-2 rounded-none p-3 text-left font-normal whitespace-normal"
            onClick={() => {
              onOpen(task);
            }}
          >
            <CardContent className="flex min-w-0 flex-col gap-2 p-0">
              <span className={cn('text-sm font-medium', task.isClosed && 'text-muted-foreground line-through')}>
                {task.title}
              </span>

              <span className="flex flex-wrap items-center gap-1.5">
                <span className={cn(PILL, PRIORITY_HUES[task.priority])}>
                  {TASK_PRIORITY_LABELS[task.priority]}
                </span>
                <Badge variant="outline" className="font-normal">
                  {task.columnName}
                </Badge>
                <DueDate value={task.dueDate} closed={task.isClosed} />
              </span>

              <span className="text-muted-foreground flex flex-col gap-1 text-xs">
                {task.partyName === null ? null : (
                  <span className="flex min-w-0 items-center gap-1">
                    <BuildingsIcon className="shrink-0" />
                    <span className="truncate">{task.partyName}</span>
                  </span>
                )}
                {task.vendorName === null ? null : (
                  <span className="flex min-w-0 items-center gap-1">
                    <TruckIcon className="shrink-0" />
                    <span className="truncate">{task.vendorName}</span>
                  </span>
                )}
                {task.items.length === 0 ? null : (
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
                )}
              </span>

              <span className="flex items-center gap-3">
                {task.assigneeName === null ? (
                  <span className="text-muted-foreground text-xs">Nobody assigned</span>
                ) : (
                  <PersonChip name={task.assigneeName} tiny />
                )}
                {task.attachmentCount > 0 ? (
                  <span className="text-muted-foreground ml-auto flex items-center gap-1 text-xs tabular-nums">
                    <PaperclipIcon className="shrink-0" />
                    {task.attachmentCount}
                  </span>
                ) : null}
              </span>
            </CardContent>
          </Button>
        </Card>
      ))}
    </div>
  );
}
