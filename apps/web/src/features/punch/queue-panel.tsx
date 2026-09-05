import { Fragment } from 'react';
import {
  ArrowClockwiseIcon,
  CloudArrowUpIcon,
  ClockCountdownIcon,
  SignInIcon,
  SignOutIcon,
  WarningCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { formatClock } from '@/features/attendance/format';
import {
  OFFLINE_QUEUE_MAX_AGE_HOURS,
  isNearingSyncDeadline,
  queuedHours,
  type QueuedPunch,
} from '@/lib/offline/punch-queue';
import type { DrainResult } from '@/lib/offline/outbox';

/**
 * What the offline queue is doing, stated on the punch screen (REQ-D-10,
 * technical design §8: "Never let someone believe a queued punch is
 * confirmed").
 *
 * The requirement this is written against is a truth requirement rather than a
 * layout one, so every element here answers a question somebody standing at a
 * gate would ask out loud: how many are waiting, which ones, when did it last
 * try, can I make it try now, and — for a punch the server has refused — what
 * do I do instead.
 *
 * One bordered surface divided by rules, not a card per punch (CLAUDE.md §3
 * rule 3).
 */

function typeLabel(type: QueuedPunch['type']): string {
  return type === 'IN' ? 'In' : 'Out';
}

function waitedFor(entry: QueuedPunch): string {
  const hours = queuedHours(entry);
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `waiting ${String(minutes)} min`;
  }
  return `waiting ${String(Math.round(hours))} h`;
}

function QueueRow({
  entry,
  detail,
  action,
}: {
  entry: QueuedPunch;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <Item size="sm" className="min-h-11 rounded-none">
      {entry.type === 'IN' ? (
        <SignInIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      ) : (
        <SignOutIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      )}
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="tabular-nums">
          {typeLabel(entry.type)} {formatClock(entry.clientTime)}
        </ItemTitle>
        <ItemDescription className="text-xs">{detail}</ItemDescription>
      </ItemContent>
      {action ? <ItemActions>{action}</ItemActions> : null}
    </Item>
  );
}

export function QueuePanel({
  waiting,
  refused,
  unreadable,
  legacy,
  locked,
  draining,
  lastResult,
  lastAttemptAt,
  online,
  onRetry,
  onDismiss,
}: {
  waiting: readonly QueuedPunch[];
  refused: readonly QueuedPunch[];
  unreadable: number;
  legacy: number;
  locked: number;
  draining: boolean;
  lastResult: DrainResult | null;
  lastAttemptAt: string | null;
  online: boolean;
  onRetry: () => void;
  onDismiss: (idempotencyKey: string) => void;
}) {
  if (
    waiting.length === 0 &&
    refused.length === 0 &&
    unreadable === 0 &&
    legacy === 0 &&
    locked === 0
  ) {
    return null;
  }

  // Prefer this session's own result; fall back to what the entries themselves
  // remember, which is what survives a reload.
  const attemptedAt = lastResult?.at ?? lastAttemptAt;

  return (
    <div className="flex flex-col gap-4">
      {waiting.length > 0 ? (
        <div className="border">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-3">
            {draining ? (
              <Spinner aria-hidden className="text-muted-foreground size-4 shrink-0" />
            ) : (
              <CloudArrowUpIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
            )}
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-sm font-medium">
                {waiting.length === 1
                  ? '1 punch waiting to sync'
                  : `${String(waiting.length)} punches waiting to sync`}
              </p>
              <p className="text-muted-foreground text-xs">
                {draining
                  ? 'Sending now.'
                  : online
                    ? 'Saved on this device. Not recorded until the server accepts them.'
                    : 'Saved on this device. They will be sent when the connection returns.'}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto shrink-0"
              disabled={draining || !online}
              onClick={onRetry}
            >
              <ArrowClockwiseIcon data-icon="inline-start" />
              {draining ? 'Sending' : 'Sync now'}
            </Button>
          </div>

          <ItemGroup role="presentation" className="gap-0">
            {waiting.map((entry, index) => (
              <Fragment key={entry.idempotencyKey}>
                {index > 0 ? <ItemSeparator className="my-0" /> : null}
                <QueueRow
                  entry={entry}
                  detail={[
                    waitedFor(entry),
                    entry.attempts > 0
                      ? `${String(entry.attempts)} ${entry.attempts === 1 ? 'try' : 'tries'}`
                      : null,
                    isNearingSyncDeadline(entry)
                      ? `get online within ${String(
                          Math.max(
                            1,
                            Math.round(OFFLINE_QUEUE_MAX_AGE_HOURS - queuedHours(entry)),
                          ),
                        )} h or it needs a regularization`
                      : null,
                  ]
                    .filter((part) => part !== null)
                    .join(' · ')}
                  action={
                    isNearingSyncDeadline(entry) ? (
                      <ClockCountdownIcon
                        aria-label="Close to the 48-hour sync limit"
                        className="text-destructive size-4"
                      />
                    ) : undefined
                  }
                />
              </Fragment>
            ))}
          </ItemGroup>

          {attemptedAt ? (
            <p className="text-muted-foreground border-t px-3 py-2 text-xs tabular-nums">
              Last tried {formatClock(attemptedAt)}
              {lastResult?.error ? ` — ${lastResult.error}` : ''}
              {lastResult && !lastResult.error && lastResult.accepted > 0
                ? ` — ${String(lastResult.accepted)} accepted`
                : ''}
            </p>
          ) : (
            <p className="text-muted-foreground border-t px-3 py-2 text-xs">
              Not tried yet on this device.
            </p>
          )}
        </div>
      ) : null}

      {/* REQ-D-10 and technical design §8: a punch the server refuses does not
          disappear. It is named, the server's own reason is quoted, and the
          instruction is the one the requirement gives — raise a
          regularization, because a punch is immutable and cannot be
          backdated into existence. */}
      {refused.length > 0 ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>
            {refused.length === 1
              ? 'The server refused 1 queued punch'
              : `The server refused ${String(refused.length)} queued punches`}
          </AlertTitle>
          <AlertDescription>
            <span>
              These were never recorded. Raise a regularization for each one; a punch cannot be
              backdated, so a regularization is the only way the day gets corrected.
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      {refused.length > 0 ? (
        <ItemGroup role="presentation" className="gap-0 border">
          {refused.map((entry, index) => (
            <Fragment key={entry.idempotencyKey}>
              {index > 0 ? <ItemSeparator className="my-0" /> : null}
              <QueueRow
                entry={entry}
                detail={entry.refusal?.message ?? 'Refused with no reason given.'}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onDismiss(entry.idempotencyKey);
                    }}
                  >
                    Dismiss
                  </Button>
                }
              />
            </Fragment>
          ))}
        </ItemGroup>
      ) : null}

      {legacy > 0 ? (
        <Alert variant="destructive">
          <WarningIcon />
          <AlertTitle>
            {legacy === 1
              ? '1 older queued punch needs manual recovery'
              : `${String(legacy)} older queued punches need manual recovery`}
          </AlertTitle>
          <AlertDescription>
            An older app version did not record which account made these punches, so they cannot
            be synced safely and their details are hidden from every account on this shared device.
            Nothing has been deleted. Check your attendance for a missing punch, then raise a
            regularization or ask HR to help identify the affected day.
          </AlertDescription>
        </Alert>
      ) : null}

      {locked > 0 ? (
        <Alert>
          <WarningIcon />
          <AlertTitle>
            {locked === 1
              ? '1 queued punch belongs to another account'
              : `${String(locked)} queued punches belong to another account`}
          </AlertTitle>
          <AlertDescription>
            They were recorded on this device by somebody else. They will be sent only when that
            person signs in here. Nothing has been deleted.
          </AlertDescription>
        </Alert>
      ) : null}
      {unreadable > 0 ? (
        <Alert variant="destructive">
          <WarningIcon />
          <AlertTitle>
            {unreadable === 1
              ? '1 queued punch cannot be read'
              : `${String(unreadable)} queued punches cannot be read`}
          </AlertTitle>
          <AlertDescription>
            They were written by a different version of this app and this one cannot make sense of
            them. Nothing has been deleted. Report it, and raise a regularization for any punch you
            made offline that has not appeared on your attendance.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
