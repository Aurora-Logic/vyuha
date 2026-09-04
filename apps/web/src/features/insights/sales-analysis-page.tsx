import { Fragment, useState } from 'react';
import { ArrowsClockwiseIcon, LockKeyIcon, XIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DefinitionLink } from '@/components/shared/definition-panel';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPicker } from '@/components/shared/record-picker';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatCount, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import type { Metric } from './api';
import { MetricChart } from './metric-card';
import { rangeFromParams } from './period';
import { ExportButton } from './export-button';
import { PeriodRangeField } from './period-field';
import { deltaText, useSalesAnalysis, useTiers, type BreakdownRowData, type SalesAnalysisData, type SalesScope } from './use-cfo';

/**
 * Sales Analysis, level-aware (brief B3): one screen at every scope.
 * Company is the empty scope; drilling into a brand, a person, a customer
 * or a product adds a filter that carries down and shows in the breadcrumb,
 * each step clickable back (R1). The unassigned bucket travels in the
 * footer as the data-quality KPI B3 asks for, never silently dropped.
 */

const SCOPE_KEYS = ['brand', 'class', 'person', 'party', 'item'] as const;
type ScopeKey = (typeof SCOPE_KEYS)[number];

function scopeFromParams(params: URLSearchParams): SalesScope {
  const scope: SalesScope = {};
  for (const key of SCOPE_KEYS) {
    const value = params.get(key);
    if (value !== null && value !== '') scope[key] = value;
  }
  return scope;
}

function trendMetric(data: SalesAnalysisData): Metric {
  return {
    key: 'sales-trend',
    label: 'Net sales',
    hint: 'Net sales per day at this scope, against the same days last year.',
    unit: 'money',
    headline: data.summary.net,
    series: [
      { key: 'net', label: 'This period' },
      { key: 'lastYear', label: 'Same days last year' },
    ],
    points: data.trend.map((p) => ({ t: p.t, net: p.net, lastYear: p.lastYear })),
  };
}

function rankMetric(level: string, rows: readonly BreakdownRowData[]): Metric {
  const top = rows.slice(0, 15);
  return {
    key: `by-${level}`,
    label: `By ${level}`,
    hint: `Net sales for the period split by ${level}; the chart draws the top fifteen, the table has the rest.`,
    unit: 'money',
    headline: rows.reduce((sum, r) => sum + Number(r.net), 0).toFixed(2),
    series: [{ key: 'net', label: 'Net sales' }],
    points: top.map((r) => ({ t: r.label, net: Number(r.net) })),
    xKind: 'category',
  };
}

const ROW_COLUMNS: RecordColumn<BreakdownRowData>[] = [
  { key: 'label', header: 'Name', cell: (row) => row.label },
  { key: 'net', header: 'Net sales', cell: (row) => formatMoney(row.net), numeric: true },
  { key: 'lastYear', header: 'Last year', cell: (row) => formatMoney(row.lastYear), numeric: true, secondary: true },
  { key: 'qty', header: 'Qty', cell: (row) => formatCount(Math.round(Number(row.qty))), numeric: true, secondary: true },
  { key: 'vouchers', header: 'Vouchers', cell: (row) => formatCount(row.vouchers), numeric: true, secondary: true },
];

export function SalesAnalysisPage() {
  const canView = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const [searchParams, setSearchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);
  const scope = scopeFromParams(searchParams);
  const query = useSalesAnalysis(range, scope, { enabled: canView });
  const tiers = useTiers({ enabled: canView });
  const [tab, setTab] = useState<string | null>(null);

  function setParams(mutate: (params: URLSearchParams) => void) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        mutate(next);
        return next;
      },
      { replace: true },
    );
  }
  /** Drill: fix one more level; the breadcrumb grows by a step. */
  function drill(level: ScopeKey, key: string) {
    setParams((p) => {
      p.set(level, key);
    });
    setTab(null);
  }
  /** Climb: clear this level and every level fixed after it. */
  function climbTo(level: ScopeKey | null) {
    setParams((p) => {
      let clear = level === null;
      for (const key of SCOPE_KEYS) {
        if (clear) p.delete(key);
        if (key === level) clear = true;
      }
    });
    setTab(null);
  }

  if (!canView) {
    return (
      <>
        <PageHeader description="One sales engine at every scope: company, brand, person, customer, product." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view sales analysis</EmptyTitle>
            <EmptyDescription>This needs the cfo.sales.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;
  const crumbs = data?.scope ?? [];
  const breakdowns = data?.breakdowns ?? [];
  const activeLevel = tab ?? breakdowns[0]?.level ?? '';
  const active = breakdowns.find((b) => b.level === activeLevel);
  const tableTotal = active?.rows.reduce((sum, r) => sum + Number(r.net), 0) ?? 0;
  const ties = data !== undefined && Math.abs(tableTotal - Number(data.summary.net)) < 0.005;

  return (
    <>
      <PageHeader description="One sales engine at every scope. Drill into a brand, a person, a customer or a product; the path stays clickable." />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Refresh"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <ArrowsClockwiseIcon />
          </Button>
          <PeriodRangeField range={range} />
          {/* P6: the class as a slicer, membership as of the window's end. */}
          <Select
            value={scope.class ?? '__all__'}
            onValueChange={(value) => {
              if (value === null) return;
              setParams((p) => {
                if (value === '__all__') p.delete('class');
                else p.set('class', value);
              });
              setTab(null);
            }}
          >
            <SelectTrigger className="w-36" aria-label="Customer class">
              <SelectValue>{(value: string) => (value === '__all__' ? 'All classes' : `Class ${value}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All classes</SelectItem>
              {(tiers.data ?? []).map((tier) => (
                <SelectItem key={tier.code} value={tier.code}>{tier.code} · {tier.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatDate(range.from)} → {formatDate(range.to)} vs the same days last year
          </span>
          <span className="ml-auto"><ExportButton report="sales-analysis" range={range} scope={{ ...scope }} /></span>
        </div>

        {/* The level, as a breadcrumb: Company › C&S › Rajesh, every step clickable (B3). */}
        <div className="flex flex-wrap items-center gap-3">
          <Breadcrumb aria-label="Scope">
            <BreadcrumbList>
              <BreadcrumbItem>
                {crumbs.length === 0 ? (
                  <BreadcrumbPage>Company</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Button variant="link" className="h-auto p-0" onClick={() => { climbTo(null); }} />}>
                    Company
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {crumbs.map((crumb, index) => {
                const last = index === crumbs.length - 1;
                return (
                  <Fragment key={crumb.level}>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      {last ? (
                        <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink
                          render={
                            <Button
                              variant="link"
                              className="h-auto p-0"
                              onClick={() => {
                                climbTo(crumb.level as ScopeKey);
                              }}
                            />
                          }
                        >
                          {crumb.label}
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
          {/* Filters as removable chips (R1). */}
          {crumbs.map((crumb) => (
            <Badge key={crumb.level} variant="secondary" className="gap-1 pr-1">
              {crumb.label}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${crumb.label}`}
                onClick={() => {
                  setParams((p) => {
                    p.delete(crumb.level);
                  });
                  setTab(null);
                }}
              >
                <XIcon />
              </Button>
            </Badge>
          ))}
          {active !== undefined && active.rows.length > 0 ? (
            <RecordPicker
              label={`Go to ${active.label.toLowerCase()}`}
              placeholder={`Go to ${active.label.toLowerCase()}`}
              className="w-56"
              value={null}
              options={active.rows.map((r) => ({ id: r.key, label: r.label, hint: formatMoney(r.net) }))}
              onValueChange={(picked) => {
                if (picked !== null) drill(active.level as ScopeKey, picked.id);
              }}
            />
          ) : null}
        </div>

        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.error ? <QueryErrorAlert error={query.error} subject="sales analysis" onRetry={() => void query.refetch()} /> : null}

        {data ? (
          <>
            <KpiGrid
              columns={5}
              tiles={[
                { label: 'Net sales', value: formatMoney(data.summary.net), note: deltaText(data.summary.delta), info: <DefinitionLink id="R05" /> },
                { label: 'Same days last year', value: formatMoney(data.summary.lastYear) },
                { label: 'Customers', value: formatCount(data.summary.customers), info: <DefinitionLink id="C01" /> },
                { label: 'Vouchers', value: formatCount(data.summary.vouchers) },
                { label: 'Quantity', value: formatCount(Math.round(Number(data.summary.qty))), info: <DefinitionLink id="R11" /> },
              ]}
            />

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Net sales by day, against the same days last year</CardTitle>
              </CardHeader>
              <CardContent>
                {data.trend.length === 0 ? (
                  <p className="text-muted-foreground flex h-40 items-center justify-center text-sm">Nothing sold in this scope for the period.</p>
                ) : (
                  <MetricChart metric={trendMetric(data)} kind="line" options={{ legend: true, dataLabels: false }} className="h-56" />
                )}
              </CardContent>
            </Card>

            {breakdowns.length > 0 ? (
              <Tabs value={activeLevel} onValueChange={(value) => { setTab(String(value)); }}>
                <TabsList>
                  {breakdowns.map((b) => (
                    <TabsTrigger key={b.level} value={b.level}>By {b.label.toLowerCase()}</TabsTrigger>
                  ))}
                </TabsList>
                {breakdowns.map((b) => (
                  <TabsContent key={b.level} value={b.level} className="flex flex-col gap-4">
                    {b.rows.length === 0 ? (
                      <p className="text-muted-foreground text-sm">Nothing to rank here.</p>
                    ) : (
                      <>
                        <Card>
                          <CardHeader>
                            <CardTitle className="text-sm font-medium">Top {formatCount(Math.min(15, b.rows.length))} by net sales</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <MetricChart
                              metric={rankMetric(b.label.toLowerCase(), b.rows)}
                              kind="barh"
                              options={{ legend: false, dataLabels: true, xOrder: 'natural' }}
                              className={b.rows.length > 8 ? 'h-96' : 'h-64'}
                              onActivate={(label) => {
                                const row = b.rows.find((r) => r.label === label);
                                if (row) drill(b.level as ScopeKey, row.key);
                              }}
                            />
                          </CardContent>
                        </Card>
                        {/* The full table, always (R3), and the badge that says it ties. */}
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground text-xs">
                            {formatCount(b.rows.length)} rows · total {formatMoney(tableTotal.toFixed(2))}
                          </span>
                          <Badge variant={ties ? 'secondary' : 'destructive'}>{ties ? 'Ties to the summary' : 'Does not tie'}</Badge>
                        </div>
                        <RecordTable
                          columns={ROW_COLUMNS}
                          rows={[...b.rows]}
                          rowKey={(row) => row.key}
                          mobilePrimary={(row) => row.label}
                          mobileSupporting={(row) => `${formatMoney(row.net)} · ${formatCount(row.vouchers)} vouchers`}
                          onRowActivate={(row) => {
                            drill(b.level as ScopeKey, row.key);
                          }}
                        />
                      </>
                    )}
                  </TabsContent>
                ))}
              </Tabs>
            ) : null}

            {/* B3's footer: the unassigned bucket is a data-quality KPI, never hidden. */}
            <p className="text-muted-foreground border-t pt-3 text-xs">
              Unassigned sales this period: {formatMoney(data.summary.unassignedNet)} ({String(data.summary.unassignedPct)}% of the company). Assign owners in the CFO owner map to bring this to zero.
            </p>
          </>
        ) : null}
      </div>
    </>
  );
}
