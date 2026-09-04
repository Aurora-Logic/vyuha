import { useState } from 'react';

import { ResponsiveDialog, ResponsiveDialogActions } from '@/components/shared/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { PartyPicker } from '@/features/masters/party-picker';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { PARTY_LEDGER_GROUPS } from '@vyuha/shared';

import { TaskItemsField } from './task-items-field';
import { emptyTaskDraft, type TaskItemLine } from './types';
import { useSaveTask } from './use-tasks';

/**
 * REQ-V-17: place an order in the time it takes to agree one.
 *
 * Owner, 2 Sep 2026: "immediately place order — select party, select item, qty
 * and disc, total, notes and comments." That is this dialog, and the order of
 * the fields is the order they said it in, because that is the order it
 * happens in when somebody is standing in front of a customer.
 *
 * It writes a task. A task is what CRM already has that carries a customer,
 * items and notes, and what the whole board, calendar and dashboard already
 * read -- so an order placed here is visible everywhere work is, from the
 * moment it is placed. Converting it to a sales order is the next step and
 * lives on the task, once there is one to convert.
 *
 * Deliberately not the task sheet with more fields on it. That sheet is for
 * describing a piece of work; this is for taking an order, and asking somebody
 * to fill in a title, an assignee, a due date and a board column first is how
 * you make them write it on paper instead.
 */
export function PlaceOrderDialog({
  open,
  onOpenChange,
  onPlaced,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The task the order became, so the caller can open it. */
  readonly onPlaced?: (taskId: string) => void;
}) {
  const save = useSaveTask();
  const [partyId, setPartyId] = useState<string | null>(null);
  const [partyName, setPartyName] = useState<string | null>(null);
  const [items, setItems] = useState<TaskItemLine[]>([]);
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const ready = partyId !== null && items.length > 0;

  function reset() {
    setPartyId(null);
    setPartyName(null);
    setItems([]);
    setNotes('');
    setSubmitted(false);
  }

  function place() {
    setSubmitted(true);
    if (!ready || save.isPending) return;
    save.mutate(
      {
        ...emptyTaskDraft(),
        // Named for what it is, so the board reads as work rather than as a
        // row of untitled orders. The person can rename it on the task.
        title: `Order — ${partyName ?? 'customer'}`,
        description: notes.trim(),
        partyId,
        partyName,
        items,
      },
      {
        onSuccess: (task) => {
          toast.add({
            type: 'success',
            title: `Order placed for ${partyName ?? 'the customer'}`,
            description: 'It is on the board. Convert it to a sales order when you are ready.',
          });
          reset();
          onOpenChange(false);
          onPlaced?.(task.id);
        },
        onError: (error) => {
          const copy = actionErrorCopy(error, 'Placing the order');
          toast.add({ type: 'error', title: copy.title, description: copy.description });
        },
      },
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Place an order"
      description="The customer, what they asked for, and anything worth remembering."
      className="sm:max-w-xl"
    >
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="order-party">Customer</FieldLabel>
          <PartyPicker
            id="order-party"
            label="Customer"
            placeholder="Choose a customer"
            parentGroup={PARTY_LEDGER_GROUPS.CUSTOMER}
            partyId={partyId}
            {...(partyName === null ? {} : { partyName })}
            onValueChange={(party) => {
              setPartyId(party?.id ?? null);
              setPartyName(party?.name ?? null);
            }}
          />
          {submitted && partyId === null ? (
            <span className="text-destructive text-xs">An order is placed by somebody. Choose the customer.</span>
          ) : null}
        </Field>

        <Field>
          <FieldLabel>Items</FieldLabel>
          <TaskItemsField value={items} onValueChange={setItems} />
          {submitted && items.length === 0 ? (
            <span className="text-destructive text-xs">Add at least one item.</span>
          ) : null}
        </Field>

        <Field>
          <FieldLabel htmlFor="order-notes">Notes and comments</FieldLabel>
          <Textarea
            id="order-notes"
            rows={3}
            placeholder="Delivery by Friday, site contact, anything agreed on the call."
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
        </Field>
      </div>

      <ResponsiveDialogActions>
        <Button
          variant="outline"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          Cancel
        </Button>
        <Button disabled={save.isPending} onClick={place}>
          {save.isPending ? <Spinner data-icon="inline-start" /> : null}
          {save.isPending ? 'Placing' : 'Place order'}
        </Button>
      </ResponsiveDialogActions>
    </ResponsiveDialog>
  );
}
