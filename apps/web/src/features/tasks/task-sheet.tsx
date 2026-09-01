import { useState } from 'react';
import { ArrowSquareOutIcon, BuildingsIcon, CalendarBlankIcon, CheckIcon, CircleDashedIcon, FlagIcon, LinkSimpleIcon, NotePencilIcon, PackageIcon, TrashIcon, TruckIcon, UserIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { NotesEditor } from '@/components/shared/notes-editor';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PresenceAvatars } from '@/components/shared/presence-avatars';
import { usePresence, useRecordViewers } from '@/lib/realtime/realtime-provider';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { DateField } from '@/features/attendance/pickers';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { useManagerOptions } from '@/features/employees/use-employee-mutations';
import { PartyPicker } from '@/features/masters/party-picker';
import { TaskAttachments } from './task-attachments';
import { TaskItemsField } from './task-items-field';
import { PILL, PRIORITY_HUES, columnHue } from './task-pills';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { useIsMobile } from '@/hooks/use-mobile';
import { kindOf } from '@/lib/go-to-records';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { cn } from '@/lib/utils';
import { PARTY_LEDGER_GROUPS, PERMISSIONS, REALTIME_RESOURCES, TASK_PRIORITIES, TASK_PRIORITY_LABELS, type TaskPriority } from '@vyuha/shared';

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

/**
 * A property label in the record sheet: a type icon, a quiet name, and a
 * fixed column so every value on the page starts at the same x.
 *
 * The shape is Notion's property list (owner, 31 Aug 2026). The width only
 * applies once `Field`'s own `responsive` orientation has turned the row
 * horizontal, which it does above the phone breakpoint -- at 360px the label
 * sits above its control, which is what PRD §6.5 asks for anyway.
 */
const PROPERTY_LABEL = 'text-muted-foreground gap-1.5 font-normal [&_svg]:size-3.5';

/**
 * Pins the label column so every value starts at the same x.
 *
 * Written on the row rather than the label because `Field`'s horizontal
 * variant sets the label to `flex-auto` through a `*:` selector, which a
 * plain utility on the label cannot outrank -- the labels sat left and the
 * controls were flung to the right margin.
 */
const PROPERTY_ROW =
  '@md/field-group:[&>[data-slot=field-label]]:w-32 @md/field-group:[&>[data-slot=field-label]]:flex-none';

export function TaskSheet({ draft, onOpenChange, onSaved }: TaskSheetProps) {
  const isMobile = useIsMobile();
  return (
    <Sheet open={draft !== null} onOpenChange={onOpenChange}>
      {/* Wider than the other sheets on purpose. `Field`'s responsive
            orientation turns a property into a label|value row at its `@md`
            container width, and at the old 448px the group never reached it,
            so every label stayed stacked above its control. A record page is
            roomy in Notion for the same reason. */}
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-xl max-md:max-h-[90vh]">
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
  // Offering a button that lands on "you cannot raise estimates" is worse
  // than not offering it: the editor refuses without this key.
  const canRaiseEstimate = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  // The masters key gates both pickers: a task may name a party and an item,
  // but only for someone entitled to read the ledger and the catalogue in the
  // first place. The field is shown disabled rather than hidden, so a saved
  // link is still legible to whoever opens the task (Definition of Done: RBAC
  // reflected in the UI, disabled with a reason).
  const canSeeParties = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const canSeeItems = canSeeParties;
  const columns = useBoardColumns();
  const owners = useManagerOptions();
  const isNew = initial.id === undefined;

  // REQ-U-10: hold this task open for as long as the sheet is, and show who
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

          {/* The title is the page's heading, the way a Notion record opens
              with its name typed straight into the page: no label above it
              and no box around it until the caret is in it. */}
          <Field>
            <FieldLabel htmlFor="task-title" className="sr-only">
              Title
            </FieldLabel>
            <Input
              id="task-title"
              autoFocus
              autoComplete="off"
              placeholder="Untitled"
              className="h-auto rounded-none border-0 bg-transparent px-0 py-1 text-xl font-semibold shadow-none focus-visible:ring-0 md:text-xl"
              value={draft.title}
              onChange={(event) => {
                setDraft((current) => ({ ...current, title: event.target.value }));
              }}
            />
          </Field>

          {draft.subjectType !== null && draft.subjectId !== null ? (
            <Field orientation="responsive" className={PROPERTY_ROW}>
              <FieldLabel className={PROPERTY_LABEL}>
                <LinkSimpleIcon /> On
              </FieldLabel>
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
            <Field orientation="responsive" className={PROPERTY_ROW}>
              <FieldLabel htmlFor="task-priority" className={PROPERTY_LABEL}>
                <FlagIcon /> Priority
              </FieldLabel>
              <Select
                value={draft.priority}
                onValueChange={(next: string | null) => {
                  const parsed = TASK_PRIORITIES.find((p) => p === next);
                  if (parsed) setDraft((current) => ({ ...current, priority: parsed }));
                }}
              >
                <SelectTrigger id="task-priority" aria-label="Priority" className="w-full">
                  {/* Coloured in the menu and in the trigger, not only on the
                      card (owner, 1 Sep 2026). Picking a priority from a plain
                      list and then seeing it come back red is the product
                      telling you something after the fact that it could have
                      told you during. */}
                  <SelectValue>
                    {(value: TaskPriority) => (
                      <span className={cn(PILL, PRIORITY_HUES[value])}>{TASK_PRIORITY_LABELS[value]}</span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TASK_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      <span className={cn(PILL, PRIORITY_HUES[p])}>{TASK_PRIORITY_LABELS[p]}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field orientation="responsive" className={PROPERTY_ROW}>
              <FieldLabel htmlFor="task-column" className={PROPERTY_LABEL}>
                <CircleDashedIcon /> Status
              </FieldLabel>
              <Select
                value={draft.columnId ?? columnList.find((c) => !c.isDone)?.id ?? ''}
                onValueChange={(next: string | null) => {
                  if (next) setDraft((current) => ({ ...current, columnId: next }));
                }}
              >
                <SelectTrigger id="task-column" aria-label="Status" className="w-full">
                  {/* The lane's own colour, by its board position, so the
                      status you pick here is the colour it lands in there. */}
                  <SelectValue>
                    {(value: string) => {
                      const index = columnList.findIndex((c) => c.id === value);
                      const column = columnList[index];
                      return column === undefined ? (
                        'Choose'
                      ) : (
                        <span className={cn(PILL, columnHue(index, column.isDone))}>{column.name}</span>
                      );
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {columnList.map((c, index) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className={cn(PILL, columnHue(index, c.isDone))}>{c.name}</span>
                      {c.isDone ? <span className="text-muted-foreground ml-1 text-xs">closes</span> : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field orientation="responsive" className={PROPERTY_ROW}>
            <FieldLabel className={PROPERTY_LABEL}>
              <CalendarBlankIcon /> Due
            </FieldLabel>
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
              <div className="flex min-w-0 items-center gap-2">
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
            <Field orientation="responsive" className={PROPERTY_ROW}>
              <FieldLabel htmlFor="task-assignee" className={PROPERTY_LABEL}>
                <UserIcon /> Assigned to
              </FieldLabel>
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
            </Field>
          ) : null}

          {/* The body of the page, under a rule -- properties above, writing
              below, which is the order a Notion record reads in. */}
          <Field className="border-t pt-4">
            <FieldLabel htmlFor="task-description" className={PROPERTY_LABEL}>
              <NotePencilIcon /> Notes
            </FieldLabel>
            {/* The same markdown editor the deal notes use, so a written
                instruction can carry a list and an emphasis rather than
                being one grey paragraph. */}
            <NotesEditor
              id="task-description"
              rows={5}
              value={draft.description}
              placeholder="What has to happen, and anything the person picking it up needs to know."
              onValueChange={(next) => {
                setDraft((current) => ({ ...current, description: next }));
              }}
            />
          </Field>

          <Field orientation="responsive" className={PROPERTY_ROW}>
            <FieldLabel htmlFor="task-party" className={PROPERTY_LABEL}>
              <BuildingsIcon /> Customer
            </FieldLabel>
            <PartyPicker
              id="task-party"
              label="Customer"
              placeholder="No customer"
              parentGroup={PARTY_LEDGER_GROUPS.CUSTOMER}
              partyId={draft.partyId}
              {...(draft.partyName === null ? {} : { partyName: draft.partyName })}
              clearable
              clearLabel="No customer"
              enabled={canSeeParties}
              disabled={!canSeeParties}
              icon={<BuildingsIcon className="text-muted-foreground" />}
              onValueChange={(party) => {
                setDraft((current) => ({
                  ...current,
                  partyId: party?.id ?? null,
                  partyName: party?.name ?? null,
                }));
              }}
            />
          </Field>

          <Field orientation="responsive" className={PROPERTY_ROW}>
            <FieldLabel htmlFor="task-vendor" className={PROPERTY_LABEL}>
              <TruckIcon /> Supplier
            </FieldLabel>
            <PartyPicker
              id="task-vendor"
              label="Supplier"
              placeholder="No supplier"
              // The other side of the ledger. The server refuses a customer
              // here, so offering one would offer a choice that cannot save.
              parentGroup={PARTY_LEDGER_GROUPS.SUPPLIER}
              partyId={draft.vendorId}
              {...(draft.vendorName === null ? {} : { partyName: draft.vendorName })}
              clearable
              clearLabel="No supplier"
              enabled={canSeeParties}
              disabled={!canSeeParties}
              icon={<TruckIcon className="text-muted-foreground" />}
              onValueChange={(party) => {
                setDraft((current) => ({
                  ...current,
                  vendorId: party?.id ?? null,
                  vendorName: party?.name ?? null,
                }));
              }}
            />
          </Field>

          <Field orientation="responsive" className={PROPERTY_ROW}>
            <FieldLabel htmlFor="task-items" className={PROPERTY_LABEL}>
              <PackageIcon /> Items
            </FieldLabel>
            <TaskItemsField
              value={draft.items}
              enabled={canSeeItems}
              onValueChange={(items) => {
                setDraft((current) => ({ ...current, items }));
              }}
            />
          </Field>
        </FieldGroup>
        {/* Only on a saved task: an attachment needs an id to hang off, and a
            file chosen before the task exists would have nowhere to go. The
            deal sheet places it exactly here, for the same reason. */}
        {isNew ? null : (
          <div className="mt-6 border-t pt-4">
            <TaskAttachments taskId={initial.id ?? ''} />
          </div>
        )}
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
        {/* REQ-V-15 (owner, 1 Sep 2026): the task carries a customer and the
            items somebody asked for, which is most of an estimate already.
            Only offered once it has been saved and has a customer -- an
            estimate addressed to nobody is not a shortcut. Unsaved edits are
            deliberately not carried: what converts is what the task says. */}
        {!isNew && draft.partyId !== null && canRaiseEstimate ? (
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to={`/sales/estimates/new?task=${initial.id ?? ''}`} />}
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            Convert to estimate
          </Button>
        ) : null}
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
