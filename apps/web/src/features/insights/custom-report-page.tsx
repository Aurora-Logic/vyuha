import { useRef, useState } from 'react';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  DotsSixVerticalIcon,
  DotsThreeVerticalIcon,
  LockKeyIcon,
  PencilSimpleIcon,
  PlusIcon,
  TextAaIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import type { CustomWidget, InsightArea } from '@vyuha/shared';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMediaQuery } from '@/hooks/use-media-query';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import { useAreaInsights, useCustomReport, useCustomReportMutations } from './api';
import { HeatmapTable } from '@/components/shared/heatmap-table';
import { heatGridOf } from '@/components/shared/heat-grid';
import { formatCount, formatMoneyShort } from '@/lib/format';
import { usePivot } from './use-cfo';
import { BuilderPanel } from './builder-panel';
import { AREA_METRICS } from './catalogue';
import { MetricChart, MetricPointsTable } from './metric-card';
import { INSIGHT_PRESETS, rangeAsPickerValue, rangeFromParams, toApiDate } from './period';
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

/**
 * S1.1: a pivot draws from the sales fact, not an area metric. Column keys
 * are prefixed with their rank so the grid keeps the server's order; the
 * heatmap sorts keys and would otherwise shuffle people and brands.
 */
function PivotWidgetBody({ spec, range, tall }: { spec: NonNullable<CustomWidget['pivot']>; range: { from: string; to: string }; tall: boolean }) {
  const { partyName: _p, itemName: _i, personName: _o, ...scope } = spec.scope ?? {};
  const query = usePivot(range, spec, scope);
  if (query.isPending) return <Skeleton className="h-40 w-full" />;
  if (query.isError) {
    return (
      <div className="text-muted-foreground flex h-40 flex-col items-center justify-center gap-1 border border-dashed text-sm">
        <LockKeyIcon className="size-5" />
        Needs a permission you do not hold
      </div>
    );
  }
  const data = query.data;
  if (data.rows.length === 0) {
    return <div className="text-muted-foreground flex h-40 items-center justify-center border border-dashed text-sm">Nothing sold in this period</div>;
  }
  const keyOf = new Map(data.columns.map((c, i) => [c.key, `${String(i).padStart(3, '0')}|${c.key}`]));
  const labelOf = new Map(data.columns.map((c, i) => [`${String(i).padStart(3, '0')}|${c.key}`, c.label]));
  const grid = heatGridOf(data.cells.map((cell) => ({ category: data.rows.find((r) => r.key === cell.row)?.label ?? cell.row, month: keyOf.get(cell.column) ?? cell.column, value: cell.value, rowId: cell.row })));
  const show = (v: number) => (data.unit === 'money' ? formatMoneyShort(v) : data.unit === 'ratio' ? v.toFixed(2) : formatCount(Math.round(v)));
  return (
    <div className={tall ? 'max-h-80 overflow-y-auto' : 'max-h-44 overflow-y-auto'}>
      <HeatmapTable grid={grid} rowLabel="" format={show} columnLabel={(key) => labelOf.get(key) ?? key} />
      <p className="text-muted-foreground mt-2 text-xs tabular-nums">Total {show(data.grandTotal)} · {formatCount(data.rows.length)} rows</p>
    </div>
  );
}

function WidgetBody({ widget, range }: { widget: CustomWidget; range: { from: string; to: string } }) {
  if (widget.kind === 'pivot' && widget.pivot !== undefined) {
    return <PivotWidgetBody spec={widget.pivot} range={range} tall={widget.size === '2x2'} />;
  }
  return <MetricWidgetBody widget={widget} range={range} />;
}

function MetricWidgetBody({ widget, range }: { widget: CustomWidget; range: { from: string; to: string } }) {
  const query = useAreaInsights(widget.area, range);
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
  if (widget.kind === 'table') {
    // Some reports are honest as rows, not marks -- an ageing, an interest
    // working. The breakdown when the metric carries one, the series itself
    // when it does not.
    return (
      <div className={widget.size === '2x2' ? 'max-h-80 overflow-y-auto' : 'max-h-44 overflow-y-auto'}>
        <MetricPointsTable metric={metric} />
      </div>
    );
  }
  if (widget.kind === 'pivot') return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-2xl font-semibold tracking-tight tabular-nums">{formatHeadline(metric.unit, metric.headline)}</p>
      <MetricChart
        metric={metric}
        kind={widget.kind}
        options={widget.options}
        className={widget.size === '2x2' ? 'h-64' : 'h-36'}
      />
    </div>
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

  const range = rangeFromParams(searchParams);
  const editing = searchParams.get('edit') === '1' && query.data?.editable === true;
  const [draft, setDraft] = useState<CustomWidget[] | null>(null);
  const [shared, setShared] = useState<boolean | null>(null);
  const [sharedWithText, setSharedWithText] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<{ name: string; description: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isMobile = useIsMobile();
  // The rail is pinned beside the canvas only where there is room for both;
  // below that it opens as a sheet over the widget it configures.
  const isWide = useMediaQuery('(min-width: 1280px)');

  const report = query.data;
  // Arriving with ?edit=1 in the address arms edit mode before enterEdit ever
  // ran, so the draft is seeded here the moment both halves are known --
  // without this, the first change would start from an empty layout and Save
  // would quietly drop every other widget.
  if (editing && draft === null && report !== undefined) {
    setDraft([...report.widgets]);
    setShared(report.shared);
    setSharedWithText(report.sharedWith.map((share) => share.email).join(', '));
    setSelectedId(isWide ? (report.widgets[0]?.id ?? null) : null);
  }
  const widgets = editing && draft !== null ? draft : (report?.widgets ?? []);
  const isShared = editing && shared !== null ? shared : (report?.shared ?? false);
  const selected = widgets.find((w) => w.id === selectedId) ?? null;

  function enterEdit() {
    if (report === undefined) return;
    setDraft([...report.widgets]);
    setShared(report.shared);
    setSharedWithText(report.sharedWith.map((share) => share.email).join(', '));
    setSelectedId(isWide ? (report.widgets[0]?.id ?? null) : null);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('edit', '1');
      return next;
    });
  }

  function leaveEdit() {
    setDraft(null);
    setShared(null);
    setSharedWithText(null);
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
      options: {
        legend: true,
        dataLabels: false,
        showTotal: true,
        palette: 'default',
        omitZero: false,
        curve: 'linear',
        points: true,
        stacked: true,
        grid: false,
        xOrder: 'natural',
      },
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
        body: {
          name: report.name,
          description: report.description,
          shared: shared ?? report.shared,
          // The comma-separated field becomes a list here; the server
          // refuses an email that matches nobody rather than dropping it.
          sharedWith: (sharedWithText ?? '').split(/[\s,;]+/u).filter((email) => email !== ''),
          widgets: draft,
        },
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

  async function rename() {
    if (report === undefined || renaming === null) return;
    const name = renaming.name.trim();
    if (name === '') return;
    try {
      await update.mutateAsync({
        id: report.id,
        body: { name, description: renaming.description.trim(), shared: report.shared, widgets: [...report.widgets] },
      });
      setRenaming(null);
      toast.add({ type: 'success', title: 'Report renamed' });
    } catch (error) {
      toast.add({
        type: 'error',
        title: 'Could not rename the report',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    }
  }

  async function deleteReport() {
    if (report === undefined) return;
    try {
      await remove.mutateAsync(report.id);
      void navigate('/reports/custom');
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not delete', description: error instanceof Error ? error.message : 'Try again.' });
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
            {!editing && report.editable && !report.shared && report.sharedWith.length > 0 ? (
              <span className="text-muted-foreground text-xs">
                shared with {report.sharedWith.length === 1 ? (report.sharedWith[0]?.email ?? '') : `${String(report.sharedWith.length)} colleagues`}
              </span>
            ) : null}
            {!report.editable ? (
              <span className="text-muted-foreground text-xs">by {report.ownerName}</span>
            ) : null}
          </span>
        }
        description={
          editing
            ? 'Pick a widget to configure it; drag the grip or use its menu to reorder.'
            : report.description !== ''
              ? report.description
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
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button variant="outline" size="icon-sm" aria-label="Report menu">
                          <DotsThreeVerticalIcon />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => {
                          setRenaming({ name: report.name, description: report.description });
                        }}
                      >
                        <TextAaIcon />
                        Rename or describe
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          setConfirmDelete(true);
                        }}
                      >
                        <TrashIcon />
                        Delete report
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
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

      {editing ? (
        <div className="mb-4 flex max-w-xl flex-col gap-1.5">
          <Label htmlFor="report-shared-with">Also visible to</Label>
          <Input
            id="report-shared-with"
            placeholder="colleague@company.in, another@company.in"
            value={sharedWithText ?? ''}
            onChange={(e) => { setSharedWithText(e.target.value); }}
          />
          <p className="text-muted-foreground text-xs">
            Work emails, comma separated. They can open the report, not edit it. The Shared switch shows it to everyone instead.
          </p>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Refresh"
          onClick={() => {
            void query.refetch();
          }}
        >
          <ArrowsClockwiseIcon />
        </Button>
        <DateRangeField
          label="Period"
          value={rangeAsPickerValue(range)}
          presets={INSIGHT_PRESETS}
          onValueChange={(next) => {
            if (!next.from || !next.to) return;
            const from = toApiDate(next.from);
            const to = toApiDate(next.to);
            setSearchParams(
              (current) => {
                const params = new URLSearchParams(current);
                params.set('from', from);
                params.set('to', to);
                return params;
              },
              { replace: true },
            );
          }}
        />
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatDate(range.from)} → {formatDate(range.to)}
        </span>
        {editing ? (
          <Button variant="outline" size="sm" className="ml-auto" onClick={addWidget}>
            <PlusIcon data-icon="inline-start" />
            Add widget
          </Button>
        ) : null}
      </div>

      {/* One scroller: the canvas. The rail is pinned to the viewport edge,
          full height, and scrolls only inside itself -- two independent
          scrolling columns read as two half-broken pages (owner, 26 Aug). */}
      <div className={cn('flex flex-col gap-4', editing && selected !== null && isWide && 'xl:pr-[21rem]')}>
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
                <CardHeader>
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
                    <CardAction>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon-sm" aria-label={`${widget.title} widget menu`}>
                            <DotsThreeVerticalIcon />
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
                    </CardAction>
                  ) : null}
                </CardHeader>
                <CardContent>
                  <WidgetBody widget={widget} range={range} />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {editing && selected !== null && isWide ? (
          <div className="bg-background border p-4 xl:fixed xl:top-14 xl:right-0 xl:bottom-0 xl:z-10 xl:w-80 xl:overflow-y-auto xl:border-t-0 xl:border-r-0 xl:border-b-0">
            <BuilderPanel
              widget={selected}
              range={range}
              onChange={patchWidget}
              onRemove={() => {
                setDraft((current) => (current ?? []).filter((w) => w.id !== selected.id));
                setSelectedId(null);
              }}
            />
          </div>
        ) : null}
      </div>

      <Sheet
        open={editing && selected !== null && !isWide}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-sm">
          <SheetHeader>
            <SheetTitle>{selected?.title ?? 'Widget'}</SheetTitle>
            <SheetDescription>Configure this widget; changes land on Save.</SheetDescription>
          </SheetHeader>
          {selected !== null ? (
            <div className="max-h-[70vh] overflow-y-auto px-4 pb-6 sm:max-h-none">
              <BuilderPanel
                widget={selected}
                range={range}
                onChange={patchWidget}
                onRemove={() => {
                  setDraft((current) => (current ?? []).filter((w) => w.id !== selected.id));
                  setSelectedId(null);
                }}
              />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={renaming !== null} onOpenChange={(open) => { if (!open) setRenaming(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename or describe</DialogTitle>
            <DialogDescription>The name is how the report is found; the description says what it is for.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="report-name">Name</FieldLabel>
            <Input
              id="report-name"
              value={renaming?.name ?? ''}
              maxLength={80}
              onChange={(event) => {
                setRenaming((current) => (current === null ? current : { ...current, name: event.target.value }));
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void rename();
                }
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="report-description">Description</FieldLabel>
            <Textarea
              id="report-description"
              rows={3}
              maxLength={500}
              value={renaming?.description ?? ''}
              onChange={(event) => {
                setRenaming((current) => (current === null ? current : { ...current, description: event.target.value }));
              }}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRenaming(null); }}>
              Cancel
            </Button>
            <Button disabled={(renaming?.name.trim() ?? '') === '' || update.isPending} onClick={() => void rename()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this report?</AlertDialogTitle>
            <AlertDialogDescription>
              {isShared
                ? 'It is shared: everyone who opens it will lose it. This cannot be undone.'
                : 'Its widgets go with it. This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => void deleteReport()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
