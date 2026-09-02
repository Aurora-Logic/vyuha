import { XIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ItemPicker } from '@/features/masters/item-picker';
import { formatMoney } from '@/lib/format';
import { TASK_ITEM_CAP, taskLineAmount, taskOrderTotal } from '@vyuha/shared';

import type { TaskItemLine } from './types';

/**
 * REQ-V-10, REQ-V-17: the order a task is carrying.
 *
 * Owner, 2 Sep 2026: "immediately place order — select party, select item, qty
 * and disc, total." An order is agreed standing in front of the customer; a
 * sales order is a document you sit down to write. So this captures what was
 * agreed and the sales module still owns the document.
 *
 * It was a row of chips, on the reasoning that a task carrying quantities is a
 * sales order wearing the wrong name. That reasoning is now overruled by the
 * person who has to place the orders.
 *
 * A row per line rather than a table: at 360px a five-column table is a
 * horizontal scroll, and this is the screen somebody uses on a site visit. The
 * rate is optional throughout — an enquiry with no price yet is a real state,
 * and it shows no amount rather than a zero it cannot support.
 */

export interface TaskItemRef {
  readonly itemId: string;
  readonly itemName: string;
}

/** Only what a decimal field should accept, so the server never sees the rest. */
const QUANTITY = /^\d{0,12}(\.\d{0,3})?$/u;
const MONEY = /^\d{0,14}(\.\d{0,2})?$/u;
const PERCENT = /^(100(\.0{0,2})?|\d{0,2}(\.\d{0,2})?)$/u;

export function TaskItemsField({
  value,
  onValueChange,
  enabled = true,
}: {
  readonly value: readonly TaskItemLine[];
  readonly onValueChange: (items: TaskItemLine[]) => void;
  readonly enabled?: boolean;
}) {
  // Reset the picker after each add, so the trigger reads "Add an item"
  // again rather than holding the last one as though it were still a choice.
  const [pickerKey, setPickerKey] = useState(0);
  const full = value.length >= TASK_ITEM_CAP;
  const total = taskOrderTotal(value);

  const patch = (itemId: string, change: Partial<TaskItemLine>) => {
    onValueChange(
      value.map((line) => {
        if (line.itemId !== itemId) return line;
        const next = { ...line, ...change };
        // Recomputed here so the line's amount and the total can never
        // disagree with the numbers above them.
        return { ...next, amount: taskLineAmount(next.quantity || '0', next.rate, next.discountPct || '0') };
      }),
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {value.map((line, index) => (
        <div key={line.itemId} className="flex flex-col gap-2 border-b pb-3 last:border-b-0 last:pb-0">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-sm font-medium">{line.itemName}</span>
            {enabled ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${line.itemName}`}
                onClick={() => {
                  onValueChange(value.filter((row) => row.itemId !== line.itemId));
                }}
              >
                <XIcon />
              </Button>
            ) : null}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Field>
              <FieldLabel htmlFor={`line-qty-${line.itemId}`} className="text-xs">
                Qty
              </FieldLabel>
              <Input
                id={`line-qty-${line.itemId}`}
                inputMode="decimal"
                className="tabular-nums"
                disabled={!enabled}
                value={line.quantity}
                onChange={(event) => {
                  if (QUANTITY.test(event.target.value)) patch(line.itemId, { quantity: event.target.value });
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`line-rate-${line.itemId}`} className="text-xs">
                Rate
              </FieldLabel>
              <Input
                id={`line-rate-${line.itemId}`}
                inputMode="decimal"
                className="tabular-nums"
                placeholder="Not priced"
                disabled={!enabled}
                value={line.rate ?? ''}
                onChange={(event) => {
                  const next = event.target.value;
                  // Emptied is "not priced yet", which is not the same as zero.
                  if (next === '') patch(line.itemId, { rate: null });
                  else if (MONEY.test(next)) patch(line.itemId, { rate: next });
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`line-disc-${line.itemId}`} className="text-xs">
                Disc %
              </FieldLabel>
              <Input
                id={`line-disc-${line.itemId}`}
                inputMode="decimal"
                className="tabular-nums"
                disabled={!enabled}
                value={line.discountPct}
                onChange={(event) => {
                  if (PERCENT.test(event.target.value)) patch(line.itemId, { discountPct: event.target.value });
                }}
              />
            </Field>
          </div>

          <span className="text-muted-foreground text-right text-xs tabular-nums">
            {line.amount === null ? 'No rate yet' : formatMoney(line.amount)}
          </span>
          {index === value.length - 1 ? null : <span className="sr-only">End of line</span>}
        </div>
      ))}

      {enabled && !full ? (
        <ItemPicker
          key={pickerKey}
          id="task-items"
          label="Items"
          placeholder="Add an item"
          value={null}
          onValueChange={(item) => {
            if (item === null) return;
            if (value.some((line) => line.itemId === item.id)) return;
            onValueChange([
              ...value,
              {
                itemId: item.id,
                itemName: item.name,
                quantity: '1',
                rate: null,
                discountPct: '0',
                amount: null,
              },
            ]);
            setPickerKey((k) => k + 1);
          }}
        />
      ) : null}

      {full ? (
        <p className="text-muted-foreground text-xs">
          {String(TASK_ITEM_CAP)} items is the most one task carries. A bigger order is a sales order.
        </p>
      ) : null}

      {total === null ? null : (
        <div className="flex items-baseline justify-between border-t pt-2">
          <span className="text-sm font-medium">Total</span>
          <span className="text-sm font-semibold tabular-nums">{formatMoney(total)}</span>
        </div>
      )}
    </div>
  );
}
