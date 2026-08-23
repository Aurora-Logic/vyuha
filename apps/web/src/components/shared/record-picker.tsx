import { useId, useState, type ReactNode } from 'react';
import { CaretUpDownIcon, CheckIcon, XIcon, WarningDiamondIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
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

/**
 * One record, chosen by typing — the combobox this product does not have.
 *
 * CLAUDE.md §3 forbids a raw control and directs a missing primitive to be
 * composed from shadcn primitives and kept in `components/shared` so it is
 * reused rather than re-invented. The registry's own `combobox` could not be
 * installed: its add command rewrites `button.tsx`, which is out of bounds
 * while several slices are in flight. So this is that composition — `Command`
 * for the filtered list, `Popover` on a pointer, a bottom `Sheet` on a phone,
 * which is the surface switch rule 1 requires of every picker.
 *
 * Generic over the option, because the employee form alone needs four of these
 * over four different collections and a per-collection copy is four places for
 * the mobile branch to be forgotten.
 */

export interface PickerOption {
  id: string;
  /** 15 REQ-AO-09: why to look twice before choosing (a likely duplicate), shown before it is chosen. */
  warning?: string;
  /** The line the reader searches and reads. */
  label: string;
  /** A code or a qualifier, shown dimmed at the end of the row. */
  hint?: string;
}

interface RecordPickerProps {
  /** Null when nothing is chosen. */
  value: PickerOption | null;
  onValueChange: (value: PickerOption | null) => void;
  options: readonly PickerOption[];
  /** Names the control, and titles the sheet on a phone. */
  label: string;
  /**
   * Renders `label` as text above the control, through the same Field and
   * FieldLabel every other input uses.
   *
   * Off by default because a filter toolbar is a row of controls whose
   * placeholders carry the meaning, and a column of labels there is noise.
   * On in a form: a picker beside a labelled Input is otherwise the one
   * control on the row with no name and no label line, which reads as a
   * broken row rather than a deliberate one.
   */
  showLabel?: boolean;
  /** Sizing from the row that owns it; the control itself is always full width. */
  className?: string;
  placeholder: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  loading?: boolean;
  /** Offers a "clear" row, for a field that is genuinely optional. */
  clearable?: boolean;
  clearLabel?: string;
  id?: string;
  icon?: ReactNode;
  disabled?: boolean;
  /**
   * Server-search mode. When `onSearchChange` is given the field is controlled
   * and cmdk's own filtering is switched off — the caller refetches `options`
   * for the term, so a match past the first page is reachable. A 5,000-item
   * catalogue cannot be filtered in the browser: it was never loaded, only its
   * first page was. Omit for the small, fully loaded lists (a handful of
   * offices, a fixed set of statuses) that filter fine on the client.
   */
  search?: string;
  onSearchChange?: (search: string) => void;
}

export function RecordPicker({
  value,
  onValueChange,
  options,
  label,
  showLabel = false,
  className,
  placeholder,
  searchPlaceholder = 'Search',
  emptyMessage = 'Nothing matches that.',
  loading = false,
  clearable = false,
  clearLabel = 'None',
  id,
  icon,
  disabled = false,
  search = '',
  onSearchChange,
}: RecordPickerProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  // The label needs something to point at when the caller gave no id.
  const fallbackId = useId();
  const controlId = id ?? fallbackId;
  // The caller drives the search on the server, so cmdk must not also filter
  // the rows it sent back — with filtering left on, a server result whose text
  // doesn't literally contain the query (a code match, a fuzzy match) would be
  // hidden the instant it arrived.
  const serverSearch = onSearchChange !== undefined;

  const trigger = (
    <Button
      id={controlId}
      variant="outline"
      disabled={disabled}
      aria-label={label}
      className="w-full justify-between gap-2 font-normal"
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        {value?.warning !== undefined ? <WarningDiamondIcon weight="fill" className="text-destructive shrink-0" aria-label={value.warning} /> : null}
        <span className={cn('truncate', value === null && 'text-muted-foreground')}>
          {value === null ? placeholder : value.label}
        </span>
      </span>
      <CaretUpDownIcon className="text-muted-foreground shrink-0" />
    </Button>
  );

  const list = (
    <Command shouldFilter={serverSearch ? false : undefined}>
      <CommandInput
        placeholder={searchPlaceholder}
        value={serverSearch ? search : undefined}
        onValueChange={serverSearch ? onSearchChange : undefined}
      />
      <CommandList>
        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
            <Spinner />
            Loading
          </div>
        ) : (
          <>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {clearable ? (
                <CommandItem
                  value={clearLabel}
                  className="gap-2"
                  onSelect={() => {
                    onValueChange(null);
                    setOpen(false);
                  }}
                >
                  <XIcon className={cn('shrink-0', value === null ? '' : 'invisible')} />
                  <span className="text-muted-foreground min-w-0 flex-1 truncate">
                    {clearLabel}
                  </span>
                </CommandItem>
              ) : null}
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  // Client mode filters on this text, so it carries both parts —
                  // a search matches the code as well as the name. Server mode
                  // does not filter here, so identity is the id alone, which two
                  // rows sharing a name cannot collide on.
                  value={serverSearch ? option.id : `${option.label} ${option.hint ?? ''}`}
                  className="gap-2"
                  onSelect={() => {
                    onValueChange(option);
                    setOpen(false);
                  }}
                >
                  <CheckIcon
                    className={cn('shrink-0', value?.id === option.id ? '' : 'invisible')}
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.warning === undefined ? null : (
                    <span title={option.warning} className="text-destructive flex shrink-0">
                      <WarningDiamondIcon weight="fill" aria-label={option.warning} />
                    </span>
                  )}
                  {option.hint === undefined ? null : (
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {option.hint}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );

  const labelled = (surface: ReactNode) =>
    showLabel ? (
      <Field className={className}>
        <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
        {surface}
      </Field>
    ) : (
      surface
    );

  if (isMobile) {
    return labelled(
      <Sheet open={open} onOpenChange={setOpen}>
        {/* Rendered by the Sheet rather than wrapped in it, so the button keeps
            its own focus management. */}
        <SheetTrigger render={trigger} />
        <SheetContent side="bottom" className="max-h-[85vh] gap-0">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{label}</SheetTitle>
            <SheetDescription>{searchPlaceholder}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">{list}</div>
        </SheetContent>
      </Sheet>,
    );
  }

  return labelled(
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-(--anchor-width) min-w-72 p-0">
        {list}
      </PopoverContent>
    </Popover>,
  );
}
