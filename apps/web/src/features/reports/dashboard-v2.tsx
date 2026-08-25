import { useState } from 'react';
import { LockKeyIcon, SlidersHorizontalIcon } from '@phosphor-icons/react';
import { DASHBOARD_KEYS, isDashboardKey, PERMISSIONS, type DashboardKey } from '@vyuha/shared';
import type { DateRange } from 'react-day-picker';
import { useSearchParams } from 'react-router';

import { PageHeader } from '@/components/shared/page-header';
import { TabsToolbar, TabsToolbarAction } from '@/components/shared/tabs-toolbar';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DateRangeField } from '@/features/attendance/pickers';
import { usePermission } from '@/lib/session/permissions';

import { boardFromParam, boardToParam, FINANCE_PRESET, OVERVIEW_PRESET, SALES_PRESET } from './dashboard-boards';
import { DashboardCustomiseSheet } from './dashboard-customise';
import { DASHBOARD_PRESETS, defaultRange } from './dashboard-v2.presets';
import { TileGrid } from './dashboard-tiles';
import { useDashboardLayouts } from './use-dashboard-layouts';

/**
 * Three boards, one machine. Every board -- the overview included -- is a
 * layout of tiles rendered by TileGrid: the KPI strip with honest loading
 * and error states, chart tiles whose segments drill to their reports with
 * the period riding along, and the tested sentence under each chart.
 *
 * The overview used to be a bespoke 550-line page titled "every chart shape
 * shadcn ships" -- a showroom for choosing forms, shipped as the front
 * door. It carried its own KPI arithmetic (which drifted from the registry
 * and showed zeros while loading), its own drill mapping (a second copy of
 * the shell's), and charts whose segments went nowhere. All of that is
 * gone: the overview is now `OVERVIEW_PRESET` through the same TileGrid as
 * the sales and finance boards, so there is exactly one implementation of
 * a figure, a drill, and a failure.
 */

const PRESETS: Record<DashboardKey, typeof OVERVIEW_PRESET> = {
  overview: OVERVIEW_PRESET,
  sales: SALES_PRESET,
  finance: FINANCE_PRESET,
};

const BOARD_LABELS: Record<DashboardKey, string> = {
  overview: 'Overview',
  sales: 'Sales',
  finance: 'Finance',
};

const BOARD_DESCRIPTIONS: Record<DashboardKey, string> = {
  overview:
    'The business at a glance: money coming in, money owed, the risks worth a call today. Every figure opens its report.',
  sales: 'The sales story over one period: what was invoiced, to whom, and how the order book moved.',
  finance: 'The money story: what is owed, how old it is, who pays late, and where the risk sits.',
};

/** The permission refusal, standing where the board would: the same Empty every screen refuses with. */
function RefusedEmpty({ description }: { description: string }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LockKeyIcon />
        </EmptyMedia>
        <EmptyTitle>Not yours to see</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** Six figures wide, so the label set is stable while the strip loads. */
const SKELETON_TILES = ['one', 'two', 'three', 'four', 'five', 'six'] as const;

/** The shapes the board resolves into: the headline strip, then the chart grid. */
function BoardSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading the dashboard"
      className="flex flex-col gap-4"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {SKELETON_TILES.map((key) => (
          <Skeleton key={key} className="h-22 w-full" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-56 w-full sm:h-64" />
        <Skeleton className="h-56 w-full sm:h-64" />
      </div>
    </div>
  );
}

export function ReportsDashboardV2() {
  const [searchParams, setSearchParams] = useSearchParams();
  const board = boardFromParam(searchParams.get('board'));
  // One gate for every board: report.view. Which tiles then stand is the
  // catalogue's answer per report -- a person without receivables.view sees
  // the receivables tiles absent, not a locked door over the whole page.
  const canBoards = usePermission(PERMISSIONS.REPORT_VIEW);
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [customising, setCustomising] = useState(false);
  const layouts = useDashboardLayouts(canBoards);

  const stored = layouts.data?.find((view) => view.dashboard === board)?.config ?? null;
  const layout = stored ?? PRESETS[board];

  const switchBoard = (next: string): void => {
    if (!isDashboardKey(next)) return;
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      const value = boardToParam(next);
      if (value === null) params.delete('board');
      else params.set('board', value);
      return params;
    });
  };

  return (
    <>
      <PageHeader description={BOARD_DESCRIPTIONS[board]} />

      <Tabs
        value={board}
        onValueChange={(value) => {
          switchBoard(String(value));
        }}
        className="gap-4"
      >
        <TabsToolbar
          list={
            <TabsList>
              {DASHBOARD_KEYS.map((key) => (
                <TabsTrigger key={key} value={key} className="px-3">
                  {BOARD_LABELS[key]}
                </TabsTrigger>
              ))}
            </TabsList>
          }
        >
          <TabsToolbarAction>
            <DateRangeField
              value={range}
              onValueChange={setRange}
              label="Period"
              presets={DASHBOARD_PRESETS}
              className="w-full sm:w-auto"
            />
            {canBoards ? (
              <Button
                variant="outline"
                onClick={() => {
                  setCustomising(true);
                }}
              >
                <SlidersHorizontalIcon data-icon="inline-start" />
                Customise
              </Button>
            ) : null}
          </TabsToolbarAction>

          {!canBoards ? (
            <RefusedEmpty description="The dashboard needs permission to view reports. Ask an administrator to widen your reports." />
          ) : layouts.isLoading ? (
            <BoardSkeleton />
          ) : (
            <TileGrid layout={layout} range={range} />
          )}
        </TabsToolbar>
      </Tabs>

      {canBoards ? (
        <DashboardCustomiseSheet
          board={board}
          open={customising}
          onOpenChange={setCustomising}
          current={layout}
          hasStored={stored !== null}
          range={range}
        />
      ) : null}
    </>
  );
}
