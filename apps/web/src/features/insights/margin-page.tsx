import { ArrowsClockwiseIcon, LockKeyIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DefinitionLink } from '@/components/shared/definition-panel';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatCount, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { ExportButton } from './export-button';
import { StepsWaterfall } from './growth-charts';
import { INSIGHT_PRESETS, rangeAsPickerValue, rangeFromParams, toApiDate } from './period';
import { useMargin, type MarginData } from './use-cfo';

/**
 * Margin (brief C2): the pocket-price waterfall from
 * the master's list rate down to pocket margin, always beside its
 * coverage -- the share of net the cost could actually be read on -- and
 * never a rupee of it without cfo.margin.view (K3). M13's zero tolerance:
 * grains sold below cost are named, not averaged away.
 */

type SliceRow = MarginData['slices'][number]['rows'][number];
type NegativeRow = MarginData['negativeGrains'][number];

const SLICE_COLUMNS: RecordColumn<SliceRow>[] = [
  { key: 'label', header: 'Name', cell: (row) => row.label },
  { key: 'net', header: 'Net', cell: (row) => formatMoney(row.net), numeric: true },
  { key: 'margin', header: 'Margin', cell: (row) => (row.margin === null ? '—' : formatMoney(row.margin)), numeric: true },
  { key: 'marginPct', header: 'Margin %', cell: (row) => (row.marginPct === null ? '—' : `${String(row.marginPct)}%`), numeric: true },
];

const NEGATIVE_COLUMNS: RecordColumn<NegativeRow>[] = [
  { key: 'day', header: 'Day', cell: (row) => formatDate(row.day) },
  { key: 'party', header: 'Customer', cell: (row) => row.party },
  { key: 'item', header: 'Item', cell: (row) => row.item },
  { key: 'net', header: 'Net', cell: (row) => formatMoney(row.net), numeric: true },
  { key: 'margin', header: 'Margin', cell: (row) => <span className="text-destructive tabular-nums">{formatMoney(row.margin)}</span>, numeric: true },
];

export function MarginPage() {
  const canView = usePermission(PERMISSIONS.CFO_MARGIN_VIEW);
  const [searchParams, setSearchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);
  const query = useMargin(range, {}, { enabled: canView });

  if (!canView) {
    return (
      <>
        <PageHeader description="The pocket-price waterfall, and where the margin sits." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view margin in rupees</EmptyTitle>
            <EmptyDescription>This needs the cfo.margin.view permission; your own book&rsquo;s percentage lives on My CFO.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;

  return (
    <>
      <PageHeader description="From the master's list rate down to pocket margin, on the confirmed Tally item-cost basis -- always beside its coverage." />
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
          <span className="text-muted-foreground text-xs tabular-nums">{formatDate(range.from)} → {formatDate(range.to)}</span>
          <span className="ml-auto"><ExportButton report="margin" range={range} /></span>
        </div>

        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.error ? <QueryErrorAlert error={query.error} subject="margin" onRetry={() => void query.refetch()} /> : null}

        {data ? (
          <>
            <KpiGrid
              columns={4}
              tiles={[
                { label: 'Pocket margin', value: formatMoney(data.waterfall.find((w) => w.key === 'margin')?.amount ?? '0'), info: <DefinitionLink id="M07" /> },
                { label: 'Pocket price', value: formatMoney(data.waterfall.find((w) => w.key === 'pocket')?.amount ?? '0'), info: <DefinitionLink id="M05" /> },
                { label: 'Cost coverage', value: `${String(data.coveragePct)}%`, note: 'of net sits on costed grains', info: <DefinitionLink id="M06" /> },
                { label: 'Sold below cost', value: formatCount(data.negativeGrains.length), note: 'grains named below', info: <DefinitionLink id="M13" /> },
              ]}
            />

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  The pocket-price waterfall
                  {data.coveragePct < 90 ? <Badge variant="outline">Coverage {String(data.coveragePct)}% — map costs on Data quality</Badge> : null}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <StepsWaterfall
                  steps={data.waterfall.map((w) => ({ name: w.label, value: Number(w.amount), total: w.key === 'list' || w.key === 'invoice' || w.key === 'pocket' || w.key === 'margin' }))}
                />
              </CardContent>
            </Card>

            <Tabs defaultValue="brand">
              <TabsList>
                {data.slices.map((s) => (
                  <TabsTrigger key={s.level} value={s.level}>By {s.label.toLowerCase()}</TabsTrigger>
                ))}
                <TabsTrigger value="negative">Below cost</TabsTrigger>
              </TabsList>
              {data.slices.map((s) => (
                <TabsContent key={s.level} value={s.level}>
                  <RecordTable
                    columns={SLICE_COLUMNS}
                    rows={[...s.rows]}
                    rowKey={(row) => row.key}
                    mobilePrimary={(row) => row.label}
                    mobileSupporting={(row) => `${formatMoney(row.net)} net${row.marginPct === null ? '' : ` · ${String(row.marginPct)}%`}`}
                  />
                </TabsContent>
              ))}
              <TabsContent value="negative">
                {data.negativeGrains.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Nothing sold below its cost in this period.</p>
                ) : (
                  <RecordTable
                    columns={NEGATIVE_COLUMNS}
                    rows={[...data.negativeGrains]}
                    rowKey={(row) => `${row.day}-${row.party}-${row.item}`}
                    mobilePrimary={(row) => `${row.party} · ${row.item}`}
                    mobileSupporting={(row) => `${formatDate(row.day)} · ${formatMoney(row.margin)}`}
                  />
                )}
              </TabsContent>
            </Tabs>
          </>
        ) : null}
      </div>
    </>
  );
}
