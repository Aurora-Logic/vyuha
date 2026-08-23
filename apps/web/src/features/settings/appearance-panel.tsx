import { useEffect } from 'react';
import { ArrowCounterClockwiseIcon, CheckIcon } from '@phosphor-icons/react';

import { applyAppearance } from '@/components/shared/appearance';
import { SectionHeading } from '@/components/shared/section-heading';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import {
  ACCENT_PRESETS,
  APPEARANCE_BASES,
  APPEARANCE_BASE_LABELS,
  APPEARANCE_DENSITIES,
  APPEARANCE_DENSITY_LABELS,
  DEFAULT_APPEARANCE,
  presetFor,
  type Appearance,
  type AppearanceBase,
} from '@vyuha/shared';

import { BASE_SWATCH, SWATCH } from './appearance-swatches';
import { EnforcementNote } from './policy-fields';

/**
 * The workspace's colour and density, with the page as the preview: every
 * change is applied to the document at once, and Save or Discard on the
 * page settles it. Eight accents in fixed order, and a hue for any other,
 * all at the lightness the theme was measured at; three bases; two
 * densities. No hex field: a picker that can choose any colour can choose
 * one the text cannot sit on.
 */
const CUSTOM_CHROMA = 0.22;

export function AppearancePanel({ value, saved, enforcedBy, onChange }: { value: Appearance; saved: Appearance; enforcedBy: string | null | undefined; onChange: (next: Partial<Appearance>) => void }) {
  // The page is the preview. On unmount -- the tab left, the page left --
  // the saved appearance comes back, so an unsaved draft never outlives the
  // screen that made it.
  useEffect(() => {
    applyAppearance(document.documentElement, value);
  }, [value]);
  useEffect(
    () => () => {
      applyAppearance(document.documentElement, saved);
    },
    [saved],
  );

  const preset = presetFor(value);
  const isShipped = JSON.stringify(value) === JSON.stringify(DEFAULT_APPEARANCE);

  return (
    <div className="flex flex-col gap-6 border p-4">
      <SectionHeading
        title="Appearance"
        note="The accent and the base are the workspace's; light and dark are each person's. The page shows the change as you make it."
        action={
          <Button variant="ghost" size="sm" disabled={isShipped} onClick={() => { onChange(DEFAULT_APPEARANCE); }}>
            <ArrowCounterClockwiseIcon data-icon="inline-start" />
            As shipped
          </Button>
        }
      />

      <FieldGroup className="gap-6">
        <Field>
          <FieldLabel>Accent</FieldLabel>
          {/*
            Swatches, not labelled buttons. Eight fitted in a row; eighteen do
            not, and a wall of pill-shaped names is harder to scan than the
            colours themselves -- the swatch *is* the label here. The name is
            still reachable: it is the accessible name and it is in the
            tooltip, so nothing is colour-only.

            Selection is a ring plus a tick, never colour alone. A ring on its
            own fails for the person who cannot separate the ring's hue from
            the swatch's, and on slate it would barely show.
          */}
          <TooltipProvider delay={300}>
            <div
              role="radiogroup"
              aria-label="Accent"
              className="grid grid-cols-9 gap-1.5 sm:grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))]"
            >
              {ACCENT_PRESETS.map((candidate) => {
                const selected = preset?.id === candidate.id;
                return (
                  <Tooltip key={candidate.id}>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          role="radio"
                          aria-checked={selected}
                          aria-label={candidate.label}
                          onClick={() => {
                            onChange({ accentHue: candidate.hue, accentChroma: candidate.chroma });
                          }}
                          className={cn(
                            // Padding and the minimum width are cleared so the
                            // control *is* the swatch rather than a button with
                            // a colour inside it. The primitive's coarse-pointer
                            // hit area is kept.
                            'size-auto min-w-0 p-0 hover:bg-transparent',
                            // 44px on a coarse pointer via the pseudo-element,
                            // so the tile stays 36px and the grid stays a grid.
                            'focus-visible:ring-ring relative flex aspect-square items-center justify-center rounded-md outline-none transition-transform focus-visible:ring-2 focus-visible:ring-offset-2',
                            'after:absolute after:inset-0 pointer-coarse:after:-inset-1',
                            'active:scale-95',
                            selected && 'ring-foreground ring-2 ring-offset-2',
                          )}
                        >
                          {/*
                            The colour is a layer inside the control, not the
                            control's own background, which is how the base row
                            below already does it. On the button itself it was
                            being wiped by `hover:bg-transparent` -- that class
                            is there to kill the ghost variant's hover tint, and
                            a hover: utility beats a plain bg utility, so the
                            swatch went invisible under the pointer. Painting an
                            opaque layer over the button makes any hover
                            background unreachable rather than fighting it.
                          */}
                          <span
                            aria-hidden
                            className={cn('absolute inset-0 rounded-md', SWATCH[candidate.id])}
                          />
                          {/* White on every swatch: each is oklch(0.457), and
                              white on that lightness clears AA at any hue in
                              the ramp. */}
                          {selected ? (
                            <CheckIcon weight="bold" className="relative size-4 text-white" />
                          ) : null}
                        </Button>
                      }
                    />
                    <TooltipContent>{candidate.label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </TooltipProvider>
          <FieldDescription>
            {preset ? `${preset.label}, at the lightness the theme was measured at.` : `A custom hue at ${String(Math.round(value.accentHue))}°; the lightness and contrast are the theme's.`}
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="appearance-hue">Any other hue</FieldLabel>
          <div className="flex items-center gap-3">
            <span aria-hidden className="bg-primary size-5 shrink-0" />
            <Slider
              id="appearance-hue"
              aria-label="Accent hue"
              min={0}
              max={360}
              step={1}
              value={[Math.round(value.accentHue)]}
              onValueChange={(next: number | readonly number[]) => {
                const hue = typeof next === 'number' ? next : next[0];
                if (typeof hue === 'number') onChange({ accentHue: hue, accentChroma: preset ? CUSTOM_CHROMA : value.accentChroma });
              }}
              className="max-w-md"
            />
            <span className="w-10 text-right text-xs tabular-nums">{String(Math.round(value.accentHue))}°</span>
          </div>
          <FieldDescription>Drag to a brand hue. The swatch is the accent the page is wearing now.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel>Base</FieldLabel>
          <ToggleGroup
            variant="outline"
            aria-label="Base"
            value={[value.base]}
            onValueChange={(next: string[]) => {
              const base = next[0];
              if (APPEARANCE_BASES.includes(base as AppearanceBase)) onChange({ base: base as AppearanceBase });
            }}
          >
            {APPEARANCE_BASES.map((base) => (
              <ToggleGroupItem key={base} value={base} className="gap-2 pl-1.5">
                <span aria-hidden className={cn('size-4 border', BASE_SWATCH[base])} />
                {APPEARANCE_BASE_LABELS[base]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>The temperature of every surface, border and muted word, in both modes.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel>Density</FieldLabel>
          <ToggleGroup
            variant="outline"
            aria-label="Density"
            value={[value.density]}
            onValueChange={(next: string[]) => {
              const density = next[0];
              if (density === 'comfortable' || density === 'compact') onChange({ density });
            }}
          >
            {APPEARANCE_DENSITIES.map((density) => (
              <ToggleGroupItem key={density} value={density}>
                {APPEARANCE_DENSITY_LABELS[density]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>Compact tightens spacing by a fifth; type stays its size and touch targets stay 44px.</FieldDescription>
        </Field>
      </FieldGroup>

      <EnforcementNote by={enforcedBy} />
    </div>
  );
}
