import { useState } from 'react';
import { CalendarBlankIcon, XIcon } from '@phosphor-icons/react';
import type { Matcher } from 'react-day-picker';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

interface DateFieldProps {
  /** Matches the FieldLabel's htmlFor: the trigger is the labelled control. */
  id: string;
  /** Names the surface that opens, and the control for a screen reader. */
  label: string;
  value: Date | undefined;
  onValueChange: (value: Date | undefined) => void;
  disabled?: Matcher | Matcher[];
  /** Which month opens when nothing is chosen yet. */
  defaultMonth?: Date;
  placeholder?: string;
  invalid?: boolean;
}

/**
 * The date control for this product (CLAUDE.md §3 rule 1).
 *
 * Never `<input type="date">`. The native control renders differently in every
 * browser, cannot be themed, and on a phone hands the reader an OS picker that
 * has nothing to do with the rest of the interface. This is shadcn's own
 * date-picker composition — Calendar inside a Popover — with one change that
 * matters more than any styling: on a coarse pointer the calendar arrives as a
 * bottom Sheet instead.
 *
 * The switch is on `useIsMobile()` rather than on CSS because the two are
 * different markup, not one thing styled two ways, and because a popover
 * anchored to a field halfway up a phone screen puts the calendar where the
 * thumb is not.
 *
 * The cell size is raised to 44px inside the sheet. The desktop default is
 * 28px, which is right for a dense operations tool with a mouse and far too
 * small to hit with a thumb; seven 44px cells come to 308px, which fits inside
 * a 360px viewport with the sheet's own padding.
 */
export function DateField({
  id,
  label,
  value,
  onValueChange,
  disabled,
  defaultMonth,
  placeholder = 'Choose a date',
  invalid,
}: DateFieldProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  const triggerClassName = cn(
    // Full width so the two date fields line up in the form grid, and 44px on
    // a coarse pointer like every other control (index.css raises buttons to
    // the floor, but the text alignment below is what makes it read as a field
    // rather than a button).
    'w-full justify-start gap-2 font-normal pointer-coarse:h-11',
    !value && 'text-muted-foreground',
  );

  const triggerContent = (
    <>
      <CalendarBlankIcon data-icon="inline-start" />
      <span className="tabular-nums">{value ? formatDate(value.toISOString()) : placeholder}</span>
    </>
  );

  const calendarProps = {
    mode: 'single' as const,
    selected: value,
    disabled,
    defaultMonth: value ?? defaultMonth,
    // react-day-picker's own focus handling; without it the keyboard lands on
    // the popup rather than on a day, and arrow keys do nothing.
    autoFocus: true,
    onSelect: (next: Date | undefined) => {
      onValueChange(next);
      // Closing on choice rather than on a confirm button: a single date has
      // nothing left to decide once it is picked, and on a phone the sheet
      // covers the field it is filling in.
      setOpen(false);
    },
  };

  if (isMobile) {
    return (
      <>
        <Button
          id={id}
          type="button"
          variant="outline"
          aria-label={label}
          aria-invalid={invalid}
          className={triggerClassName}
          onClick={() => {
            setOpen(true);
          }}
        >
          {triggerContent}
        </Button>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="max-h-[85vh] gap-0">
            <SheetHeader className="shrink-0 border-b">
              <SheetTitle>{label}</SheetTitle>
              <SheetDescription>{`Dates are shown as ${formatDate('2026-12-31')}.`}</SheetDescription>
            </SheetHeader>

            {/* min-h-0 is load-bearing: a flex child will not shrink below its
                content without it, and the footer gets pushed off the sheet. */}
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <Calendar {...calendarProps} className="mx-auto [--cell-size:--spacing(11)]" />
            </div>

            <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t">
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => {
                  onValueChange(undefined);
                  setOpen(false);
                }}
              >
                <XIcon data-icon="inline-start" />
                Clear
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setOpen(false);
                }}
              >
                Close
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            aria-label={label}
            aria-invalid={invalid}
            className={triggerClassName}
          />
        }
      >
        {triggerContent}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar {...calendarProps} />
      </PopoverContent>
    </Popover>
  );
}
