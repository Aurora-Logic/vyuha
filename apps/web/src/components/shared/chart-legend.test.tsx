import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Recharts measures its ResponsiveContainer and renders nothing at all when
 * the box is zero, which it always is under jsdom. Stubbing it to a plain div
 * is what lets the legend -- which needs no layout -- be read here.
 */
vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

import { ChartContainer, ChartLegendContent, type ChartConfig } from '@/components/ui/chart';

/**
 * A legend swatch with no word beside it.
 *
 * `ChartLegendContent` renders `itemConfig?.label` and has no fallback, so a
 * `nameKey` that does not resolve into the config prints a coloured square and
 * nothing else. Three charts shipped that way -- the two composition donuts
 * and the share rings -- because their config is keyed `slice0`, `slice1` and
 * the legend was pointed at `name`, which holds a party name.
 *
 * The tooltip hid it: `ChartTooltipContent` falls back to `item.name`, so
 * hovering showed the right word and the legend beneath it showed none.
 */
function legendPayload(datum: Record<string, unknown>) {
  // The shape Recharts hands a Pie or RadialBar legend: the datum is nested.
  const name = typeof datum.name === 'string' ? datum.name : '';
  return [{ value: name, type: 'square' as const, color: '#000', payload: datum }];
}

function renderLegend(config: ChartConfig, nameKey: string, datum: Record<string, unknown>) {
  // ChartLegendContent directly, not through ChartLegend: the latter is
  // Recharts' own Legend, which registers with a chart and renders nothing
  // outside one. The label lookup is what is under test, and it needs only the
  // config from ChartContainer's context.
  render(
    <ChartContainer config={config}>
      <ChartLegendContent payload={legendPayload(datum)} nameKey={nameKey} />
    </ChartContainer>,
  );
}

describe('chart legend labels', () => {
  it('names a slice when the nameKey resolves into the config', () => {
    renderLegend(
      { slice0: { label: 'Godavari Electricals', color: 'var(--chart-1)' } },
      'slice',
      { name: 'Godavari Electricals', slice: 'slice0', value: 12 },
    );
    expect(screen.getByText('Godavari Electricals')).not.toBeNull();
  });

  it('renders nothing at all when it does not — the bug this pins', () => {
    // Config keyed by slug, legend pointed at the display name: no match, no
    // label, and no error either.
    renderLegend(
      { slice0: { label: 'Godavari Electricals', color: 'var(--chart-1)' } },
      'name',
      { name: 'Godavari Electricals', slice: 'slice0', value: 12 },
    );
    expect(screen.queryByText('Godavari Electricals')).toBeNull();
  });

  it('names a series when the key is the dataKey itself', () => {
    renderLegend(
      { repeatRevenue: { label: 'Returning', color: 'var(--chart-1)' } },
      'repeatRevenue',
      { repeatRevenue: 'repeatRevenue' },
    );
    expect(screen.getByText('Returning')).not.toBeNull();
  });
});
