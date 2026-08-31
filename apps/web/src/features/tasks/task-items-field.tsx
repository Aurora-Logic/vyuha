import { XIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ItemPicker } from '@/features/masters/item-picker';
import { TASK_ITEM_CAP } from '@vyuha/shared';

/**
 * REQ-V-10: the stock items a task is about.
 *
 * A picker that adds, and a chip per item that removes — rather than a
 * multi-select, which on a phone is a list of checkboxes the reader has to
 * scroll past to find the one they wanted. Adding is a search; removing is
 * one 44px target beside the name.
 *
 * No quantities anywhere. The moment a task carries quantities it is a sales
 * order wearing the wrong name, and the sales module owns that model.
 */

export interface TaskItemRef {
  readonly itemId: string;
  readonly itemName: string;
}

export function TaskItemsField({
  value,
  onValueChange,
  enabled = true,
}: {
  readonly value: readonly TaskItemRef[];
  readonly onValueChange: (items: TaskItemRef[]) => void;
  readonly enabled?: boolean;
}) {
  // Reset the picker after each add, so the trigger reads "Add an item"
  // again rather than holding the last one as though it were still a choice.
  const [pickerKey, setPickerKey] = useState(0);
  const full = value.length >= TASK_ITEM_CAP;

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((item) => (
            <li key={item.itemId}>
              {/* The removable-chip shape the analysis filters already use:
                  the primitive owns the height and grows its own 44px target
                  on a coarse pointer, so this sets neither. */}
              <Badge variant="secondary" className="gap-1 pr-1 font-normal">
                <span className="truncate">{item.itemName}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${item.itemName}`}
                  onClick={() => {
                    onValueChange(value.filter((kept) => kept.itemId !== item.itemId));
                  }}
                >
                  <XIcon />
                </Button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      <ItemPicker
        key={pickerKey}
        id="task-items"
        label="Item"
        placeholder={full ? `That is ${String(TASK_ITEM_CAP)} items` : 'Add an item'}
        searchPlaceholder="Search stock items"
        enabled={enabled && !full}
        disabled={!enabled || full}
        value={null}
        onValueChange={(item) => {
          if (item === null) return;
          // Already there: adding it again would mean a quantity, and a task
          // has none.
          if (value.some((existing) => existing.itemId === item.id)) return;
          onValueChange([...value, { itemId: item.id, itemName: item.name }]);
          setPickerKey((key) => key + 1);
        }}
      />
    </div>
  );
}
