import { SlidersHorizontalIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { TASK_CARD_FIELDS, useTaskCardFields } from './card-fields';

/**
 * REQ-V-13: what a task card shows.
 *
 * A checklist rather than a settings screen, because the change is one click
 * and its effect is on the page behind the menu — a reader turns a field off
 * and sees the board tighten at once.
 *
 * The count of hidden fields is on the trigger. A control that silently
 * removes information has to say that it did, or the next person to look at
 * this board wonders where the supplier went.
 */
export function CardFieldsMenu() {
  const { shown, toggle, showAll } = useTaskCardFields();
  const hidden = TASK_CARD_FIELDS.filter((field) => !shown[field.key]).length;

  return (
    <DropdownMenu>
      {/* Base UI takes the trigger's element through `render`, where Radix
          would have taken `asChild`. The Radix spelling is silently ignored
          here -- the menu still opened, which is why only the project's own
          `tsc -b` caught it. */}
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm">
            <SlidersHorizontalIcon data-icon="inline-start" />
            Fields
            {hidden > 0 ? <span className="text-muted-foreground tabular-nums">{hidden} hidden</span> : null}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Show on cards and rows</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {TASK_CARD_FIELDS.map((field) => (
          <DropdownMenuCheckboxItem
            key={field.key}
            checked={shown[field.key]}
            // Base UI, not Radix: the toggle is `onCheckedChange` and the
            // menu is held open with `closeOnClick`, where Radix would have
            // wanted `onSelect` and a `preventDefault`. Written the Radix way
            // first, it type-checked, rendered, and did nothing at all --
            // `onSelect` is simply not a prop here.
            closeOnClick={false}
            onCheckedChange={() => {
              toggle(field.key);
            }}
          >
            {field.label}
          </DropdownMenuCheckboxItem>
        ))}
        {hidden > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                showAll();
              }}
            >
              Show everything
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
