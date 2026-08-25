import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ACTION_ICONS } from '@/components/shared/action-icons';
import { flagClasses, flagLabel } from '@/features/attendance/status';
import { ArrowsOutIcon, DeviceMobileIcon, MapPinIcon } from '@phosphor-icons/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatDate, humaniseEnum } from '@/lib/format';
import { formatCoordinates } from '@vyuha/shared';

import { usePunchPhoto } from './api';
import { formatTimestamp } from './format';
import type { PunchAuditRow } from './types';

/**
 * REQ-J-02: "click any punch to see the stamped photo, map pin, device, and
 * flags in a side panel."
 *
 * REQ-D-03a is the constraint that shapes it: fetching full images in a list
 * is called out as a review failure. So the thumbnail is what the panel opens
 * with -- one signed URL for one punch, requested only once the panel is open
 * -- and the full image is a second, deliberate request behind a button. A
 * table row never triggers either.
 */

interface PunchPhotoSheetProps {
  punch: PunchAuditRow | null;
  onOpenChange: (open: boolean) => void;
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-muted-foreground shrink-0 text-xs">{label}</span>
      <span className="min-w-0 text-right text-sm break-words tabular-nums">{value}</span>
    </div>
  );
}

function PhotoFrame({
  punchId,
  variant,
  enabled,
  alt,
}: {
  punchId: string;
  variant: 'thumbnail' | 'full';
  enabled: boolean;
  alt: string;
}) {
  const photo = usePunchPhoto(punchId, variant, enabled);

  if (!enabled) return null;

  if (photo.isPending) {
    return <Skeleton className="aspect-square w-full" aria-label="Loading the photo" />;
  }

  if (photo.isError) {
    // A punch photo past its retention window is deleted by design and comes
    // back NOT_FOUND; the punch record survives without it.
    return (
      <QueryErrorAlert
        error={photo.error}
        subject="the punch photo"
        onRetry={() => {
          void photo.refetch();
        }}
      />
    );
  }

  return (
    <img
      src={photo.data}
      alt={alt}
      // The object is served from storage at its stored aspect ratio; the frame
      // fixes the layout so a portrait photo does not push the details off the
      // panel on a phone.
      className="bg-muted max-h-80 w-full border object-contain"
    />
  );
}

export function PunchPhotoSheet({ punch, onOpenChange }: PunchPhotoSheetProps) {
  const [showFull, setShowFull] = useState(false);
  const [shownPunchId, setShownPunchId] = useState<string | null>(null);

  // A new punch starts on the thumbnail. Without this, opening one punch's
  // full image and then a second punch would fetch the second full image
  // straight away -- the exact request REQ-D-03a is about.
  //
  // Reset during render rather than in an effect: an effect would render the
  // second punch once with the previous punch's `showFull` still true, and
  // that render is what issues the query. The reset has to happen before the
  // request, not after it.
  const punchId = punch?.id ?? null;
  if (shownPunchId !== punchId) {
    setShownPunchId(punchId);
    if (showFull) setShowFull(false);
  }

  const open = punch !== null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="shrink-0 border-b">
          <SheetTitle>{punch === null ? 'Punch' : punch.employee.name}</SheetTitle>
          <SheetDescription>
            {punch === null
              ? ''
              : `${humaniseEnum(punch.type)} on ${formatDate(punch.attendanceDate)}`}
          </SheetDescription>
        </SheetHeader>

        {punch === null ? null : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="flex flex-col gap-3">
              <PhotoFrame
                punchId={punch.id}
                variant={showFull ? 'full' : 'thumbnail'}
                enabled
                alt={`Punch photo for ${punch.employee.name}`}
              />

              {showFull ? null : (
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => {
                    setShowFull(true);
                  }}
                >
                  <ArrowsOutIcon data-icon="inline-start" />
                  Load the full-size photo
                </Button>
              )}

              <Separator />

              <div className="flex flex-col divide-y">
                <Detail label="Employee code" value={punch.employeeCode} />
                <Detail label="Recorded at" value={formatTimestamp(punch.serverTime)} />
                <Detail
                  label="Device time"
                  value={punch.clientTime === null ? EMPTY_VALUE : formatTimestamp(punch.clientTime)}
                />
                <Detail
                  label="Clock skew"
                  value={
                    punch.clockSkewSeconds === null
                      ? EMPTY_VALUE
                      : `${String(punch.clockSkewSeconds)}s`
                  }
                />
                <Detail
                  label="Source"
                  value={
                    <span className="inline-flex items-center gap-1.5">
                      <DeviceMobileIcon className="size-3.5" />
                      {humaniseEnum(punch.source)}
                    </span>
                  }
                />
                <Detail
                  label="Location"
                  value={
                    punch.location === null ? (
                      EMPTY_VALUE
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <MapPinIcon className="size-3.5" />
                        {formatCoordinates(punch.location.latitude, punch.location.longitude)}
                      </span>
                    )
                  }
                />
                <Detail
                  label="Accuracy"
                  value={
                    punch.location?.accuracyM == null
                      ? EMPTY_VALUE
                      : `${String(punch.location.accuracyM)} m`
                  }
                />
                <Detail
                  label="From the office"
                  value={
                    punch.location?.distanceFromGeofenceM == null
                      ? EMPTY_VALUE
                      : `${String(punch.location.distanceFromGeofenceM)} m`
                  }
                />
                <Detail
                  label="Half day"
                  value={
                    punch.isHalfDayMarked
                      ? humaniseEnum(punch.halfDayPart ?? 'yes')
                      : EMPTY_VALUE
                  }
                />
                <Detail label="Reason" value={punch.reason ?? EMPTY_VALUE} />
              </div>

              {punch.flags.length > 0 ? (
                <Alert>
                  <ACTION_ICONS.flag />
                  <AlertTitle>Flagged</AlertTitle>
                  <AlertDescription>
                    <span className="flex flex-wrap gap-1">
                      {punch.flags.map((flag) => (
                        <Badge key={flag} variant="outline" className={cn('font-normal', flagClasses(flag).text, flagClasses(flag).border, flagClasses(flag).fill)}>
                          <ACTION_ICONS.flag aria-hidden />
                          {flagLabel(flag)}
                        </Badge>
                      ))}
                    </span>
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
