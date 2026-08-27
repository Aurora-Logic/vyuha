import { useState } from 'react';
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatCount, formatDate, formatMoney } from '@/lib/format';

import { DESK_OUTCOME_LABELS, mondayOf, useWeekClose, type WeekCloseData } from './use-cfo';

/**
 * The week close (CFO brief O5.3), the Saturday screen: called against
 * planned, outcomes by type, rupees collected against rupees targeted,
 * orders won, what rolls over, owner-wise completion.
 */

type Outcome = WeekCloseData['outcomes'][number];
type Rollover = WeekCloseData['rollovers'][number];
type Owner = WeekCloseData['byOwner'][number];

const OUTCOME_COLUMNS: RecordColumn<Outcome>[] = [
  { key: 'outcome', header: 'Outcome', cell: (row) => DESK_OUTCOME_LABELS[row.outcome] ?? row.outcome },
  { key: 'count', header: 'Count', cell: (row) => formatCount(row.count), numeric: true },
  { key: 'amount', header: 'Amount', cell: (row) => formatMoney(row.amount), numeric: true },
];

const ROLLOVER_COLUMNS: RecordColumn<Rollover>[] = [
  { key: 'party', header: 'Customer', cell: (row) => row.party },
  { key: 'reason', header: 'Listed for', cell: (row) => row.reason, secondary: true },
  { key: 'atStake', header: 'At stake', cell: (row) => formatMoney(row.atStake), numeric: true },
];

const OWNER_COLUMNS: RecordColumn<Owner>[] = [
  { key: 'owner', header: 'Owner', cell: (row) => row.ownerLabel },
  { key: 'planned', header: 'Planned', cell: (row) => formatCount(row.planned), numeric: true },
  { key: 'called', header: 'Called', cell: (row) => formatCount(row.called), numeric: true },
  { key: 'completion', header: 'Completion', cell: (row) => (row.planned === 0 ? '—' : `${String(Math.round((row.called / row.planned) * 100))}%`), numeric: true },
];

function shiftWeek(monday: string, weeks: number): string {
  return new Date(Date.parse(monday) + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
}

export function WeekClose() {
  const navigate = useNavigate();
  const [week, setWeek] = useState(() => mondayOf(new Date().toISOString().slice(0, 10)));
  const query = useWeekClose(week);
  const data = query.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon-sm" aria-label="Previous week" onClick={() => { setWeek((w) => shiftWeek(w, -1)); }}>
          <CaretLeftIcon />
        </Button>
        <span className="text-sm tabular-nums">Week of {formatDate(week)}</span>
        <Button variant="outline" size="icon-sm" aria-label="Next week" onClick={() => { setWeek((w) => shiftWeek(w, 1)); }}>
          <CaretRightIcon />
        </Button>
      </div>

      {query.isPending ? <Skeleton className="h-48" /> : null}
      {query.error ? <QueryErrorAlert error={query.error} subject="week close" onRetry={() => void query.refetch()} /> : null}

      {data ? (
        <>
          <KpiGrid
            columns={4}
            tiles={[
              { label: 'Called vs planned', value: `${formatCount(data.called)} / ${formatCount(data.planned)}` },
              { label: 'Collected vs targeted', value: formatMoney(data.collected), note: `of ${formatMoney(data.targeted)} at stake` },
              { label: 'Orders won', value: formatCount(data.ordersWon.count), note: formatMoney(data.ordersWon.value) },
              { label: 'Rolls over', value: formatCount(data.rollovers.length), note: 'served, no outcome' },
            ]}
          />

          <SectionHeading title="Outcomes by type" />
          {data.outcomes.length === 0 ? (
            <p className="text-muted-foreground text-sm">No outcomes logged this week.</p>
          ) : (
            <RecordTable columns={OUTCOME_COLUMNS} rows={[...data.outcomes]} rowKey={(r) => r.outcome} mobilePrimary={(r) => DESK_OUTCOME_LABELS[r.outcome] ?? r.outcome} mobileSupporting={(r) => `${formatCount(r.count)} · ${formatMoney(r.amount)}`} />
          )}

          <SectionHeading title="Rolls over into next week" note="Served this week, no outcome logged." />
          {data.rollovers.length === 0 ? (
            <p className="text-muted-foreground text-sm">Everything served was answered.</p>
          ) : (
            <RecordTable
              columns={ROLLOVER_COLUMNS}
              rows={[...data.rollovers]}
              rowKey={(r) => r.partyId}
              mobilePrimary={(r) => r.party}
              mobileSupporting={(r) => `${r.reason} · ${formatMoney(r.atStake)}`}
              onRowActivate={(r) => void navigate(`/masters/vouchers?party=${r.partyId}`)}
            />
          )}

          <SectionHeading title="Owner-wise completion" />
          {data.byOwner.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing was planned this week.</p>
          ) : (
            <RecordTable columns={OWNER_COLUMNS} rows={[...data.byOwner]} rowKey={(r) => r.ownerRef} mobilePrimary={(r) => r.ownerLabel} mobileSupporting={(r) => `${formatCount(r.called)} of ${formatCount(r.planned)} called`} />
          )}
        </>
      ) : null}
    </div>
  );
}
