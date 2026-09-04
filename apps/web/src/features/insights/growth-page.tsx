import { useState } from 'react';
import { ArrowsClockwiseIcon, LockKeyIcon } from '@phosphor-icons/react';
import { useNavigate, useSearchParams } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { DefinitionLink } from '@/components/shared/definition-panel';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatCount, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { rangeFromParams } from './period';
import { BridgeWaterfall, MovementMatrix } from './growth-charts';
import { PeriodRangeField } from './period-field';
import { STATES } from './movement-states';
import { useGrowthBridge, useMovement, type MovementCell } from './use-cfo';

/**
 * Growth (brief D1 + D2, Phase 3): where the change came from, then who it
 * happened to. The bridge's factors sum to the change exactly -- the page
 * refuses to draw a bridge whose reconciliation failed, per Q1.6 rule five
 * -- and every matrix cell opens the named list behind it, because a number
 * that cannot be attributed to a name belongs in a pack, not on a screen.
 */

const PARTY_COLUMNS: RecordColumn<MovementCell['parties'][number]>[] = [
  { key: 'party', header: 'Customer', cell: (row) => row.party },
  { key: 'thisYear', header: 'This period', cell: (row) => formatMoney(row.thisYear), numeric: true },
  { key: 'lastYear', header: 'Last year', cell: (row) => formatMoney(row.lastYear), numeric: true },
];

export function GrowthPage() {
  const canView = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const isMobile = useIsMobile();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const range = rangeFromParams(searchParams);
  const bridge = useGrowthBridge(range, { enabled: canView });
  const movement = useMovement(range, { enabled: canView });
  const [openCell, setOpenCell] = useState<MovementCell | null>(null);

  if (!canView) {
    return (
      <>
        <PageHeader description="Where the growth came from, and who it happened to." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view growth</EmptyTitle>
            <EmptyDescription>This needs the cfo.sales.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader description="Where the change came from — volume, price, mix, new and lost customers — and the movement matrix naming who it happened to." />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Refresh"
            disabled={bridge.isFetching || movement.isFetching}
            onClick={() => {
              void bridge.refetch();
              void movement.refetch();
            }}
          >
            <ArrowsClockwiseIcon />
          </Button>
          <PeriodRangeField range={range} />
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatDate(range.from)} → {formatDate(range.to)} vs the same days last year
          </span>
        </div>

        {bridge.isPending || movement.isPending ? <Skeleton className="h-64" /> : null}
        {bridge.isError ? (
          <QueryErrorAlert error={bridge.error} subject="growth bridge" onRetry={() => void bridge.refetch()} />
        ) : null}
        {movement.isError ? (
          <QueryErrorAlert error={movement.error} subject="movement matrix" onRetry={() => void movement.refetch()} />
        ) : null}

        {bridge.data ? (
          bridge.data.reconciliationError > 0.01 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>The bridge does not reconcile</EmptyTitle>
                <EmptyDescription>
                  Its factors do not sum to the actual change, so it is not shown — a decorative bridge is
                  worse than none (Q1.6). This is a defect; report it.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Card data-metric="growth-bridge">
              <CardHeader>
                <CardTitle className="flex items-center gap-1 text-sm font-medium">
                  {formatMoney(bridge.data.lastYear.toFixed(2))} → {formatMoney(bridge.data.thisYear.toFixed(2))}
                  <DefinitionLink id="X01" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <BridgeWaterfall bridge={bridge.data} />
              </CardContent>
            </Card>
          )
        ) : null}

        {movement.data ? (
          <Card data-metric="movement-matrix">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Customer movement</CardTitle>
            </CardHeader>
            <CardContent>
              <MovementMatrix cells={movement.data.cells} onCell={setOpenCell} />
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Sheet
        open={openCell !== null}
        onOpenChange={(next) => {
          if (!next) setOpenCell(null);
        }}
      >
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-lg">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>
              {STATES.find((s) => s.key === openCell?.state)?.label} · {openCell?.band} band
            </SheetTitle>
            <SheetDescription>
              {formatCount(openCell?.count ?? 0)} customers · {formatMoney(openCell?.amount ?? '0')}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {openCell ? (
              <RecordTable
                columns={PARTY_COLUMNS}
                rows={[...openCell.parties]}
                rowKey={(row) => row.partyId}
                // R1: every drill terminates at a voucher.
                onRowActivate={(row) => void navigate(`/masters/vouchers?party=${row.partyId}&from=${range.from}&to=${range.to}`)}
                mobilePrimary={(row) => row.party}
                mobileSupporting={(row) => `${formatMoney(row.thisYear)} vs ${formatMoney(row.lastYear)}`}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
