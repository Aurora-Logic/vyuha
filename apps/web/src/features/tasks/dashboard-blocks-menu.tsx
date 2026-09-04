import { ArrowDownIcon, ArrowUpIcon, SlidersHorizontalIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Checkbox } from '@/components/ui/checkbox';

import { TASK_DASHBOARD_BLOCKS, useTaskDashboardBlocks } from './dashboard-blocks';

/**
 * REQ-V-11: which blocks the dashboard shows, and in what order.
 *
 * Not `DropdownMenuCheckboxItem` like the card-fields menu beside it, because
 * each row here carries three controls rather than one, and a checkbox item
 * swallows the click for its own toggle -- the arrows inside it would never
 * fire. So the row is a plain menu item holding a Checkbox and two buttons,
 * which is also why the arrows stop the click from reaching the row.
 *
 * The hidden count rides on the trigger. A control that quietly removes
 * information has to admit it, or the next person wonders where the chart
 * went.
 */
export function DashboardBlocksMenu() {
  const { shown, order, toggle, move, reset } = useTaskDashboardBlocks();
  const label = new Map(TASK_DASHBOARD_BLOCKS.map((block) => [block.key, block.label]));
  const hidden = TASK_DASHBOARD_BLOCKS.filter((block) => !shown[block.key]).length;
  const changed = hidden > 0 || order.some((key, index) => TASK_DASHBOARD_BLOCKS[index]?.key !== key);

  return (
    <DropdownMenu>
      {/* Base UI takes the trigger's element through `render`; the Radix
          `asChild` spelling is silently ignored here. */}
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm">
            <SlidersHorizontalIcon data-icon="inline-start" />
            Blocks
            {hidden > 0 ? <span className="text-muted-foreground tabular-nums">{hidden} hidden</span> : null}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Show on the dashboard</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {order.map((key, index) => (
          <DropdownMenuItem
            key={key}
            closeOnClick={false}
            className="justify-between gap-2"
            onClick={() => {
              toggle(key);
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Checkbox checked={shown[key]} aria-label={`Show ${label.get(key) ?? key}`} tabIndex={-1} />
              <span className="truncate">{label.get(key)}</span>
            </span>
            <span className="flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Move ${label.get(key) ?? key} up`}
                disabled={index === 0}
                onClick={(event) => {
                  // The row toggles on click; without this the arrow would
                  // reorder and hide in the same press.
                  event.stopPropagation();
                  move(key, -1);
                }}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Move ${label.get(key) ?? key} down`}
                disabled={index === order.length - 1}
                onClick={(event) => {
                  event.stopPropagation();
                  move(key, 1);
                }}
              >
                <ArrowDownIcon />
              </Button>
            </span>
          </DropdownMenuItem>
        ))}
        {changed ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                reset();
              }}
            >
              Reset to the default layout
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
