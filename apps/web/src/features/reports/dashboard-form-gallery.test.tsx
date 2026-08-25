import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { REPORT_DEFINITIONS } from '@vyuha/shared';

import { FormGalleryView } from './dashboard-form-gallery';
import { wearableForms, type ChartRow } from './report-series';

/**
 * The gallery's promise is one honest tile per choice: every form the
 * report's columns can wear gets a live preview, a form these rows cannot
 * draw stays visible but says so, and the pick is the tile itself. jsdom
 * gives Recharts no room to measure, so nothing asserts on marks -- presence
 * of the chart containers is what proves a preview rendered.
 */

const AOV = REPORT_DEFINITIONS['aov-trend'];

function row(cells: Record<string, string | number | boolean | null>): ChartRow {
  return { id: 'r1', cells };
}

const MONTH_ROWS = [
  row({ month: '2026-07', invoices: 3, revenue: '300.00', aov: '100.00' }),
  row({ month: '2026-08', invoices: 2, revenue: '400.00', aov: '200.00' }),
];

/** Rows the time forms can draw but the bar family cannot: every value zero. */
const ZERO_ROWS = [row({ month: '2026-08', invoices: 0, revenue: '0', aov: '0' })];

describe('FormGalleryView', () => {
  it('renders one live preview tile per wearable form, plus Automatic with its resolution badge', () => {
    const { container } = render(
      <FormGalleryView reportKey="aov-trend" definition={AOV} rows={MONTH_ROWS} form="auto" onPick={() => undefined} />,
    );
    const expected = wearableForms(AOV).length + 1;
    expect(screen.getAllByRole('button')).toHaveLength(expected);
    // Every one of these rows' forms draws, so every tile carries a real
    // chart container and none carries the cannot-draw caption.
    expect(container.querySelectorAll('[data-slot="chart"]')).toHaveLength(expected);
    expect(screen.queryByText('needs different columns')).toBeNull();
    // The Automatic tile names what it resolves to (aov-trend's override is a line).
    const auto = screen.getByRole('button', { name: /^Automatic/ });
    expect(within(auto).getByText('Line')).toBeTruthy();
  });

  it('fires onPick with the tile form, and marks the current pick pressed', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <FormGalleryView reportKey="aov-trend" definition={AOV} rows={MONTH_ROWS} form="line" onPick={onPick} />,
    );
    expect(screen.getByRole('button', { name: 'Line' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Donut' }).getAttribute('aria-pressed')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Donut' }));
    expect(onPick).toHaveBeenCalledWith('donut');
    await user.click(screen.getByRole('button', { name: /^Automatic/ }));
    expect(onPick).toHaveBeenCalledWith('auto');
  });

  it('shows a form these rows cannot draw dimmed and captioned, never hidden', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <FormGalleryView reportKey="aov-trend" definition={AOV} rows={ZERO_ROWS} form="auto" onPick={onPick} />,
    );
    // All-zero rows: the bar family cannot draw, the time family still can.
    const bars = screen.getByText('Bars').closest('button');
    if (bars === null) throw new Error('the Bars tile is missing');
    expect(within(bars).getByText('needs different columns')).toBeTruthy();
    expect(bars.querySelector('.opacity-50')).toBeTruthy();
    expect(bars.querySelector('[data-slot="chart"]')).toBeNull();
    const line = screen.getByRole('button', { name: 'Line' });
    expect(within(line).queryByText('needs different columns')).toBeNull();
    expect(line.querySelector('[data-slot="chart"]')).toBeTruthy();
    // Dimmed is not disabled: picking it is allowed, and the board heals it.
    await user.click(bars);
    expect(onPick).toHaveBeenCalledWith('bar');
  });

  it('falls back to captions only when the period has no rows', () => {
    const { container } = render(
      <FormGalleryView reportKey="aov-trend" definition={AOV} rows={[]} form="auto" onPick={() => undefined} />,
    );
    expect(screen.getByText('No rows in this period to preview.')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(wearableForms(AOV).length + 1);
    expect(container.querySelectorAll('[data-slot="chart"]')).toHaveLength(0);
  });
});
