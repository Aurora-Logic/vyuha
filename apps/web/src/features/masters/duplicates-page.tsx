import { useState } from 'react';
import { ArrowCounterClockwiseIcon, CopyIcon, LockKeyIcon, MagnifyingGlassIcon, PaperPlaneTiltIcon, ProhibitIcon, WarningDiamondIcon } from '@phosphor-icons/react';
import { Link, useSearchParams } from 'react-router';

import { StatusBadge } from '@/components/shared/status-badge';
import { matchedFieldLabels } from '@/components/shared/duplicate-flag';
import { PageHeader } from '@/components/shared/page-header';
import { ReasonDialog } from '@/components/shared/reason-dialog';
import { RecordPagination } from '@/components/shared/record-pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatMoney, formatRelativeAge } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import {
  DUPLICATE_CLUSTER_STATES,
  DUPLICATE_CLUSTER_STATE_LABELS,
  DUPLICATE_ENTITY_LABELS,
  DUPLICATE_ENTITY_TYPES,
  PERMISSIONS,
  type DuplicateClusterState,
  type DuplicateClusterView,
  type DuplicateEntityType,
} from '@vyuha/shared';

import { useDetectDuplicates, useDismissDuplicate, useDuplicateClusters, useReopenDuplicate, useSendDuplicateToTally } from './use-duplicates';

/**
 * 15 REQ-AO-10: the duplicates screen, one tab per master, clusters
 * ranked by impact -- open documents, the receivables behind them,
 * transactions in the last ninety days -- so the ones actually splitting
 * the ledger surface first. Three things can be said about a cluster:
 * sent to Tally (the merge is Tally's), genuinely different (with a
 * reason), or reopened. Nothing here edits a master (REQ-AO-11).
 */

const ANY = 'open_or_sent';

function memberHref(entityType: DuplicateEntityType, id: string): string {
  return entityType === 'party' ? `/masters/parties/${id}` : `/masters/items/${id}`;
}

export function DuplicatesPage() {
  const canView = usePermission(PERMISSIONS.DUPLICATES_VIEW);
  const canManage = usePermission(PERMISSIONS.DUPLICATES_MANAGE);
  const [searchParams, setSearchParams] = useSearchParams();
  const entityType: DuplicateEntityType = searchParams.get('type') === 'stock_item' ? 'stock_item' : 'party';
  const stateParam = searchParams.get('state');
  const state = DUPLICATE_CLUSTER_STATES.find((s) => s === stateParam);
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const query = useDuplicateClusters({ page, pageSize: 20, entityType, ...(state ? { state } : {}) }, { enabled: canView });
  const detect = useDetectDuplicates();
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta ?? null;

  function setParam(key: string, value: string | null) {
    setSearchParams(
      (current) => {
        const out = new URLSearchParams(current);
        if (value === null) out.delete(key);
        else out.set(key, value);
        out.delete('page');
        return out;
      },
      { replace: true },
    );
  }

  if (!canView) {
    return (
      <>
        <PageHeader description="Likely duplicate parties and items, as the detector finds them after each pull." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view duplicates</EmptyTitle>
            <EmptyDescription>This needs duplicates.view — the Sales manager, Accounts and Admin roles carry it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Records Tally holds twice, as the detector reads them after each pull. Vyuha flags; the merge happens in Tally. Ranked by what each cluster is splitting: open documents, receivables, recent transactions."
        action={
          canManage ? (
            <Button
              variant="outline"
              size="sm"
              disabled={detect.isPending}
              onClick={() => {
                detect.mutate(
                  {},
                  {
                    onSuccess: (results) => {
                      const words = results.map((r) => `${DUPLICATE_ENTITY_LABELS[r.entityType].toLowerCase()}: ${String(r.clusters)} cluster${r.clusters === 1 ? '' : 's'}`).join(' · ');
                      toast.add({ type: 'success', title: 'Detection ran', description: words });
                    },
                    onError: (error) => {
                      toast.add({ type: 'error', title: 'Detection failed', description: error.message });
                    },
                  },
                );
              }}
            >
              {detect.isPending ? <Spinner data-icon="inline-start" /> : <MagnifyingGlassIcon data-icon="inline-start" />}
              Detect now
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={entityType}
          onValueChange={(next) => {
            setParam('type', next === 'stock_item' ? 'stock_item' : null);
          }}
        >
          <TabsList>
            {DUPLICATE_ENTITY_TYPES.map((t) => (
              <TabsTrigger key={t} value={t}>
                {DUPLICATE_ENTITY_LABELS[t]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Select
          value={state ?? ANY}
          onValueChange={(next) => {
            setParam('state', next === null || next === ANY ? null : next);
          }}
        >
          <SelectTrigger aria-label="Filter by state" className="w-full sm:w-56">
            <SelectValue>{(current: string) => (current === ANY ? 'Open and sent to Tally' : DUPLICATE_CLUSTER_STATE_LABELS[current as DuplicateClusterState])}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>Open and sent to Tally</SelectItem>
              {DUPLICATE_CLUSTER_STATES.map((s) => (
                <SelectItem key={s} value={s}>
                  {DUPLICATE_CLUSTER_STATE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {query.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading duplicates" className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}
      {query.isError ? (
        <QueryErrorAlert
          error={query.error}
          subject="duplicates"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}
      {query.isSuccess && rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CopyIcon />
            </EmptyMedia>
            <EmptyTitle>{state ? `No ${DUPLICATE_CLUSTER_STATE_LABELS[state].toLowerCase()} cluster` : `No likely duplicate ${DUPLICATE_ENTITY_LABELS[entityType].toLowerCase()}`}</EmptyTitle>
            <EmptyDescription>The detector runs after every pull. {canManage ? 'Detect now runs it by hand.' : ''}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {rows.length > 0 ? (
        <ol className="flex flex-col divide-y border">
          {rows.map((cluster) => (
            <ClusterRow key={cluster.id} cluster={cluster} canManage={canManage} />
          ))}
        </ol>
      ) : null}
      {meta !== null && meta.total > meta.pageSize ? <RecordPagination page={meta.page} pageSize={meta.pageSize} total={meta.total} /> : null}
    </>
  );
}

function ClusterRow({ cluster, canManage }: { cluster: DuplicateClusterView; canManage: boolean }) {
  const [dismissing, setDismissing] = useState(false);
  const dismiss = useDismissDuplicate();
  const send = useSendDuplicateToTally();
  const reopen = useReopenDuplicate();
  const busy = dismiss.isPending || send.isPending || reopen.isPending;
  const fields = matchedFieldLabels(cluster.matchedFields);

  return (
    <li className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <WarningDiamondIcon className={cluster.state === 'open' ? 'text-destructive' : 'text-muted-foreground'} weight="fill" />
          <StatusBadge state={`duplicate_${cluster.state}`} label={DUPLICATE_CLUSTER_STATE_LABELS[cluster.state]} />
          <Badge variant="outline" className="tabular-nums">
            {Math.round(cluster.confidence * 100)}% sure
          </Badge>
          <span className="text-muted-foreground text-xs">Same {fields.map((f) => f.toLowerCase()).join(', ')}</span>
        </div>
        <dl className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
          <div className="flex gap-1">
            <dt>Open documents</dt>
            <dd className="text-foreground font-medium">{String(cluster.impact.openDocuments)}</dd>
          </div>
          {cluster.entityType === 'party' ? (
            <div className="flex gap-1">
              <dt>Outstanding</dt>
              <dd className="text-foreground font-medium">{formatMoney(cluster.impact.outstanding)}</dd>
            </div>
          ) : null}
          <div className="flex gap-1">
            <dt>Last 90 days</dt>
            <dd className="text-foreground font-medium">{String(cluster.impact.recentTransactions)}</dd>
          </div>
        </dl>
      </div>

      <ul className="flex flex-col gap-1">
        {cluster.members.map((member) => (
          <li key={member.entityId} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
            <Link to={memberHref(cluster.entityType, member.entityId)} className="font-medium underline-offset-4 hover:underline">
              {member.name}
            </Link>
            {member.detail ? <span className="text-muted-foreground truncate text-xs">{member.detail}</span> : null}
            {member.absentInTally ? <Badge variant="outline">Gone from Tally</Badge> : null}
          </li>
        ))}
      </ul>

      {cluster.state === 'dismissed' && cluster.dismissedReason ? (
        <p className="text-muted-foreground text-xs">
          Genuinely different — {cluster.dismissedReason}
          {cluster.dismissedByName ? ` (${cluster.dismissedByName}${cluster.dismissedAt ? `, ${formatRelativeAge(cluster.dismissedAt)}` : ''})` : ''}
        </p>
      ) : null}
      {cluster.state === 'sent_to_tally' && cluster.sentToTallyAt ? <p className="text-muted-foreground text-xs">Sent to Tally {formatRelativeAge(cluster.sentToTallyAt)}; the next pull closes this if the merge happened.</p> : null}
      {cluster.state === 'resolved' && cluster.resolvedAt ? <p className="text-muted-foreground text-xs">Resolved {formatRelativeAge(cluster.resolvedAt)}: the pull no longer finds this pair.</p> : null}

      {canManage && (cluster.state === 'open' || cluster.state === 'sent_to_tally' || cluster.state === 'dismissed') ? (
        <div className="flex flex-wrap gap-2">
          {cluster.state === 'open' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                send.mutate(cluster.id, {
                  onError: (error) => {
                    toast.add({ type: 'error', title: 'Could not mark it', description: error.message });
                  },
                });
              }}
            >
              {send.isPending ? <Spinner data-icon="inline-start" /> : <PaperPlaneTiltIcon data-icon="inline-start" />}
              Sent to Tally for merging
            </Button>
          ) : null}
          {cluster.state !== 'dismissed' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDismissing(true);
              }}
            >
              <ProhibitIcon data-icon="inline-start" />
              Genuinely different
            </Button>
          ) : null}
          {cluster.state !== 'open' ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                reopen.mutate(cluster.id, {
                  onError: (error) => {
                    toast.add({ type: 'error', title: 'Could not reopen', description: error.message });
                  },
                });
              }}
            >
              <ArrowCounterClockwiseIcon data-icon="inline-start" />
              Reopen
            </Button>
          ) : null}
        </div>
      ) : null}

      <ReasonDialog
        open={dismissing}
        onOpenChange={setDismissing}
        title="Genuinely different"
        description={`${cluster.members.map((m) => m.name).join(' and ')} are not the same record. Say why; the cluster is not raised again unless one of the matched fields changes.`}
        prompt="Why they are different"
        confirmLabel="Mark as different"
        pendingLabel="Marking"
        pending={dismiss.isPending}
        error={dismiss.error}
        onConfirm={(reason) => {
          dismiss.mutate(
            { id: cluster.id, reason },
            {
              onSuccess: () => {
                setDismissing(false);
              },
            },
          );
        }}
      />
    </li>
  );
}
