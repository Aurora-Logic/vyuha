import { useState } from 'react';
import { ArrowsClockwiseIcon, LockKeyIcon, PlusIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatCount, formatDate, formatMoney, formatMoneyShort } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import type { Metric } from './api';
import { ExportButton } from './export-button';
import { MetricChart } from './metric-card';
import { INSIGHT_PRESETS, rangeAsPickerValue, rangeFromParams, toApiDate } from './period';
import { deltaText, deleteSlab, saveSlab, useBrands, type BrandRowData } from './use-cfo';

/**
 * Brand performance (brief G2) -- where a switchgear distributor actually
 * earns. Per principal: sales against the same days last year, the proxy
 * margin where the viewer may see rupees, the category split, price
 * realisation, target against achievement, and the slabs: "so much to the
 * next slab, so many days left" is the most profitable number here.
 */

function categoryMetric(row: BrandRowData): Metric {
  return {
    key: `brand-${row.brand}`,
    label: 'Category split',
    unit: 'money',
    headline: row.net,
    series: [{ key: 'net', label: 'Net sales' }],
    points: row.categories.map((c) => ({ t: c.category, net: Number(c.net) })),
    xKind: 'category',
  };
}

type SlabDraft = { id?: string; brand: string; label: string; threshold: string; reward: string; active: boolean };

export function BrandsPage() {
  const canView = usePermission(PERMISSIONS.CFO_BRAND_VIEW);
  const canManage = usePermission(PERMISSIONS.CFO_TARGETS_MANAGE);
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);
  const query = useBrands(range, { enabled: canView });
  const [draft, setDraft] = useState<SlabDraft | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (draft === null || draft.brand.trim() === '' || draft.label.trim() === '' || !/^\d{1,14}(\.\d{1,2})?$/u.test(draft.threshold)) return;
    setBusy(true);
    try {
      await saveSlab(draft);
      await queryClient.invalidateQueries({ queryKey: ['cfo', 'brands'] });
      toast.add({ type: 'success', title: `Slab saved for ${draft.brand}` });
      setDraft(null);
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not save the slab', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (draft?.id === undefined) return;
    setBusy(true);
    try {
      await deleteSlab(draft.id);
      await queryClient.invalidateQueries({ queryKey: ['cfo', 'brands'] });
      toast.add({ type: 'success', title: 'Slab removed' });
      setDraft(null);
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not remove the slab', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (!canView) {
    return (
      <>
        <PageHeader description="Per principal: sales, margin, slabs and schemes." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view brand performance</EmptyTitle>
            <EmptyDescription>This needs the cfo.brand.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;

  return (
    <>
      <PageHeader
        description="Where the trade actually earns: each principal's sales, realisation, proxy margin and the distance to its next slab."
        action={canManage ? (
          <Button variant="outline" size="sm" onClick={() => { setDraft({ brand: data?.brands[0]?.brand ?? '', label: '', threshold: '', reward: '', active: true }); }}>
            <PlusIcon data-icon="inline-start" />
            Add slab
          </Button>
        ) : undefined}
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon-sm" aria-label="Refresh" disabled={query.isFetching} onClick={() => void query.refetch()}>
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
              setSearchParams((current) => { const p = new URLSearchParams(current); p.set('from', from); p.set('to', to); return p; }, { replace: true });
            }}
          />
          <span className="text-muted-foreground text-xs tabular-nums">{formatDate(range.from)} → {formatDate(range.to)} vs the same days last year</span>
          <span className="ml-auto"><ExportButton report="brands" range={range} /></span>
        </div>

        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.error ? <QueryErrorAlert error={query.error} subject="brand performance" onRetry={() => void query.refetch()} /> : null}

        {data && data.brands.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No brand sales in this period</EmptyTitle>
              <EmptyDescription>Brands come from each stock item&rsquo;s parent group in Tally.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          {(data?.brands ?? []).map((row) => (
            <Card key={row.brand} className="min-w-0">
              <CardHeader>
                <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  <span className="truncate">{row.brand}</span>
                  <Badge variant="secondary">{String(row.sharePct)}% of sales</Badge>
                </CardTitle>
                <CardAction><span className="text-sm font-semibold tabular-nums">{formatMoney(row.net)}</span></CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-muted-foreground text-xs">
                  {deltaText(row.delta)}
                  {row.realisation !== null ? ` · realisation ${formatMoney(row.realisation)}/unit${row.realisationLy !== null ? ` (was ${formatMoney(row.realisationLy)})` : ''}` : ''}
                  {row.marginPct !== null ? ` · margin ${String(row.marginPct)}%${row.margin !== null ? ` (${formatMoneyShort(Number(row.margin))})` : ''}` : ''}
                </p>
                {row.target !== null && row.achievementPct !== null ? (
                  <div className="flex items-center gap-2 text-xs tabular-nums">
                    <Progress value={Math.min(row.achievementPct, 100)} className="h-1.5 w-28" />
                    {String(row.achievementPct)}% of {formatMoney(row.target)}
                  </div>
                ) : null}
                {row.categories.length > 0 ? (
                  <MetricChart metric={categoryMetric(row)} kind="bar" options={{ legend: false, dataLabels: true }} className="h-36" />
                ) : null}
                {row.slabs.length > 0 ? (
                  <div className="flex flex-col gap-2 border-t pt-2">
                    {row.slabs.map((slab) => (
                      <Button
                        key={slab.id}
                        variant="ghost"
                        disabled={!canManage}
                        onClick={() => { setDraft({ id: slab.id, brand: slab.brand, label: slab.label, threshold: slab.threshold, reward: slab.reward, active: slab.active }); }}
                        className="h-auto flex-col items-stretch gap-1 px-2 py-1.5 text-left font-normal"
                      >
                        <span className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium">{slab.label}{slab.active ? '' : ' (inactive)'}</span>
                          <span className="tabular-nums">
                            {Number(slab.distance) <= 0
                              ? 'Attained'
                              : `${formatMoneyShort(Number(slab.distance))} to go · ${formatCount(slab.daysLeft)} days left`}
                          </span>
                        </span>
                        <Progress value={Math.min(slab.attainedPct, 100)} className="h-1.5" />
                        {slab.reward ? <span className="text-muted-foreground text-xs">{slab.reward} · basis: {slab.basis}, FY to date</span> : null}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Sheet open={draft !== null} onOpenChange={(open) => { if (!open) setDraft(null); }}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-md">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{draft?.id ? 'Edit slab' : 'New slab'}</SheetTitle>
            <SheetDescription>All or nothing at the boundary; the basis is sales until purchases join the projection.</SheetDescription>
          </SheetHeader>
          {draft ? (
            <div className="flex flex-col gap-3 px-4 py-4">
              <Field>
                <FieldLabel htmlFor="slab-brand">Brand</FieldLabel>
                <Input id="slab-brand" maxLength={120} value={draft.brand} onChange={(e) => { setDraft((d) => (d === null ? d : { ...d, brand: e.target.value })); }} />
              </Field>
              <Field>
                <FieldLabel htmlFor="slab-label">Slab</FieldLabel>
                <Input id="slab-label" maxLength={80} placeholder="FY28 volume slab" value={draft.label} onChange={(e) => { setDraft((d) => (d === null ? d : { ...d, label: e.target.value })); }} />
              </Field>
              <Field>
                <FieldLabel htmlFor="slab-threshold">Threshold</FieldLabel>
                <Input id="slab-threshold" inputMode="decimal" value={draft.threshold} onChange={(e) => { setDraft((d) => (d === null ? d : { ...d, threshold: e.target.value })); }} />
              </Field>
              <Field>
                <FieldLabel htmlFor="slab-reward">Reward</FieldLabel>
                <Input id="slab-reward" maxLength={200} placeholder="2% rebate on the whole year" value={draft.reward} onChange={(e) => { setDraft((d) => (d === null ? d : { ...d, reward: e.target.value })); }} />
              </Field>
              <span className="flex min-h-9 items-center gap-2">
                <Switch id="slab-active" checked={draft.active} onCheckedChange={(active) => { setDraft((d) => (d === null ? d : { ...d, active })); }} />
                <Label htmlFor="slab-active" className="text-sm">Active</Label>
              </span>
              <div className="flex items-center justify-between gap-2 pt-2">
                {draft.id ? <Button variant="outline" disabled={busy} onClick={() => void remove()}>Remove</Button> : <span />}
                <Button disabled={busy || draft.brand.trim() === '' || draft.label.trim() === '' || !/^\d{1,14}(\.\d{1,2})?$/u.test(draft.threshold)} onClick={() => void save()}>
                  {busy ? 'Saving' : 'Save'}
                </Button>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
