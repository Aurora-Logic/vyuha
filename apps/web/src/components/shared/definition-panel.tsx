import { useState } from 'react';
import { InfoIcon } from '@phosphor-icons/react';
import { metricById, type MetricDefinition } from '@vyuha/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatDate, formatMoney } from '@/lib/format';

/**
 * "How is this calculated?" (CFO brief Q4, R7): the definition panel on
 * every metric, read from the registry and never hardcoded -- meaning,
 * formula, source, what is excluded, the minimum-sample rule, the version
 * and its effective date, and related metrics. The info icon is the door.
 */

const UNIT_LABELS: Record<MetricDefinition['unit'], string> = {
  money: 'Rupees',
  count: 'Count',
  pct: 'Percent',
  days: 'Days',
  score: 'Score, 0-100',
  grade: 'Grade, A to E',
};

const GOOD_LABELS: Record<MetricDefinition['good'], string> = {
  up: 'Higher is better',
  down: 'Lower is better',
  none: 'No good direction',
};

export function DefinitionBody({ metric, onOpenRelated }: { metric: MetricDefinition; onOpenRelated?: (id: string) => void }) {
  const related = (metric.related ?? []).map((id) => metricById(id)).filter((m): m is MetricDefinition => m !== undefined);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>{metric.meaning}</p>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
        <dt className="text-muted-foreground">Formula</dt>
        <dd className="font-mono text-xs leading-relaxed">{metric.formula}</dd>
        <dt className="text-muted-foreground">Source</dt>
        <dd>{metric.source}</dd>
        {metric.denominator ? (<><dt className="text-muted-foreground">Denominator</dt><dd>{metric.denominator}</dd></>) : null}
        <dt className="text-muted-foreground">Unit</dt>
        <dd>{UNIT_LABELS[metric.unit]} · {GOOD_LABELS[metric.good]}</dd>
        {metric.excludes ? (<><dt className="text-muted-foreground">Excluded</dt><dd>{metric.excludes}</dd></>) : null}
        {metric.materialityFloor !== undefined ? (
          <><dt className="text-muted-foreground">Materiality</dt><dd>Below {formatMoney(metric.materialityFloor.toFixed(2))} a change shows as rupees, never a percent.</dd></>
        ) : null}
        {metric.minimumSample ? (<><dt className="text-muted-foreground">Minimum sample</dt><dd>{metric.minimumSample}</dd></>) : null}
        <dt className="text-muted-foreground">Version</dt>
        <dd>v{metric.version}, effective {formatDate(metric.effectiveFrom)}</dd>
        <dt className="text-muted-foreground">Shown on</dt>
        <dd>{metric.builtIn ?? 'Not built yet'}</dd>
        <dt className="text-muted-foreground">Needs</dt>
        <dd><code className="text-xs">{metric.permission}</code></dd>
      </dl>
      {related.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Related:</span>
          {related.map((r) =>
            onOpenRelated ? (
              <Button key={r.id} variant="outline" size="sm" onClick={() => { onOpenRelated(r.id); }}>
                {r.id} {r.label}
              </Button>
            ) : (
              <Badge key={r.id} variant="secondary">{r.id} {r.label}</Badge>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The info icon beside a figure; opens the panel for the given registry id. */
export function DefinitionLink({ id, className }: { id: string; className?: string }) {
  const isMobile = useIsMobile();
  const [openId, setOpenId] = useState<string | null>(null);
  const metric = openId === null ? undefined : metricById(openId);
  const root = metricById(id);
  if (root === undefined) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        className={className}
        aria-label={`How is ${root.label} calculated?`}
        onClick={(event) => {
          event.stopPropagation();
          setOpenId(id);
        }}
      >
        <InfoIcon />
      </Button>
      <Sheet open={openId !== null} onOpenChange={(open) => { if (!open) setOpenId(null); }}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-md">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{metric ? `${metric.id} · ${metric.label}` : ''}</SheetTitle>
            <SheetDescription>How this is calculated, from the metric registry.</SheetDescription>
          </SheetHeader>
          {metric ? (
            <div className="max-h-[75vh] overflow-y-auto px-4 py-4 sm:max-h-none">
              <DefinitionBody metric={metric} onOpenRelated={setOpenId} />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
