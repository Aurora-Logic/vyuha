import { useMemo, useState } from 'react';
import { ArrowsClockwiseIcon, LockKeyIcon, TargetIcon, TrophyIcon } from '@phosphor-icons/react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useIsMobile } from '@/hooks/use-mobile';
import { EMPTY_VALUE, formatCount, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { useMe } from '@/lib/session/use-session';

import { INSIGHT_PRESETS, rangeAsPickerValue, rangeFromParams, toApiDate } from './period';
import { ExportButton } from './export-button';
import { deltaText, saveTarget, useLeague, useTargets, type LeagueRowData } from './use-cfo';

/**
 * The league table (brief G4) and target entry (G5). K3's deliberate split
 * holds here: every holder of the module key sees the league; opening
 * another person's detail is team.view and arrives with the scorecard.
 * Rupee sales only -- margin never appears on this screen.
 */

function personLabel(row: Pick<LeagueRowData, 'ownerRef' | 'ownerEmail'>): string {
  if (row.ownerRef === 'HOUSE') return 'House';
  const email = row.ownerEmail;
  if (email === null) return 'Former user';
  const local = email.split('@')[0] ?? email;
  return local.length > 0 ? local : email;
}

/** The current month and its neighbours, as YYYY-MM options for the picker. */
function monthOptions(): { value: string; label: string }[] {
  const now = new Date();
  const options: { value: string; label: string }[] = [];
  for (let offset = -2; offset <= 3; offset += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const value = d.toISOString().slice(0, 7);
    options.push({
      value,
      label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    });
  }
  return options;
}

const LEAGUE_COLUMNS: RecordColumn<LeagueRowData & { rank: number }>[] = [
  { key: 'rank', header: '#', cell: (row) => row.rank, numeric: true, className: 'w-10' },
  { key: 'person', header: 'Person', cell: (row) => personLabel(row) },
  { key: 'book', header: 'Book', cell: (row) => formatCount(row.bookSize), numeric: true, secondary: true },
  { key: 'sales', header: 'Sales', cell: (row) => formatMoney(row.sales), numeric: true },
  { key: 'vsLy', header: 'vs last year', cell: (row) => deltaText(row.salesDelta), secondary: true },
  { key: 'collections', header: 'Collections', cell: (row) => formatMoney(row.collections), numeric: true },
  { key: 'overdue', header: 'Overdue', cell: (row) => formatMoney(row.overdue), numeric: true },
  // K3: rupees only under cfo.margin.view (the server blanks them
  // otherwise); the percentage appears on the caller's own row for everyone.
  {
    key: 'margin',
    header: 'Margin (proxy)',
    cell: (row) =>
      row.margin !== null ? (
        <span className="tabular-nums">{formatMoney(row.margin)}{row.marginPct === null ? '' : ` · ${String(row.marginPct)}%`}</span>
      ) : row.marginPct !== null ? (
        `${String(row.marginPct)}%`
      ) : (
        <span className="text-muted-foreground">{EMPTY_VALUE}</span>
      ),
    numeric: true,
    secondary: true,
  },
  {
    key: 'achievement',
    header: 'Target',
    cell: (row) =>
      row.target === null || row.achievementPct === null ? (
        <span className="text-muted-foreground">{EMPTY_VALUE}</span>
      ) : (
        <span className="flex items-center justify-end gap-2">
          <Progress value={Math.min(row.achievementPct, 100)} className="h-1.5 w-16" />
          <span className="tabular-nums">{row.achievementPct}%</span>
        </span>
      ),
    numeric: true,
  },
];

function TargetsSheet({ open, onOpenChange, owners }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owners: readonly Pick<LeagueRowData, 'ownerRef' | 'ownerEmail'>[];
}) {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const months = useMemo(() => monthOptions(), []);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const targets = useTargets(month, { enabled: open });

  const storedOf = (ownerRef: string): string =>
    targets.data?.find((t) => t.ownerRef === ownerRef)?.netTarget ?? '';
  const draftOf = (ownerRef: string): string => drafts[ownerRef] ?? storedOf(ownerRef).replace(/\.00$/u, '');

  async function save() {
    const changed = owners.filter((o) => {
      const draft = drafts[o.ownerRef];
      return draft !== undefined && draft.trim() !== '' && draft.trim() !== storedOf(o.ownerRef).replace(/\.00$/u, '');
    });
    if (changed.length === 0) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    try {
      for (const owner of changed) {
        await saveTarget({ ownerRef: owner.ownerRef, month, netTarget: (drafts[owner.ownerRef] ?? '').trim() });
      }
      await queryClient.invalidateQueries({ queryKey: ['cfo'] });
      toast.add({ type: 'success', title: 'Targets saved', description: `${formatCount(changed.length)} updated for ${months.find((m) => m.value === month)?.label ?? month}.` });
      setDrafts({});
      onOpenChange(false);
    } catch (error) {
      toast.add({
        type: 'error',
        title: 'Could not save targets',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Set targets</SheetTitle>
          <SheetDescription>
            Net sales for the month, per person. A window covering part of a month takes its share by days.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-6">
          <Select value={month} onValueChange={(value) => { setMonth(value); setDrafts({}); }}>
            <SelectTrigger className="w-full" aria-label="Target month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {targets.isPending ? <Skeleton className="h-24" /> : null}
          {targets.error ? <QueryErrorAlert error={targets.error} onRetry={() => void targets.refetch()} /> : null}
          {targets.isSuccess
            ? owners.map((owner) => (
                <label key={owner.ownerRef} className="flex items-center justify-between gap-3">
                  <span className="text-sm">{personLabel(owner)}</span>
                  <Input
                    className="w-36 text-right tabular-nums"
                    inputMode="numeric"
                    placeholder="No target"
                    value={draftOf(owner.ownerRef)}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [owner.ownerRef]: event.target.value }))
                    }
                  />
                </label>
              ))
            : null}

          <Button onClick={() => void save()} disabled={saving || targets.isPending}>
            {saving ? 'Saving' : 'Save targets'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function TeamPage() {
  const canView = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const canSetTargets = usePermission(PERMISSIONS.CFO_TARGETS_MANAGE);
  const canTeam = usePermission(PERMISSIONS.CFO_TEAM_VIEW);
  const me = useMe().data;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);
  const league = useLeague(range, { enabled: canView });
  const [targetsOpen, setTargetsOpen] = useState(false);

  if (!canView) {
    return (
      <>
        <PageHeader description="The league table: every book priced the same way." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view the sales team</EmptyTitle>
            <EmptyDescription>This needs the cfo.sales.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const rows = (league.data ?? []).map((row, index) => ({ ...row, rank: index + 1 }));

  return (
    <>
      <PageHeader
        description="Every book priced the same way: sales, collections, overdue, and the month's target."
        action={
          canSetTargets ? (
            <Button variant="outline" onClick={() => setTargetsOpen(true)}>
              <TargetIcon />
              Set targets
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Refresh"
            disabled={league.isFetching}
            onClick={() => void league.refetch()}
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
                  const params = new URLSearchParams(current);
                  params.set('from', from);
                  params.set('to', to);
                  return params;
                },
                { replace: true },
              );
            }}
          />
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatDate(range.from)} → {formatDate(range.to)} vs the same days last year
          </span>
          <span className="ml-auto"><ExportButton report="league" range={range} /></span>
        </div>

        {league.isPending ? <Skeleton className="h-64" /> : null}
        {league.error ? <QueryErrorAlert error={league.error} onRetry={() => void league.refetch()} /> : null}

        {league.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TrophyIcon />
              </EmptyMedia>
              <EmptyTitle>No books to rank yet</EmptyTitle>
              <EmptyDescription>
                The league fills as customers are assigned owners — relationship managers on parties, or
                the CFO owner map.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <RecordTable
            columns={LEAGUE_COLUMNS}
            rows={rows}
            rowKey={(row) => row.ownerRef}
            // K3: the league is everyone's; the scorecard behind a row is
            // team.view, or your own.
            onRowActivate={(row) => {
              const self = me?.user.id !== undefined && row.ownerRef === `user:${me.user.id}`;
              if (canTeam || self) void navigate(`/reports/team/${encodeURIComponent(row.ownerRef)}`);
            }}
            mobilePrimary={(row) => `${String(row.rank)}. ${personLabel(row)}`}
            mobileStatus={(row) =>
              row.achievementPct === null ? null : <span className="tabular-nums">{row.achievementPct}% of target</span>
            }
            mobileSupporting={(row) =>
              `${formatMoney(row.sales)} sales · ${formatMoney(row.collections)} collected · ${formatMoney(row.overdue)} overdue`
            }
          />
        ) : null}
      </div>

      <TargetsSheet open={targetsOpen} onOpenChange={setTargetsOpen} owners={league.data ?? []} />
    </>
  );
}
