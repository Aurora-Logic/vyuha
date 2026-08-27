import { useState } from 'react';
import { LockKeyIcon, LockKeyOpenIcon, LockSimpleIcon } from '@phosphor-icons/react';
import { parseISO } from 'date-fns';

import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { ReasonDialog } from '@/components/shared/reason-dialog';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { toast } from '@/components/ui/toast';
import { toDateParam } from '@/features/attendance/format';
import { MonthField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatDate } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { isLive, periodLabel, type PeriodLock } from './types';
import { useLockPeriod, usePeriodLocks, useUnlockPeriod } from './use-period-locks';

/**
 * REQ-E-09 / PRD §5 screen 19: closing a month.
 *
 * The screen's job is to make the consequence obvious before the button is
 * pressed. A locked month refuses punches, leave, regularizations, overrides
 * and recomputes, and it is the precondition for the payroll handoff
 * (REQ-J-04), so it is the one action here that other people notice
 * immediately.
 *
 * **The two actions carry different permissions.** Locking needs
 * `attendance.lock`, which HR holds. Unlocking needs `attendance.unlock`, which
 * only Admin holds — REQ-E-09 says "unlocking requires Admin", and until this
 * slice there was no key that could say so, only a dialog that claimed it
 * (docs/OPEN-QUESTIONS P2-1). The Unlock control is now absent for HR, with the
 * reason stated in its place, rather than present and then refused.
 */

function printInstant(value: string | null): string {
  if (value === null) return EMPTY_VALUE;
  const parsed = parseISO(value);
  if (Number.isNaN(parsed.getTime())) return EMPTY_VALUE;
  return formatDate(toDateParam(parsed));
}

const COLUMNS: RecordColumn<PeriodLock>[] = [
  {
    key: 'period',
    header: 'Period',
    cell: (row) => <span className="font-medium">{periodLabel(row.year, row.month)}</span>,
  },
  {
    key: 'scope',
    header: 'Scope',
    cell: (row) => row.locationName ?? 'Whole organisation',
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) =>
      isLive(row) ? <Badge>Locked</Badge> : <Badge variant="outline">Unlocked</Badge>,
  },
  {
    key: 'lockedBy',
    header: 'Locked by',
    cell: (row) => row.lockedBy?.name ?? EMPTY_VALUE,
    secondary: true,
  },
  {
    key: 'lockedAt',
    header: 'Locked on',
    cell: (row) => printInstant(row.lockedAt),
    className: 'tabular-nums',
  },
  {
    key: 'lockReason',
    header: 'Locked because',
    cell: (row) => row.lockReason ?? EMPTY_VALUE,
    secondary: true,
  },
  {
    key: 'unlockedAt',
    header: 'Unlocked on',
    cell: (row) => printInstant(row.unlockedAt),
    className: 'tabular-nums',
    secondary: true,
  },
  {
    key: 'unlockReason',
    header: 'Unlocked because',
    cell: (row) => row.unlockReason ?? EMPTY_VALUE,
    secondary: true,
  },
];

export function PeriodLockPage() {
  const canLock = usePermission(PERMISSIONS.ATTENDANCE_LOCK);
  const canUnlock = usePermission(PERMISSIONS.ATTENDANCE_UNLOCK);

  if (!canLock && !canUnlock) {
    return (
      <>
        <PageHeader description="Closing a month freezes it against any further change." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot lock or unlock a period</EmptyTitle>
            <EmptyDescription>
              Locking needs attendance.lock, which HR and Admin hold. Unlocking needs
              attendance.unlock, which only Admin holds. A locked month is what payroll is
              calculated from, so both controls are narrow on purpose.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return <PeriodLockBody canLock={canLock} canUnlock={canUnlock} />;
}

function PeriodLockBody({ canLock, canUnlock }: { canLock: boolean; canUnlock: boolean }) {
  // Last month rather than this one: locking a month that is still running is
  // almost never what somebody means, and a default that has to be corrected
  // every time is a default that will eventually not be.
  const [period, setPeriod] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() - 1, 1);
  });
  const [periodOpen, setPeriodOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [unlocking, setUnlocking] = useState<PeriodLock | null>(null);

  const query = usePeriodLocks();
  const lock = useLockPeriod();
  const unlock = useUnlockPeriod();

  const rows = query.data?.data ?? [];
  const year = period.getFullYear();
  const month = period.getMonth() + 1;
  const already = rows.find((row) => row.year === year && row.month === month && isLive(row));

  // PRD §6.4: Alt+F2 changes the period.
  useShortcut({
    id: 'period-lock.change-period',
    keys: 'alt+f2',
    label: 'Change period',
    scope: 'screen',
    run: () => {
      setPeriodOpen(true);
    },
  });

  return (
    <>
      <PageHeader description="Closing a month freezes it against any further change. Locking and unlocking each take a reason, and both are audited." />

      <div className="flex flex-col gap-4">
        {/* Toolbar row (PRD §6.2). */}
        <div className="flex flex-wrap items-center gap-2">
          <MonthField
            value={period}
            onValueChange={setPeriod}
            label="Month to lock"
            open={periodOpen}
            onOpenChange={setPeriodOpen}
            hint={<ShortcutHint keys="alt+f2" className="ml-1 hidden md:inline-flex" />}
          />
          {canLock ? (
            <Button
              disabled={already !== undefined}
              onClick={() => {
                lock.reset();
                setConfirming(true);
              }}
            >
              <LockSimpleIcon data-icon="inline-start" />
              Lock {periodLabel(year, month)}
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">
              You can reopen a closed month but not close one; closing needs attendance.lock.
            </p>
          )}
          {canLock && already !== undefined ? (
            <p className="text-muted-foreground text-xs">
              {periodLabel(year, month)} is already locked.
            </p>
          ) : null}
        </div>

        {query.isPending ? <ListSkeleton rows={4} label="Loading period locks" /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="period locks"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LockKeyOpenIcon />
              </EmptyMedia>
              <EmptyTitle>No month has been locked</EmptyTitle>
              <EmptyDescription>
                Every month is still open, so punches, leave and corrections can still change any
                past day. The payroll handoff only runs from a locked period.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <>
            <RecordTable
              columns={COLUMNS}
              rows={rows}
              rowKey={(row) => row.id}
              mobilePrimary={(row) => periodLabel(row.year, row.month)}
              mobileStatus={(row) =>
                isLive(row) ? <Badge>Locked</Badge> : <Badge variant="outline">Unlocked</Badge>
              }
              mobileSupporting={(row) =>
                `${row.locationName ?? 'Whole organisation'} · ${printInstant(row.lockedAt)}`
              }
            />

            <div className="flex flex-col gap-2">
              {rows.filter(isLive).map((row) => (
                <div key={row.id} className="flex flex-wrap items-center gap-2">
                  <p className="text-muted-foreground min-w-0 flex-1 text-xs">
                    {canUnlock
                      ? `${periodLabel(row.year, row.month)} is locked. Unlocking needs a reason and is recorded against your name.`
                      : `${periodLabel(row.year, row.month)} is locked. Reopening it is an Admin action: it needs the attendance.unlock permission, which your account does not hold.`}
                  </p>
                  {canUnlock ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        unlock.reset();
                        setUnlocking(row);
                      }}
                    >
                      <LockKeyOpenIcon data-icon="inline-start" />
                      Unlock {periodLabel(row.year, row.month)}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <ReasonDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Lock ${periodLabel(year, month)}?`}
        description="This is what the rest of the system will refuse afterwards."
        consequences={[
          'No punch can be recorded against a day in this month.',
          'No leave, regularization or on-duty request can affect it.',
          'No manual override, and the day engine will not recompute it.',
          'Reopening it needs an Admin and a typed reason.',
        ]}
        prompt="Why is this month being closed?"
        hint="Stored on the lock row and shown in the audit log."
        confirmLabel="Lock the month"
        pendingLabel="Locking"
        confirmIcon={<LockSimpleIcon data-icon="inline-start" />}
        pending={lock.isPending}
        error={lock.error}
        onConfirm={(reason) => {
          lock.mutate(
            { year, month, locationId: null, reason },
            {
              onSuccess: () => {
                toast.add({
                  type: 'success',
                  title: `${periodLabel(year, month)} locked`,
                  description: 'Nothing in this month can change until an Admin unlocks it.',
                });
                setConfirming(false);
              },
              // No success toast on failure and no optimistic row. The dialog
              // stays open with the error, because a month that was not locked
              // must never look locked.
            },
          );
        }}
      />

      <ReasonDialog
        open={unlocking !== null}
        onOpenChange={(next) => {
          if (!next) setUnlocking(null);
        }}
        title={
          unlocking === null ? 'Unlock' : `Unlock ${periodLabel(unlocking.year, unlocking.month)}?`
        }
        description="The month becomes changeable again. Anything recomputed afterwards can differ from what payroll was already given."
        consequences={
          unlocking === null
            ? []
            : [
                unlocking.lockReason === null
                  ? 'No reason was recorded when it was closed.'
                  : `It was closed because: ${unlocking.lockReason}`,
                'Punches, leave, regularizations and overrides can affect it again.',
                'The lock row is kept, so both decisions stay on the record.',
              ]
        }
        prompt="Why is this being unlocked?"
        hint="Required. Write what a reader in six months would need."
        confirmLabel="Unlock"
        pendingLabel="Unlocking"
        confirmIcon={<LockKeyOpenIcon data-icon="inline-start" />}
        destructive
        pending={unlock.isPending}
        error={unlock.error}
        onConfirm={(reason) => {
          if (unlocking === null) return;
          unlock.mutate(
            { id: unlocking.id, reason },
            {
              onSuccess: () => {
                toast.add({
                  type: 'success',
                  title: `${periodLabel(unlocking.year, unlocking.month)} unlocked`,
                  description: 'Your reason is recorded in the audit log.',
                });
                setUnlocking(null);
              },
            },
          );
        }}
      />
    </>
  );
}
