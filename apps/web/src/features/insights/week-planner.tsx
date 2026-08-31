import { useState } from 'react';
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { SectionHeading } from '@/components/shared/section-heading';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatCount, formatDate, formatMoney, formatMoneyShort } from '@/lib/format';

import { mondayOf, usePlanner } from './use-cfo';

/**
 * The week planner (CFO brief O5.2): five columns, one per weekday, each
 * with its theme and the names it would serve on today's reading, with the
 * rupees at stake per day and per owner -- the week's workload before
 * Monday. Read-only: the day itself writes the served log.
 */

function shiftWeek(monday: string, weeks: number): string {
  return new Date(Date.parse(monday) + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
}

export function WeekPlanner({ cap }: { cap: number }) {
  const [week, setWeek] = useState(() => shiftWeek(mondayOf(new Date().toISOString().slice(0, 10)), 0));
  const query = usePlanner(week, cap);
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
        <span className="text-muted-foreground text-xs">Today&rsquo;s reading; the day itself decides.</span>
      </div>

      {query.isPending ? <Skeleton className="h-64" /> : null}
      {query.error ? <QueryErrorAlert error={query.error} subject="week planner" onRetry={() => void query.refetch()} /> : null}

      {data ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {data.days.map((day) => (
              <div key={day.date} className="flex min-w-0 flex-col gap-2 border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{formatDate(day.date)}</span>
                  <Badge variant="secondary">{day.theme.label}</Badge>
                </div>
                <p className="text-muted-foreground text-xs">{day.theme.hint}</p>
                <p className="text-xs tabular-nums">{formatCount(day.rows.length)} names · {formatMoneyShort(Number(day.atStake))} at stake</p>
                {day.rows.length === 0 ? (
                  <p className="text-muted-foreground text-xs">Nothing qualifies on this theme today.</p>
                ) : (
                  <ol className="flex flex-col gap-1 text-sm">
                    {day.rows.map((row) => (
                      <li key={row.partyId} className="flex min-w-0 items-baseline justify-between gap-2">
                        <span className="truncate">{row.party}</span>
                        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatMoneyShort(Number(row.atStake))} · {row.ownerLabel}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>

          <SectionHeading title="Per owner" note="Names and rupees at stake across the week." />
          {data.byOwner.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing qualifies this week.</p>
          ) : (
            <KpiGrid
              columns={4}
              tiles={data.byOwner.map((o) => ({ label: o.ownerLabel, value: formatCount(o.names), note: `${formatMoney(o.atStake)} at stake` }))}
            />
          )}
        </>
      ) : null}
    </div>
  );
}
