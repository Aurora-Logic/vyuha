import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { REPORT_DEFINITIONS } from '@vyuha/shared';

import { GenericReportChart } from './report-charts';
import type { ChartRow } from './report-series';

/**
 * A dashboard tile must never vanish silently.
 *
 * The form branches returned bare null when they could not extract points
 * from the rows -- right for the report shell, whose table stands beside the
 * chart, but on a board every tile the person had pinned a wrong form on
 * disappeared, and a board of such tiles rendered as a blank page under a
 * "Board saved" toast. In tile mode (a title is passed) the card now stands
 * and says what happened.
 */

const AGEING = REPORT_DEFINITIONS.ageing;

function row(cells: Record<string, string | number | boolean | null>): ChartRow {
  return { id: 'r1', cells };
}

describe('a tile whose rows cannot wear the pinned form', () => {
  it('keeps the card and says so instead of vanishing (heatmap on month-less rows)', () => {
    render(
      <GenericReportChart
        reportKey="ageing"
        definition={AGEING}
        rows={[row({ partyName: 'Asha Traders', outstanding: '1200.00', ageDays: 12 })]}
        animate={false}
        form="heatmap"
        title="Receivables ageing"
        wide={false}
      />,
    );
    expect(screen.getByText('Receivables ageing')).toBeTruthy();
    expect(screen.getByText(/cannot wear the heatmap chart/)).toBeTruthy();
  });

  it('keeps the card when a pinned bar has nothing to draw', () => {
    // A month-shaped report pinned to bars, every numeric zero: the resolver
    // still offers its line, the bar path's series builder refuses, and the
    // tile must stand rather than leave a hole in the grid.
    render(
      <GenericReportChart
        reportKey="aov-trend"
        definition={REPORT_DEFINITIONS['aov-trend']}
        rows={[row({ month: '2026-08', invoices: 0, revenue: '0', aov: '0' })]}
        animate={false}
        form="hbar"
        title="Order value"
        wide={false}
      />,
    );
    expect(screen.getByText('Order value')).toBeTruthy();
    expect(screen.getByText(/cannot wear the bar chart/)).toBeTruthy();
  });

  it('says the report reads as a table when no chart form resolves at all', () => {
    render(
      <GenericReportChart
        reportKey="ageing"
        definition={AGEING}
        rows={[row({ partyName: 'Asha Traders', outstanding: '0', ageDays: 0 })]}
        animate={false}
        title="Receivables ageing"
        wide={false}
      />,
    );
    expect(screen.getByText('Receivables ageing')).toBeTruthy();
    expect(screen.getByText(/reads as a table/)).toBeTruthy();
  });

  it('still returns nothing in shell mode, where the table carries the rows', () => {
    const { container } = render(
      <GenericReportChart
        reportKey="ageing"
        definition={AGEING}
        rows={[row({ partyName: 'Asha Traders', outstanding: '0', ageDays: 0 })]}
        animate={false}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('every shadcn chart family renders as a standing card', () => {
  // jsdom gives Recharts no room to measure, so nothing asserts on marks;
  // what a tile must prove is that a pinned form over rows that fit it keeps
  // the card and its title on the board.
  const RANKED_ROWS = [
    row({ partyName: 'Asha Traders', outstanding: '1200.00', ageDays: 12 }),
    row({ partyName: 'Behar Metals', outstanding: '800.00', ageDays: 30 }),
  ];
  const MONTH_ROWS = [
    row({ month: '2026-07', invoices: 3, revenue: '300.00', aov: '100.00' }),
    row({ month: '2026-08', invoices: 2, revenue: '400.00', aov: '200.00' }),
  ];

  it.each(['bar', 'stacked-bar', 'radar', 'pie'] as const)('%s over ranked rows', (form) => {
    render(
      <GenericReportChart
        reportKey="ageing"
        definition={AGEING}
        rows={RANKED_ROWS}
        animate={false}
        form={form}
        title="Receivables ageing"
        wide={false}
      />,
    );
    expect(screen.getByText('Receivables ageing')).toBeTruthy();
    expect(screen.queryByText(/cannot wear/)).toBeNull();
  });

  it.each(['area', 'stacked-area'] as const)('%s over month-shaped rows', (form) => {
    render(
      <GenericReportChart
        reportKey="aov-trend"
        definition={REPORT_DEFINITIONS['aov-trend']}
        rows={MONTH_ROWS}
        animate={false}
        form={form}
        title="Order value"
        wide={false}
      />,
    );
    expect(screen.getByText('Order value')).toBeTruthy();
    expect(screen.queryByText(/cannot wear/)).toBeNull();
  });
});
