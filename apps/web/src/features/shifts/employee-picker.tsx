import { useState } from 'react';
import { CaretUpDownIcon, CheckIcon, UserIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

import type { RosterCandidate } from './types';

/**
 * One employee, chosen by typing.
 *
 * CLAUDE.md section 3 forbids a raw control and directs a missing primitive to
 * be composed from shadcn primitives. The registry's `combobox` could not be
 * installed here: its add command rewrites `button.tsx`, which three other
 * slices are editing in parallel. So this is the sanctioned composition --
 * `Command` for the filtered list, `Popover` on a pointer, `Sheet` from the
 * bottom on a phone -- and it deliberately mirrors the surface switch in
 * `features/attendance/pickers.tsx` so a reader meets one behaviour, not two.
 *
 * It lives in this feature rather than `components/shared/` only because that
 * directory is locked while several agents are editing this app; it is
 * general-purpose and belongs there.
 */

interface EmployeePickerProps {
  /** Null until something is chosen. */
  value: RosterCandidate | null;
  onValueChange: (value: RosterCandidate) => void;
  candidates: readonly RosterCandidate[];
  /**
   * The search term, owned by the parent because the parent owns the query it
   * feeds — and renders its own alert when that query fails on permission.
   * Given it, the list is whatever the server returned and is not filtered
   * again here.
   */
  search?: string;
  onSearchChange?: (search: string) => void;
  loading?: boolean;
  label: string;
  /** Ids that cannot be chosen, with the reason shown beside them. */
  disabledReason?: (candidate: RosterCandidate) => string | null;
  className?: string;
}

export function EmployeePicker({
  value,
  onValueChange,
  candidates,
  search,
  onSearchChange,
  loading = false,
  label,
  disabledReason,
  className,
}: EmployeePickerProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();

  const trigger = (
    <Button
      variant="outline"
      aria-label={label}
      className={cn('w-full justify-between gap-2 font-normal', className)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <UserIcon data-icon="inline-start" />
        <span className="truncate">
          {value === null ? 'Choose an employee' : `${value.employeeCode} — ${value.name}`}
        </span>
      </span>
      <CaretUpDownIcon className="text-muted-foreground shrink-0" />
    </Button>
  );

  const serverSearched = search !== undefined && onSearchChange !== undefined;
  // The chosen person is prepended when the current search page no longer
  // holds them, so their row keeps its tick and stays selectable.
  const rows =
    value !== null && !candidates.some((candidate) => candidate.id === value.id)
      ? [value, ...candidates]
      : candidates;

  const list = (
    <Command shouldFilter={!serverSearched}>
      <CommandInput
        placeholder="Search by code or name"
        {...(serverSearched ? { value: search, onValueChange: onSearchChange } : {})}
      />
      <CommandList>
        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
            <Spinner />
            Loading the employee register
          </div>
        ) : (
          <>
            <CommandEmpty>Nobody matches that code or name.</CommandEmpty>
            <CommandGroup>
              {rows.map((candidate) => {
                const reason = disabledReason?.(candidate) ?? null;
                return (
                  <CommandItem
                    key={candidate.id}
                    value={`${candidate.employeeCode} ${candidate.name}`}
                    disabled={reason !== null}
                    onSelect={() => {
                      if (reason !== null) return;
                      onValueChange(candidate);
                      setOpen(false);
                    }}
                    className="gap-2"
                  >
                    <CheckIcon
                      className={cn('shrink-0', value?.id === candidate.id ? '' : 'invisible')}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="tabular-nums">{candidate.employeeCode}</span> —{' '}
                      {candidate.name}
                    </span>
                    {reason === null ? (
                      candidate.department ? (
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {candidate.department}
                        </span>
                      ) : null
                    ) : (
                      // Why, not just greyed out: a disabled row with no reason
                      // reads as the screen being broken.
                      <span className="text-muted-foreground shrink-0 text-xs">{reason}</span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        {/* The trigger is rendered by the Sheet so the button keeps its own
            focus management rather than being wrapped in a second element. */}
        <SheetTrigger render={trigger} />
        <SheetContent side="bottom" className="max-h-[85vh] gap-0">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{label}</SheetTitle>
            <SheetDescription>Search by employee code or name.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">{list}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-(--anchor-width) min-w-72 p-0">
        {list}
      </PopoverContent>
    </Popover>
  );
}
