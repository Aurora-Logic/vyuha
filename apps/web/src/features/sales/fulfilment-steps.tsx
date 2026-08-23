import { CheckIcon, HandGrabbingIcon, PackageIcon, PrinterIcon, ReceiptIcon, ScanIcon, TruckIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { STEP_BAR, STEP_TICK, STEPS, type FulfilmentProgress } from './fulfilment-progress';
import type { PackRecord } from './types';

/**
 * The owner's four steps (22 Aug 2026), as the order sees them: Picked,
 * Packed, Shipped, Delivered. One bar, the current step lit, and the one
 * verb that moves it. Invoicing is not a step the owner names, but goods
 * do not leave ahead of the paperwork (REQ-AA-14), so when that is what
 * blocks Shipped the verb says so rather than hiding.
 */

export function FulfilmentSteps({
  progress,
  latestPack,
  canAct,
  onPack,
  onInvoice,
  onDispatch,
}: {
  progress: FulfilmentProgress;
  latestPack: PackRecord | null;
  canAct: boolean;
  onPack: () => void;
  onInvoice: () => void;
  onDispatch: () => void;
}) {
  if (progress.current === null && progress.done.size === 0) return null;
  const { current, done } = progress;

  const verb = (() => {
    if (!canAct) return null;
    // D-48: the sheet behind onPack opens at the step that is next.
    if (current === 'picked' || current === 'packed') {
      return (
        <Button size="sm" onClick={onPack}>
          {current === 'picked' ? <HandGrabbingIcon data-icon="inline-start" /> : <PackageIcon data-icon="inline-start" />}
          {current === 'picked' ? (progress.toPack > 1e-9 ? 'Pack what is picked' : 'Pick') : progress.toPack > 1e-9 ? 'Pack the rest' : 'Pack'}
        </Button>
      );
    }
    if (current === 'shipped') {
      if (progress.toInvoice > 1e-9 && progress.toDispatch <= 1e-9) {
        return (
          <Button size="sm" onClick={onInvoice}>
            <ReceiptIcon data-icon="inline-start" />
            Invoice first
          </Button>
        );
      }
      return (
        <Button size="sm" onClick={onDispatch}>
          <TruckIcon data-icon="inline-start" />
          Ship
        </Button>
      );
    }
    if (current === 'delivered') {
      return (
        <Button size="sm" nativeButton={false} render={<Link to="/sales/scan" />}>
          <ScanIcon data-icon="inline-start" />
          Scan to mark delivered
        </Button>
      );
    }
    return null;
  })();

  return (
    <section aria-label="Fulfilment steps" className="flex flex-col gap-3">
      <ol className="grid grid-cols-4 gap-1">
        {STEPS.map((step, index) => {
          const isDone = done.has(step.key);
          const isCurrent = current === step.key;
          return (
            <li key={step.key} className="flex min-w-0 flex-col gap-1.5" aria-current={isCurrent ? 'step' : undefined}>
              <span
                className={cn(
                  'h-1 rounded-none',
                  isDone ? STEP_BAR[step.key].done : isCurrent ? STEP_BAR[step.key].current : 'bg-border',
                )}
                aria-hidden
              />
              <span className={cn('flex items-center gap-1 truncate text-xs', isDone || isCurrent ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                {isDone ? (
                  <CheckIcon className={cn('size-3.5 shrink-0', STEP_TICK[step.key])} />
                ) : (
                  <span className="text-muted-foreground tabular-nums">{index + 1}</span>
                )}
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
      {/* The one verb, and the slip beside it while a pack exists: printing is what
          follows packing, and it must not be a hunt (owner, 22 Aug). */}
      {(verb !== null || latestPack !== null) ? (
        <div className="flex flex-wrap gap-2">
          {verb}
          {latestPack !== null ? (
            <Button size="sm" variant="outline" nativeButton={false} render={<a href={`/print/packs/${latestPack.id}`} target="_blank" rel="noreferrer" />}>
              <PrinterIcon data-icon="inline-start" />
              Print slips
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
