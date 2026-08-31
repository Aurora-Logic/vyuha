import type { RealtimeResource, RealtimeViewer } from '@vyuha/shared';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRecordViewers } from '@/lib/realtime/realtime-provider';
import { cn } from '@/lib/utils';

import { presenceLabel } from './presence-label';

/**
 * Who else has this record open, right now.
 *
 * The overlap is the point: a row of separated avatars reads as data about
 * the record ("its three owners"), while an overlapping stack reads as people
 * present at it. They are ordered by name so the same two colleagues are
 * always in the same order and the row does not reshuffle under the eye every
 * time a heartbeat lands.
 *
 * Names, not just faces. An initials circle alone is a guess -- two people
 * whose names start the same are the same circle -- so every avatar carries a
 * tooltip, and the whole stack carries a label for a screen reader, which
 * cannot hover at all.
 */

const MAX_SHOWN = 3;

const PRESENCE_HUES = [
  'bg-tint-1/20 text-tint-1',
  'bg-tint-2/20 text-tint-2',
  'bg-tint-3/20 text-tint-3',
  'bg-tint-4/20 text-tint-4',
  'bg-tint-5/20 text-tint-5',
  'bg-tint-6/20 text-tint-6',
  'bg-tint-7/20 text-tint-7',
  'bg-tint-8/20 text-tint-8',
] as const;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : (parts[0]?.[1] ?? '');
  return `${first}${last}`.toUpperCase() || '?';
}

/** The same person is the same colour here as in every other chip on the screen. */
function hueOf(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return PRESENCE_HUES[hash % PRESENCE_HUES.length] ?? PRESENCE_HUES[0];
}


export function PresenceAvatars({
  viewers,
  className,
}: {
  readonly viewers: readonly RealtimeViewer[];
  readonly className?: string;
}) {
  if (viewers.length === 0) return null;
  const shown = viewers.slice(0, MAX_SHOWN);
  const overflow = viewers.length - shown.length;

  return (
    <span
      className={cn('inline-flex items-center', className)}
      // The stack is one thing to a reader who cannot see it, not four.
      role="img"
      aria-label={presenceLabel(viewers)}
    >
      {shown.map((viewer) => (
        <Tooltip key={viewer.userId}>
          <TooltipTrigger
            // A tooltip on a non-interactive element still has to be
            // reachable without a mouse.
            className="focus-visible:ring-ring -ml-1.5 rounded-full first:ml-0 focus-visible:ring-2 focus-visible:outline-none"
            aria-hidden
            tabIndex={-1}
          >
            {/* The ring is what separates one head from the next where they overlap. */}
            <Avatar size="sm" className="ring-background size-6 ring-2 after:border-0">
              <AvatarFallback className={cn('text-[0.625rem] font-medium', hueOf(viewer.name))}>
                {initialsOf(viewer.name)}
              </AvatarFallback>
            </Avatar>
          </TooltipTrigger>
          <TooltipContent>{viewer.name} has this open</TooltipContent>
        </Tooltip>
      ))}
      {overflow > 0 ? (
        <Avatar size="sm" className="ring-background -ml-1.5 size-6 ring-2 after:border-0">
          <AvatarFallback className="bg-muted text-muted-foreground text-[0.625rem] font-medium">
            +{overflow}
          </AvatarFallback>
        </Avatar>
      ) : null}
    </span>
  );
}

/**
 * The same stack, for a place that renders one row per record and so cannot
 * call a hook itself -- a board card's `renderItem` is a callback, not a
 * component. One line at the call site, and the subscription stays inside
 * the component that draws it.
 */
export function RecordPresence({
  resource,
  recordId,
  className,
}: {
  readonly resource: RealtimeResource;
  readonly recordId: string;
  readonly className?: string;
}) {
  const viewers = useRecordViewers(resource, recordId);
  return <PresenceAvatars viewers={viewers} className={className} />;
}
