import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useSearchParams } from 'react-router';
import { describe, expect, it } from 'vitest';

import { PeriodRangeField } from './period-field';

/**
 * Sixteen screens shared one copy of this write path and only the read path
 * was covered. What matters here is that picking a period keeps the rest of
 * the query string: these reports carry an area, a page and a drill-down
 * beside the dates, and dropping them lands the reader somewhere else.
 */

function Probe() {
  const [params] = useSearchParams();
  return <output data-testid="params">{params.toString()}</output>;
}

function setup(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <PeriodRangeField range={{ from: '2026-08-01', to: '2026-08-30' }} />
      <Probe />
    </MemoryRouter>,
  );
}

describe('PeriodRangeField', () => {
  it('writes the chosen period without dropping the other parameters', async () => {
    const user = userEvent.setup();
    setup('/reports/margin?area=west&page=3');

    await user.click(screen.getByRole('button', { name: 'Period' }));
    await user.click(screen.getByRole('button', { name: 'Last 7 days' }));

    const params = new URLSearchParams(screen.getByTestId('params').textContent ?? '');
    expect(params.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(params.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(params.get('area')).toBe('west');
    expect(params.get('page')).toBe('3');
  });

  it('takes a label for the one screen that asks for a different one', () => {
    render(
      <MemoryRouter initialEntries={['/reports/exports']}>
        <PeriodRangeField range={{ from: '2026-08-01', to: '2026-08-30' }} label="Period for exports" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Period for exports' })).toBeTruthy();
  });
});
