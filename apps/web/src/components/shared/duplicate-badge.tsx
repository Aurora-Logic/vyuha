import { WarningDiamondIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { duplicateWarning, type FlagLike } from './duplicate-flag';

/**
 * 15 REQ-AO-08: colour is never the only signal. The diamond carries the
 * sentence as its name and its tooltip, is reachable by keyboard, and
 * does not open the row behind it.
 */
export function DuplicateBadge({ flag, className }: { flag: FlagLike; className?: string }) {
  const warning = duplicateWarning(flag);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn('text-destructive shrink-0', className)}
              aria-label={`Possible duplicate: ${warning}`}
              onClick={(event) => {
                event.stopPropagation();
              }}
            />
          }
        >
          <WarningDiamondIcon weight="fill" />
        </TooltipTrigger>
        <TooltipContent>{warning}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
