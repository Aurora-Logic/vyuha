import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { STATUS_ICONS, statusTone } from './status-tone';

/**
 * A status pill coloured by its meaning and marked by its glyph. Pass the raw
 * state value and the label to show; the colour and the icon are both chosen in
 * one place ({@link statusTone}, {@link statusIcon}) so no screen picks its own.
 * The word stays beside the colour and the shape, so a status is legible three
 * ways over — for a colour-blind reader and a greyscale print, not colour alone.
 */
export function StatusBadge({
  state,
  label,
  className,
}: {
  state: string;
  label: string;
  className?: string;
}) {
  const Glyph = STATUS_ICONS[state];
  return (
    <Badge variant={statusTone(state)} className={cn(className)}>
      {Glyph ? <Glyph aria-hidden data-icon="inline-start" /> : null}
      {label}
    </Badge>
  );
}
