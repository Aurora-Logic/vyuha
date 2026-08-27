import { useState } from 'react';
import { ArrowsClockwiseIcon, GridNineIcon, LockKeyIcon } from '@phosphor-icons/react';
import { useNavigate, useSearchParams } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { MatrixGrid } from '@/components/shared/matrix-grid';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useIsMobile } from '@/hooks/use-mobile';
import { apiRequest } from '@/lib/api/client';
import { formatCount, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { INSIGHT_PRESETS, rangeAsPickerValue, rangeFromParams, toApiDate } from './period';
import { ExportButton } from './export-button';
import { usePenetration, type PenetrationData } from './use-cfo';

/**
 * The penetration grid (brief Q2.10): customer x category, the whitespace
 * map. A filled cell is what they buy from us; an empty one is what they
 * buy from someone else -- styled as opportunity, and one click from a
 * task on the board.
 */

export function PenetrationPage() {
  const canView = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const canTask = usePermission(PERMISSIONS.CRM_TASK_MANAGE);
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const range = rangeFromParams(searchParams);
  const query = usePenetration(range, { enabled: canView });
  const [open, setOpen] = useState<{ partyId: string; party: string; category: string; filled: boolean } | null>(null);

  async function createTask(target: NonNullable<typeof open>) {
    try {
      await apiRequest('/tasks', {
        method: 'POST',
        body: {
          title: `Open ${target.category} with ${target.party}`,
          description: `${target.party} buys no ${target.category} from us in this period — whitespace on the penetration grid.`,
          priority: 'MEDIUM',
          subjectType: 'party',
          subjectId: target.partyId,
        },
      });
      toast.add({ type: 'success', title: 'Task created', description: `${target.party} · ${target.category}` });
      setOpen(null);
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not create the task', description: error instanceof Error ? error.message : 'Try again.' });
    }
  }

  if (!canView) {
    return (
      <>
        <PageHeader description="Who buys which category from us — and who buys it from someone else." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view the penetration grid</EmptyTitle>
            <EmptyDescription>This needs the cfo.sales.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data: PenetrationData | undefined = query.data;
  const cellOf = (partyId: string, category: string) => {
    const cell = data?.cells.find((c) => c.partyId === partyId && c.category === category);
    return cell === undefined ? undefined : { count: cell.count, amount: Number(cell.amount) };
  };
  const whitespace = data === undefined ? 0 : data.customers.length * (data.categories.length - 1) - data.cells.filter((c) => c.category !== 'Other').length;

  return (
    <>
      <PageHeader description="Customer by category. A filled cell is what they buy from us; an empty one is what they buy from someone else." />
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
              setSearchParams(
                (current) => {
                  const p = new URLSearchParams(current);
                  p.set('from', from);
                  p.set('to', to);
                  return p;
                },
                { replace: true },
              );
            }}
          />
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatDate(range.from)} → {formatDate(range.to)} · top {formatCount(data?.customers.length ?? 0)} customers
          </span>
          <span className="ml-auto"><ExportButton report="penetration" range={range} /></span>
        </div>

        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.error ? <QueryErrorAlert error={query.error} subject="penetration grid" onRetry={() => void query.refetch()} /> : null}

        {data && data.customers.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GridNineIcon />
              </EmptyMedia>
              <EmptyTitle>No inventory sales in this period</EmptyTitle>
              <EmptyDescription>The grid reads item lines on Sales vouchers. Widen the period, or wait for the next pull from Tally.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {data && data.customers.length > 0 ? (
          <>
            <KpiGrid
              columns={3}
              tiles={[
                { label: 'Customers on the grid', value: formatCount(data.customers.length) },
                { label: 'Whitespace cells', value: formatCount(whitespace), note: 'categories they buy elsewhere' },
                { label: 'Fully penetrated', value: formatCount(data.customers.filter((c) => c.filled >= data.categories.length - 1).length), note: 'buy every category from us' },
              ]}
            />
            <MatrixGrid
              rows={data.customers.map((c) => ({ key: c.partyId, label: c.party }))}
              columns={data.categories.map((c) => ({ key: c, label: c }))}
              cellOf={cellOf}
              emptyLabel="Opportunity"
              totals
              onCell={(partyId, category) => {
                const customer = data.customers.find((c) => c.partyId === partyId);
                if (customer) setOpen({ partyId, party: customer.party, category, filled: cellOf(partyId, category) !== undefined });
              }}
            />
          </>
        ) : null}
      </div>

      <Sheet open={open !== null} onOpenChange={(next) => { if (!next) setOpen(null); }}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{open ? `${open.party} · ${open.category}` : ''}</SheetTitle>
            <SheetDescription>
              {open?.filled
                ? `They buy ${open.category} from us: ${formatCount(cellOf(open.partyId, open.category)?.count ?? 0)} items, ${formatMoney((cellOf(open.partyId, open.category)?.amount ?? 0).toFixed(2))} in the period.`
                : `No ${open?.category ?? ''} from us in this period. Whoever supplies it, it is not you.`}
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 px-4 pb-6">
            {open && !open.filled && canTask ? (
              <Button onClick={() => void createTask(open)}>Create a task to open this line</Button>
            ) : null}
            {open ? (
              <Button variant="outline" onClick={() => void navigate(`/masters/vouchers?party=${open.partyId}&from=${range.from}&to=${range.to}`)}>
                Open their vouchers
              </Button>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
