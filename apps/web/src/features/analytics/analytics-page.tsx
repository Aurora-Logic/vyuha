import { useMemo, useRef, useState } from 'react';
import { ChartBarIcon, InfoIcon, LockKeyIcon } from '@phosphor-icons/react';
import { subDays } from 'date-fns';

import { canViewOvertime, PERMISSIONS } from '@vyuha/shared';

import { PageHeader } from '@/components/shared/page-header';
import { SectionHeading } from '@/components/shared/section-heading';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ChartCard } from '@/components/shared/chart-card';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { ChartSkeleton } from '@/features/attendance/charts';
import { dateRange } from '@/features/attendance/chart-series';
import { formatDuration, toDateParam } from '@/features/attendance/format';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { SampleDataNotice } from '@/features/attendance/sample-data-notice';
import { useDepartments } from '@/features/attendance/use-attendance-days';
import { useAttendancePeriod } from '@/features/attendance/use-attendance-period';
import { useChartIntro } from '@/features/attendance/use-chart-motion';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermissions } from '@/lib/session/permissions';
import { cn } from '@/lib/utils';

import {
  AttendanceRateChart,
  FlagVolumeChart,
  HeadcountChart,
  LateSpreadChart,
  OvertimeChart,
  PunchSourceChart,
  RepeatLateChart,
  WeekdayAbsenceChart,
} from './charts';
import {
  absenceByWeekday,
  attendanceRate,
  concentration,
  flagVolume,
  headcountByDepartment,
  lateSpread,
  overtimeLeaders,
  periodTotals,
  punchSources,
  repeatLate,
  TOP_N,
} from './series';
import { usePunchWindow, useRoster } from './use-analytics-data';

/**
 * Workforce analytics — the questions a manager arrives with, answered from
 * the three feeds that exist today.
 *
 * Route: `/analytics`. Gated on `attendance.view.team` or `attendance.view.all`
 * (PRD §2.1), which is the same pair that decides whether `/attendance/days`
 * and `/punches` return anybody but the caller. The gate is a courtesy: the
 * server scopes every row regardless, so a plain employee reaching this URL by
 * hand sees the refusal below rather than somebody else's attendance.
 *
 * Each chart exists to answer one question, and no chart restates a figure
 * sitting beside it:
 *
 *   Attendance rate, day by day   Is attendance drifting, independent of headcount?
 *   Absence by weekday            Which weekday do people miss?
 *   Late arrivals by severity     A few big delays, or a habit of small ones?
 *   Repeatedly late               Who is late again and again?
 *   Overtime, by person           Who carries the overtime?
 *   Punch mix                     Which premises control is doing the work?
 *   Flagged punches               What actually goes wrong at the punch?
 *   Headcount by department       Where do people sit, and where is fixed-term?
 *
 * What is deliberately absent, and said out loud at the bottom of the screen
 * rather than invented: anything about leave balances, approvals or period
 * locks. Those endpoints do not exist yet, and a chart that looks plausible is
 * worse than no chart, because somebody will act on it.
 *
 * Motion: every chart draws once, on the first paint after its data arrives,
 * and never again. Changing the period or the department redraws instantly.
 * An analytics screen is studied rather than glanced at, which is what makes
 * the first draw defensible; re-animating on a filter change would turn every
 * filter into a wait. `useChartIntro` also reads `prefers-reduced-motion` in
 * JavaScript, because recharts animates through requestAnimationFrame and the
 * blanket CSS collapse in index.css cannot reach it.
 */

type RangeDays = 30 | 60 | 90;
const RANGE_OPTIONS: RangeDays[] = [30, 60, 90];
const ALL = 'ALL';

function isRangeDays(value: string | undefined): value is `${RangeDays}` {
  return value === '30' || value === '60' || value === '90';
}

/** The strip's own shape, so the page does not jump when the figures land. */
function StripSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the period" className="border">
      <div aria-hidden className="grid grid-cols-2 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col gap-0.5 px-3 py-2">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-6 w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A chart with nothing in it yet, said in one line rather than a whole panel. */
function NothingYet({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground py-6 text-center text-xs">{children}</p>;
}

export function AnalyticsPage() {
  const granted = usePermissions();
  const canSeeOthers =
    granted.has(PERMISSIONS.ATTENDANCE_VIEW_ALL) || granted.has(PERMISSIONS.ATTENDANCE_VIEW_TEAM);
  const canSeeRoster = granted.has(PERMISSIONS.EMPLOYEE_VIEW);
  // The server omits `otMinutes` from anyone who may see only their own
  // attendance. Both breadth keys imply it, so this is true whenever the gate
  // above passes -- asserted rather than assumed, because a chart plotting a
  // withheld field would draw a flat zero and read as "nobody works late".
  const canSeeOvertime = canViewOvertime(granted);

  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const rangeRef = useRef<HTMLDivElement>(null);

  const today = toDateParam(new Date());
  const from = toDateParam(subDays(new Date(), rangeDays - 1));

  const period = useAttendancePeriod(
    { from, to: today, departmentId },
    { enabled: canSeeOthers },
  );
  // Punches are not department-filterable on the feed, so this one is scoped
  // by the server's predicate alone. The section says so rather than implying
  // the department control reaches it.
  const punchWindow = usePunchWindow({ from, to: today }, { enabled: canSeeOthers });
  const roster = useRoster({ enabled: canSeeOthers && canSeeRoster });
  const departments = useDepartments();

  const days = useMemo(() => period.data?.value.days ?? [], [period.data]);
  const dates = useMemo(() => dateRange(from, today), [from, today]);
  const totals = useMemo(() => periodTotals(days), [days]);
  const ratePoints = useMemo(() => attendanceRate(days, dates), [days, dates]);
  const weekdayPoints = useMemo(() => absenceByWeekday(days), [days]);
  const latePoints = useMemo(() => lateSpread(days), [days]);
  const repeatPoints = useMemo(() => repeatLate(days), [days]);
  const overtimePoints = useMemo(
    () => (canSeeOvertime ? overtimeLeaders(days) : []),
    [days, canSeeOvertime],
  );
  const overtimeShare = useMemo(
    () => concentration(overtimePoints, days),
    [overtimePoints, days],
  );
  const overtimeTotal = useMemo(
    () => days.reduce((sum, day) => sum + Math.max(0, day.otMinutes ?? 0), 0),
    [days],
  );

  const punches = useMemo(() => punchWindow.data?.punches ?? [], [punchWindow.data]);
  const sourcePoints = useMemo(() => punchSources(punches), [punches]);
  const flagPoints = useMemo(() => flagVolume(punches), [punches]);

  const people = useMemo(() => roster.data?.people ?? [], [roster.data]);
  const departmentPoints = useMemo(() => headcountByDepartment(people), [people]);

  // One policy per feed: draw once, when that feed's first answer lands.
  const periodIntro = useChartIntro(period.isSuccess);
  const punchIntro = useChartIntro(punchWindow.isSuccess);
  const rosterIntro = useChartIntro(roster.isSuccess);

  const periodComplete = period.data?.value.complete ?? true;
  const lateDays = latePoints.reduce((sum, bucket) => sum + bucket.days, 0);
  const departmentOptions = departments.data?.value.data ?? [];
  const departmentName = departmentOptions.find((option) => option.id === departmentId)?.name;

  // PRD §6.4: Alt+F2 changes the period. The toggle group is a composite, so
  // the honest equivalent of "open the picker" is to put the caret in it and
  // let the arrow keys do the rest.
  useShortcut({
    id: 'analytics.period',
    keys: 'alt+f2',
    label: 'Change period',
    scope: 'screen',
    run: () => {
      const group = rangeRef.current;
      const pressed = group?.querySelector<HTMLElement>('[aria-pressed="true"]');
      (pressed ?? group?.querySelector<HTMLElement>('[data-slot="toggle-group-item"]'))?.focus();
    },
  });

  if (!canSeeOthers) {
    return (
      <>
        <PageHeader description="How the workforce is actually turning up." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>Not yours to see</EmptyTitle>
            <EmptyDescription>
              Analytics summarise other people&apos;s attendance, which needs permission to view a
              team or the whole organisation. Your own month is on My attendance.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader description="How the workforce is actually turning up, over a period you choose." />

      <div className="flex flex-col gap-8">
        {/* Toolbar row (PRD §6.2). Wraps rather than scrolling sideways at
            360px. */}
        <div className="flex flex-wrap items-center gap-2">
          <div ref={rangeRef} className="flex items-center gap-2">
            <ToggleGroup
              variant="outline"
              aria-label="Period"
              value={[String(rangeDays)]}
              onValueChange={(value) => {
                // Base UI hands back an empty array when the pressed item is
                // pressed again. There is no "no period".
                const next = value[0];
                if (isRangeDays(next)) setRangeDays(Number(next) as RangeDays);
              }}
            >
              {RANGE_OPTIONS.map((option) => (
                <ToggleGroupItem
                  key={option}
                  value={String(option)}
                  // The 44px floor in index.css does not reach a toggle: the
                  // vendored shadcn variant keeps the box at 32px and grows an
                  // invisible ::after hit area instead. That satisfies a thumb
                  // and fails the route sweep, which measures the element.
                  className={cn(' px-2.5', PRESS)}
                >
                  {String(option)}d
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ShortcutHint keys="alt+f2" className="hidden md:inline-flex" />
          </div>

          <Select
            value={departmentId ?? ALL}
            onValueChange={(next: string | null) => {
              setDepartmentId(next === null || next === ALL ? null : next);
            }}
          >
            <SelectTrigger aria-label="Filter by department" className="w-full sm:w-48">
              <SelectValue>
                {(value: string) =>
                  departmentOptions.find((option) => option.id === value)?.name ?? 'All departments'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All departments</SelectItem>
                {departmentOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {period.data?.sample ? <SampleDataNotice what="attendance day" /> : null}

        {/* ----------------------------------------------------- attendance */}
        <section className="flex flex-col gap-3">
          <SectionHeading
            title="Attendance"
            note={`Counted from the attendance days the server returned for these ${String(rangeDays)} days${departmentName ? `, in ${departmentName}` : ''}.`}
          />

          {period.isPending ? (
            <>
              <StripSkeleton />
              <ChartCard title="Attendance rate, day by day">
                <ChartSkeleton label="Loading the attendance rate" className="h-44 sm:h-52" />
              </ChartCard>
            </>
          ) : null}

          {period.isError ? (
            <QueryErrorAlert
              error={period.error}
              subject="attendance analytics"
              onRetry={() => {
                void period.refetch();
              }}
            />
          ) : null}

          {period.isSuccess && !periodComplete ? (
            <Alert>
              <InfoIcon />
              <AlertTitle>This period is too large to summarise</AlertTitle>
              <AlertDescription>
                {`The list endpoint holds ${String(period.data.value.total)} attendance days for these ${String(rangeDays)} days, which is more than this screen reads in one go. Choose a shorter period or a single department. Charting the part that arrived would show a real collapse where the data simply stopped.`}
              </AlertDescription>
            </Alert>
          ) : null}

          {period.isSuccess && periodComplete ? (
            <>
              <KpiGrid
                columns={4}
                tiles={[
                  { label: 'People', value: String(totals.people) },
                  { label: 'Days recorded', value: String(totals.rows) },
                  {
                    label: 'Attendance rate',
                    value: totals.attendanceRate === null ? '—' : `${String(totals.attendanceRate)}%`,
                  },
                  { label: 'Flagged days', value: String(totals.flaggedDays), icon: <ACTION_ICONS.flag /> },
                ]}
              />

              {/* Two readings of the same period, side by side on a desktop.
                  Stacked, they made a 2,300px page of half-empty panels; the
                  pair belongs together anyway, because "the rate is falling"
                  and "it falls on Mondays" are one thought. */}
              <div className="grid gap-3 lg:grid-cols-2">
              <ChartCard
                title="Attendance rate, day by day"
                description="Of the people expected that day"
              >
                {totals.expected > 0 ? (
                  <AttendanceRateChart points={ratePoints} animate={periodIntro} />
                ) : (
                  <NothingYet>
                    Nobody was expected at work in this period, so there is no rate to plot.
                    Holidays and weekly offs are left out of the denominator on purpose.
                  </NothingYet>
                )}
              </ChartCard>

              <ChartCard title="Absence by weekday" description="Share of expected days missed">
                {totals.absent > 0 ? (
                  <WeekdayAbsenceChart points={weekdayPoints} animate={periodIntro} />
                ) : (
                  <NothingYet>
                    {totals.expected > 0
                      ? 'Nobody was absent on an expected working day in this period.'
                      : 'No expected working days in this period.'}
                  </NothingYet>
                )}
              </ChartCard>
              </div>
            </>
          ) : null}
        </section>

        {/* ---------------------------------------------------- punctuality */}
        {period.isSuccess && periodComplete ? (
          <section className="flex flex-col gap-3">
            <SectionHeading
              title="Punctuality"
              note="Late arrivals, by how late and by who. Minutes come from the shift's own late threshold."
            />

            <div className="grid gap-3 lg:grid-cols-2">
            <ChartCard
              title="Late arrivals, by minutes late"
              description={lateDays > 0 ? `${String(lateDays)} late day${lateDays === 1 ? '' : 's'}` : undefined}
            >
              {lateDays > 0 ? (
                <LateSpreadChart points={latePoints} animate={periodIntro} />
              ) : (
                <NothingYet>Nobody arrived late in this period.</NothingYet>
              )}
            </ChartCard>

            <ChartCard
              title="Late most often"
              description={repeatPoints.length > 0 ? `Top ${String(Math.min(TOP_N, repeatPoints.length))}` : undefined}
            >
              {repeatPoints.length > 0 ? (
                <RepeatLateChart points={repeatPoints} animate={periodIntro} />
              ) : (
                <NothingYet>No repeat late arrivals to rank.</NothingYet>
              )}
            </ChartCard>
            </div>
          </section>
        ) : null}

        {/* ------------------------------------------------------- overtime */}
        {period.isSuccess && periodComplete && canSeeOvertime ? (
          <section className="flex flex-col gap-3">
            <SectionHeading
              title="Overtime"
              note="Minutes only. This product records overtime and never prices it."
            />

            <ChartCard
              title="Who carries the overtime"
              description={
                overtimePoints.length > 0
                  ? `${formatDuration(overtimeTotal)} in total · these ${String(overtimePoints.length)} carry ${String(overtimeShare)}%`
                  : undefined
              }
            >
              {overtimePoints.length > 0 ? (
                <OvertimeChart points={overtimePoints} animate={periodIntro} />
              ) : (
                <NothingYet>No overtime recorded in this period.</NothingYet>
              )}
            </ChartCard>
          </section>
        ) : null}

        {/* -------------------------------------------------- punch quality */}
        <section className="flex flex-col gap-3">
          <SectionHeading
            title="Punch quality"
            note="From the punch log for the same period. The department filter above does not reach this feed, so it covers everyone you may see."
          />

          {punchWindow.isPending ? (
            <ChartCard title="How punches reached the server">
              <ChartSkeleton label="Loading the punch mix" className="h-24" shape="row" />
            </ChartCard>
          ) : null}

          {punchWindow.isError ? (
            <QueryErrorAlert
              error={punchWindow.error}
              subject="the punch log"
              onRetry={() => {
                void punchWindow.refetch();
              }}
            />
          ) : null}

          {punchWindow.isSuccess && !punchWindow.data.complete ? (
            <Alert>
              <InfoIcon />
              <AlertTitle>Too many punches to summarise</AlertTitle>
              <AlertDescription>
                {`More than ${String(punchWindow.data.fetched)} punches were logged in this period, which is more than this screen reads in one go. Choose a shorter period.`}
              </AlertDescription>
            </Alert>
          ) : null}

          {punchWindow.isSuccess && punchWindow.data.complete ? (
            <>
              <ChartCard
                title="How punches reached the server"
                description={`${String(punches.length)} punch${punches.length === 1 ? '' : 'es'}`}
              >
                {punches.length > 0 ? (
                  <PunchSourceChart points={sourcePoints} animate={punchIntro} />
                ) : (
                  <NothingYet>No punches were logged in this period.</NothingYet>
                )}
              </ChartCard>

              <ChartCard
                icon={<ACTION_ICONS.flag />}
                title="Flagged punches, by kind"
                description={flagPoints.length > 0 ? 'Red needs somebody to look' : undefined}
              >
                {flagPoints.length > 0 ? (
                  <FlagVolumeChart points={flagPoints} animate={punchIntro} />
                ) : (
                  <NothingYet>
                    {punches.length > 0
                      ? 'No punch in this period raised a flag.'
                      : 'No punches were logged in this period.'}
                  </NothingYet>
                )}
              </ChartCard>
            </>
          ) : null}
        </section>

        {/* ------------------------------------------------------ headcount */}
        <section className="flex flex-col gap-3">
          <SectionHeading
            title="Headcount"
            note="Active and on-notice people, as the register holds them today. Not scoped to the period above — a roster is a fact about now."
          />

          {!canSeeRoster ? (
            <p className="text-muted-foreground text-xs">
              Headcount comes from the employee register, which needs the employee view
              permission. Nothing else on this screen depends on it.
            </p>
          ) : null}

          {canSeeRoster && roster.isPending ? (
            <ChartCard title="Headcount by department">
              <ChartSkeleton label="Loading headcount" className="h-40" />
            </ChartCard>
          ) : null}

          {canSeeRoster && roster.isError ? (
            <QueryErrorAlert
              error={roster.error}
              subject="the employee register"
              onRetry={() => {
                void roster.refetch();
              }}
            />
          ) : null}

          {canSeeRoster && roster.isSuccess ? (
            <ChartCard
              title="Headcount by department"
              description={`${String(roster.data.total)} on the register`}
            >
              {departmentPoints.length > 0 ? (
                <HeadcountChart points={departmentPoints} animate={rosterIntro} />
              ) : (
                <Empty className="border-0 py-6">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ChartBarIcon />
                    </EmptyMedia>
                    <EmptyTitle>Nobody on the register</EmptyTitle>
                    <EmptyDescription>
                      Headcount appears once employees are added, or once an import has run.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </ChartCard>
          ) : null}
        </section>

        {/* What this screen cannot answer, said rather than invented. */}
        <section className="flex flex-col gap-2 border-t pt-4">
          <div className="text-muted-foreground flex items-start gap-2 text-xs">
            <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <p>
              Leave, approvals and period locks have no analytics here: the endpoints that would
              answer them are not built yet, and a plausible-looking chart is worse than none
              because somebody would act on it. Everything above is counted from attendance days,
              punches and employee records the server returned for the period on screen.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}

/**
 * Emil Kowalski's press feedback, spelled out rather than added to the shared
 * Button: components/ui is vendored shadcn source and changing it there would
 * be reverted by the next `shadcn add --diff`. The transition list restates
 * the button's own so tailwind-merge does not drop the colour transitions when
 * it resolves the two `transition-*` classes. 100ms and ease-out, because a
 * press has to answer inside the same moment the finger lands.
 */
const PRESS =
  'transition-[color,background-color,border-color,box-shadow,transform,scale] duration-100 ease-out-strong active:scale-[0.97]';
