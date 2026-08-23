import { useState } from 'react';
import { BellRingingIcon, HandshakeIcon, LockKeyIcon, UsersThreeIcon, WarningDiamondIcon } from '@phosphor-icons/react';
import { Link, useSearchParams } from 'react-router';

import { StatusBadge } from '@/components/shared/status-badge';
import { KpiGrid, type KpiTileProps } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatDate, formatMoney, formatRelativeAge } from '@/lib/format';
import { periodForGranularity } from '@/lib/period-compare';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, PROMISE_STATES, PROMISE_STATE_LABELS, type CollectorDashboardRow, type PromiseState, type PromiseView } from '@vyuha/shared';

import { PromiseDialog } from './promise-dialog';
import { useCollectorDashboard, usePromises, useSendReminder } from './use-collections';

/**
 * REQ-AJ-07: the collector's morning. Who owes what, how much of it is
 * past its date, which promises are open and which came due with nothing,
 * and what has been collected against the target. Every row is a customer
 * to call, with the two things a collector does from here: record what
 * they said, and send them their account.
 *
 * REQ-AJ-13: where a party sits in an open duplicate cluster, the row
 * shows the cluster's combined outstanding beside its own, so one company
 * is not chased twice for halves of the same balance.
 */

const ANY = 'any';

export function CollectionsPage() {
  const canViewSelf = usePermission(PERMISSIONS.COLLECTIONS_VIEW_SELF);
  const canViewAll = usePermission(PERMISSIONS.COLLECTIONS_VIEW_ALL);
  const canView = canViewSelf || canViewAll;
  const canManage = usePermission(PERMISSIONS.COLLECTIONS_MANAGE);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'promises' ? 'promises' : 'parties';
  const today = toDateParam(new Date());
  const fallback = periodForGranularity('month', today);
  const from = searchParams.get('from') ?? fallback.from;
  const to = searchParams.get('to') ?? fallback.to;
  const [promising, setPromising] = useState<{ id: string; name: string } | null>(null);
  const board = useCollectorDashboard({ from, to }, { enabled: canView });

  function setParams(next: Record<string, string | null>): void {
    setSearchParams(
      (current) => {
        const out = new URLSearchParams(current);
        for (const [key, value] of Object.entries(next)) {
          if (value === null) out.delete(key);
          else out.set(key, value);
        }
        return out;
      },
      { replace: true },
    );
  }

  if (!canView) {
    return (
      <>
        <PageHeader description="What each customer owes, what they promised, and what arrived." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view collections</EmptyTitle>
            <EmptyDescription>This needs collections.view.self or collections.view.all — the Accounts and Sales manager roles carry them.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="The parties assigned to you, what is owed and how much of it is late, the promises taken against them, and what has actually arrived. A promise is never marked kept here: the receipts Tally sends decide it."
        action={
          canManage ? (
            <Button
              size="sm"
              onClick={() => {
                setPromising({ id: '', name: '' });
              }}
            >
              <HandshakeIcon data-icon="inline-start" />
              Record a promise
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <Tabs
          value={tab}
          onValueChange={(next) => {
            setParams({ tab: next === 'promises' ? 'promises' : null });
          }}
        >
          <TabsList>
            <TabsTrigger value="parties">Parties</TabsTrigger>
            <TabsTrigger value="promises">Promises</TabsTrigger>
          </TabsList>
        </Tabs>
        <DateRangeField
          label="Period"
          value={{ from: fromDateParam(from), to: fromDateParam(to) }}
          onValueChange={(next) => {
            if (next.from === undefined || next.to === undefined) return;
            setParams({ from: toDateParam(next.from), to: toDateParam(next.to) });
          }}
          className="w-full sm:w-auto"
        />
      </div>

      {board.isError ? (
        <QueryErrorAlert
          error={board.error}
          subject="the collections board"
          onRetry={() => {
            void board.refetch();
          }}
        />
      ) : null}

      {tab === 'promises' ? (
        <PromisesTab from={from} to={to} canView={canView} />
      ) : board.data === undefined ? (
        <div role="status" aria-busy="true" aria-label="Loading the board" className="flex flex-col gap-6">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <Board rows={board.data.rows} tiles={tiles(board.data)} canManage={canManage} onPromise={setPromising} />
      )}

      <PromiseDialog
        open={promising !== null}
        onOpenChange={(next) => {
          if (!next) setPromising(null);
        }}
        partyId={promising === null || promising.id === '' ? null : promising.id}
        {...(promising !== null && promising.name !== '' ? { partyName: promising.name } : {})}
      />
    </>
  );
}

function tiles(board: NonNullable<ReturnType<typeof useCollectorDashboard>['data']>): KpiTileProps[] {
  const target = board.target === null ? null : Number(board.target);
  const collected = Number(board.collectedThisPeriod);
  return [
    { label: 'Parties assigned', value: String(board.assignedParties), note: board.collector === null ? 'across every collector' : board.collector.name },
    { label: 'Outstanding', value: formatMoney(board.totalOutstanding), note: 'open bills, now' },
    { label: 'Overdue', value: formatMoney(board.overdue), note: 'past the bill’s own date' },
    { label: 'Collected', value: formatMoney(board.collectedThisPeriod), note: target === null ? 'in the period' : `${String(Math.round((collected / Math.max(target, 1)) * 100))}% of ${formatMoney(board.target ?? '0')}` },
    { label: 'Promises open', value: String(board.promisesOpen), note: 'not yet due' },
    { label: 'Due today', value: String(board.promisesDueToday), note: 'call before the day ends' },
    { label: 'Broken', value: String(board.promisesBroken), note: 'came due with nothing' },
    { label: 'Target', value: board.target === null ? EMPTY_VALUE : formatMoney(board.target), note: 'for the period' },
  ];
}

function Board({ rows, tiles: kpis, canManage, onPromise }: { rows: readonly CollectorDashboardRow[]; tiles: KpiTileProps[]; canManage: boolean; onPromise: (party: { id: string; name: string }) => void }) {
  const remind = useSendReminder();
  const [sending, setSending] = useState<string | null>(null);

  const columns: RecordColumn<CollectorDashboardRow>[] = [
    {
      key: 'party',
      header: 'Customer',
      cell: (row) => (
        <Link to={`/masters/parties/${row.partyId}`} className="font-medium underline-offset-4 hover:underline">
          {row.partyName}
        </Link>
      ),
    },
    { key: 'outstanding', header: 'Outstanding', cell: (row) => formatMoney(row.outstanding), numeric: true },
    {
      key: 'overdue',
      header: 'Overdue',
      cell: (row) => (Number(row.overdue) > 0 ? <span className="text-destructive">{formatMoney(row.overdue)}</span> : EMPTY_VALUE),
      numeric: true,
    },
    {
      key: 'cluster',
      header: 'With its duplicate',
      // REQ-AJ-13: the same company under two names owes one balance, not two halves.
      cell: (row) =>
        row.clusterOutstanding === null || Number(row.clusterOutstanding) === Number(row.outstanding) ? (
          EMPTY_VALUE
        ) : (
          <span className="flex items-center justify-end gap-1">
            <WarningDiamondIcon className="text-destructive" weight="fill" />
            {formatMoney(row.clusterOutstanding)}
          </span>
        ),
      numeric: true,
      secondary: true,
    },
    {
      key: 'promises',
      header: 'Promises',
      cell: (row) => (
        <span className="flex items-center justify-end gap-1">
          {row.openPromises > 0 ? <Badge variant="secondary">{row.openPromises} open</Badge> : null}
          {row.brokenPromises > 0 ? <Badge variant="destructive">{row.brokenPromises} broken</Badge> : null}
          {row.openPromises === 0 && row.brokenPromises === 0 ? EMPTY_VALUE : null}
        </span>
      ),
      numeric: true,
    },
    { key: 'next', header: 'Next promised', cell: (row) => (row.nextPromiseDate === null ? EMPTY_VALUE : formatDate(row.nextPromiseDate)), className: 'tabular-nums', secondary: true },
    { key: 'reminder', header: 'Last reminded', cell: (row) => (row.lastReminderAt === null ? 'never' : formatRelativeAge(row.lastReminderAt)), secondary: true },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: 'Do',
            cell: (row: CollectorDashboardRow) => (
              <span className="flex flex-wrap justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Record a promise from ${row.partyName}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPromise({ id: row.partyId, name: row.partyName });
                  }}
                >
                  <HandshakeIcon data-icon="inline-start" />
                  Promise
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Send ${row.partyName} their account`}
                  disabled={remind.isPending && sending === row.partyId}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSending(row.partyId);
                    remind.mutate(
                      { partyId: row.partyId, channels: ['email'] },
                      {
                        onSuccess: (notices) => {
                          const email = notices.find((n) => n.channel === 'email');
                          toast.add({
                            type: email?.status === 'sent' ? 'success' : 'error',
                            title: email?.status === 'sent' ? `Statement sent to ${row.partyName}` : `Could not send to ${row.partyName}`,
                            description: email?.status === 'sent' ? `${formatMoney(email.outstandingAtSend)} as of ${formatDate(email.statementAsOf)}.` : (email?.error ?? 'The party master carries no email address.'),
                          });
                        },
                        onError: (error) => {
                          toast.add({ type: 'error', title: 'Reminder failed', description: error.message });
                        },
                      },
                    );
                  }}
                >
                  {remind.isPending && sending === row.partyId ? <Spinner data-icon="inline-start" /> : <BellRingingIcon data-icon="inline-start" />}
                  Remind
                </Button>
              </span>
            ),
            numeric: true,
          },
        ]
      : []),
  ];

  return (
    <>
      <KpiGrid tiles={kpis} />
      <section className="flex flex-col gap-3">
        <SectionHeading title="Who to call" note="Most overdue first, then the largest balance." />
        {rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersThreeIcon />
              </EmptyMedia>
              <EmptyTitle>No party is assigned to a collector yet</EmptyTitle>
              <EmptyDescription>Assign one from the party’s own page, and it appears here with what it owes.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <RecordTable
            columns={columns}
            rows={[...rows]}
            rowKey={(row) => row.partyId}
            mobilePrimary={(row) => row.partyName}
            mobileStatus={(row) => (row.brokenPromises > 0 ? <Badge variant="destructive">{row.brokenPromises} broken</Badge> : Number(row.overdue) > 0 ? <Badge variant="outline">Overdue</Badge> : null)}
            mobileSupporting={(row) => `${formatMoney(row.outstanding)} open · ${Number(row.overdue) > 0 ? `${formatMoney(row.overdue)} overdue` : 'nothing overdue'}${row.nextPromiseDate === null ? '' : ` · promised ${formatDate(row.nextPromiseDate)}`}`}
          />
        )}
      </section>
    </>
  );
}

function PromisesTab({ from, to, canView }: { from: string; to: string; canView: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const stateParam = searchParams.get('state');
  const state = PROMISE_STATES.find((s) => s === stateParam);
  const query = usePromises({ page: 1, pageSize: 100, from, to, ...(state ? { state } : {}) }, { enabled: canView });
  const rows = query.data?.data ?? [];

  const columns: RecordColumn<PromiseView>[] = [
    {
      key: 'party',
      header: 'Customer',
      cell: (row) => (
        <Link to={`/masters/parties/${row.partyId}`} className="font-medium underline-offset-4 hover:underline">
          {row.partyName}
        </Link>
      ),
    },
    { key: 'amount', header: 'Promised', cell: (row) => formatMoney(row.amount), numeric: true },
    { key: 'received', header: 'Received', cell: (row) => formatMoney(row.receivedAmount), numeric: true },
    { key: 'date', header: 'By', cell: (row) => formatDate(row.promisedDate), className: 'tabular-nums' },
    { key: 'state', header: 'State', cell: (row) => <StatusBadge state={row.state} label={PROMISE_STATE_LABELS[row.state]} /> },
    { key: 'bills', header: 'Against', cell: (row) => (row.bills.length === 0 ? 'any receipt' : row.bills.join(', ')), secondary: true },
    { key: 'takenBy', header: 'Taken by', cell: (row) => row.takenByName ?? EMPTY_VALUE, secondary: true },
    { key: 'collector', header: 'Collector', cell: (row) => row.collectorName ?? 'Unassigned', secondary: true },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={state ?? ANY}
          onValueChange={(next) => {
            setSearchParams(
              (current) => {
                const out = new URLSearchParams(current);
                if (next === null || next === ANY) out.delete('state');
                else out.set('state', next);
                return out;
              },
              { replace: true },
            );
          }}
        >
          <SelectTrigger aria-label="Filter by state" className="w-full sm:w-48">
            <SelectValue>{(current: string) => (current === ANY ? 'Every state' : PROMISE_STATE_LABELS[current as PromiseState])}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>Every state</SelectItem>
              {PROMISE_STATES.map((s) => (
                <SelectItem key={s} value={s}>
                  {PROMISE_STATE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {query.isPending ? <Skeleton className="h-40 w-full" /> : null}
      {query.isError ? (
        <QueryErrorAlert
          error={query.error}
          subject="the promises"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}
      {query.isSuccess && rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HandshakeIcon />
            </EmptyMedia>
            <EmptyTitle>No promise in this period</EmptyTitle>
            <EmptyDescription>Record one when a customer gives a date; its state follows the receipts on its own.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {rows.length > 0 ? (
        <RecordTable
          columns={columns}
          rows={[...rows]}
          rowKey={(row) => row.id}
          mobilePrimary={(row) => row.partyName}
          mobileStatus={(row) => <StatusBadge state={row.state} label={PROMISE_STATE_LABELS[row.state]} />}
          mobileSupporting={(row) => `${formatMoney(row.amount)} by ${formatDate(row.promisedDate)} · ${formatMoney(row.receivedAmount)} received`}
        />
      ) : null}
    </div>
  );
}
