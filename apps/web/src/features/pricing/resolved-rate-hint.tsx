import { ArrowDownIcon, TagIcon } from '@phosphor-icons/react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatMoney } from '@/lib/format';
import { RATE_SOURCE_LABELS } from '@vyuha/shared';

import { useRateSimulation } from './use-pricing';

/**
 * 15 REQ-AN-17: "why this rate", on the line. The price lists' answer for
 * this party, item, quantity and date sits under the rate box with where
 * it came from; one tap puts it in the box. A typed rate below it is the
 * variance in red, and the reason the server will ask for at confirm
 * (REQ-AN-16) is asked for here, so the salesperson never meets it as a
 * refusal.
 */
export function ResolvedRateHint({
  partyId,
  stockItemId,
  quantity,
  date,
  rate,
  reason,
  editable,
  lineNo,
  onUseRate,
  onReasonChange,
}: {
  partyId: string | null;
  stockItemId: string | null;
  quantity: string;
  date: string | null;
  rate: string;
  reason: string;
  editable: boolean;
  lineNo: number;
  onUseRate: (rate: string) => void;
  onReasonChange: (reason: string) => void;
}) {
  const simulation = useRateSimulation({ stockItemId, partyId: partyId ?? undefined, quantity: quantity.trim() === '' ? '1' : quantity.trim(), date: date ?? undefined });
  if (stockItemId === null || simulation.data === undefined || simulation.data.rate === null) return null;
  const resolved = simulation.data;
  const typed = Number(rate.trim().replace(/,/gu, ''));
  const floor = Number(resolved.rate);
  const below = rate.trim() !== '' && Number.isFinite(typed) && typed < floor - 1e-9;
  const matches = rate.trim() !== '' && Number.isFinite(typed) && Math.abs(typed - floor) < 1e-9;
  const variance = below ? Math.round(((floor - typed) / floor) * 1000) / 10 : 0;
  const source = resolved.source === 'tally' ? 'Tally rate' : resolved.priceListName === null ? RATE_SOURCE_LABELS[resolved.source] : `${resolved.priceListName} v${String(resolved.priceListVersion ?? 1)}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" title={resolved.explanation}>
        <TagIcon className="shrink-0" />
        <span className="tabular-nums">
          {source}: {formatMoney(resolved.rate)}
          {resolved.discountPct !== null && resolved.source !== 'tally' ? ` (${resolved.discountPct}% off${resolved.tallyRate !== null ? ` ${formatMoney(resolved.tallyRate)}` : ''})` : ''}
        </span>
        {below ? (
          <Badge variant="destructive" className="gap-1">
            <ArrowDownIcon />
            {String(variance)}% below the floor
          </Badge>
        ) : null}
        {editable && !matches ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0 text-xs"
            onClick={() => {
              onUseRate(resolved.rate ?? '');
            }}
          >
            Use {formatMoney(resolved.rate)}
          </Button>
        ) : null}
      </div>
      {below ? (
        <Input
          aria-label={`Line ${String(lineNo)} reason for the rate below the floor`}
          placeholder="Why below the price list? Needed at confirm; goes to the approver."
          disabled={!editable}
          value={reason}
          aria-invalid={reason.trim() === '' || undefined}
          onChange={(event) => {
            onReasonChange(event.target.value);
          }}
        />
      ) : null}
    </div>
  );
}
