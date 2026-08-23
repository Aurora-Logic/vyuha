import { useState, type ReactNode } from 'react';
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { ACTION_ICONS } from '@/components/shared/action-icons';

import { buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  RecordHistoryButton,
  RecordHistorySheet,
} from '@/features/audit/record-history-sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { EMPTY_VALUE, formatDate } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { cn } from '@/lib/utils';
import { PERMISSIONS, type RegularizationKind } from '@vyuha/shared';

import { DayPunches } from './day-punches';
import { formatClock, formatDuration, formatWindow } from './format';
import { AttendanceFlags, AttendanceStatusBadge } from './status-badge';
import type { AttendanceDay } from './types';
import { useCanViewOvertime } from './visibility';

/**
 * One day, in full.
 *
 * PRD §6.5 makes this the destination of a row tap below 768px, which is what
 * lets the stacked mobile row carry two fields instead of nine. The same sheet
 * serves the calendar on My Attendance, so a day looks identical however it
 * was reached.
 */

/**
 * Whether this day is worth offering a correction for, and which one.
 *
 * REQ-F-01 lists four kinds; the two a screen can infer are the two the day
 * itself records. A day stuck on PENDING is REQ-E-02's "IN exists, OUT
 * missing, and the shift window has closed" — the exact state the decision log
 * calls "Pending until regularized" — so the missing OUT is named. A day
 * flagged `missing_punch` with neither punch is a forgotten day.
 *
 * Null for every other day. A correction offered on a clean PRESENT day would
 * be an invitation to edit attendance that nothing went wrong with, and the
 * form is one nav item away for the cases this cannot see.
 */
function suggestedKind(day: AttendanceDay): RegularizationKind | null {
  const missingPunch = day.flags.includes('missing_punch');
  if (day.status === 'PENDING') return day.firstIn === null ? 'FORGOT_TO_PUNCH' : 'MISSING_OUT';
  if (!missingPunch) return null;
  if (day.firstIn === null && day.lastOut === null) return 'FORGOT_TO_PUNCH';
  return day.lastOut === null ? 'MISSING_OUT' : 'MISSING_IN';
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground shrink-0 text-xs">{label}</dt>
      <dd className="min-w-0 text-right text-xs font-medium tabular-nums">{children}</dd>
    </div>
  );
}

export function DayDetailSheet({
  day,
  onOpenChange,
}: {
  /** Null closes the sheet. Passing the day itself keeps open state in one place. */
  day: AttendanceDay | null;
  onOpenChange: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  // The sheet serves both My Attendance and the muster, so the row is decided
  // by the viewer's keys rather than by which screen opened it.
  const canSeeOvertime = useCanViewOvertime();
  const canRaise = usePermission(PERMISSIONS.PUNCH_SELF);
  const kind = day === null ? null : suggestedKind(day);

  // REQ-M-02. A derived day is the one record in this product that a person
  // can find changed underneath them — an override, a lock, a nightly
  // recompute — so "who did this to my day" is the question it most needs to
  // be able to answer.
  const canReadTrail = usePermission(PERMISSIONS.AUDIT_VIEW);
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <Sheet open={day !== null} onOpenChange={onOpenChange}>
      {/* Bottom on a phone, right on a desktop: the sheet should arrive from
          the edge nearest the hand that opened it (CLAUDE.md §3 rule 1). */}
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0">
        {day ? (
          <>
            <SheetHeader className="shrink-0 border-b">
              <SheetTitle className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums">{formatDate(day.date)}</span>
                <AttendanceStatusBadge status={day.status} />
              </SheetTitle>
              <SheetDescription>{day.employee.name}</SheetDescription>
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <dl className="divide-border divide-y">
                <Row label="Shift">{day.shiftName ?? EMPTY_VALUE}</Row>
                <Row label="Scheduled">{formatWindow(day.scheduledIn, day.scheduledOut)}</Row>
                <Row label="First in">{formatClock(day.firstIn)}</Row>
                <Row label="Last out">{formatClock(day.lastOut)}</Row>
                <Row label="Worked">{formatDuration(day.workedMinutes)}</Row>
                {canSeeOvertime ? (
                  <Row label="Overtime">{formatDuration(day.otMinutes)}</Row>
                ) : null}
                <Row label="Late by">
                  {day.lateMinutes > 0 ? `${String(day.lateMinutes)}m` : EMPTY_VALUE}
                </Row>
              </dl>

              {day.flags.length > 0 ? (
                <>
                  <Separator className="my-4" />
                  <p className="text-muted-foreground mb-2 flex items-center gap-1 text-xs [&_svg]:size-3.5">
                    <ACTION_ICONS.flag aria-hidden />
                    Flags
                  </p>
                  <AttendanceFlags flags={day.flags} />
                </>
              ) : null}

              {/* REQ-D-02's photograph, where the day is actually looked at.
                  The times above answer "when"; the photo is what makes the
                  punch trustworthy, and without it somebody querying a late
                  arrival had to go and find the same rows in the punch audit
                  report. Fetched only because this sheet is open -- a calendar
                  that pre-loaded them would issue one request per day. */}
              <Separator className="my-4" />
              <p className="text-muted-foreground mb-2 text-xs">Punches</p>
              <DayPunches employeeId={day.employee.id} date={day.date} enabled />
            </div>

            {/* REQ-F-01 and REQ-M-02 share this footer. The correction is
                offered where the problem is noticed rather than only on a
                screen somebody has to know to visit, and the trail answers
                "who did this to my day" about the one record in this product
                that can change underneath a person -- an override, a lock, a
                recompute. Pinned to the sheet's bottom edge, which is the one
                place a thumb reaches without the hand moving. */}
            {(kind !== null && canRaise) || canReadTrail ? (
              <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t">
                {canReadTrail ? (
                  <RecordHistoryButton
                    onClick={() => {
                      setHistoryOpen(true);
                    }}
                  />
                ) : null}
                {/* A link, not a button that submits: the correction needs a
                    reason and a time, and the form is where those are given.
                    It carries the day and the kind so nothing is chosen twice.

                    `buttonVariants` on a real anchor is shadcn's own pattern
                    for a link that looks like a button (the Calendar in this
                    codebase does the same). `Button render={<Link/>}` was the
                    first attempt and Base UI warned about it: it applies
                    role="button" to the anchor, which announces a navigation
                    as a button and loses open-in-new-tab in assistive
                    technology. */}
                {kind !== null && canRaise ? (
                  <Link
                    to={`/regularizations?date=${day.date}&kind=${kind}`}
                    className={cn(buttonVariants({ variant: 'default' }), 'flex-1')}
                    onClick={() => {
                      onOpenChange(false);
                    }}
                  >
                    <ClockCounterClockwiseIcon data-icon="inline-start" />
                    Correct this day
                  </Link>
                ) : null}
              </SheetFooter>
            ) : null}
          </>
        ) : null}
      </SheetContent>

      {/* Opens over this sheet rather than replacing it, so closing it returns
          to the day rather than to the table. It is one surface deep, not two:
          the history sheet swaps its own body between the list and an entry
          instead of stacking a third. */}
      <RecordHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        entityType="attendance_days"
        entityId={day?.id ?? null}
        title={day === null ? '' : formatDate(day.date)}
        description={
          day === null
            ? ''
            : `${day.employee.name} — every override, lock and recompute recorded against this day.`
        }
      />
    </Sheet>
  );
}
