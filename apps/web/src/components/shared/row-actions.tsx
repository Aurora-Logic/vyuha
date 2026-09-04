import type { Icon } from '@phosphor-icons/react';
import { DotsThreeVerticalIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * The one row-level action affordance (CLAUDE.md §3 rule 4).
 *
 * Every master list needs the same three verbs and no more room than a cell to
 * put them in. A menu rather than a strip of icon buttons because the strip
 * costs one column per verb, and at 1280px the register already hides two
 * columns to fit; because a trash can sitting permanently a few pixels from an
 * edit pencil is the classic mis-tap; and because a menu item can carry a
 * sentence saying why an action is unavailable, which an icon cannot.
 *
 * It renders in two places on purpose — a trailing table column above 768px and
 * the stacked row's action slot below it — so a phone is not left with a row
 * that can be read and not acted on (PRD §6.5).
 *
 * Nothing here is optimistic and nothing here confirms: the menu only chooses
 * the verb. What happens next belongs to the screen, which owns the dialog and
 * the refetch.
 */

export interface RowAction {
  /** Stable across renders; used as the React key. */
  key: string;
  label: string;
  icon: Icon;
  onSelect: () => void;
  /** Red, and sorted to the bottom of the menu by the caller. */
  destructive?: boolean;
  /**
   * Set when the viewer may not do this. The item is disabled and the sentence
   * is rendered under it — CLAUDE.md's Definition of Done asks for RBAC to be
   * "hidden or disabled with a reason", and a disabled row with no reason is
   * the version people file bugs about.
   */
  unavailableReason?: string;
}

interface RowActionsProps {
  /**
   * The accessible name of the trigger. Name the record, not the verb: a table
   * of twenty rows otherwise announces twenty controls all called "Actions".
   */
  label: string;
  actions: readonly RowAction[];
}

export function RowActions({ label, actions }: RowActionsProps) {
  if (actions.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            // One per row, so this matches many elements and the guide points
            // at the first. That is the honest answer: they are the same
            // control repeated, and the step is about what it does.
            data-guide="screen.row-actions" 
            // The stacked row below 768px can be activated as a whole, and a
            // tap that opened both the row and this menu would be two surfaces
            // fighting over one gesture. Stopped here rather than on a wrapper,
            // so there is no extra element with a click handler and no role.
            onClick={(event) => {
              event.stopPropagation();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
            }}
          >
            <DotsThreeVerticalIcon />
          </Button>
        }
      />
      <DropdownMenuContent
        align="end"
        className="w-56"
        // The popup is portalled to the body, but React replays events up the
        // *component* tree rather than the DOM tree -- so a click on "Edit"
        // reached the table row's own handler and navigated away instead of
        // opening the form. Caught by driving it; a portal reads as isolated
        // and is not.
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {actions.map((action) => {
          const blocked = action.unavailableReason !== undefined;
          // A Group, not a div. Base UI's GroupLabel reads its group through
          // context and throws without one -- which crashed the whole menu into
          // the error boundary the first time a disabled action was rendered,
          // so every RBAC-blocked row would have shown an empty popup. The
          // group is also what keeps arrow-key navigation walking the items.
          return (
            <DropdownMenuGroup key={action.key}>
              <DropdownMenuItem
                disabled={blocked}
                variant={action.destructive === true ? 'destructive' : 'default'}
                onClick={() => {
                  if (!blocked) action.onSelect();
                }}
              >
                <action.icon />
                {action.label}
              </DropdownMenuItem>
              {blocked ? (
                <DropdownMenuLabel className="pt-0 pb-2 leading-snug text-wrap">
                  {action.unavailableReason}
                </DropdownMenuLabel>
              ) : null}
            </DropdownMenuGroup>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
