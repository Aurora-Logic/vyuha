import { useEffect, useState } from 'react';
import { BuildingsIcon, CalendarBlankIcon, CircleDashedIcon, CircleHalfIcon, CircleIcon, GearIcon, HandshakeIcon, KanbanIcon, ListBulletsIcon, LockKeyIcon, PlusIcon, SealCheckIcon, XCircleIcon } from '@phosphor-icons/react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { KanbanBoard } from '@/components/shared/kanban-board';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { RecordPresence } from '@/components/shared/presence-avatars';
import { PersonChip } from '@/components/shared/person';
import { SavedViews } from '@/components/shared/saved-views';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SearchField } from '@/components/shared/search-field';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useManagerOptions } from '@/features/employees/use-employee-mutations';
import { useTaskViewStore, type TaskViewMode } from '@/features/tasks/task-view-store';
import { useIsMobile } from '@/hooks/use-mobile';
import { EMPTY_VALUE, formatDate, formatMoney } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { cn } from '@/lib/utils';
import { DEAL_STATUSES, PERMISSIONS, REALTIME_RESOURCES, type DealStatusFilter } from '@vyuha/shared';

import { DealSheet } from './deal-sheet';
import { PipelineSheet } from './pipeline-sheet';
import { dealToDraft, emptyDealDraft, type Deal, type DealDraft } from './types';
import { useDeal, useDealBoard, useDeals, useMoveDeal, usePipelines, type DealFilters } from './use-deals';

/**
 * Deals (REQ-U-05): the pipeline as a list or a board, one filter set for
 * both, the same way tasks work — including the default-view preference,
 * which is shared with tasks on purpose: a person who likes boards likes
 * boards.
 */

const STATUS_LABELS: Record<DealStatusFilter, string> = { open: 'Open', won: 'Won', lost: 'Lost', all: 'All' };

/**
 * A tint per open stage, cycled by position, worn by the lane's header chip
 * (the grouped-board idiom) — stages are user-named, so the colour says
 * "which column" at a glance rather than anything semantic. Won is always
 * green, lost always rose. Full literal classes, for Tailwind.
 */
const STAGE_HUES = [
  'bg-tint-1/15 text-tint-1',
  'bg-tint-2/15 text-tint-2',
  'bg-tint-3/15 text-tint-3',
  'bg-tint-4/15 text-tint-4',
  'bg-tint-5/15 text-tint-5',
  'bg-tint-6/15 text-tint-6',
] as const;
const WON_HUE = 'bg-success/15 text-success';
const LOST_HUE = 'bg-destructive/10 text-destructive';

/** Won a seal, lost a cross; an open stage a circle filling with its probability. */
function stageIcon(stage: { isWon: boolean; isLost: boolean; probability: number }, className: string) {
  if (stage.isWon) return <SealCheckIcon className={className} />;
  if (stage.isLost) return <XCircleIcon className={className} />;
  if (stage.probability >= 75) return <CircleIcon weight="fill" className={className} />;
  if (stage.probability >= 40) return <CircleHalfIcon weight="fill" className={className} />;
  return <CircleDashedIcon className={className} />;
}

/** A deal's value, written the way the workspace writes figures; a whole rupee stays whole. */
function formatValue(value: string | null): string {
  if (value === null) return EMPTY_VALUE;
  const amount = formatMoney(value);
  return amount.endsWith('.00') ? amount.slice(0, -3) : amount;
}

const COLUMNS: RecordColumn<Deal>[] = [
  {
    key: 'name',
    header: 'Deal',
    cell: (row) => (
      <span className="flex items-center gap-2">
        <span className="font-medium">{row.name}</span>
        {row.status === 'won' ? <Badge>Won</Badge> : row.status === 'lost' ? <Badge variant="outline">Lost</Badge> : null}
        {/* REQ-U-10 in the list as well as the board. The list is the view
            this screen opens in, so presence that only appeared on the board
            was presence most people would never see. */}
        <RecordPresence resource={REALTIME_RESOURCES.CRM_DEAL} recordId={row.id} />
      </span>
    ),
  },
  { key: 'company', header: 'Company', cell: (row) => row.companyName ?? EMPTY_VALUE },
  { key: 'stage', header: 'Stage', cell: (row) => `${row.stageName} · ${String(row.probability)}%` },
  { key: 'value', header: 'Value', cell: (row) => formatValue(row.value), numeric: true },
  { key: 'close', header: 'Expected close', cell: (row) => formatDate(row.expectedCloseDate), className: 'tabular-nums', secondary: true },
  { key: 'owner', header: 'Owner', cell: (row) => <PersonChip name={row.ownerName} />, secondary: true },
];

/** What a saved view keeps: the filter and view keys, never the transients (page, the open sheet). */
function dealViewQuery(params: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const key of ['q', 'status', 'pipeline', 'stage', 'owner', 'company', 'view']) {
    const value = params.get(key);
    if (value !== null && value !== '') kept.set(key, value);
  }
  return kept.toString();
}

function isStatus(value: string | null): value is DealStatusFilter {
  return DEAL_STATUSES.some((s) => s === value);
}

export function DealsPage() {
  // Overdue is "before today" in the org's working sense: the local calendar date.
  const todayParam = new Date().toLocaleDateString('en-CA');
  const canViewSelf = usePermission(PERMISSIONS.CRM_DEAL_VIEW_SELF);
  const canViewAll = usePermission(PERMISSIONS.CRM_DEAL_VIEW_ALL);
  const canView = canViewSelf || canViewAll;
  const canManage = usePermission(PERMISSIONS.CRM_DEAL_MANAGE);
  const canConfigure = usePermission(PERMISSIONS.CRM_PIPELINE_MANAGE);
  const [searchParams, setSearchParams] = useSearchParams();
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const defaultView = useTaskViewStore((s) => s.defaultView);
  const setDefaultView = useTaskViewStore((s) => s.setDefaultView);
  const [configuring, setConfiguring] = useState(false);

  const q = searchParams.get('q') ?? '';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const statusParam = searchParams.get('status');
  const status: DealStatusFilter = isStatus(statusParam) ? statusParam : 'open';
  const pipelineParam = searchParams.get('pipeline') ?? '';
  const viewParam = searchParams.get('view');
  const view: TaskViewMode = isMobile ? 'list' : viewParam === 'board' || viewParam === 'list' ? viewParam : defaultView;
  const openId = params.id ?? null;
  const creating = searchParams.get('new') === '1';
  const companyParam = searchParams.get('company') ?? '';
  const ownerParam = searchParams.get('owner') ?? '';
  const stageParam = searchParams.get('stage') ?? '';

  const [draft, setDraft] = useState(q);
  const [syncedQ, setSyncedQ] = useState(q);
  if (syncedQ !== q) {
    setSyncedQ(q);
    if (draft.trim() !== q) setDraft(q);
  }
  useEffect(() => {
    if (draft.trim() === q) return undefined;
    const timer = window.setTimeout(() => {
      setParam('q', draft.trim() || null);
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setParam is stable in effect
  }, [draft, q]);

  function setParam(name: string, value: string | null) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null) next.delete(name);
        else next.set(name, value);
        if (name !== 'page' && name !== 'view') next.delete('page');
        return next;
      },
      { replace: true },
    );
  }

  const pipelines = usePipelines({ enabled: canView });
  const pipelineList = pipelines.data ?? [];
  const pipeline = pipelineList.find((p) => p.id === pipelineParam) ?? pipelineList.find((p) => p.isDefault) ?? pipelineList[0] ?? null;

  const filters: DealFilters = {
    ...(q ? { q } : {}),
    ...(status === 'open' ? {} : { status }),
    ...(pipeline === null ? {} : { pipelineId: pipeline.id }),
    ...(companyParam ? { companyId: companyParam } : {}),
    ...(ownerParam ? { ownerId: ownerParam } : {}),
    ...(stageParam && view === 'list' ? { stageId: stageParam } : {}),
  };
  const owners = useManagerOptions();

  const list = useDeals({ ...filters, page }, { enabled: canView && view === 'list' });
  const board = useDealBoard(filters, { enabled: canView && view === 'board' && pipeline !== null });
  const open = useDeal(canView ? openId : null);
  const move = useMoveDeal();

  function startNew() {
    setParam('new', '1');
  }
  function closeSheet() {
    const next = new URLSearchParams(window.location.search);
    next.delete('new');
    const search = next.toString();
    void navigate(`/crm/deals${search ? `?${search}` : ''}`, { replace: true });
  }

  useShortcut({
    id: 'crm.deals.create',
    keys: 'alt+c',
    label: 'New deal',
    scope: 'screen',
    when: () => canManage,
    run: startNew,
  });

  const sheetDraft: DealDraft | null = creating
    ? emptyDealDraft({ ...(pipeline === null ? {} : { pipelineId: pipeline.id }), ...(companyParam ? { companyId: companyParam } : {}) })
    : open.data !== undefined && openId !== null
      ? dealToDraft(open.data)
      : null;

  if (!canView) {
    return (
      <>
        <PageHeader description="The pipeline: what is being sold, to whom, and how far along." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view deals</EmptyTitle>
            <EmptyDescription>This needs crm.deal.view.self or crm.deal.view.all. Ask an administrator for the Sales role.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta ?? null;
  const query = view === 'list' ? list : board;
  const nothing = view === 'list' ? list.isSuccess && rows.length === 0 : board.isSuccess && board.data.lanes.every((l) => l.deals.length === 0);
  const filtered = Boolean(q) || status !== 'open' || Boolean(companyParam) || Boolean(ownerParam) || Boolean(stageParam);

  return (
    <>
      <PageHeader
        description="What is being sold, to whom, and how far along. A deal has no accounting existence; when it is won, its company is linked to the Tally party that invoices it."
        action={
          canManage ? (
            <Button size="sm" onClick={startNew}>
              <PlusIcon data-icon="inline-start" />
              New deal
              <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
            </Button>
          ) : null
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField id="deal-search" label="Search deals" value={draft} onValueChange={setDraft} placeholder="Deal name or notes" />

          {pipelineList.length > 1 ? (
            <Select
              value={pipeline?.id ?? ''}
              onValueChange={(value: string | null) => {
                setParam('pipeline', value);
              }}
            >
              <SelectTrigger className="w-40" aria-label="Pipeline">
                <SelectValue>{(value: string) => pipelineList.find((p) => p.id === value)?.name ?? 'Pipeline'}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {pipelineList.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          {view === 'list' ? (
            <ToggleGroup
              variant="outline"
              aria-label="Status"
              value={[status]}
              onValueChange={(value) => {
                const next = value[0];
                if (isStatus(next)) setParam('status', next === 'open' ? null : next);
              }}
            >
              {DEAL_STATUSES.map((s) => (
                <ToggleGroupItem key={s} value={s}>
                  {STATUS_LABELS[s]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}

          {view === 'list' && pipeline !== null && pipeline.stages.length > 0 ? (
            <Select
              value={stageParam === '' ? 'all' : stageParam}
              onValueChange={(value: string | null) => {
                setParam('stage', value === null || value === 'all' ? null : value);
              }}
            >
              <SelectTrigger className="w-40" aria-label="Stage">
                <SelectValue>{(value: string) => (value === 'all' ? 'Any stage' : (pipeline.stages.find((st) => st.id === value)?.name ?? 'Stage'))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any stage</SelectItem>
                {pipeline.stages.map((st) => (
                  <SelectItem key={st.id} value={st.id}>
                    {st.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          <Select
            value={ownerParam === '' ? 'all' : ownerParam}
            onValueChange={(value: string | null) => {
              setParam('owner', value === null || value === 'all' ? null : value);
            }}
          >
            <SelectTrigger className="w-40" aria-label="Owner">
              <SelectValue>{(value: string) => (value === 'all' ? 'Any owner' : ((owners.data ?? []).find((o) => o.id === value)?.name ?? 'Owner'))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any owner</SelectItem>
              {(owners.data ?? []).map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-2">
            <SavedViews
              storageKey="vyuha.views.deals"
              current={dealViewQuery(searchParams)}
              onApply={(next) => {
                void navigate(`/crm/deals${next ? `?${next}` : ''}`, { replace: true });
              }}
            />
            {canConfigure && pipeline !== null ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setConfiguring(true);
                }}
              >
                <GearIcon data-icon="inline-start" />
                Stages
              </Button>
            ) : null}
            {isMobile ? null : (
              <ToggleGroup
                variant="outline"
                aria-label="View"
                value={[view]}
                onValueChange={(value) => {
                  const next = value[0];
                  if (next === 'list' || next === 'board') {
                    setParam('view', next);
                    setDefaultView(next);
                  }
                }}
              >
                <ToggleGroupItem value="list" aria-label="List view">
                  <ListBulletsIcon />
                </ToggleGroupItem>
                <ToggleGroupItem value="board" aria-label="Board view">
                  <KanbanIcon />
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>
        </div>

        {query.isPending || (view === 'board' && pipelines.isPending) ? <ListSkeleton rows={4} label="Loading deals" /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="deals"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {nothing ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HandshakeIcon />
              </EmptyMedia>
              <EmptyTitle>{filtered ? 'No deal matches that' : 'No open deals'}</EmptyTitle>
              <EmptyDescription>
                {filtered ? 'Try another status or clear the search.' : canManage ? 'Add the first one — a name and a company are enough to start.' : 'Deals appear here as the sales team adds them.'}
              </EmptyDescription>
            </EmptyHeader>
            {!filtered && canManage ? (
              <EmptyContent>
                <Button size="sm" onClick={startNew}>
                  <PlusIcon data-icon="inline-start" />
                  New deal
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : null}

        {view === 'list' && rows.length > 0 ? (
          <>
            <RecordTable
              columns={COLUMNS}
              rows={rows}
              rowKey={(row) => row.id}
              mobilePrimary={(row) => row.name}
              mobileStatus={(row) => <Badge variant={row.status === 'won' ? 'default' : 'outline'}>{row.status === 'open' ? row.stageName : STATUS_LABELS[row.status]}</Badge>}
              mobileSupporting={(row) => [row.companyName, formatValue(row.value)].filter((p): p is string => p !== null && p !== EMPTY_VALUE).join(' · ') || EMPTY_VALUE}
              onRowActivate={(row) => {
                void navigate(`/crm/deals/${row.id}${window.location.search}`);
              }}
            />
            {meta !== null && meta.total > meta.pageSize ? (
              <RecordPagination page={meta.page} pageSize={meta.pageSize} total={meta.total} />
            ) : null}
          </>
        ) : null}

        {view === 'board' && board.data !== undefined && !nothing ? (
          <KanbanBoard
            ariaLabel="Deal pipeline"
            lanes={board.data.lanes.map(({ stage, deals, total, valueTotal }, index) => ({
              id: stage.id,
              label: stage.name,
              accent: stage.isWon ? WON_HUE : stage.isLost ? LOST_HUE : (STAGE_HUES[index % STAGE_HUES.length] ?? STAGE_HUES[0]),
              title: (
                <>
                  {stageIcon(stage, 'shrink-0')}
                  <span className="truncate">{stage.name}</span>
                  {stage.isWon || stage.isLost ? null : <span className="font-normal opacity-70">{stage.probability}%</span>}
                </>
              ),
              meta: (
                <span className="flex items-baseline gap-2">
                  <span>{total}</span>
                  <span className="text-muted-foreground">{formatValue(valueTotal)}</span>
                </span>
              ),
              items: deals,
              total,
              muted: stage.isWon || stage.isLost,
            }))}
            itemKey={(deal) => deal.id}
            itemLaneId={(deal) => deal.stageId}
            itemLabel={(deal) => deal.name}
            renderItem={(deal) => (
              <>
                <span className={cn('font-medium', deal.status === 'lost' && 'text-muted-foreground line-through')}>{deal.name}</span>
                <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-normal">
                  {deal.companyName === null ? null : (
                    <span className="flex min-w-0 items-center gap-1">
                      <BuildingsIcon className="shrink-0" />
                      <span className="truncate">{deal.companyName}</span>
                    </span>
                  )}
                  {deal.value === null ? null : (
                    <span className="tabular-nums">{formatValue(deal.value)}</span>
                  )}
                  {deal.expectedCloseDate === null ? null : (
                    <span className={cn('flex items-center gap-1 tabular-nums', deal.status === 'open' && deal.expectedCloseDate < todayParam && 'text-warning')}>
                      <CalendarBlankIcon className="shrink-0" />
                      {formatDate(deal.expectedCloseDate)}
                    </span>
                  )}
                  {deal.ownerName === null ? null : <PersonChip name={deal.ownerName} tiny />}
                  {/* Beside the owner, because the question they answer is the
                      same one: who is this deal's, and who is in it now. */}
                  <RecordPresence resource={REALTIME_RESOURCES.CRM_DEAL} recordId={deal.id} className="ml-auto" />
                </span>
              </>
            )}
            onOpen={(deal) => {
              void navigate(`/crm/deals/${deal.id}${window.location.search}`);
            }}
            onMove={(deal, stageId) => {
              const lane = board.data?.lanes.find((l) => l.stage.id === stageId);
              move.mutate(
                { id: deal.id, stageId },
                {
                  onSuccess: (moved) => {
                    toast.add({
                      type: 'success',
                      title: moved.status === 'won' && deal.status !== 'won' ? 'Deal won' : moved.status === 'lost' && deal.status !== 'lost' ? 'Deal marked lost' : `Moved to ${lane?.stage.name ?? moved.stageName}`,
                      description: moved.name,
                    });
                    if (moved.status === 'won' && moved.companyId !== null && moved.partyId === null) {
                      void navigate(`/crm/deals/${moved.id}${window.location.search}`);
                    }
                  },
                  onError: (error) => {
                    toast.add({ type: 'error', title: 'Could not move the deal', description: error.message });
                  },
                },
              );
            }}
            moving={move.isPending}
            overflowHint="see the list"
          />
        ) : null}
      </div>

      {openId !== null && open.isError ? (
        <QueryErrorAlert
          error={open.error}
          subject="that deal"
          onRetry={() => {
            void open.refetch();
          }}
        />
      ) : null}

      <DealSheet
        draft={sheetDraft}
        record={open.data ?? null}
        onOpenChange={(isOpen) => {
          if (!isOpen) closeSheet();
        }}
      />
      <PipelineSheet pipeline={pipeline} open={configuring} onOpenChange={setConfiguring} />
    </>
  );
}
