import { useRef, useState } from 'react';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  DotsSixVerticalIcon,
  LockKeyIcon,
  PencilSimpleIcon,
  PlusIcon,
} from '@phosphor-icons/react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import type { CustomWidget, InsightArea } from '@vyuha/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { PageHeader } from '@/components/shared/page-header';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { cn } from '@/lib/utils';

import { useAreaInsights, useCustomReport, useCustomReportMutations } from './api';
import { BuilderPanel } from './builder-panel';
import { AREA_METRICS } from './catalogue';
import { MetricChart } from './metric-card';
import { defaultRange } from './period';
import { formatHeadline } from './units';

/**
 * One custom report (owner, 26 Aug 2026, the Twenty reference): a grid of
 * widgets; for its author, an edit mode with the config rail on the right,
 * drag-to-reorder on each widget's grip, and Save/Cancel.
 *
 * The draft lives here as plain state and goes to the server whole on Save --
 * a layout is one decision, and autosaving half a decision leaves the shared
 * copy mid-thought. Cancel is a real cancel because nothing was sent.
 *
 * Reorder is native pointer capture, no dependency: the grip claims the
 * pointer, each move finds the widget under it, and the draft reorders live.
 * The same moves exist as menu items, so the keyboard path is not a lesser
 * one (PRD §6.4).
 */

const RANGE = defaultRange();

function WidgetBody({ widget }: { widget: CustomWidget }) {
  const query = useAreaInsights(widget.area, RANGE);
  const metric = query.data?.metrics.find((m) => m.key === widget.metric);

  if (query.isPending) return <Skeleton className="h-40 w-full" />;
  if (query.isError) {
    // Most commonly a 403: a shared report drawn by a viewer whose own key
    // does not open this widget's area. The figure stays withheld.
    return (
      <div className="text-muted-foreground flex h-40 flex-col items-center justify-center gap-1 border border-dashed text-sm">
        <LockKeyIcon className="size-5" />
        Needs a permission you do not hold
      </div>
    );
  }
  if (metric === undefined) {
    return (
      <div className="text-muted-foreground flex h-40 items-center justify-center border border-dashed text-sm">
        This metric no longer exists
      </div>
    );
  }
  if (widget.kind === 'number') {
    return (
      <p className="flex h-40 items-center justify-center text-4xl font-semibold tracking-tight tabular-nums">
        {formatHeadline(metric.unit, metric.headline)}
      </p>
    );
  }
  return (
    <MetricChart
      metric={metric}
      kind={widget.kind}
      legend={widget.options.legend}
      className={widget.size === '2x2' ? 'h-72' : 'h-40'}
    />
  );
}

function spanClass(widget: CustomWidget): string {
  return widget.size === '1x1' ? '' : 'sm:col-span-2';
}

export function CustomReportPage() {
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const id = params.id ?? null;
  const query = useCustomReport(id);
  const { update, remove } = useCustomReportMutations();

  const editing = searchParams.get('edit') === '1' && query.data?.editable === true;
  const [draft, setDraft] = useState<CustomWidget[] | null>(null);
  const [shared, setShared] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);

  const report = query.data;
  // Arriving with ?edit=1 in the address arms edit mode before enterEdit ever
  // ran, so the draft is seeded here the moment both halves are known --
  // without this, the first change would start from an empty layout and Save
  // would quietly drop every other widget.
  if (editing && draft === null && report !== undefined) {
    setDraft([...report.widgets]);
    setShared(report.shared);
    setSelectedId(report.widgets[0]?.id ?? null);
  }
  const widgets = editing && draft !== null ? draft : (report?.widgets ?? []);
  const isShared = editing && shared !== null ? shared : (report?.shared ?? false);
  const selected = widgets.find((w) => w.id === selectedId) ?? null;

  function enterEdit() {
    if (report === undefined) return;
    setDraft([...report.widgets]);
    setShared(report.shared);
    setSelectedId(report.widgets[0]?.id ?? null);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('edit', '1');
      return next;
    });
  }

  function leaveEdit() {
    setDraft(null);
    setShared(null);
    setSelectedId(null);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('edit');
      return next;
    });
  }

  function patchWidget(next: CustomWidget) {
    setDraft((current) => (current ?? []).map((w) => (w.id === next.id ? next : w)));
  }

  function addWidget() {
    const area: InsightArea = 'receivables';
    const first = AREA_METRICS[area][0];
    const widget: CustomWidget = {
      id: `w${String(Date.now())}`,
      title: first?.label ?? 'New widget',
      kind: 'bar',
      size: '1x1',
      area,
      metric: first?.key ?? 'invoiced',
      options: { legend: true, dataLabels: false, showTotal: true },
    };
    setDraft((current) => [...(current ?? []), widget]);
    setSelectedId(widget.id);
  }

  function move(idFrom: string, offset: number) {
    setDraft((current) => {
      const list = [...(current ?? [])];
      const from = list.findIndex((w) => w.id === idFrom);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= list.length) return list;
      const [moved] = list.splice(from, 1);
      if (moved) list.splice(to, 0, moved);
      return list;
    });
  }

  function reorderTo(idFrom: string, idOver: string) {
    if (idFrom === idOver) return;
    setDraft((current) => {
      const list = [...(current ?? [])];
      const from = list.findIndex((w) => w.id === idFrom);
      const to = list.findIndex((w) => w.id === idOver);
      if (from < 0 || to < 0) return list;
      const [moved] = list.splice(from, 1);
      if (moved) list.splice(to, 0, moved);
      return list;
    });
  }

  async function save() {
    if (report === undefined || draft === null) return;
    try {
      await update.mutateAsync({
        id: report.id,
        body: { name: report.name, shared: shared ?? report.shared, widgets: draft },
      });
      leaveEdit();
      toast.add({ type: 'success', title: 'Report saved' });
    } catch (error) {
      toast.add({
        type: 'error',
        title: 'Could not save the report',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    }
  }

  if (query.isPending) {
    return (
      <>
        <PageHeader description="Loading the report." />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </>
    );
  }

  if (query.isError || report === undefined) {
    return (
      <>
        <PageHeader description="A custom report." />
        <QueryErrorAlert error={query.error ?? new Error('Not found')} subject="report" onRetry={() => void query.refetch()} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {report.name}
            {isShared ? <Badge variant="secondary">Shared</Badge> : null}
            {!report.editable ? (
              <span className="text-muted-foreground text-xs">by {report.ownerName}</span>
            ) : null}
          </span>
        }
        description={
          editing
            ? 'Pick a widget to configure it; drag the grip or use its menu to reorder.'
            : 'A report composed from the area metrics.'
        }
        action={
          editing ? (
            <span className="flex items-center gap-2">
              <span className="flex min-h-9 items-center gap-2">
                <Switch id="report-shared" checked={isShared} onCheckedChange={setShared} />
                <Label htmlFor="report-shared" className="text-sm">
                  Shared
                </Label>
              </span>
              <Button variant="outline" size="sm" onClick={leaveEdit}>
                Cancel
              </Button>
              <Button size="sm" disabled={update.isPending} onClick={() => void save()}>
                Save
              </Button>
            </span>
          ) : (
            <span className="flex items-center gap-2">
              {report.editable ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void (async () => {
                        try {
                          await remove.mutateAsync(report.id);
                          void navigate('/reports/custom');
                        } catch (error) {
                          toast.add({ type: 'error', title: 'Could not delete', description: error instanceof Error ? error.message : 'Try again.' });
                        }
                      })();
                    }}
                  >
                    Delete
                  </Button>
                  <Button size="sm" onClick={enterEdit}>
                    <PencilSimpleIcon data-icon="inline-start" />
                    Edit
                  </Button>
                </>
              ) : null}
            </span>
          )
        }
      />

      <div className={cn('flex flex-col gap-4', editing && 'xl:grid xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start')}>
        {widgets.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlusIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing on this report yet</EmptyTitle>
              <EmptyDescription>
                {editing
                  ? 'Add the first widget; it lands selected, ready to point at a metric.'
                  : report.editable
                    ? 'Open Edit and add the first widget.'
                    : 'Its author has not added anything yet.'}
              </EmptyDescription>
            </EmptyHeader>
            {editing ? (
              <Button size="sm" onClick={addWidget}>
                <PlusIcon data-icon="inline-start" />
                Add widget
              </Button>
            ) : null}
          </Empty>
        ) : (
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            {widgets.map((widget) => (
              <Card
                key={widget.id}
                data-widget-id={widget.id}
                className={cn(
                  spanClass(widget),
                  editing && 'cursor-pointer',
                  editing && selectedId === widget.id && 'border-ring ring-ring/50 ring-[3px]',
                )}
                onClick={editing ? () => { setSelectedId(widget.id); } : undefined}
              >
                <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
                  <CardTitle className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                    {editing ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Reorder ${widget.title}`}
                        className="text-muted-foreground -ml-1 cursor-grab touch-none"
                        onPointerDown={(event) => {
                          dragId.current = widget.id;
                          event.currentTarget.setPointerCapture(event.pointerId);
                        }}
                        onPointerMove={(event) => {
                          if (dragId.current === null) return;
                          const over = document
                            .elementFromPoint(event.clientX, event.clientY)
                            ?.closest('[data-widget-id]');
                          const overId = over?.getAttribute('data-widget-id');
                          if (overId) reorderTo(dragId.current, overId);
                        }}
                        onPointerUp={() => {
                          dragId.current = null;
                        }}
                      >
                        <DotsSixVerticalIcon />
                      </Button>
                    ) : null}
                    <span className="truncate">{widget.title}</span>
                  </CardTitle>
                  {editing ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon-sm" aria-label={`${widget.title} widget menu`}>
                            <ArrowRightIcon className="rotate-90" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => { move(widget.id, -1); }}>
                          <ArrowLeftIcon />
                          Move earlier
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { move(widget.id, 1); }}>
                          <ArrowRightIcon />
                          Move later
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => {
                            setDraft((current) => (current ?? []).filter((w) => w.id !== widget.id));
                            setSelectedId((current) => (current === widget.id ? null : current));
                          }}
                        >
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </CardHeader>
                <CardContent>
                  <WidgetBody widget={widget} />
                </CardContent>
              </Card>
            ))}
            {editing ? (
              <Button
                variant="outline"
                onClick={addWidget}
                className="text-muted-foreground hover:text-foreground w-full border-dashed font-normal sm:col-span-2"
              >
                <PlusIcon data-icon="inline-start" />
                Add widget
              </Button>
            ) : null}
          </div>
        )}

        {editing && selected !== null ? (
          <div className="border p-4 xl:sticky xl:top-4">
            <BuilderPanel
              widget={selected}
              onChange={patchWidget}
              onRemove={() => {
                setDraft((current) => (current ?? []).filter((w) => w.id !== selected.id));
                setSelectedId(null);
              }}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}
