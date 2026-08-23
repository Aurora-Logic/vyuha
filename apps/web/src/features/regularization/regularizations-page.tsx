import { useMemo } from 'react';
import { BriefcaseIcon, ClockCounterClockwiseIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { TabsToolbar } from '@/components/shared/tabs-toolbar';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiErrorCopy } from '@/features/leave/api-error-copy';
import { formatClock } from '@/features/attendance/format';
import { ApiError } from '@/lib/api/client';
import { EMPTY_VALUE, formatDate } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { useSessionStore } from '@/lib/session/session-store';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PERMISSIONS,
  REGULARIZATION_KIND_LABELS,
  type OnDutyRequest,
  type RegularizationKind,
  type RegularizationRequest,
} from '@vyuha/shared';

import { DraftCompletionCard } from './draft-completion-card';
import { OnDutyForm } from './on-duty-form';
import { RegularizationForm } from './regularization-form';
import { isUncompletedDraft, REQUEST_STATUS_LABELS, REQUEST_STATUS_VARIANT } from './types';
import {
  useOnDutyRequests,
  useRegularizationPolicy,
  useRegularizations,
} from './use-regularization';

/**
 * REQ-F-01 … REQ-F-05 / the employee's own surface.
 *
 * One tab set for the whole screen rather than two forms stacked, for two
 * reasons. On a phone, two long forms one after the other put the second below
 * three screens of scroll and the history below five. And PRD §6.4 gives
 * Ctrl+A to "accept" — with both forms mounted, one key would have two
 * meanings, and Base UI unmounts an inactive panel, so exactly one is
 * registered at a time.
 *
 * The decision surface is deliberately not here. An approver goes to
 * Approvals, where a correction now arrives as a real approval request beside
 * leave and everything else (REQ-I-01) — this screen is what a person opens
 * about their own days.
 */

function readPositiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function isKind(value: string | null): value is RegularizationKind {
  return value !== null && value in REGULARIZATION_KIND_LABELS;
}

/** `YYYY-MM-DD`, and nothing else — a query string is untrusted input. */
function readDateParam(value: string | null): string | undefined {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : undefined;
}

function HistorySkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading your requests" className="border">
      {/* min-h-14 below md, where RecordTable renders two-line cards rather
          than 36px table rows -- a skeleton at table height would grow 20px
          per row when the list arrived. */}
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex min-h-14 items-center gap-4 border-b px-3 py-2.5 last:border-b-0 md:min-h-9"
        >
          <Skeleton className="h-3 w-24 shrink-0" />
          <Skeleton className="h-3 w-32 shrink-0" />
          <Skeleton className="hidden h-3 w-20 shrink-0 sm:block" />
          <Skeleton className="ml-auto h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function LoadFailure({
  error,
  subject,
  onRetry,
}: {
  error: unknown;
  subject: string;
  onRetry: () => void;
}) {
  const copy = apiErrorCopy(error, { subject, permission: 'punch.self' });
  return (
    <Alert variant="destructive">
      <WarningCircleIcon />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        {copy.description}
        {error instanceof ApiError && error.requestId ? (
          <span className="mt-1 block font-mono text-[0.6875rem]">Request {error.requestId}</span>
        ) : null}
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <ACTION_ICONS.retry data-icon="inline-start" />
          Try again
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** The outcome an employee actually wants to read: the approver's words. */
function DecisionCell({
  status,
  decisionReason,
}: {
  status: RegularizationRequest['status'];
  decisionReason: string | null;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <Badge variant={REQUEST_STATUS_VARIANT[status]}>{REQUEST_STATUS_LABELS[status]}</Badge>
      {decisionReason ? (
        <span className="text-muted-foreground line-clamp-2 text-right text-[0.6875rem]">
          {decisionReason}
        </span>
      ) : null}
    </div>
  );
}

const REGULARIZATION_COLUMNS: RecordColumn<RegularizationRequest>[] = [
  {
    key: 'date',
    header: 'Day',
    cell: (row) => <span className="font-medium tabular-nums">{formatDate(row.date)}</span>,
  },
  {
    key: 'kind',
    header: 'What went wrong',
    cell: (row) => REGULARIZATION_KIND_LABELS[row.kind],
  },
  {
    key: 'in',
    header: 'In',
    cell: (row) => formatClock(row.requestedIn),
    numeric: true,
  },
  {
    key: 'out',
    header: 'Out',
    cell: (row) => formatClock(row.requestedOut),
    numeric: true,
  },
  {
    key: 'reason',
    header: 'Reason',
    cell: (row) => <span className="line-clamp-1">{row.reason}</span>,
    secondary: true,
  },
  {
    key: 'decidedBy',
    header: 'Decided by',
    cell: (row) => row.decidedBy?.name ?? EMPTY_VALUE,
    secondary: true,
  },
  {
    key: 'status',
    header: 'Outcome',
    cell: (row) => <DecisionCell status={row.status} decisionReason={row.decisionReason} />,
    className: 'text-right',
  },
];

const ON_DUTY_COLUMNS: RecordColumn<OnDutyRequest>[] = [
  {
    key: 'from',
    header: 'From',
    cell: (row) => <span className="font-medium tabular-nums">{formatDate(row.fromDate)}</span>,
  },
  { key: 'to', header: 'To', cell: (row) => formatDate(row.toDate), className: 'tabular-nums' },
  { key: 'site', header: 'Client or site', cell: (row) => row.siteName ?? EMPTY_VALUE },
  {
    key: 'reason',
    header: 'Reason',
    cell: (row) => <span className="line-clamp-1">{row.reason}</span>,
    secondary: true,
  },
  {
    key: 'decidedBy',
    header: 'Decided by',
    cell: (row) => row.decidedBy?.name ?? EMPTY_VALUE,
    secondary: true,
  },
  {
    key: 'status',
    header: 'Outcome',
    cell: (row) => <DecisionCell status={row.status} decisionReason={row.decisionReason} />,
    className: 'text-right',
  },
];

export function RegularizationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const canRaise = usePermission(PERMISSIONS.PUNCH_SELF);
  // The permission set arrives from `/me` through an effect, so the first
  // render after the session gate opens still has an empty set. Waiting for
  // the store to leave `loading` costs one skeleton frame and sends one
  // request instead of two, the first of them wrong.
  const permissionsKnown = useSessionStore((s) => s.status) !== 'loading';

  const page = readPositiveInt(searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = readPositiveInt(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const params = useMemo(
    () => ({ page, pageSize, status: null }),
    [page, pageSize],
  );

  // Set by the "Correct this day" control on My Attendance, so the form opens
  // already pointed at the day the person was looking at.
  const initialDate = readDateParam(searchParams.get('date'));
  const kindParam = searchParams.get('kind');
  const initialKind = isKind(kindParam) ? kindParam : undefined;
  // A `?date=` arriving from My Attendance means "correct a day", never "on
  // duty" -- opening the wrong panel would discard the prefill silently.
  const defaultTab = searchParams.get('tab') === 'on-duty' && initialDate === undefined
    ? 'on-duty'
    : 'corrections';

  const policyQuery = useRegularizationPolicy(permissionsKnown);
  const historyQuery = useRegularizations(params, permissionsKnown);
  const onDutyQuery = useOnDutyRequests(params, permissionsKnown);

  const allHistory = historyQuery.data?.data ?? [];
  // Drafts `attendance.regularization_auto_file` raised for this employee and
  // nobody has finished yet: the server only ever sends them to the employee
  // they are about, so every row here needs this person's input, not a
  // history table's read-only row.
  const drafts = allHistory.filter(isUncompletedDraft);
  const history = allHistory.filter((row) => !isUncompletedDraft(row));
  const onDuty = onDutyQuery.data?.data ?? [];

  function changeTab(next: string) {
    setSearchParams((current) => {
      const next_ = new URLSearchParams(current);
      if (next === 'corrections') next_.delete('tab');
      else next_.set('tab', next);
      // The two lists share one `?page=`. Leaving corrections on page 2 would
      // open a one-page on-duty list on page 2, which renders as no rows and
      // reads as an empty list.
      next_.delete('page');
      return next_;
    });
  }

  return (
    <>
      <PageHeader description="Correct a day that went wrong, or say you were working away from the premises. Both go to your approver." />

      <Tabs defaultValue={defaultTab} className="gap-4" onValueChange={changeTab}>
        <TabsToolbar
          list={
            <TabsList>
              <TabsTrigger value="corrections" className="px-3">
                <ClockCounterClockwiseIcon data-icon="inline-start" />
                Corrections
              </TabsTrigger>
              <TabsTrigger value="on-duty" className="px-3">
                <BriefcaseIcon data-icon="inline-start" />
                On duty
              </TabsTrigger>
            </TabsList>
          }
        >
          <TabsContent value="corrections" className="flex flex-col gap-6">
            {drafts.length > 0 ? (
              <section className="flex flex-col gap-4">
                <SectionHeading
                  title="Needs your input"
                  note="Raised automatically because a punch fell outside the shift window. Add why and send it on, or it will keep waiting here."
                />
                <div className="flex flex-col gap-3">
                  {drafts.map((draft) => (
                    <DraftCompletionCard key={draft.id} draft={draft} />
                  ))}
                </div>
                <Separator />
              </section>
            ) : null}

            <section className="flex flex-col gap-4">
              <SectionHeading
                title="Correct a day"
                note="A missing punch, or one recorded at the wrong time. The original punches are never changed — an approved correction sits beside them."
              />

              {policyQuery.isError ? (
                <LoadFailure
                  error={policyQuery.error}
                  subject="correction limits"
                  onRetry={() => {
                    void policyQuery.refetch();
                  }}
                />
              ) : (
                <RegularizationForm
                  // Re-keyed so arriving from a different day on My Attendance
                  // re-seeds the form. A `key` rather than an effect writing
                  // state: React's own answer for "reset when this prop
                  // changes", and it cannot fight an edit made after arriving.
                  key={`${initialDate ?? ''}:${initialKind ?? ''}`}
                  policy={policyQuery.data ?? null}
                  policyPending={policyQuery.isPending}
                  canRaise={canRaise}
                  initialDate={initialDate}
                  initialKind={initialKind}
                />
              )}
            </section>

            <Separator />

            <section className="flex flex-col gap-4">
              <SectionHeading
                title="Your corrections"
                note="Every correction you have raised, newest first, and what your approver said."
              />

              {historyQuery.isPending ? <HistorySkeleton /> : null}

              {historyQuery.isError ? (
                <LoadFailure
                  error={historyQuery.error}
                  subject="your corrections"
                  onRetry={() => {
                    void historyQuery.refetch();
                  }}
                />
              ) : null}

              {historyQuery.isSuccess && history.length === 0 ? (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ClockCounterClockwiseIcon />
                    </EmptyMedia>
                    <EmptyTitle>No corrections raised</EmptyTitle>
                    <EmptyDescription>
                      A day showing Pending or a missing punch on My attendance can be corrected
                      from here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}

              {history.length > 0 ? (
                <>
                  <RecordTable
                    columns={REGULARIZATION_COLUMNS}
                    rows={history}
                    rowKey={(row) => row.id}
                    mobilePrimary={(row) => formatDate(row.date)}
                    mobileStatus={(row) => (
                      <Badge variant={REQUEST_STATUS_VARIANT[row.status]}>
                        {REQUEST_STATUS_LABELS[row.status]}
                      </Badge>
                    )}
                    mobileSupporting={(row) =>
                      `${REGULARIZATION_KIND_LABELS[row.kind]} · ${row.decisionReason ?? row.reason}`
                    }
                  />
                  <RecordPagination
                    page={page}
                    pageSize={pageSize}
                    total={historyQuery.data?.meta.total ?? 0}
                  />
                </>
              ) : null}
            </section>
          </TabsContent>

          <TabsContent value="on-duty" className="flex flex-col gap-6">
            <section className="flex flex-col gap-4">
              <SectionHeading
                title="Working away from the premises"
                note="A date or a range. Once approved, those days count as present without a punch."
              />
              <OnDutyForm canRaise={canRaise} />
            </section>

            <Separator />

            <section className="flex flex-col gap-4">
              <SectionHeading
                title="Your on-duty requests"
                note="Every request you have raised, newest first."
              />

              {onDutyQuery.isPending ? <HistorySkeleton /> : null}

              {onDutyQuery.isError ? (
                <LoadFailure
                  error={onDutyQuery.error}
                  subject="your on-duty requests"
                  onRetry={() => {
                    void onDutyQuery.refetch();
                  }}
                />
              ) : null}

              {onDutyQuery.isSuccess && onDuty.length === 0 ? (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <BriefcaseIcon />
                    </EmptyMedia>
                    <EmptyTitle>No on-duty requests</EmptyTitle>
                    <EmptyDescription>
                      Raise one before a day at a client site, and it counts as present once
                      approved.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}

              {onDuty.length > 0 ? (
                <>
                  <RecordTable
                    columns={ON_DUTY_COLUMNS}
                    rows={onDuty}
                    rowKey={(row) => row.id}
                    mobilePrimary={(row) =>
                      row.fromDate === row.toDate
                        ? formatDate(row.fromDate)
                        : `${formatDate(row.fromDate)} – ${formatDate(row.toDate)}`
                    }
                    mobileStatus={(row) => (
                      <Badge variant={REQUEST_STATUS_VARIANT[row.status]}>
                        {REQUEST_STATUS_LABELS[row.status]}
                      </Badge>
                    )}
                    mobileSupporting={(row) => row.siteName ?? row.reason}
                  />
                  <RecordPagination
                    page={page}
                    pageSize={pageSize}
                    total={onDutyQuery.data?.meta.total ?? 0}
                  />
                </>
              ) : null}
            </section>
          </TabsContent>
        </TabsToolbar>
      </Tabs>
    </>
  );
}
