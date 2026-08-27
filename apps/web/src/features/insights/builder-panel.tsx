import {
  ChartBarHorizontalIcon,
  ChartBarIcon,
  ChartDonutIcon,
  ChartLineIcon,
  ChartLineUpIcon,
  ChartPieSliceIcon,
  ChartPolarIcon,
  GridNineIcon,
  NumberSquareOneIcon,
  TableIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { WIDGET_PALETTES, type CustomWidget, type InsightArea, type WidgetKind, type WidgetPalette, type WidgetSize } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useState } from 'react';

import { RecordPicker } from '@/components/shared/record-picker';
import { usePermissions } from '@/lib/session/permissions';

import { useAreaInsights } from './api';
import { defaultRange } from './period';
import { formatCount } from '@/lib/format';

import { AREA_GATES, AREA_LABELS, AREA_METRICS, CHART_PALETTES, PALETTE_LABELS } from './catalogue';

/**
 * The widget configuration rail (owner, 26 Aug 2026, the Twenty reference):
 * chart kind across the top, then Data -- source area and metric -- then
 * Style. It edits one widget of the draft; the page owns the draft and the
 * save.
 *
 * The source list is filtered to areas the author's own permissions open. An
 * author cannot point a widget at a figure they cannot see -- and if a report
 * is later shared wider, each viewer's widgets still fetch under that
 * viewer's key, so the panel is a convenience filter, not the enforcement.
 */

const KINDS: readonly { kind: WidgetKind; label: string; icon: typeof ChartBarIcon }[] = [
  { kind: 'bar', label: 'Bars', icon: ChartBarIcon },
  { kind: 'barh', label: 'Horizontal bars', icon: ChartBarHorizontalIcon },
  { kind: 'line', label: 'Line', icon: ChartLineIcon },
  { kind: 'area', label: 'Area', icon: ChartLineUpIcon },
  { kind: 'donut', label: 'Donut', icon: ChartDonutIcon },
  { kind: 'pie', label: 'Pie', icon: ChartPieSliceIcon },
  { kind: 'radial', label: 'Radial', icon: ChartPolarIcon },
  { kind: 'number', label: 'Number', icon: NumberSquareOneIcon },
  { kind: 'table', label: 'Table', icon: TableIcon },
  { kind: 'heatmap', label: 'Heatmap', icon: GridNineIcon },
];

/** 8340 -> 10000; 61200 -> 70000: one significant step up, for a y-range list. */
function niceCeil(value: number): number {
  if (value <= 0) return 0;
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  const leading = value / power;
  const step = leading <= 1 ? 1 : leading <= 2 ? 2 : leading <= 2.5 ? 2.5 : leading <= 5 ? 5 : 10;
  return step * power;
}

function PaletteRow({ palette }: { palette: WidgetPalette }) {
  return (
    <span className="flex w-full items-center justify-between gap-3">
      <span>{PALETTE_LABELS[palette]}</span>
      <span aria-hidden className="flex items-center gap-0.5">
        {CHART_PALETTES[palette].map((colour, index) => (
          <span key={index} className="size-2.5 rounded-full" style={{ backgroundColor: colour }} />
        ))}
      </span>
    </span>
  );
}

const SIZES: readonly { size: WidgetSize; label: string }[] = [
  { size: '1x1', label: 'Half' },
  { size: '2x1', label: 'Full' },
  { size: '2x2', label: 'Tall' },
];

/**
 * A y-range bound as a dropdown of suggested clean figures, with a Custom
 * door for the number the suggestions did not think of. Auto clears it.
 */
function RangeField({
  label,
  value,
  suggestions,
  onValueChange,
}: {
  label: string;
  value: number | undefined;
  suggestions: readonly number[];
  onValueChange: (next: number | undefined) => void;
}) {
  const inSuggestions = value !== undefined && suggestions.includes(value);
  const [custom, setCustom] = useState(value !== undefined && !inSuggestions);
  const selectValue = custom ? 'custom' : value === undefined ? 'auto' : String(value);
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select
        value={selectValue}
        onValueChange={(next) => {
          if (next === null) return;
          if (next === 'auto') {
            setCustom(false);
            onValueChange(undefined);
          } else if (next === 'custom') {
            setCustom(true);
          } else {
            setCustom(false);
            onValueChange(Number(next));
          }
        }}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue>
            {(v: string) => (v === 'auto' ? 'Auto' : v === 'custom' ? 'Custom' : formatCount(Number(v)))}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Auto</SelectItem>
          {suggestions.map((s) => (
            <SelectItem key={s} value={String(s)}>
              {formatCount(s)}
            </SelectItem>
          ))}
          <SelectItem value="custom">Custom</SelectItem>
        </SelectContent>
      </Select>
      {custom ? (
        <Input
          type="number"
          inputMode="decimal"
          aria-label={`${label}, custom value`}
          value={value ?? ''}
          onChange={(event) => {
            const raw = event.target.value.trim();
            onValueChange(raw === '' || Number.isNaN(Number(raw)) ? undefined : Number(raw));
          }}
        />
      ) : null}
    </Field>
  );
}

export function BuilderPanel({
  widget,
  range,
  onChange,
  onRemove,
}: {
  widget: CustomWidget;
  /** The page's period, so suggestions come from the data actually shown. */
  range?: { from: string; to: string };
  onChange: (next: CustomWidget) => void;
  onRemove: () => void;
}) {
  const held = usePermissions();
  const areas = (Object.keys(AREA_LABELS) as InsightArea[]).filter((area) => held.has(AREA_GATES[area]));
  const metrics = AREA_METRICS[widget.area];

  // The widget's own data, from the same cache its chart reads, so the
  // range dropdowns can SUGGEST rather than ask for a bare number: the top
  // of the data, one step up, and double, each rounded to a clean figure.
  const areaData = useAreaInsights(widget.area, range ?? defaultRange());
  const liveMetric = areaData.data?.metrics.find((m) => m.key === widget.metric);
  const metricSeries = liveMetric?.series ?? [];
  const peak = (liveMetric?.points ?? []).reduce(
    (top, point) => Math.max(top, (liveMetric?.series ?? []).reduce((sum, m) => sum + Number(point[m.key] ?? 0), 0)),
    0,
  );
  const maxSuggestions = [...new Set([niceCeil(peak), niceCeil(peak * 1.5), niceCeil(peak * 2)])].filter((v) => v > 0);
  const minSuggestions = [...new Set([niceCeil(peak / 2) / 2])].filter((v) => v > 0);

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel>Chart type</FieldLabel>
        <Select
          value={widget.kind}
          onValueChange={(value) => {
            if (value !== null) onChange({ ...widget, kind: value });
          }}
        >
          <SelectTrigger aria-label="Chart type">
            <SelectValue>
              {(value: string) => {
                const entry = KINDS.find((k) => k.kind === value);
                if (entry === undefined) return value;
                const Icon = entry.icon;
                return (
                  <span className="flex items-center gap-2">
                    <Icon className="text-muted-foreground size-4" />
                    {entry.label}
                  </span>
                );
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {KINDS.map(({ kind, label, icon: Icon }) => (
              <SelectItem key={kind} value={kind}>
                <span className="flex items-center gap-2">
                  <Icon className="text-muted-foreground size-4" />
                  {label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <p className="text-muted-foreground text-xs font-medium">Data</p>

      <Field>
        <FieldLabel htmlFor="widget-title">Title</FieldLabel>
        <Input
          id="widget-title"
          value={widget.title}
          maxLength={80}
          onChange={(event) => {
            onChange({ ...widget, title: event.target.value });
          }}
        />
      </Field>

      {/* Searchable, both of them: the metric catalogue is already past a
          dozen entries and grows with every brief part that lands. */}
      <RecordPicker
        label="Source"
        showLabel
        placeholder="Pick an area"
        value={{ id: widget.area, label: AREA_LABELS[widget.area] }}
        options={areas.map((area) => ({ id: area, label: AREA_LABELS[area] }))}
        onValueChange={(picked) => {
          if (picked === null) return;
          const area = picked.id as InsightArea;
          const first = AREA_METRICS[area][0];
          onChange({ ...widget, area, metric: first?.key ?? widget.metric });
        }}
      />

      <RecordPicker
        label="Metric"
        showLabel
        placeholder="Pick a metric"
        value={{ id: widget.metric, label: metrics.find((m) => m.key === widget.metric)?.label ?? widget.metric }}
        options={metrics.map((metric) => ({ id: metric.key, label: metric.label, hint: AREA_LABELS[widget.area] }))}
        onValueChange={(picked) => {
          if (picked !== null) {
            const { series: _series, ...rest } = widget.options;
            const oldLabel = metrics.find((m) => m.key === widget.metric)?.label;
            const title = widget.title === oldLabel || widget.title.trim() === '' ? picked.label : widget.title;
            onChange({ ...widget, metric: picked.id, title, options: rest });
          }
        }}
      />

      <p className="text-muted-foreground text-xs font-medium">Style</p>

      <Field>
        <FieldLabel>Colors</FieldLabel>
        <Select
          value={widget.options.palette}
          onValueChange={(value) => {
            if (value !== null) {
              onChange({ ...widget, options: { ...widget.options, palette: value } });
            }
          }}
        >
          <SelectTrigger aria-label="Colour palette">
            <SelectValue>{(value: string) => PALETTE_LABELS[value as WidgetPalette]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {WIDGET_PALETTES.map((palette) => (
              <SelectItem key={palette} value={palette}>
                <PaletteRow palette={palette} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel>Width</FieldLabel>
        <ToggleGroup
          value={[widget.size]}
          aria-label="Widget size"
          className="w-full"
          onValueChange={(value: unknown[]) => {
            const size = value[0];
            if (typeof size === 'string' && size !== '') onChange({ ...widget, size: size as WidgetSize });
          }}
        >
          {SIZES.map(({ size, label }) => (
            <ToggleGroupItem key={size} value={size} className="flex-1 text-xs">
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>

      {widget.kind === 'line' || widget.kind === 'area' ? (
        <>
          {/* The reference's line block offers exactly this: how the line
              bends, and whether the points show. */}
          <Field>
            <FieldLabel>Curve</FieldLabel>
            <ToggleGroup
              value={[widget.options.curve]}
              aria-label="Curve style"
              className="w-full"
              onValueChange={(value: unknown[]) => {
                const curve = value[0];
                if (typeof curve === 'string' && curve !== '') {
                  onChange({ ...widget, options: { ...widget.options, curve: curve as 'linear' | 'smooth' | 'step' } });
                }
              }}
            >
              <ToggleGroupItem value="linear" className="flex-1 text-xs">
                Straight
              </ToggleGroupItem>
              <ToggleGroupItem value="smooth" className="flex-1 text-xs">
                Smooth
              </ToggleGroupItem>
              <ToggleGroupItem value="step" className="flex-1 text-xs">
                Step
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="widget-points" className="text-sm">
              Show points
            </Label>
            <Switch
              id="widget-points"
              checked={widget.options.points}
              onCheckedChange={(points) => {
                onChange({ ...widget, options: { ...widget.options, points } });
              }}
            />
          </div>
        </>
      ) : null}

      {widget.kind === 'bar' || widget.kind === 'barh' ? (
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="widget-stacked" className="text-sm">
            Stack series
          </Label>
          <Switch
            id="widget-stacked"
            checked={widget.options.stacked}
            onCheckedChange={(stacked) => {
              onChange({ ...widget, options: { ...widget.options, stacked } });
            }}
          />
        </div>
      ) : null}

      {widget.kind !== 'donut' && widget.kind !== 'number' && widget.kind !== 'table' ? (
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="widget-grid" className="text-sm">
            Grid lines
          </Label>
          <Switch
            id="widget-grid"
            checked={widget.options.grid}
            onCheckedChange={(grid) => {
              onChange({ ...widget, options: { ...widget.options, grid } });
            }}
          />
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="widget-legend" className="text-sm">
          Legend
        </Label>
        <Switch
          id="widget-legend"
          checked={widget.options.legend}
          onCheckedChange={(legend) => {
            onChange({ ...widget, options: { ...widget.options, legend } });
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="widget-labels" className="text-sm">
          Data labels
        </Label>
        <Switch
          id="widget-labels"
          checked={widget.options.dataLabels}
          onCheckedChange={(dataLabels) => {
            onChange({ ...widget, options: { ...widget.options, dataLabels } });
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="widget-omit-zero" className="text-sm">
          Omit zero values
        </Label>
        <Switch
          id="widget-omit-zero"
          checked={widget.options.omitZero}
          onCheckedChange={(omitZero) => {
            onChange({ ...widget, options: { ...widget.options, omitZero } });
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="widget-total" className="text-sm">
          Show total
        </Label>
        <Switch
          id="widget-total"
          checked={widget.options.showTotal}
          onCheckedChange={(showTotal) => {
            onChange({ ...widget, options: { ...widget.options, showTotal } });
          }}
        />
      </div>

      <p className="text-muted-foreground text-xs font-medium">Y axis</p>

      <Field>
        <FieldLabel>Series shown</FieldLabel>
        <Select
          value={widget.options.series?.[0] ?? 'ALL'}
          onValueChange={(value) => {
            if (value === null) return;
            const { series: _series, ...rest } = widget.options;
            onChange({
              ...widget,
              options: value === 'ALL' ? rest : { ...rest, series: [String(value)] },
            });
          }}
        >
          <SelectTrigger aria-label="Series shown">
            <SelectValue>
              {(value: string) =>
                value === 'ALL' ? 'All series' : (metricSeries.find((m) => m.key === value)?.label ?? value)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All series</SelectItem>
            {metricSeries.map((m) => (
              <SelectItem key={m.key} value={m.key}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <RangeField
          label="Min range"
          value={widget.options.yMin}
          suggestions={[0, ...minSuggestions]}
          onValueChange={(next) => {
            const { yMin: _yMin, ...rest } = widget.options;
            onChange({ ...widget, options: next === undefined ? rest : { ...rest, yMin: next } });
          }}
        />
        <RangeField
          label="Max range"
          value={widget.options.yMax}
          suggestions={maxSuggestions}
          onValueChange={(next) => {
            const { yMax: _yMax, ...rest } = widget.options;
            onChange({ ...widget, options: next === undefined ? rest : { ...rest, yMax: next } });
          }}
        />
      </div>

      <p className="text-muted-foreground text-xs font-medium">X axis</p>

      <Field>
        <FieldLabel>Order</FieldLabel>
        <Select
          value={widget.options.xOrder}
          onValueChange={(value) => {
            if (value !== null) {
              onChange({ ...widget, options: { ...widget.options, xOrder: value } });
            }
          }}
        >
          <SelectTrigger aria-label="X axis order">
            <SelectValue>
              {(value: string) =>
                value === 'natural' ? 'As the data comes' : value === 'asc' ? 'Low to high' : 'High to low'
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="natural">As the data comes</SelectItem>
            <SelectItem value="asc">Low to high</SelectItem>
            <SelectItem value="desc">High to low</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor="widget-xtitle">X axis name</FieldLabel>
          <Input
            id="widget-xtitle"
            maxLength={40}
            placeholder="None"
            value={widget.options.xTitle ?? ''}
            onChange={(event) => {
              const raw = event.target.value;
              const { xTitle: _x, ...rest } = widget.options;
              onChange({ ...widget, options: raw.trim() === '' ? rest : { ...rest, xTitle: raw } });
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="widget-ytitle">Y axis name</FieldLabel>
          <Input
            id="widget-ytitle"
            maxLength={40}
            placeholder="None"
            value={widget.options.yTitle ?? ''}
            onChange={(event) => {
              const raw = event.target.value;
              const { yTitle: _y, ...rest } = widget.options;
              onChange({ ...widget, options: raw.trim() === '' ? rest : { ...rest, yTitle: raw } });
            }}
          />
        </Field>
      </div>

      <Button variant="outline" size="sm" onClick={onRemove}>
        <TrashIcon data-icon="inline-start" />
        Remove widget
      </Button>
    </div>
  );
}
