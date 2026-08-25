import { useMemo, useRef, useState } from 'react';
import { ArrowRightIcon, DatabaseIcon, InfoIcon } from '@phosphor-icons/react';
import { subDays } from 'date-fns';
import { Link } from 'react-router';

import { PERMISSIONS } from '@vyuha/shared';
import type { DateRange } from 'react-day-picker';

import { ChartCard } from '@/components/shared/chart-card';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { toDateParam } from '@/features/attendance/format';
import { formatCount } from '@/lib/format';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { SampleDataNotice } from '@/features/attendance/sample-data-notice';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermissions } from '@/lib/session/permissions';

import { AttendanceTrendChart, LateArrivalsChart, TeamHoursChart } from './charts';
import {
  attendanceTrend,
  dateRange,
  attendanceInsight,
  hasValues,
  lateArrivals,
  lateInsight,
  teamHours,
  teamHoursInsight,
  summarise,
} from './series';
import { DASHBOARD_PRESETS } from '@/features/reports/dashboard-v2.presets';

import { useAttendanceRange } from './use-attendance-range';
import { useChartIntro } from './use-chart-motion';

/**
 * REQ-K-01, the part of it today's data can answer honestly.
 *
 * Everyone sees their own day, their own month, and the shape of their own
 * hours. Anyone who may look beyond themselves also sees the organisation's
 * day and two charts over a period they choose - all scoped by the server
 * rather than by this component, since the same `/attendance/days` call with
 * no employee filter returns exactly what the caller is allowed to see.
 *
 * What is deliberately absent: leave balances, pending approvals and unlocked
 * periods. REQ-K-01 asks for all three and Phase 2 builds the endpoints they
 * read. A tile showing a plausible zero is indistinguishable from a tile
 * showing a true zero, and the first one is a lie that survives until somebody
 * trusts it - so the screen says out loud what it cannot show, at the bottom,
 * rather than filling the gap.
 *
 * The same rule governs the charts. Every series here is counted from rows the
 * server sent for the period on screen; there is no target line on the late
 * chart because no endpoint carries a target, and no stacked overtime on the
 * hours chart because the contract does not say whether worked minutes already
 * contain it.
 */

/** Label, value, and optionally the glyph the figure's subject wears elsewhere (the flag). */

/**
 * The strip's own shape, to the pixel that matters.
 *
 * Measured rather than eyeballed: with the old proportions the page dropped
 * 35px when the figures arrived, which on a screen somebody opens ten times a
 * day is a flinch every time.
 */

/** The one-line "how today went" row, at the height it will be. */
/** A figure and its label, inline, for the row that describes today. */
/**
 * The surface a chart sits on: one border, a caption, and the plot.
 *
 * The caption is inside the border rather than above it because the section
 * already has a heading, and a second heading outside would read as a second
 * section. It is text, not a card header - nothing here nests a surface in a
 * surface.
 */

/**
 * Emil Kowalski's press feedback, spelled out rather than added to the shared
 * Button: components/ui is vendored shadcn source and changing it there would
 * be reverted by the next `shadcn add --diff`. The transition list restates
 * the button's own so tailwind-merge does not drop the colour transitions when
 * it resolves the two `transition-*` classes.
 */

export function DashboardPage() {
  const granted = usePermissions();

  const canSeeOthers =
    granted.has(PERMISSIONS.ATTENDANCE_VIEW_ALL) || granted.has(PERMISSIONS.ATTENDANCE_VIEW_TEAM);

  const [range, setRange] = useState<DateRange>(() => ({
    from: subDays(new Date(), 29),
    to: new Date(),
  }));
  const rangeRef = useRef<HTMLDivElement>(null);

  // PRD section 6.4: Alt+F2 changes the period.
  useShortcut({
    id: 'dashboard.period',
    keys: 'alt+f2',
    label: 'Change period',
    scope: 'screen',
    run: () => {
      rangeRef.current?.querySelector<HTMLElement>('button')?.click();
    },
  });

  const now = new Date();
  const today = toDateParam(now);
  const rangeFrom = toDateParam(range.from ?? subDays(now, 29));
  const rangeTo = toDateParam(range.to ?? now);
  const spanDays = dateRange(rangeFrom, rangeTo).length;

  // The organisation's day, and the organisation's period. Two queries rather
  // than one slice of the other: the period can run past what the list
  // endpoint will return in twelve pages, and today's counts must never be
  // computed from a range that came back short.
  const orgToday = useAttendanceRange({ from: today, to: today }, { enabled: canSeeOthers });
  const orgRange = useAttendanceRange({ from: rangeFrom, to: rangeTo }, { enabled: canSeeOthers });

  const orgTodayDays = useMemo(() => orgToday.data?.value.days ?? [], [orgToday.data]);
  const orgTodayTotals = useMemo(() => summarise(orgTodayDays), [orgTodayDays]);

  const rangeDates = useMemo(() => dateRange(rangeFrom, rangeTo), [rangeFrom, rangeTo]);
  const orgRangeDays = useMemo(() => orgRange.data?.value.days ?? [], [orgRange.data]);
  const trendPoints = useMemo(
    () => attendanceTrend(orgRangeDays, rangeDates),
    [orgRangeDays, rangeDates],
  );
  const latePoints = useMemo(
    () => lateArrivals(orgRangeDays, rangeDates),
    [orgRangeDays, rangeDates],
  );
  const teamHoursPoints = useMemo(
    () => teamHours(orgRangeDays, rangeDates),
    [orgRangeDays, rangeDates],
  );
  const rangeTotals = useMemo(() => summarise(orgRangeDays), [orgRangeDays]);

  // One policy for every chart here: draw once, when the first data lands.
  const rangeIntro = useChartIntro(orgRange.isSuccess);

  const rangeComplete = orgRange.data?.value.complete ?? true;
  // `a ?? b ?? c` was wrong here and quietly so: `??` stops at the first
  // non-nullish value, so a personal query that returned real data (sample:
  // false) hid a sampled organisation query behind it, and the screen would
  // have shown invented rows with no notice.
  const showsSamples = [orgToday.data, orgRange.data].some((result) => result?.sample === true);
  // Nothing personal is left on this screen, so the only question is whether
  // this account may look beyond itself.
  const nothingToShow = !canSeeOthers;
  const atWorkToday = orgTodayTotals.present + orgTodayTotals.halfDay + orgTodayTotals.onDuty;
  const atWorkRange = rangeTotals.present + rangeTotals.halfDay + rangeTotals.onDuty;

  return (
    <>
      <PageHeader description="Today at a glance, and how the period behind it went." />

      {nothingToShow ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <DatabaseIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing to show yet</EmptyTitle>
            <EmptyDescription>
              This sign-in is not linked to an employee record and cannot see anyone else&apos;s
              attendance, so there is nothing to summarise.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {showsSamples ? <SampleDataNotice what="attendance day" /> : null}

          {/*
            The same shape as the reports dashboard: a row of figures, then a
            Card per question with the sentence its own series supports. It
            used to be SectionHeading over a bordered ChartPanel, which was the
            house pattern before the product settled on shadcn's, and it left
            the two dashboards looking like two products.

            It also used to open with Today and This month, so far -- the
            signed-in person's own status and their own hours -- above the team
            sections. Both already exist on /my-attendance, for any month
            rather than only this one, and the punch is a route of its own.
          */}
          <div className="flex flex-wrap items-center gap-2" ref={rangeRef}>
            <DateRangeField
              value={range}
              onValueChange={setRange}
              label="Period"
              presets={DASHBOARD_PRESETS}
              className="w-full sm:w-auto"
            />
            <ShortcutHint keys="alt+f2" className="hidden md:inline-flex" />
            <Button variant="outline" size="sm" nativeButton={false} className="ms-auto" render={<Link to="/team-attendance" />}>
              Team attendance
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          </div>

          <KpiGrid
            tiles={[
              { label: 'At work today', value: formatCount(atWorkToday), note: 'Present, half day or on duty' },
              { label: 'On leave today', value: formatCount(orgTodayTotals.leave), note: 'Approved leave for today' },
              { label: 'Absent today', value: formatCount(orgTodayTotals.absent), note: 'Due in, with no punch' },
              { label: 'Flagged today', value: formatCount(orgTodayTotals.flagged), note: 'Days carrying at least one flag' },
              { label: 'Late arrivals', value: formatCount(rangeTotals.lateDays), note: 'Across the period' },
              { label: 'Days at work', value: formatCount(atWorkRange), note: 'Across the period' },
            ]}
          />

          {orgRange.isError ? (
            <QueryErrorAlert
              error={orgRange.error}
              subject="the attendance trend"
              onRetry={() => void orgRange.refetch()}
            />
          ) : null}

          {!rangeComplete ? (
            <Alert>
              <InfoIcon aria-hidden />
              <AlertTitle>Too many days to chart</AlertTitle>
              <AlertDescription>
                {`The list endpoint returned ${String(orgRange.data?.value.total ?? 0)} days for these ${String(spanDays)} days, which is more than this screen reads. Choose a shorter period. Charting the part that arrived would show a real dip where the data simply stopped.`}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard
              title="Attendance by day"
              description="Stacked bar. Who was at work, on leave, absent or not due"
              pending={orgRange.isPending}
              empty={!hasValues(trendPoints, ['work', 'leave', 'absent', 'other'])}
              emptyNote="No days recorded in this period."
              insight={attendanceInsight(trendPoints)}
            >
              <AttendanceTrendChart points={trendPoints} animate={rangeIntro} />
            </ChartCard>

            <ChartCard
              title="Hours worked, day by day"
              description="Line. Everyone's minutes added together"
              pending={orgRange.isPending}
              empty={!hasValues(teamHoursPoints, ['workedMinutes'])}
              emptyNote="No hours recorded in this period."
              insight={teamHoursInsight(teamHoursPoints)}
            >
              <TeamHoursChart points={teamHoursPoints} animate={rangeIntro} />
            </ChartCard>

            <ChartCard
              title="Late arrivals"
              description="Area. People arriving after their rostered start"
              wide
              pending={orgRange.isPending}
              empty={!hasValues(latePoints, ['late'])}
              emptyNote={rangeTotals.rows > 0 ? `Nobody arrived late in these ${String(spanDays)} days.` : 'No days recorded in this period.'}
              insight={lateInsight(latePoints)}
            >
              <LateArrivalsChart points={latePoints} animate={rangeIntro} />
            </ChartCard>
          </div>

          {/* REQ-K-01 asks for more than this. Saying which parts are missing
              and why is the only alternative to a tile that invents them. */}
          <section className="flex flex-col gap-2 border-t pt-4">
            <div className="text-muted-foreground flex items-start gap-2 text-xs">
              <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <p>
                Leave balances, pending approvals and unlocked periods are part of this screen and
                are not shown: the endpoints that answer them are not built yet. Nothing above is a
                placeholder — every figure and every bar is counted from attendance days the server
                returned.
              </p>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
