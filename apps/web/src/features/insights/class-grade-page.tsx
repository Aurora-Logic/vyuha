import { useState } from 'react';
import { ArrowsClockwiseIcon, LockKeyIcon } from '@phosphor-icons/react';
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
import { ClassBadge, GradeBadge } from '@/components/shared/customer-badges';
import { DefinitionLink } from '@/components/shared/definition-panel';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { MatrixGrid } from '@/components/shared/matrix-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatCount, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { useClassGrade, useTiers, type ClassGradeData } from './use-cfo';

/**
 * Class x payment grade (brief Q2.2): the manual class down the side, the
 * system's grade across the top, count and rupees in every cell. The
 * A+ / D cell is the concentrated risk in one number -- your most
 * important customers who pay late -- and it is invisible when the two
 * gradings look alike.
 */

type Cell = ClassGradeData['cells'][number];

const PARTY_COLUMNS: RecordColumn<Cell['parties'][number]>[] = [
  { key: 'party', header: 'Customer', cell: (row) => row.party },
  { key: 'outstanding', header: 'Outstanding', cell: (row) => formatMoney(row.outstanding), numeric: true },
];

export function ClassGradePage() {
  const canView = usePermission(PERMISSIONS.CFO_RECEIVABLES_VIEW);
  const isMobile = useIsMobile();
  const query = useClassGrade({ enabled: canView });
  const tiers = useTiers({ enabled: canView });
  const [open, setOpen] = useState<Cell | null>(null);

  if (!canView) {
    return (
      <>
        <PageHeader description="Customer class against payment grade." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view this grid</EmptyTitle>
            <EmptyDescription>This needs the cfo.receivables.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;
  const tierOf = (code: string) => tiers.data?.find((t) => t.code === code);
  const find = (tierCode: string, grade: string) => data?.cells.find((c) => c.tierCode === tierCode && c.grade === grade);
  const concentrated = data?.cells.filter((c) => c.tierCode === 'A+' && (c.grade === 'D' || c.grade === 'E')) ?? [];

  return (
    <>
      <PageHeader
        description="How important they are to us, against how they pay. The top-left is where you earn; the top-right is your concentrated risk."
        action={
          <Button variant="outline" size="icon-sm" aria-label="Refresh" disabled={query.isFetching} onClick={() => void query.refetch()}>
            <ArrowsClockwiseIcon />
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.error ? <QueryErrorAlert error={query.error} subject="class and grade grid" onRetry={() => void query.refetch()} /> : null}
        {data ? (
          <>
            <KpiGrid
              columns={3}
              tiles={[
                { label: 'Key accounts paying late', value: formatCount(concentrated.reduce((n, c) => n + c.count, 0)), note: formatMoney(concentrated.reduce((s, c) => s + Number(c.amount), 0).toFixed(2)) },
                { label: 'Unclassed on the book', value: formatCount(data.unclassed.count), note: formatMoney(data.unclassed.amount) },
                { label: 'Classes', value: formatCount(data.classes.length), info: <DefinitionLink id="D18" /> },
              ]}
            />
            <MatrixGrid
              rows={data.classes.map((c) => ({ key: c, label: `${c} · ${tierOf(c)?.label ?? ''}` }))}
              columns={data.grades.map((g) => ({ key: g, label: `Pays ${g}` }))}
              rowHeader={(row) => (
                <span className="flex items-center gap-2">
                  <ClassBadge code={row.key} label={tierOf(row.key)?.label} token={tierOf(row.key)?.colourToken} />
                  <span className="truncate">{tierOf(row.key)?.label ?? row.key}</span>
                </span>
              )}
              columnHeader={(col) => (
                <span className="inline-flex items-center gap-1">
                  <GradeBadge grade={col.key} />
                </span>
              )}
              cellOf={(tierCode, grade) => {
                const cell = find(tierCode, grade);
                return cell === undefined ? undefined : { count: cell.count, amount: Number(cell.amount) };
              }}
              toneOf={(tierCode, grade) => {
                const trouble = grade === 'D' || grade === 'E';
                return { tone: trouble ? 'var(--destructive)' : 'var(--fresh-1)', emphasis: trouble && tierCode === 'A+' ? 0.55 : 0.35 };
              }}
              onCell={(tierCode, grade) => {
                const cell = find(tierCode, grade);
                if (cell) setOpen(cell);
              }}
              totals
            />
            <p className="text-muted-foreground text-xs">
              Classes are set by people with a reason and an effective date; grades are read nightly from payment behaviour (D18). The two never share a colour.
            </p>
          </>
        ) : null}
      </div>

      <Sheet open={open !== null} onOpenChange={(next) => { if (!next) setOpen(null); }}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-lg">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{open ? `Class ${open.tierCode} · pays ${open.grade}` : ''}</SheetTitle>
            <SheetDescription>{open ? `${formatCount(open.count)} customers · ${formatMoney(open.amount)} outstanding` : ''}</SheetDescription>
          </SheetHeader>
          {open ? (
            <div className="overflow-y-auto px-4 pb-6">
              <RecordTable
                columns={PARTY_COLUMNS}
                rows={[...open.parties]}
                rowKey={(row) => row.partyId}
                mobilePrimary={(row) => row.party}
                mobileSupporting={(row) => `${formatMoney(row.outstanding)} outstanding`}
              />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
