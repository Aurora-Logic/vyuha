import { useState } from 'react';
import { ArrowSquareOutIcon, CalendarBlankIcon, CheckIcon, TrashIcon, UserIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PresenceAvatars } from '@/components/shared/presence-avatars';
import { usePresence, useRecordViewers } from '@/lib/realtime/realtime-provider';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { DateField } from '@/features/attendance/pickers';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { useManagerOptions } from '@/features/employees/use-employee-mutations';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { useIsMobile } from '@/hooks/use-mobile';
import { kindOf } from '@/lib/go-to-records';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, REALTIME_RESOURCES, TASK_PRIORITIES, TASK_PRIORITY_LABELS, type TaskPriority } from '@vyuha/shared';

import { DeleteTaskDialog } from './delete-task-dialog';
import type { Task, TaskDraft } from './types';
import { useBoardColumns, useSaveTask } from './use-tasks';

/**
 * One task (REQ-V-01), created or edited. This sheet is where REQ-V-05 is
 * kept: every field is a keyboard control — the assignee is a Command
 * picker, the column a Select, the priority a Select, the date the shared
 * DateField — and Ctrl+A saves, Alt+D marks done, so a task can be created,
 * assigned, moved through every status and closed without a mouse.
 */

interface TaskSheetProps {
  draft: TaskDraft | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (task: Task) => void;
}

export function TaskSheet({ draft, onOpenChange, onSaved }: TaskSheetProps) {
  const isMobile = useIsMobile();
  return (
    <Sheet open={draft !== null} onOpenChange={onOpenChange}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-md max-md:max-h-[90vh]">
        {draft ? (
          <TaskSheetBody
            key={draft.id ?? 'new'}
            initial={draft}
            onClose={() => {
              onOpenChange(false);
            }}
            {...(onSaved === undefined ? {} : { onSaved })}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function TaskSheetBody({
  initial,
  onClose,
  onSaved,
}: {
  initial: TaskDraft;
  onClose: () => void;
  onSaved?: (task: Task) => void;
}) {
  const [draft, setDraft] = useState<TaskDraft>(initial);
  const [deleting, setDeleting] = useState(false);
  const save = useSaveTask();
  const canManage = usePermission(PERMISSIONS.CRM_TASK_MANAGE);
  const columns = useBoardColumns();
  const owners = useManagerOptions();
  const isNew = initial.id === undefined;

  // REQ-U-09: hold this task open for as long as the sheet is, and show who
  // else is in it. A new task has no id, so there is nothing to be in.
  const taskId = initial.id ?? null;
  usePresence(REALTIME_RESOURCES.TASK, taskId);
  const viewers = useRecordViewers(REALTIME_RESOURCES.TASK, taskId);

  const assigneeOptions: PickerOption[] = (owners.data ?? []).map((o) => ({
    id: o.id,
    label: o.name,
    ...(o.hint === undefined ? {} : { hint: o.hint }),
  }));
  const columnList = columns.data ?? [];
  const doneColumn = columnList.find((c) => c.isDone) ?? null;
  const currentColumn = columnList.find((c) => c.id === draft.columnId) ?? null;
  const titleMissing = draft.title.trim().length === 0;
  const subjectKind =
    draft.subjectType !== null && draft.subjectId !== null
      ? kindOf({ type: draft.subjectType, id: draft.subjectId, title: draft.subjectLabel ?? '', subtitle: null, code: null })
      : null;

  function submit(overrides: Partial<TaskDraft> = {}) {
    if (titleMissing || save.isPending) return;
    const next = { ...draft, ...overrides };
    save.mutate(next, {
      onSuccess: (saved) => {
        toast.add({
          type: 'success',
          title: isNew ? 'Task added' : overrides.columnId !== undefined && saved.isClosed ? 'Task done' : 'Task saved',
          description: saved.assigneeName === null ? saved.title : `${saved.title} · ${saved.assigneeName}`,
        });
        onSaved?.(saved);
        onClose();
      },
    });
  }

  function markDone() {
    if (doneColumn === null || currentColumn?.isDone === true) return;
    submit({ columnId: doneColumn.id });
  }

  const copy = actionErrorCopy(save.error, 'Saving the task');

  return (
    <ShortcutLayer id={`modal:task-${initial.id ?? 'new'}`}>
      <SheetShortcuts onSave={() => { submit(); }} onDone={markDone} />

      <SheetHeader className="shrink-0 border-b">
        <SheetTitle className="flex items-center gap-2">
          {isNew ? 'New task' : initial.title}
          <PresenceAvatars viewers={viewers} className="ml-auto" />
        </SheetTitle>
        <SheetDescription>
          {isNew
            ? 'Assigned to you unless you name somebody. Every change is audited.'
            : currentColumn === null
              ? 'Edit the task.'
              : `In ${currentColumn.name}${currentColumn.isDone ? ' — closed' : ''}.`}
        </SheetDescription>
      </SheetHeader>

      <Form onSubmit={() => { submit(); }} className="min-h-0 flex-1 overflow-y-auto p-4">
        <FieldGroup>
          {save.isError ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>{copy.title}</AlertTitle>
              <AlertDescription>{copy.description}</AlertDescription>
            </Alert>
          ) : null}

          <Field>
            <FieldLabel htmlFor="task-title">Title</FieldLabel>
            <Input
              id="task-title"
              autoFocus
              autoComplete="off"
              value={draft.title}
              onChange={(event) => {
                setDraft((current) => ({ ...current, title: event.target.value }));
              }}
            />
          </Field>

          {draft.subjectType !== null && draft.subjectId !== null ? (
            <Field>
              <FieldLabel>On</FieldLabel>
              <div className="flex items-center gap-2 text-sm">
                {subjectKind === null ? (
                  <span>{draft.subjectLabel ?? draft.subjectType}</span>
                ) : (
                  <Link
                    to={subjectKind.route({ type: draft.subjectType, id: draft.subjectId, title: draft.subjectLabel ?? '', subtitle: null, code: null })}
                    className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
                  >
                    <subjectKind.icon className="text-muted-foreground" />
                    {draft.subjectLabel ?? draft.subjectType}
                    <ArrowSquareOutIcon className="text-muted-foreground" />
                  </Link>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Detach from subject"
                  onClick={() => {
                    setDraft((current) => ({ ...current, subjectType: null, subjectId: null, subjectLabel: null }));
                  }}
                >
                  <XIcon />
                </Button>
              </div>
            </Field>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="task-priority">Priority</FieldLabel>
              <Select
                value={draft.priority}
                onValueChange={(next: string | null) => {
                  const parsed = TASK_PRIORITIES.find((p) => p === next);
                  if (parsed) setDraft((current) => ({ ...current, priority: parsed }));
                }}
              >
                <SelectTrigger id="task-priority" aria-label="Priority" className="w-full">
                  <SelectValue>{(value: TaskPriority) => TASK_PRIORITY_LABELS[value]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TASK_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {TASK_PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="task-column">Status</FieldLabel>
              <Select
                value={draft.columnId ?? columnList.find((c) => !c.isDone)?.id ?? ''}
                onValueChange={(next: string | null) => {
                  if (next) setDraft((current) => ({ ...current, columnId: next }));
                }}
              >
                <SelectTrigger id="task-column" aria-label="Status" className="w-full">
                  <SelectValue>
                    {(value: string) => columnList.find((c) => c.id === value)?.name ?? 'Choose'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {columnList.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.isDone ? <span className="text-muted-foreground ml-1 text-xs">closes</span> : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field>
            <FieldLabel>Due</FieldLabel>
            {draft.dueDate === null ? (
              <Button
                type="button"
                variant="outline"
                className="w-full justify-start font-normal"
                onClick={() => {
                  setDraft((current) => ({ ...current, dueDate: toDateParam(new Date()) }));
                }}
              >
                <CalendarBlankIcon data-icon="inline-start" className="text-muted-foreground" />
                <span className="text-muted-foreground">No due date — set one</span>
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <DateField
                    label="Due date"
                    value={fromDateParam(draft.dueDate)}
                    onValueChange={(next) => {
                      setDraft((current) => ({ ...current, dueDate: toDateParam(next) }));
                    }}
                    yearsBack={1}
                    yearsForward={3}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Clear due date"
                  onClick={() => {
                    setDraft((current) => ({ ...current, dueDate: null }));
                  }}
                >
                  <XIcon />
                </Button>
              </div>
            )}
          </Field>

          {canManage ? (
            <Field>
              <FieldLabel htmlFor="task-assignee">Assigned to</FieldLabel>
              <RecordPicker
                id="task-assignee"
                label="Assignee"
                placeholder={isNew ? 'You' : 'Nobody'}
                searchPlaceholder="Search by name or code"
                emptyMessage="Nobody matches that name or code."
                icon={<UserIcon className="text-muted-foreground" />}
                options={assigneeOptions}
                loading={owners.isPending}
                clearable
                clearLabel={isNew ? 'You' : 'Nobody'}
                value={assigneeOptions.find((o) => o.id === draft.assigneeId) ?? null}
                onValueChange={(next) => {
                  setDraft((current) => ({ ...current, assigneeId: next?.id ?? null }));
                }}
              />
              <FieldDescription>They are told when it lands on them.</FieldDescription>
            </Field>
          ) : null}

          <Field>
            <FieldLabel htmlFor="task-description">Notes</FieldLabel>
            <Textarea
              id="task-description"
              rows={4}
              value={draft.description}
              onChange={(event) => {
                setDraft((current) => ({ ...current, description: event.target.value }));
              }}
            />
          </Field>
        </FieldGroup>
      </Form>

      <SheetFooter className="shrink-0 flex-row flex-wrap justify-end gap-2 border-t">
        {isNew || !canManage ? null : (
          <Button
            variant="outline"
            className="mr-auto"
            disabled={save.isPending}
            onClick={() => {
              setDeleting(true);
            }}
            aria-label={`Delete ${initial.title}`}
          >
            <TrashIcon data-icon="inline-start" />
            Delete
          </Button>
        )}
        {!isNew && doneColumn !== null && currentColumn?.isDone !== true ? (
          <Button variant="outline" disabled={save.isPending} onClick={markDone}>
            <CheckIcon data-icon="inline-start" />
            Done
            <ShortcutHint keys="alt+d" className="ml-1 hidden md:inline-flex" />
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          Cancel
        </Button>
        <Button disabled={save.isPending || titleMissing} onClick={() => { submit(); }}>
          {save.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
          {save.isPending ? 'Saving' : 'Save'}
          <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
        </Button>
      </SheetFooter>

      {initial.id === undefined ? null : (
        <DeleteTaskDialog
          target={deleting ? { id: initial.id, title: initial.title } : null}
          onOpenChange={(open) => {
            setDeleting(open);
          }}
          onDeleted={onClose}
        />
      )}
    </ShortcutLayer>
  );
}

function SheetShortcuts({ onSave, onDone }: { onSave: () => void; onDone: () => void }) {
  useShortcut({
    id: 'task-sheet.save',
    keys: 'ctrl+a',
    label: 'Accept / Save',
    scope: 'modal',
    allowInInput: true,
    run: onSave,
  });
  useShortcut({
    id: 'task-sheet.done',
    keys: 'alt+d',
    label: 'Mark done',
    scope: 'modal',
    allowInInput: true,
    run: onDone,
  });
  return null;
}
