import { createElement, useState } from 'react';
import { PUNCH_SOURCE_ICONS } from '@/components/shared/entity-icons';
import { PUNCH_FLAG_REVIEW_LABELS, type PunchSource } from '@vyuha/shared';
import { ImageBrokenIcon, UserGearIcon } from '@phosphor-icons/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useEmployeePunches, type EmployeePunch } from '@/features/employees/use-employee-attendance';
import { usePunchPhoto } from './punch-photo.js';
import { humaniseEnum } from '@/lib/format';

import { formatClock } from './format';

/**
 * The punches behind one day, with the photo taken at each (REQ-D-02).
 *
 * The day sheet used to state times and nothing else, which answers "when" and
 * not "was that really them" -- and the photograph is the whole reason the
 * punch is trusted. Somebody querying a late arrival, or a manager checking a
 * field punch, was sent to the punch audit report to find the same two rows.
 *
 * Fetched only while the sheet is open. A day row that pre-loaded its punches
 * would issue one request per row on a month view -- thirty-one requests to
 * show a calendar nobody has tapped yet.
 */

/** REQ-D-03a: the full image is fetched when asked for, never with the list. */
function Thumbnail({ punch, onOpen }: { punch: EmployeePunch; onOpen: () => void }) {
  // An admin's entry has no photograph, so nothing is fetched for it.
  const photo = usePunchPhoto(punch.id, 'thumbnail', punch.source !== 'ADMIN_ENTRY');
  if (punch.source === 'ADMIN_ENTRY') {
    return (
      <span
        aria-label="Recorded by an administrator, no photo"
        className="bg-muted text-muted-foreground flex size-16 shrink-0 items-center justify-center"
      >
        <UserGearIcon className="size-5" aria-hidden />
      </span>
    );
  }

  if (photo.isPending) {
    return <Skeleton className="size-16 shrink-0" aria-label="Loading the photo" />;
  }

  /*
   * A missing photo is not an error state worth a red panel here.
   *
   * REQ-L-03 deletes a photo at the end of its retention window and keeps the
   * punch, and a web punch from an allow-listed desktop may never have had one.
   * Both are ordinary; the row still has to render its time.
   */
  if (photo.isError) {
    return (
      <div
        className="bg-muted text-muted-foreground flex size-16 shrink-0 items-center justify-center border"
        aria-label="No photo for this punch"
      >
        <ImageBrokenIcon />
      </div>
    );
  }

  return (
    // The shadcn Button, not a raw one (CLAUDE.md section 3 rule 1). Padding
    // and the minimum width are cleared so the frame is the photograph rather
    // than a control with a picture inside it; the coarse-pointer hit area the
    // primitive adds is kept, and 64px already clears the 44px floor.
    <Button
      variant="ghost"
      onClick={onOpen}
      aria-label={`View the ${humaniseEnum(punch.type)} photo full size`}
      className="size-16 shrink-0 overflow-hidden border p-0 pointer-coarse:min-w-16"
    >
      <img src={photo.data} alt="" className="size-16 object-cover" />
    </Button>
  );
}

function FullPhoto({ punch }: { punch: EmployeePunch }) {
  const photo = usePunchPhoto(punch.id, 'full', true);

  if (photo.isPending) {
    return <Skeleton className="aspect-square w-full" aria-label="Loading the photo" />;
  }
  if (photo.isError) {
    return (
      <Alert variant="destructive">
        <ImageBrokenIcon />
        <AlertTitle>The photo could not be loaded</AlertTitle>
        <AlertDescription>
          It may have passed its retention window, or you may not have permission to view it.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <img
      src={photo.data}
      alt={`${humaniseEnum(punch.type)} at ${formatClock(punch.serverTime)}`}
      className="bg-muted max-h-[70vh] w-full border object-contain"
    />
  );
}

export function DayPunches({
  employeeId,
  date,
  enabled,
}: {
  readonly employeeId: string;
  readonly date: string;
  readonly enabled: boolean;
}) {
  // One day, so `from` and `to` are the same date. The feed is keyed on the
  // attendance date, which a night shift's OUT shares with its IN (REQ-C-02),
  // so a shift crossing midnight still returns both.
  const punches = useEmployeePunches({ employeeId, from: date, to: date }, { enabled });
  const [viewing, setViewing] = useState<EmployeePunch | null>(null);

  if (!enabled) return null;

  if (punches.isPending) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-busy="true">
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  // Silent on error rather than shouting. The times above are already on
  // screen and correct; a failed photo lookup should not make the day look
  // broken.
  if (punches.isError) return null;

  const rows = punches.data?.punches ?? [];
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-xs">No punches were recorded on this day.</p>;
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        {rows.map((punch) => (
          <div key={punch.id} className="flex items-center gap-3">
            <Thumbnail
              punch={punch}
              onOpen={() => {
                setViewing(punch);
              }}
            />
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={punch.type === 'IN' ? 'default' : 'outline'}>
                  {humaniseEnum(punch.type)}
                </Badge>
                <span className="text-xs font-medium tabular-nums">
                  {formatClock(punch.serverTime)}
                </span>
              </div>
              <span className="text-muted-foreground truncate text-xs">
                <SourceGlyph source={punch.source} />
                {punch.source === 'ADMIN_ENTRY'
                  ? ` Recorded by admin${punch.recordedBy === null ? '' : ` (${punch.recordedBy.name})`}`
                  : ` ${humaniseEnum(punch.source)}`}
                {punch.reason === null ? '' : ` · ${punch.reason}`}
                {punch.flagReview === null
                  ? ''
                  : ` · ${PUNCH_FLAG_REVIEW_LABELS[punch.flagReview.action]} by ${punch.flagReview.decidedBy?.name ?? 'an administrator'}`}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/*
        A Dialog rather than a second Sheet. The day sheet is already a Sheet,
        and a sheet sliding out of a sheet gives no sense of where the photo
        came from; a centred dialog reads as "this, larger".
      */}
      <Dialog
        open={viewing !== null}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
      >
        <DialogContent className="block max-w-2xl min-w-0">
          {viewing ? (
            <>
              <DialogTitle>
                {humaniseEnum(viewing.type)} at {formatClock(viewing.serverTime)}
              </DialogTitle>
              <DialogDescription>
                The photo captured with this punch. {humaniseEnum(viewing.source)}.
              </DialogDescription>
              <div className="mt-3">
                <FullPhoto punch={viewing} />
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Owner, 22 Aug 2026: where a punch came from, as the glyph the source wears everywhere. */
function SourceGlyph({ source }: { source: PunchSource }) {
  return createElement(PUNCH_SOURCE_ICONS[source], { 'aria-hidden': true, className: 'inline size-3.5 align-[-2px]' });
}
