import { DEAL_STALE_DAYS, type CrmAnalyticsView, type CrmOutcomeMonth, type CrmOwnerLoad, type CrmStageSlice } from '@vyuha/shared';

/**
 * The CRM dashboard's arithmetic, as pure functions.
 *
 * The questions each chart answers, written down before the chart was drawn:
 *
 * - Funnel: *where are open deals piling up?* Count by stage, because a
 *   stage holding six deals is a queue whatever those deals are worth.
 * - Outcomes: *are we winning more or less than we were?* Won and lost per
 *   month, counts on one axis -- never money and count on two, which is the
 *   chart that makes any pair of lines look correlated.
 * - Owner load: *who is carrying the pipeline?* Open count per owner.
 *
 * Nothing here fetches and nothing renders. The thresholds every insight
 * turns on are named constants in this file so they can be argued with and
 * tested, rather than appearing as a bare number inside JSX.
 */

/** Below this many decided deals, a win rate is a coincidence rather than a rate. */
export const MIN_DECIDED_FOR_WIN_RATE = 5;

/** A stage holding at least this share of the open pipeline is worth naming. */
export const CROWDED_STAGE_SHARE = 0.4;

/**
 * The win rate, or nothing.
 *
 * The same threshold the insight applies, so the two cannot disagree: the
 * screen once showed "100%" in the stat row above a sentence saying two
 * deals were too few to read a rate from, which leaves the reader to decide
 * which half of their own dashboard to believe.
 */
export function readableWinRate(totals: { wonCount: number; lostCount: number; winRatePct: number | null }): number | null {
  const decided = totals.wonCount + totals.lostCount;
  return decided < MIN_DECIDED_FOR_WIN_RATE ? null : totals.winRatePct;
}

export interface FunnelPoint {
  readonly stage: string;
  readonly count: number;
  readonly value: number;
}

export interface OutcomePoint {
  readonly month: string;
  /** "Aug" — the axis label; the tooltip carries the year. */
  readonly label: string;
  readonly won: number;
  readonly lost: number;
}

export interface OwnerPoint {
  readonly owner: string;
  readonly count: number;
}

/** Open stages only: won and lost are outcomes, not places a deal waits. */
export function funnelSeries(stages: readonly CrmStageSlice[]): FunnelPoint[] {
  return stages
    .filter((stage) => !stage.isWon && !stage.isLost)
    .map((stage) => ({
      stage: stage.stageName,
      count: stage.count,
      // Money is exact text on the wire and stays that way on screen; this
      // number exists only to give a bar a length, never to be displayed.
      value: Number(stage.value),
    }));
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function outcomeSeries(months: readonly CrmOutcomeMonth[]): OutcomePoint[] {
  return months.map((entry) => {
    const monthIndex = Number(entry.month.slice(5, 7)) - 1;
    return {
      month: entry.month,
      label: MONTH_LABELS[monthIndex] ?? entry.month,
      won: entry.won,
      lost: entry.lost,
    };
  });
}

export function ownerSeries(owners: readonly CrmOwnerLoad[]): OwnerPoint[] {
  return owners.map((owner) => ({
    // A deal with nobody on it is a real state and the most actionable row
    // on the chart, so it is named rather than dropped.
    owner: owner.ownerName ?? 'Unassigned',
    count: owner.openCount,
  }));
}

/**
 * The sentences printed beside the charts.
 *
 * Every one is a claim the numbers prove, scoped to something the reader can
 * act on. Where the data cannot support a claim, the insight says so instead
 * of drawing a trend through two points.
 */
export function crmInsights(view: CrmAnalyticsView): string[] {
  const insights: string[] = [];
  const open = funnelSeries(view.stages);
  const openTotal = open.reduce((sum, point) => sum + point.count, 0);

  if (openTotal === 0) {
    insights.push('No open deals in this pipeline yet.');
  } else {
    const crowded = [...open].sort((a, b) => b.count - a.count)[0];
    if (crowded !== undefined && crowded.count / openTotal >= CROWDED_STAGE_SHARE && open.length > 1) {
      insights.push(
        `${String(crowded.count)} of ${String(openTotal)} open deals sit in ${crowded.stage} — more than any other stage.`,
      );
    }
  }

  const decided = view.totals.wonCount + view.totals.lostCount;
  if (decided < MIN_DECIDED_FOR_WIN_RATE) {
    // A "100% win rate" off two deals is the kind of number that gets quoted
    // in a meeting and then has to be walked back.
    insights.push(
      decided === 0
        ? 'Nothing has closed in this period, so there is no win rate to read yet.'
        : `Only ${String(decided)} deals have closed in this period — too few to read a win rate from.`,
    );
  } else if (view.totals.winRatePct !== null) {
    insights.push(
      `${String(view.totals.winRatePct)}% of the ${String(decided)} deals decided in this period were won.`,
    );
  }

  if (view.attention.overdue > 0) {
    insights.push(
      `${String(view.attention.overdue)} open ${view.attention.overdue === 1 ? 'deal is' : 'deals are'} past the close date on the record.`,
    );
  }
  if (view.attention.stale > 0) {
    insights.push(
      `${String(view.attention.stale)} open ${view.attention.stale === 1 ? 'deal has' : 'deals have'} not been touched in ${String(DEAL_STALE_DAYS)} days.`,
    );
  }

  return insights;
}
