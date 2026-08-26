import {
  ChartBarIcon,
  ChartDonutIcon,
  ChartLineIcon,
  NumberSquareOneIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import type { CustomWidget, InsightArea, WidgetKind, WidgetSize } from '@vyuha/shared';

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

import { AREA_GATES, AREA_LABELS, AREA_METRICS } from './catalogue';

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
  { kind: 'line', label: 'Line', icon: ChartLineIcon },
  { kind: 'donut', label: 'Donut', icon: ChartDonutIcon },
  { kind: 'number', label: 'Number', icon: NumberSquareOneIcon },
];

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

      <Button variant="outline" size="sm" onClick={onRemove}>
        <TrashIcon data-icon="inline-start" />
        Remove widget
      </Button>
    </div>
  );
}
