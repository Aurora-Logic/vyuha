import type { CrmAnalyticsView, CrmStageSlice } from '@vyuha/shared';
import { describe, expect, it } from 'vitest';

import { MIN_DECIDED_FOR_WIN_RATE, crmInsights, funnelSeries, outcomeSeries, ownerSeries, readableWinRate } from './analytics-series';

function stage(name: string, count: number, extra: Partial<CrmStageSlice> = {}): CrmStageSlice {
  return {
    stageId: name,
    stageName: name,
    position: 0,
    isWon: false,
    isLost: false,
    count,
    value: '0',
    ...extra,
  };
}

function view(overrides: Partial<CrmAnalyticsView> = {}): CrmAnalyticsView {
  return {
    totals: {
      openCount: 0,
      openValue: '0',
      wonCount: 0,
      lostCount: 0,
      wonValue: '0',
      winRatePct: null,
      avgDaysToWin: null,
    },
    stages: [],
    outcomes: [],
    owners: [],
    attention: { overdue: 0, followUpDue: 0, stale: 0, closingSoon: 0 },
    ...overrides,
  };
}

describe('funnelSeries', () => {
  it('drops won and lost, which are outcomes rather than places a deal waits', () => {
    const points = funnelSeries([
      stage('Lead', 4),
      stage('Won', 9, { isWon: true }),
      stage('Lost', 3, { isLost: true }),
    ]);
    expect(points.map((point) => point.stage)).toEqual(['Lead']);
  });

  it('keeps a stage nobody has reached, so the funnel is not silently shorter', () => {
    const points = funnelSeries([stage('Lead', 4), stage('Proposal', 0)]);
    expect(points).toHaveLength(2);
    expect(points[1]).toMatchObject({ stage: 'Proposal', count: 0 });
  });

  it('reads exact decimal text into a plottable number', () => {
    expect(funnelSeries([stage('Lead', 1, { value: '3447414.78' })])[0]?.value).toBe(3447414.78);
  });

  it('has nothing to draw for an empty pipeline', () => {
    expect(funnelSeries([])).toEqual([]);
  });
});

describe('outcomeSeries', () => {
  it('labels months short and keeps the sortable key', () => {
    const points = outcomeSeries([
      { month: '2026-07', won: 1, lost: 2, wonValue: '10' },
      { month: '2026-08', won: 3, lost: 0, wonValue: '20' },
    ]);
    expect(points.map((point) => point.label)).toEqual(['Jul', 'Aug']);
    expect(points[0]).toMatchObject({ month: '2026-07', won: 1, lost: 2 });
  });

  it('keeps a month in which nothing closed', () => {
    // The server backfills these; dropping them here would join the month
    // before the gap straight to the month after it.
    const points = outcomeSeries([{ month: '2026-05', won: 0, lost: 0, wonValue: '0' }]);
    expect(points).toHaveLength(1);
  });

  it('survives a single point without inventing a trend', () => {
    expect(outcomeSeries([{ month: '2026-08', won: 2, lost: 1, wonValue: '5' }])).toHaveLength(1);
  });
});

describe('ownerSeries', () => {
  it('names deals with nobody on them rather than dropping them', () => {
    const points = ownerSeries([{ ownerId: null, ownerName: null, openCount: 3, openValue: '0' }]);
    expect(points[0]).toEqual({ owner: 'Unassigned', count: 3 });
  });

  it('is empty when nothing is open', () => {
    expect(ownerSeries([])).toEqual([]);
  });
});

describe('crmInsights', () => {
  it('says an empty pipeline is empty instead of inventing a claim', () => {
    expect(crmInsights(view())).toContain('No open deals in this pipeline yet.');
  });

  it('names the stage holding the most, when it holds enough to matter', () => {
    const insights = crmInsights(view({ stages: [stage('Lead', 6), stage('Proposal', 2), stage('Won', 1, { isWon: true })] }));
    expect(insights.some((line) => line.includes('6 of 8 open deals sit in Lead'))).toBe(true);
  });

  it('names no crowded stage when the pipeline is evenly spread', () => {
    const insights = crmInsights(view({ stages: [stage('Lead', 3), stage('Qualified', 3), stage('Proposal', 3)] }));
    expect(insights.some((line) => line.includes('more than any other stage'))).toBe(false);
  });

  it('refuses a win rate from too few decided deals', () => {
    // The failure this exists to prevent: "100% win rate" off two deals,
    // quoted in a meeting and then walked back.
    const insights = crmInsights(
      view({ totals: { ...view().totals, wonCount: 2, lostCount: 0, winRatePct: 100 } }),
    );
    expect(insights.some((line) => line.includes('too few to read a win rate'))).toBe(true);
    expect(insights.some((line) => line.includes('100%'))).toBe(false);
  });

  it('states the win rate once enough deals have closed', () => {
    const won = MIN_DECIDED_FOR_WIN_RATE;
    const insights = crmInsights(
      view({ totals: { ...view().totals, wonCount: won, lostCount: 0, winRatePct: 100 } }),
    );
    expect(insights.some((line) => line.includes(`100% of the ${String(won)} deals`))).toBe(true);
  });

  it('counts overdue and stale deals, in singular and plural', () => {
    const one = crmInsights(view({ attention: { overdue: 1, followUpDue: 0, stale: 1, closingSoon: 0 } }));
    expect(one.some((line) => line.includes('1 open deal is past the close date'))).toBe(true);
    expect(one.some((line) => line.includes('1 open deal has not been touched'))).toBe(true);

    const many = crmInsights(view({ attention: { overdue: 3, followUpDue: 0, stale: 4, closingSoon: 0 } }));
    expect(many.some((line) => line.includes('3 open deals are past'))).toBe(true);
    expect(many.some((line) => line.includes('4 open deals have not been touched'))).toBe(true);
  });

  it('says nothing about overdue or stale deals when there are none', () => {
    const insights = crmInsights(view({ stages: [stage('Lead', 2)] }));
    expect(insights.some((line) => line.includes('past the close date'))).toBe(false);
    expect(insights.some((line) => line.includes('not been touched'))).toBe(false);
  });
});

describe('readableWinRate', () => {
  it('withholds a rate the insight would refuse to state', () => {
    // The screen once printed "100%" above a sentence saying two deals were
    // too few to read a rate from.
    expect(readableWinRate({ wonCount: 2, lostCount: 0, winRatePct: 100 })).toBeNull();
  });

  it('gives the rate once enough has closed', () => {
    expect(readableWinRate({ wonCount: 4, lostCount: 1, winRatePct: 80 })).toBe(80);
  });

  it('passes a null rate straight through', () => {
    expect(readableWinRate({ wonCount: 0, lostCount: 0, winRatePct: null })).toBeNull();
  });
});
