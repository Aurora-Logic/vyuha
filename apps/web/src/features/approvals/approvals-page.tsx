import { createElement, useMemo, useState } from 'react';
import { CheckIcon, ProhibitIcon, TrayIcon, UserGearIcon, WarningCircleIcon } from '@phosphor-icons/react';
import type { HalfDayPart, PunchFlagReviewAction } from '@vyuha/shared';
import { Link, useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { PersonChip } from '@/components/shared/person';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { APPROVAL_TYPE_ICONS } from '@/components/shared/entity-icons';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { apiErrorCopy, actionErrorCopy } from '@/features/leave/api-error-copy';
import { CheckboxRow } from '@/features/leave/control-row';
import { SampleDataNotice } from '@/features/leave/sample-data-notice';
import { ApiError } from '@/lib/api/client';
import { formatDate } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { useSessionStore } from '@/lib/session/session-store';
import {
  APPROVAL_STATUSES,
  APPROVAL_TYPES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PERMISSIONS,
  type ApprovalStatus,
  type ApprovalType,
} from '@vyuha/shared';

import { DecisionDialog } from './decision-dialog';
import { RecordAttendanceDialog } from '@/features/attendance/record-attendance-dialog';

import { FLAG_REVIEW_COPY } from './flag-review-copy';
import { FlagReviewDialog } from './flag-review-dialog';
import { APPROVE_CLASSES, REJECT_CLASSES } from './decision-styles';
import {
  APPROVAL_STATUS_LABELS,
  APPROVAL_STATUS_VARIANT,
  APPROVAL_TYPE_LABELS,
  type ApprovalRequest,
} from './types';
import { useApprovals, useBulkDecision, useDecideApproval, useFlagReview } from './use-approvals';

/**
 * REQ-I-01…I-05 / PRD §5 screen 6: one inbox for every request type.
 *
 * The inbox is deliberately generic. It shows what every approval has —
 * requester, type, what is being asked, when it arrived, which step it is on —
 * and nothing that belongs to one type. The moment this screen starts
 * branching on `type` to render a leave row differently from a regularization
 * row, REQ-I-01's "do not build four separate ones" has quietly happened
 * inside one file.
 *
 * Bulk actions apply to one type at a time (REQ-I-03). A mixed selection does
 * not silently act on part of itself; the buttons disable and say why.
 */

const ALL = 'ALL';

function isApprovalType(value: string | null): value is ApprovalType {
  return value !== null && (APPROVAL_TYPES as readonly string[]).includes(value);
}

function isApprovalStatus(value: string | null): value is ApprovalStatus {
  return value !== null && (APPROVAL_STATUSES as readonly string[]).includes(value);
}

function readPositiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** Only a pending or escalated request can still be decided (REQ-I-02). */
function isOpen(request: ApprovalRequest): boolean {
  return request.status === 'PENDING' || request.status === 'ESCALATED';
}

function InboxSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading approvals" className="border">
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0"
        >
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className="h-3 w-24 shrink-0" />
          <Skeleton className="h-3 w-40 shrink-0" />
          <Skeleton className="hidden h-3 w-20 shrink-0 sm:block" />
          <Skeleton className="ml-auto h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

interface PendingDecision {
  action: 'APPROVE' | 'REJECT';
  /** One id for a row action, several for a bulk action. */
  ids: string[];
  subject: string;
}

export function ApprovalsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Both hooks run unconditionally; `||` between two calls would short-circuit
  // the second one and change the hook order on the render after a permission
  // set arrives.
  const canApproveTeam = usePermission(PERMISSIONS.LEAVE_APPROVE_TEAM);
  const canApproveAll = usePermission(PERMISSIONS.LEAVE_APPROVE_ALL);
  const canApprove = canApproveTeam || canApproveAll;
  // Owner, 21 Aug 2026: a flagged punch is acted on by whoever may edit
  // attendance, with four verbs instead of approve / reject.
  const canReviewFlags = usePermission(PERMISSIONS.ATTENDANCE_EDIT);

  const page = readPositiveInt(searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = readPositiveInt(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const typeParam = searchParams.get('type');
  const statusParam = searchParams.get('status');
  const type = isApprovalType(typeParam) ? typeParam : null;
  const status = isApprovalStatus(statusParam) ? statusParam : null;

  const rawView = searchParams.get('view');
  const view =
    rawView === 'inbox' || rawView === 'all' || rawView === 'raised'
      ? rawView
      : canApproveAll
        ? 'all'
        : canApprove
          ? 'inbox'
          : 'raised';

  // The permission set arrives from `/me` through an effect, so the first
  // render after the session gate opens still has an empty set -- and firing
  // then would send `view=raised` for an approver and immediately refetch.
  // Measured in Chrome: two requests, the first of them wrong. Waiting for the
  // store to leave `loading` costs one skeleton frame and sends one request.
  const permissionsKnown = useSessionStore((s) => s.status) !== 'loading';

  const query = useApprovals(
    { page, pageSize, view, type, status },
    { enabled: permissionsKnown },
  );
  // Memoised because the selection below derives from it: a fresh `[]` on
  // every render would rebuild the selection on every keystroke elsewhere.
  const rows = useMemo(() => query.data?.data ?? [], [query.data]);
  const total = query.data?.meta.total ?? 0;
  const sample = query.data?.sample ?? false;

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [decision, setDecision] = useState<PendingDecision | null>(null);
  const [recording, setRecording] = useState(false);
  const [flagReview, setFlagReview] = useState<{ action: PunchFlagReviewAction; punchId: string; subject: string } | null>(null);
  const reviewFlag = useFlagReview();

  const decide = useDecideApproval();
  const bulk = useBulkDecision();
  const pending = decide.isPending || bulk.isPending;

  // Selection is intersected with what is on screen rather than remembered
  // across pages. Acting on a row the reader cannot see is the failure mode
  // bulk actions are notorious for, and pruning here means paging or
  // filtering cannot leave one behind.
  const selectable = useMemo(() => rows.filter(isOpen), [rows]);
  const selected = useMemo(
    () => selectable.filter((row) => selectedIds.has(row.id)),
    [selectable, selectedIds],
  );

  const selectedTypes = new Set(selected.map((row) => row.type));
  const mixedTypes = selectedTypes.size > 1;
  const allSelected = selectable.length > 0 && selected.length === selectable.length;

  function setView(nextView: string) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set('view', nextView);
      params.delete('page');
      return params;
    });
    setSelectedIds(new Set());
  }

  function setParam(key: 'type' | 'status', next: string | null) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === null || next === ALL) params.delete(key);
      else params.set(key, next);
      params.delete('page');
      return params;
    });
    setSelectedIds(new Set());
  }

  function clearFilters() {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.delete('type');
      params.delete('status');
      params.delete('page');
      return params;
    });
    setSelectedIds(new Set());
  }

  function toggleRow(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(selectable.map((row) => row.id)) : new Set());
  }

  function runDecision(reason: string) {
    if (!decision) return;
    const { action, ids } = decision;
    const verb = action === 'APPROVE' ? 'Approve' : 'Reject';
    const done = action === 'APPROVE' ? 'approved' : 'rejected';

    const handlers = {
      onSuccess: () => {
        // PRD §6.6: the toast repeats the action the button named.
        toast.add({
          type: 'success',
          title:
            ids.length === 1
              ? `Request ${done}`
              : `${String(ids.length)} requests ${done}`,
        });
        setDecision(null);
        setSelectedIds(new Set());
      },
      onError: (error: Error) => {
        const copy = actionErrorCopy(error, `${verb} request`);
        toast.add({ type: 'error', title: copy.title, description: copy.description });
      },
    };

    if (ids.length === 1) {
      const [id] = ids;
      if (id === undefined) return;
      decide.mutate(
        action === 'REJECT' ? { id, action, reason } : { id, action, ...(reason ? { reason } : {}) },
        handlers,
      );
      return;
    }

    bulk.mutate({ ids, action, ...(reason ? { reason } : {}) }, handlers);
  }

  const columns: RecordColumn<ApprovalRequest>[] = [
    {
      key: 'select',
      header: 'Select',
      cell: (row) =>
        isOpen(row) ? (
          <CheckboxRow
            id={`approval-${row.id}`}
            label={<span className="sr-only">Select {row.subject}</span>}
            checked={selectedIds.has(row.id)}
            disabled={!canApprove}
            onCheckedChange={(checked) => {
              toggleRow(row.id, checked);
            }}
          />
        ) : null,
      className: 'w-10',
    },
    {
      key: 'requester',
      header: 'Requester',
      cell: (row) => <PersonChip name={row.requester.name} className="font-medium" />,
    },
    {
      key: 'type',
      header: 'Type',
      cell: (row) => (
        <Badge variant="outline">
          <TypeGlyph type={row.type} />
          {APPROVAL_TYPE_LABELS[row.type]}
        </Badge>
      ),
    },
    {
      key: 'subject',
      header: 'Asking for',
      // 15 REQ-AN-12: a price list is decided with its diff in view, one tap away.
      cell: (row) =>
        row.subjectType === 'price_list' ? (
          <Link to={`/masters/price-lists/${row.subjectId}`} className="line-clamp-2 underline-offset-4 hover:underline">
            {row.subject}
          </Link>
        ) : (
          <span className="line-clamp-2">{row.subject}</span>
        ),
    },
    {
      key: 'submitted',
      header: 'Submitted',
      cell: (row) => formatDate(row.submittedAt.slice(0, 10)),
      className: 'tabular-nums',
    },
    {
      key: 'step',
      header: 'Step',
      cell: (row) => row.currentStep,
      numeric: true,
      secondary: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Badge variant={APPROVAL_STATUS_VARIANT[row.status]}>
          {APPROVAL_STATUS_LABELS[row.status]}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: 'Decide',
      cell: (row) =>
        row.subjectType === 'punch' ? (
          isOpen(row) && canReviewFlags ? (
            <div className="flex flex-wrap justify-end gap-1">
              {(['ACCEPT', 'KEEP', 'HALF_DAY', 'NOTE'] as const).map((action) => {
                const copy = FLAG_REVIEW_COPY[action];
                const Icon = copy.icon;
                return (
                  <Button
                    key={action}
                    variant="ghost"
                    size="sm"
                    aria-label={`${copy.verb}: ${row.subject}`}
                    disabled={pending || reviewFlag.isPending}
                    className={action === 'ACCEPT' ? APPROVE_CLASSES : action === 'KEEP' ? REJECT_CLASSES : undefined}
                    onClick={() => {
                      setFlagReview({ action, punchId: row.subjectId, subject: row.subject });
                    }}
                  >
                    <Icon data-icon="inline-start" />
                    {copy.verb}
                  </Button>
                );
              })}
            </div>
          ) : null
        ) : isOpen(row) && canApprove ? (
          <div className="flex justify-end gap-1">
            {/* The two decisions carry their outcome in the text. They sit
                side by side and read identically otherwise, which is the one
                place in this product where a misread is expensive.

                The colours come from the same family map the attendance
                statuses use, so light mode gets the mixed value rather than
                the raw token — measured at 3.73 against this background, the
                raw success green fails AA for text this size and the mix
                passes. `hover:` has to be restated because the ghost variant
                resets to foreground on hover, which would drop the colour at
                the moment the pointer is on it. */}
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Approve ${row.subject}`}
              disabled={pending}
              className={APPROVE_CLASSES}
              onClick={() => {
                setDecision({ action: 'APPROVE', ids: [row.id], subject: row.subject });
              }}
            >
              <CheckIcon data-icon="inline-start" />
              Approve
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Reject ${row.subject}`}
              disabled={pending}
              className={REJECT_CLASSES}
              onClick={() => {
                setDecision({ action: 'REJECT', ids: [row.id], subject: row.subject });
              }}
            >
              <ProhibitIcon data-icon="inline-start" />
              Reject
            </Button>
          </div>
        ) : null,
      className: 'text-right',
    },
  ];

  const filtered = type !== null || status !== null;
  const bulkSubject =
    selected.length > 0
      ? `${String(selected.length)} ${APPROVAL_TYPE_LABELS[selected[0]?.type ?? 'LEAVE'].toLowerCase()} request${selected.length === 1 ? '' : 's'}`
      : '';

  return (
    <>
      {sample ? <SampleDataNotice endpoint="/api/v1/approvals" /> : null}

      <PageHeader
        description={
          canApprove
            ? 'Everything waiting on you, of every kind. Filter by type to act on a set at once.'
            : 'Everything you have put up for approval, of every kind, and where each one has got to.'
        }
        action={
          canReviewFlags ? (
            <Button
              onClick={() => {
                setRecording(true);
              }}
            >
              <UserGearIcon data-icon="inline-start" />
              Record attendance
            </Button>
          ) : undefined
        }
      />
      {canReviewFlags ? <RecordAttendanceDialog open={recording} onOpenChange={setRecording} /> : null}

      <div className="flex flex-col gap-4">
        {canApprove ? (
          <Tabs
            value={view}
            onValueChange={(val: string) => {
              if (typeof val === 'string' && val.length > 0) {
                setView(val);
              }
            }}
          >
            <TabsList>
              <TabsTrigger value="inbox">Waiting on me</TabsTrigger>
              {canApproveAll || canApproveTeam ? (
                <TabsTrigger value="all">All approvals</TabsTrigger>
              ) : null}
              <TabsTrigger value="raised">Raised by me</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}

        {/* One list, of every kind (REQ-I-01). The two bands that used to sit
            above this are gone: leave, corrections and on-duty declarations all
            raise a real approval request now, so they arrive here with
            everything else and there is one place an approver looks. Showing a
            band as well would put the same request on the screen twice, with
            two buttons that reach the same decision. */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={type ?? ALL}
            onValueChange={(next: string | null) => {
              setParam('type', next);
            }}
          >
            <SelectTrigger aria-label="Filter by request type" className="w-full sm:w-48">
              <SelectValue>
                {(value: string) => (isApprovalType(value) ? APPROVAL_TYPE_LABELS[value] : 'All types')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All types</SelectItem>
                {APPROVAL_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    <TypeGlyph type={value} />
                    {APPROVAL_TYPE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select
            value={status ?? ALL}
            onValueChange={(next: string | null) => {
              setParam('status', next);
            }}
          >
            <SelectTrigger aria-label="Filter by status" className="w-full sm:w-44">
              <SelectValue>
                {(value: string) =>
                  isApprovalStatus(value) ? APPROVAL_STATUS_LABELS[value] : 'All statuses'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {APPROVAL_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {APPROVAL_STATUS_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          {filtered ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <ACTION_ICONS.clearFilters data-icon="inline-start" />
              Clear filters
            </Button>
          ) : null}
        </div>

        {/* The bulk bar. Above the table rather than floating over it: at
            360px a floating bar covers the rows being chosen. */}
        {selectable.length > 0 && canApprove ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border px-3 py-2">
            <CheckboxRow
              id="approvals-select-all"
              label={`Select all ${String(selectable.length)} on this page`}
              checked={allSelected}
              onCheckedChange={toggleAll}
            />

            {selected.length > 0 ? (
              <>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {selected.length} selected
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={mixedTypes || pending}
                    onClick={() => {
                      setDecision({
                        action: 'APPROVE',
                        ids: selected.map((row) => row.id),
                        subject: bulkSubject,
                      });
                    }}
                  >
                    <CheckIcon data-icon="inline-start" />
                    Approve selected
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={mixedTypes || pending}
                    onClick={() => {
                      setDecision({
                        action: 'REJECT',
                        ids: selected.map((row) => row.id),
                        subject: bulkSubject,
                      });
                    }}
                  >
                    <ProhibitIcon data-icon="inline-start" />
                    Reject selected
                  </Button>
                </div>
                {mixedTypes ? (
                  <p className="text-muted-foreground w-full text-xs">
                    Bulk actions apply to one request type at a time. Filter by type, or narrow the
                    selection.
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {query.isPending ? <InboxSkeleton /> : null}

        {query.isError ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>
              {apiErrorCopy(query.error, { subject: 'approvals', permission: 'leave.approve.team' })
                .title}
            </AlertTitle>
            <AlertDescription>
              {
                apiErrorCopy(query.error, {
                  subject: 'approvals',
                  permission: 'leave.approve.team',
                }).description
              }
              {query.error instanceof ApiError && query.error.requestId ? (
                <span className="mt-1 block font-mono text-[0.6875rem]">
                  Request {query.error.requestId}
                </span>
              ) : null}
            </AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void query.refetch();
                }}
              >
                Try again
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TrayIcon />
              </EmptyMedia>
              <EmptyTitle>
                {filtered
                  ? 'Nothing matches these filters'
                  : canApprove
                    ? 'Nothing waiting on you'
                    : 'You have not raised anything'}
              </EmptyTitle>
              <EmptyDescription>
                {filtered
                  ? 'Widen the filters to see the rest of the list.'
                  : canApprove
                    ? 'Leave, regularizations, on-duty requests, flagged punches and device rebinds all arrive here.'
                    : 'Leave, regularizations and on-duty requests you raise will appear here with their progress.'}
              </EmptyDescription>
            </EmptyHeader>
            {filtered ? (
              <EmptyContent>
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  <ACTION_ICONS.clearFilters data-icon="inline-start" />
                  Clear filters
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <>
            <RecordTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              mobilePrimary={(row) => row.requester.name}
              mobileSupporting={(row) =>
                `${APPROVAL_TYPE_LABELS[row.type]} · ${row.subject}`
              }
              mobileStatus={(row) => (
                <>
                  <Badge variant={APPROVAL_STATUS_VARIANT[row.status]}>
                    {APPROVAL_STATUS_LABELS[row.status]}
                  </Badge>
                  {isOpen(row) && canApprove ? (
                    <CheckboxRow
                      id={`approval-m-${row.id}`}
                      label={<span className="sr-only">Select {row.subject}</span>}
                      checked={selectedIds.has(row.id)}
                      onCheckedChange={(checked) => {
                        toggleRow(row.id, checked);
                      }}
                    />
                  ) : null}
                </>
              )}
            />
            <RecordPagination page={page} pageSize={pageSize} total={total} />
          </>
        ) : null}

        {!canApprove ? (
          <p className="text-muted-foreground text-xs">
            You can see this inbox but not act on it. Deciding needs the leave.approve.team
            permission.
          </p>
        ) : null}
      </div>

      <FlagReviewDialog

        open={flagReview !== null}

        onOpenChange={(open) => {

          if (!open) setFlagReview(null);

        }}

        action={flagReview?.action ?? 'ACCEPT'}

        subject={flagReview?.subject ?? ''}

        pending={reviewFlag.isPending}

        onConfirm={(input: { note?: string; halfDayPart?: HalfDayPart }) => {

          if (!flagReview) return;

          const verb = FLAG_REVIEW_COPY[flagReview.action].verb;

          reviewFlag.mutate(

            { punchId: flagReview.punchId, input: { action: flagReview.action, ...input } },

            {

              onSuccess: () => {

                toast.add({ type: 'success', title: flagReview.action === 'NOTE' ? 'Note added' : `Punch ${verb.toLowerCase()}` });

                setFlagReview(null);

              },

              onError: (error: Error) => {

                const copy = actionErrorCopy(error, verb);

                toast.add({ type: 'error', title: copy.title, description: copy.description });

              },

            },

          );

        }}

      />

      <DecisionDialog
        open={decision !== null}
        onOpenChange={(next) => {
          if (!next) setDecision(null);
        }}
        action={decision?.action ?? 'APPROVE'}
        count={decision?.ids.length ?? 0}
        subject={decision?.subject ?? ''}
        pending={pending}
        onConfirm={runDecision}
      />
    </>
  );
}

/** Owner, 22 Aug 2026: a request type wears one glyph in the inbox, its filter and the bell. */
function TypeGlyph({ type }: { type: ApprovalType }) {
  return createElement(APPROVAL_TYPE_ICONS[type], { 'aria-hidden': true });
}
