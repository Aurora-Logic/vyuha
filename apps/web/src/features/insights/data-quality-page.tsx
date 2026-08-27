import { ArrowsClockwiseIcon, LockKeyIcon, ShieldCheckIcon } from '@phosphor-icons/react';
import { useNavigate } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatCount, formatDate } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { useDataQuality, type QualityCheckData } from './use-cfo';

/**
 * Data Quality (brief Q3): the screen that admits what is broken, which is
 * what makes every other screen defensible. One headline, twelve checks,
 * each with its value, its target, the fix, and where the records live.
 * A check that cannot run yet says so instead of reading zero.
 */

function valueText(check: QualityCheckData): string {
  if (check.value === null) return EMPTY_VALUE;
  return check.unit === 'pct' ? `${String(check.value)}%` : formatCount(check.value);
}

function targetText(check: QualityCheckData): string {
  return check.unit === 'pct' ? `≤ ${String(check.target)}%` : check.target === 0 ? 'none' : `≤ ${formatCount(check.target)}`;
}

function healthBadge(check: QualityCheckData) {
  if (check.health === null) return <Badge variant="outline">Not measurable yet</Badge>;
  if (check.health >= 1) return <Badge variant="secondary">On target</Badge>;
  if (check.health >= 0.6) return <Badge variant="outline">Needs attention</Badge>;
  return <Badge variant="destructive">Broken</Badge>;
}

export function DataQualityPage() {
  const canView = usePermission(PERMISSIONS.CFO_EXCEPTIONS_VIEW);
  const navigate = useNavigate();
  const query = useDataQuality({ enabled: canView });

  const columns: RecordColumn<QualityCheckData>[] = [
    { key: 'label', header: 'Check', cell: (row) => (
      <span className="flex flex-col">
        <span>{row.label}</span>
        {row.note ? <span className="text-muted-foreground text-xs">{row.note}</span> : null}
      </span>
    ) },
    { key: 'value', header: 'Now', cell: (row) => valueText(row), numeric: true },
    { key: 'target', header: 'Target', cell: (row) => targetText(row), numeric: true, secondary: true },
    { key: 'health', header: 'Health', cell: (row) => (
      <span className="flex items-center justify-end gap-2">
        {row.health === null ? null : <Progress value={Math.round(row.health * 100)} className="h-1.5 w-16" />}
        {healthBadge(row)}
      </span>
    ), numeric: true },
    { key: 'fix', header: 'Fix', cell: (row) => row.fix, secondary: true },
  ];

  if (!canView) {
    return (
      <>
        <PageHeader description="The screen that admits what is broken." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view data quality</EmptyTitle>
            <EmptyDescription>This needs the cfo.exceptions.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;
  const measured = data?.checks.filter((c) => c.health !== null) ?? [];
  const broken = measured.filter((c) => (c.health ?? 1) < 0.6).length;

  return (
    <>
      <PageHeader
        description="What the figures are built on, and where they are weak. Every check names its fix and opens the records behind it."
        action={
          <Button variant="outline" size="icon-sm" aria-label="Refresh" disabled={query.isFetching} onClick={() => void query.refetch()}>
            <ArrowsClockwiseIcon />
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.error ? <QueryErrorAlert error={query.error} subject="data quality" onRetry={() => void query.refetch()} /> : null}
        {data ? (
          <>
            <KpiGrid
              columns={4}
              tiles={[
                { label: 'Data health', value: data.headline === null ? EMPTY_VALUE : `${String(data.headline)}%`, note: `as of ${formatDate(data.asOf)}` },
                { label: 'Checks measured', value: formatCount(measured.length), note: `of ${formatCount(data.checks.length)}` },
                { label: 'On target', value: formatCount(measured.filter((c) => (c.health ?? 0) >= 1).length) },
                { label: 'Broken', value: formatCount(broken) },
              ]}
            />
            {data.checks.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ShieldCheckIcon />
                  </EmptyMedia>
                  <EmptyTitle>Nothing to check yet</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <RecordTable
                columns={columns}
                rows={[...data.checks]}
                rowKey={(row) => row.key}
                mobilePrimary={(row) => row.label}
                mobileStatus={(row) => healthBadge(row)}
                mobileSupporting={(row) => `${valueText(row)} now · target ${targetText(row)} · ${row.fix}`}
                onRowActivate={(row) => {
                  if (row.drill !== null) void navigate(row.drill);
                }}
              />
            )}
            <p className="text-muted-foreground text-xs">
              Trend over ninety days arrives with the nightly build. Health is each check&rsquo;s distance from its target, averaged over the checks that can run today.
            </p>
          </>
        ) : null}
      </div>
    </>
  );
}
