import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { useRef, useState } from 'react';

import { SearchField } from '@/components/shared/search-field';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Search as an icon until somebody wants it, which is what Notion does and
 * why its toolbar has room for anything else.
 *
 * A permanent search field is a wide control that is empty almost all of the
 * time — on the task screen it sat beside five filters and the row wrapped to
 * two, which is the report that prompted this (owner, 1 Sep 2026). Collapsed
 * it is one 32px button; expanded it is the same `SearchField` every other
 * screen uses, so nothing about searching changes except when the box exists.
 *
 * It stays open while it holds a term. Collapsing a field that is filtering
 * the page would hide the reason the page looks the way it does, which is the
 * one thing a search box must never do.
 */
export function CollapsibleSearch({
  id,
  label,
  value,
  onValueChange,
  placeholder,
  className,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly placeholder: string;
  /** The expanded width. Full width on a phone, where nothing shares the row. */
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  // A term keeps it open however the state flag got here — a saved view
  // arriving with `?q=` opens it without anyone having clicked.
  const expanded = open || value !== '';

  if (!expanded) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-expanded={false}
        onClick={() => {
          setOpen(true);
        }}
      >
        <MagnifyingGlassIcon />
      </Button>
    );
  }

  return (
    <div
      ref={wrapper}
      className={cn('flex items-center gap-1', className ?? 'w-full sm:w-56')}
      // Collapses when focus leaves and nothing was typed. `relatedTarget`
      // inside the wrapper means focus moved to the clear button, not away.
      onBlur={(event) => {
        if (value !== '') return;
        if (wrapper.current?.contains(event.relatedTarget) === true) return;
        setOpen(false);
      }}
    >
      <SearchField
        id={id}
        label={label}
        className="flex-1"
        autoFocus
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
      />
      {value === '' ? null : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => {
            onValueChange('');
            setOpen(false);
          }}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}
