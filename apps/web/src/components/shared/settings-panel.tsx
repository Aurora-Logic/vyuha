import type { ReactNode } from 'react';

import { SectionHeading } from '@/components/shared/section-heading';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The settings anatomy, taken from Supabase's dashboard (owner, 27 Aug 2026:
 * "take from Supabase"). A section is a heading and a gloss over one bordered
 * panel; a panel is rows divided by hairlines, with a footer for the actions
 * that belong to it alone; a row is the label and its helper on the left and
 * the control on the right, stacking on a phone.
 *
 * Seventeen hand-written `border p-4` panels across settings said this in
 * seventeen slightly different ways. This is the one place the shape lives.
 * Square, because the theme's radius is zero; one border deep, because the
 * panel on the page surface is the content surface and nothing sits inside it
 * but rows (CLAUDE.md §3 rule 3).
 */

interface SettingsSectionProps {
  title: string;
  /** One line under the heading saying what the section decides. */
  note?: string;
  /** A control belonging to the section, not the page: a docs link, an add button. */
  action?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}

export function SettingsSection({ title, note, action, id, className, children }: SettingsSectionProps) {
  return (
    <section id={id} aria-label={title} className={cn('flex flex-col gap-3', className)}>
      <SectionHeading title={title} note={note} action={action} />
      {children}
    </section>
  );
}

interface SettingsPanelProps {
  /** `danger` for the panel whose rows remove or reset things: the border says so before the copy does. */
  tone?: 'default' | 'danger';
  /**
   * What the footer says on the left, live: "Unsaved changes", "Saved". The
   * footer renders when either this or `footer` is given.
   */
  status?: ReactNode;
  /** The actions that belong to this panel, right-aligned under its rows. */
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function SettingsPanel({ tone = 'default', status, footer, className, children }: SettingsPanelProps) {
  return (
    <div
      data-slot="settings-panel"
      data-tone={tone}
      className={cn('flex min-w-0 flex-col border', tone === 'danger' && 'border-destructive/50', className)}
    >
      <FieldGroup className="divide-border gap-0 divide-y">{children}</FieldGroup>
      {status !== undefined || footer !== undefined ? (
        <div className="bg-muted/40 flex flex-wrap items-center gap-2 border-t px-4 py-3">
          <p aria-live="polite" className="text-muted-foreground min-w-0 flex-1 text-xs">
            {status}
          </p>
          {footer ? <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

interface SettingsRowProps {
  label: ReactNode;
  /** The control's id, so the label focuses it. Omit when the control is not one field. */
  htmlFor?: string;
  description?: ReactNode;
  /** Under the description: the enforcement note, a caveat, a link onward. */
  note?: ReactNode;
  /**
   * `field`: the control takes a 20rem column on the right once the panel is
   * wide enough, and the full width until then. `end`: the control is as wide
   * as it is (a switch, a button, a value) and hugs the right edge on every
   * width, label beside it. `full`: the control needs the width (a chip list,
   * a table) and sits under the label at every size.
   */
  layout?: 'field' | 'end' | 'full';
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  children: ReactNode;
}

export function SettingsRow({
  label,
  htmlFor,
  description,
  note,
  layout = 'field',
  disabled,
  invalid,
  className,
  children,
}: SettingsRowProps) {
  return (
    <Field
      orientation={layout === 'end' ? 'horizontal' : 'vertical'}
      data-disabled={disabled ? true : undefined}
      data-invalid={invalid ? true : undefined}
      data-layout={layout}
      className={cn(
        'px-4 py-4',
        // The two-column row waits for the panel, not the viewport, to be wide
        // enough (@xl = 36rem): beside the rail on a small laptop the panel is
        // narrower than the window suggests, and a 20rem control column would
        // leave the label nothing to stand in.
        layout === 'field' &&
          '@xl/field-group:grid @xl/field-group:grid-cols-[minmax(0,1fr)_20rem] @xl/field-group:items-start @xl/field-group:gap-x-8',
        layout === 'end' && 'gap-4',
        className,
      )}
    >
      <FieldContent className="min-w-0">
        <FieldLabel htmlFor={htmlFor} className="font-medium">
          {label}
        </FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
        {note}
      </FieldContent>
      <div className={cn('min-w-0', layout === 'end' && 'flex shrink-0 items-center justify-end')}>{children}</div>
    </Field>
  );
}

interface SettingsPanelSkeletonProps {
  /** Names the wait for a screen reader: "Loading settings". */
  label: string;
  rows?: number;
  /** A heading line and gloss over the panel, for a page that has not drawn its section yet. */
  heading?: boolean;
  className?: string;
}

/**
 * The panel's shape while its rows are on their way -- label and helper on
 * the left, a control on the right, hairlines between -- so nothing moves
 * when they arrive. One skeleton for every settings panel, for the same
 * reason there is one panel.
 */
export function SettingsPanelSkeleton({ label, rows = 4, heading = false, className }: SettingsPanelSkeletonProps) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={cn('flex flex-col gap-3', className)}>
      {heading ? (
        <div aria-hidden className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
      ) : null}
      <div aria-hidden className="divide-border flex flex-col divide-y border">
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="flex flex-col gap-3 px-4 py-4 md:grid md:grid-cols-[minmax(0,1fr)_20rem] md:items-start md:gap-x-8"
          >
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-56 max-w-full" />
            </div>
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
