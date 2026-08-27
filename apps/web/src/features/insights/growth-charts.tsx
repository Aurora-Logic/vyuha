import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from 'recharts';

import { Button } from '@/components/ui/button';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { formatCount, formatMoneyShort } from '@/lib/format';
import { cn } from '@/lib/utils';

import { BANDS, STATES } from './movement-states';
import type { GrowthBridgeData, MovementCell } from './use-cfo';

/**
 * The growth screen's two drawings, shared with the person scorecard: the
 * five-factor waterfall (D1) and the movement matrix (D2). Same component
 * at company scope and at one person's book -- B3's rule made visible.
 */

const WATERFALL_CONFIG: ChartConfig = {
  delta: { label: 'Change' },
};

interface WaterfallStep {
  readonly name: string;
  readonly base: number;
  readonly delta: number;
  readonly signed: number;
  readonly kind: 'total' | 'up' | 'down';
}

function waterfallOf(bridge: GrowthBridgeData): WaterfallStep[] {
  const steps: WaterfallStep[] = [];
  let running = bridge.lastYear;
  steps.push({ name: 'Last year', base: 0, delta: bridge.lastYear, signed: bridge.lastYear, kind: 'total' });
  for (const [name, value] of [
    ['Volume', bridge.volumeEffect],
    ['Price', bridge.priceEffect],
    ['Mix', bridge.mixEffect],
    ['New customers', bridge.newCustomerEffect],
    ['Lost customers', bridge.lostCustomerEffect],
  ] as const) {
    const next = running + value;
    steps.push({
      name,
      base: Math.min(running, next),
      delta: Math.abs(value),
      signed: value,
      kind: value >= 0 ? 'up' : 'down',
    });
    running = next;
  }
  steps.push({ name: 'This year', base: 0, delta: bridge.thisYear, signed: bridge.thisYear, kind: 'total' });
  return steps;
}

export function BridgeWaterfall({ bridge }: { bridge: GrowthBridgeData }) {
  const steps = waterfallOf(bridge);
  const fillOf = (step: WaterfallStep): string =>
    step.kind === 'total' ? 'var(--fresh-1)' : step.kind === 'up' ? 'var(--fresh-4)' : 'var(--destructive)';
  return (
    <ChartContainer config={WATERFALL_CONFIG} className="aspect-auto h-64 w-full min-w-0">
      <BarChart accessibilityLayer data={steps} margin={{ left: 4, right: 12, top: 20 }} barCategoryGap="18%">
        <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} interval={0} />
        <YAxis
          width={52}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11 }}
          tickCount={4}
          tickFormatter={(value: number) => formatMoneyShort(value)}
        />
        {/* The invisible shelf each floating step stands on. */}
        <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
        <Bar dataKey="delta" stackId="w" radius={0} isAnimationActive={false}>
          {steps.map((step) => (
            <Cell key={step.name} fill={fillOf(step)} fillOpacity={step.kind === 'total' ? 0.9 : 0.75} />
          ))}
          <LabelList
            position="top"
            offset={6}
            className="fill-foreground"
            fontSize={10}
            valueAccessor={(entry: { payload?: WaterfallStep }) =>
              entry.payload
                ? `${entry.payload.kind === 'down' ? '−' : entry.payload.kind === 'up' ? '+' : ''}${formatMoneyShort(Math.abs(entry.payload.signed))}`
                : ''
            }
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}


export function MovementMatrix({ cells, onCell }: { cells: readonly MovementCell[]; onCell: (cell: MovementCell) => void }) {
  const cellOf = (state: string, band: string) => cells.find((c) => c.state === state && c.band === band);
  const max = Math.max(1, ...cells.map((c) => Number(c.amount)));
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[28rem] grid-cols-[7rem_repeat(3,minmax(0,1fr))] gap-1">
        <span />
        {BANDS.map((band) => (
          <span key={band} className="text-muted-foreground pb-1 text-center text-xs font-medium">
            {band} band
          </span>
        ))}
        {STATES.map((state) => (
          <div key={state.key} className="contents">
            <span className="text-muted-foreground flex items-center text-xs">{state.label}</span>
            {BANDS.map((band) => {
              const cell = cellOf(state.key, band);
              const amount = Number(cell?.amount ?? 0);
              const empty = (cell?.count ?? 0) === 0;
              // Intensity carries magnitude only; "Declining x A" -- big
              // accounts shrinking -- is the loudest cell on the screen.
              const trouble = state.key === 'declining' || state.key === 'lost';
              const tone = trouble ? 'var(--destructive)' : 'var(--fresh-1)';
              const strength = empty ? 0 : Math.max(0.08, (amount / max) * (trouble && band === 'A' ? 0.5 : 0.35));
              return (
                <Button
                  key={band}
                  variant="outline"
                  disabled={empty}
                  onClick={() => {
                    if (cell) onCell(cell);
                  }}
                  className={cn('h-auto flex-col items-start gap-0.5 px-3 py-2', empty && 'opacity-50')}
                  style={empty ? undefined : { backgroundColor: `color-mix(in oklab, ${tone} ${String(Math.round(strength * 100))}%, transparent)` }}
                >
                  <span className="text-base font-semibold tabular-nums">{formatCount(cell?.count ?? 0)}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">{formatMoneyShort(amount)}</span>
                </Button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

