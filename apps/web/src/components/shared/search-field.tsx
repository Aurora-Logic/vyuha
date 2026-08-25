import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';

interface SearchFieldProps {
  id: string;
  /**
   * The accessible name. A filter toolbar has no room for a visible label and
   * the magnifier already says what the field is, but a control with no name at
   * all is unusable with a screen reader.
   */
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * The one search control (CLAUDE.md §3 rule 4).
 *
 * Composed from shadcn's InputGroup rather than written as a styled input, and
 * kept here rather than in a feature so the audit log, the employee list and
 * every later register share one shape and one clear affordance.
 *
 * `type="text"`, not `type="search"`: WebKit draws its own clear button inside
 * a search input, which would sit next to ours and give the field two X's that
 * behave differently.
 */
export function SearchField({
  id,
  label,
  value,
  onValueChange,
  placeholder,
  className,
}: SearchFieldProps) {
  return (
    // The 32px desktop density of PRD §6.3 is too small to hit on a phone, so
    // the field takes the 44px floor on a coarse pointer — the same rule the
    // global stylesheet applies to buttons, which does not cover inputs.
    <InputGroup
      // Anchor for the per-screen guide. On the shared component rather than
      // on each screen that renders one, so a page guide gains a step by the
      // screen simply using the kit (features/guide/tour-steps).
      data-guide="screen.search"
      className={className}
    >
      <InputGroupAddon>
        <MagnifyingGlassIcon />
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        type="text"
        role="searchbox"
        aria-label={label}
        // The caret sits at the text start, on top of the placeholder's first
        // letter, which reads as a struck-through "C". Fading the placeholder
        // while the field is focused leaves the caret alone on an empty field;
        // the hint returns the moment focus leaves. One place, so every search
        // across the app behaves the same.
        className="focus:placeholder:text-transparent"
        placeholder={placeholder}
        value={value}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
        onKeyDown={(event) => {
          // PRD §6.4: Esc clears the field it is typed in. Handled on the
          // element rather than in the shortcut registry because Esc there
          // means "close the screen", and a global handler that also emptied
          // fields would fire while a dialog was open.
          //
          // Propagation is only stopped when there is something to clear, so an
          // Esc in an already-empty field still reaches whatever surface is
          // listening for it.
          if (event.key === 'Escape' && value.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            onValueChange('');
          }
        }}
      />
      {value.length > 0 ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => {
              onValueChange('');
            }}
          >
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}
