import {
  ChartBarHorizontalIcon,
  ChartBarIcon,
  ChartDonutIcon,
  ChartLineIcon,
  ChartLineUpIcon,
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
import { usePermissions } from '@/lib/session/permissions';

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
  { kind: 'number', label: 'Number', icon: NumberSquareOneIcon },
  { kind: 'table', label: 'Table', icon: TableIcon },
];

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

export function BuilderPanel({
  widget,
  onChange,
  onRemove,
}: {
  widget: CustomWidget;
  onChange: (next: CustomWidget) => void;
  onRemove: () => void;
}) {
  const held = usePermissions();
  const areas = (Object.keys(AREA_LABELS) as InsightArea[]).filter((area) => held.has(AREA_GATES[area]));
  const metrics = AREA_METRICS[widget.area];

  return (
    <div className="flex flex-col gap-4">
      <ToggleGroup
        value={[widget.kind]}
        aria-label="Chart type"
        className="w-full"
        onValueChange={(value: unknown[]) => {
          const kind = value[0];
          if (typeof kind === 'string' && kind !== '') onChange({ ...widget, kind: kind as WidgetKind });
        }}
      >
        {KINDS.map(({ kind, label, icon: Icon }) => (
          <ToggleGroupItem key={kind} value={kind} aria-label={label} className="flex-1">
            <Icon />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

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

      <Field>
        <FieldLabel>Source</FieldLabel>
        <Select
          value={widget.area}
          onValueChange={(value) => {
            if (value === null) return;
            const area = String(value) as InsightArea;
            const first = AREA_METRICS[area][0];
            onChange({ ...widget, area, metric: first?.key ?? widget.metric });
          }}
        >
          <SelectTrigger aria-label="Source area">
            <SelectValue>{(value: string) => AREA_LABELS[value as InsightArea]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {areas.map((area) => (
              <SelectItem key={area} value={area}>
                {AREA_LABELS[area]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel>Metric</FieldLabel>
        <Select
          value={widget.metric}
          onValueChange={(value) => {
            if (value !== null) onChange({ ...widget, metric: String(value) });
          }}
        >
          <SelectTrigger aria-label="Metric">
            <SelectValue>
              {(value: string) => metrics.find((m) => m.key === value)?.label ?? value}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {metrics.map((metric) => (
              <SelectItem key={metric.key} value={metric.key}>
                {metric.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

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

      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor="widget-ymin">Min range</FieldLabel>
          <Input
            id="widget-ymin"
            type="number"
            inputMode="decimal"
            placeholder="Auto"
            value={widget.options.yMin ?? ''}
            onChange={(event) => {
              const raw = event.target.value.trim();
              const { yMin: _yMin, ...rest } = widget.options;
              onChange({
                ...widget,
                options: raw === '' || Number.isNaN(Number(raw)) ? rest : { ...rest, yMin: Number(raw) },
              });
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="widget-ymax">Max range</FieldLabel>
          <Input
            id="widget-ymax"
            type="number"
            inputMode="decimal"
            placeholder="Auto"
            value={widget.options.yMax ?? ''}
            onChange={(event) => {
              const raw = event.target.value.trim();
              const { yMax: _yMax, ...rest } = widget.options;
              onChange({
                ...widget,
                options: raw === '' || Number.isNaN(Number(raw)) ? rest : { ...rest, yMax: Number(raw) },
              });
            }}
          />
        </Field>
      </div>

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
