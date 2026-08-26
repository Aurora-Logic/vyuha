import { ArrowsClockwiseIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router';
import { type InsightArea, type WidgetKind } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatDate } from '@/lib/format';

import { useAreaInsights } from './api';
import { AREA_CONFIG, type AreaConfig } from './catalogue';
import { MetricCard } from './metric-card';
import { INSIGHT_PRESETS, rangeAsPickerValue, rangeFromParams, toApiDate } from './period';

/**
 * One prebuilt report page (owner, 26 Aug 2026, the Supabase shape): the
 * period toolbar, then the area's metric cards. The page is generic; what
 * differs per area is titled here, and which chart form a metric takes --
 * the data's job picks the form (dataviz §1), not the metric's author.
 */

function kindFor(config: AreaConfig, key: string): Exclude<WidgetKind, 'number'> {
  return config.lines.includes(key) ? 'line' : 'bar';
}

function CardsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading report" className="grid gap-4 lg:grid-cols-2">
      <Skeleton className="h-72 lg:col-span-2" />
      <Skeleton className="h-72" />
      <Skeleton className="h-72" />
    </div>
  );
}

// The area arrives as a prop from a literal route, not a URL param: the
// router names all four addresses, so a wrong one is an ordinary not-found
// rather than a redirect this page has to invent.
export function AreaPage({ area }: { area: InsightArea }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);
  const config = AREA_CONFIG[area];
  const query = useAreaInsights(area, range);

  return (
    <>
      <PageHeader description={config.description} />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Refresh"
            disabled={query.isFetching}
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
                  const nextParams = new URLSearchParams(current);
                  nextParams.set('from', from);
                  nextParams.set('to', to);
                  return nextParams;
                },
                { replace: true },
              );
            }}
          />
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatDate(range.from)} → {formatDate(range.to)}
          </span>
        </div>

        {query.isPending ? <CardsSkeleton /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="report"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {query.data.metrics.map((metric) => (
              <div key={metric.key} className={config.wide.includes(metric.key) ? 'lg:col-span-2' : undefined}>
                <MetricCard
                  metric={metric}
                  kind={kindFor(config, metric.key)}
                  from={query.data.from}
                  to={query.data.to}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
