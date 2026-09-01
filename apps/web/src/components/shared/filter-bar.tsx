import { FunnelIcon, XIcon } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';

import { ResponsiveDialog, ResponsiveDialogActions } from '@/components/shared/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';

/**
 * Filters behind one button, and what is actually set shown as chips.
 *
 * The task screen carried a search box, a two-way toggle, three dropdowns and
 * a switch, all of the time, and the row wrapped onto two (owner, 1 Sep 2026:
 * "UI needs to be better as this is creating issue see how notion deals with
 * it"). Read off the real Notion: its toolbar is a handful of icon buttons,
 * the filter editor is a popover behind one of them, and the filters you have
 * actually set appear as chips *under* the toolbar — so a screen with no
 * filters shows no filter furniture at all.
 *
 * That is the rule this encodes. The cost of a control is not its width, it
 * is that it is on screen when it has nothing to say.
 *
 * A dialog on a desktop, a bottom sheet on a phone, because that is what
 * `ResponsiveDialog` already settled for every other modal here (CLAUDE.md
 * section 3: pickers and modals open as a bottom sheet on small screens).
 * Fourteen list screens in this product wear the same wrapped toolbar; this
 * lives in `components/shared` so the next one adopts it rather than growing
 * a second answer.
 */

export interface FilterChip {
  /** Stable across renders; also what the clear button is keyed and named by. */
  readonly key: string;
  /** What the filter is, e.g. "Priority". */
  readonly label: string;
  /** What it is set to, e.g. "High". */
  readonly value: string;
  readonly onClear: () => void;
}

export function FilterButton({
  /** How many filters are set. Drives the badge and the "Clear all". */
  active,
  onClearAll,
  children,
  title = 'Filters',
  description,
}: {
  readonly active: number;
  readonly onClearAll: () => void;
  /** The filter controls, each wrapped in a `FilterField`. */
  readonly children: ReactNode;
  readonly title?: string;
  readonly description?: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant={active > 0 ? 'outline' : 'ghost'}
        size="sm"
        aria-label={active === 0 ? 'Filters' : `Filters, ${String(active)} set`}
        onClick={() => {
          setOpen(true);
        }}
      >
        <FunnelIcon data-icon="inline-start" />
        Filter
        {active > 0 ? <span className="text-muted-foreground tabular-nums">{active}</span> : null}
      </Button>

      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        {...(description === undefined ? {} : { description })}
        className="sm:max-w-md"
      >
        <FieldGroup>{children}</FieldGroup>
        <ResponsiveDialogActions>
          {active > 0 ? (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                onClearAll();
              }}
            >
              Clear all
            </Button>
          ) : null}
          <Button
            onClick={() => {
              setOpen(false);
            }}
          >
            Done
          </Button>
        </ResponsiveDialogActions>
      </ResponsiveDialog>
    </>
  );
}

/** One labelled control inside the filter dialog. */
export function FilterField({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <Field orientation="responsive">
      <FieldLabel {...(htmlFor === undefined ? {} : { htmlFor })}>{label}</FieldLabel>
      {children}
    </Field>
  );
}

/**
 * What is set, under the toolbar, each removable.
 *
 * Renders nothing at all when nothing is filtered — the whole point. A chip
 * says both halves ("Priority: High"), because a bare "High" under a toolbar
 * is a word with no subject.
 */
export function FilterChips({ chips }: { readonly chips: readonly FilterChip[] }) {
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="bg-muted text-foreground/80 flex items-center gap-1 py-px pr-px pl-2 text-xs"
        >
          <span className="text-muted-foreground">{chip.label}:</span>
          <span className="font-medium">{chip.value}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Clear the ${chip.label.toLowerCase()} filter`}
            onClick={() => {
              chip.onClear();
            }}
          >
            <XIcon />
          </Button>
        </span>
      ))}
    </div>
  );
}
