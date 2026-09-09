import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Tally's closing quantity as a badge (owner, 9 Sep 2026). The register is
 * opened to find out what is on the shelf, and a plain number in a column
 * of grey text was the one thing the eye could not pick out. Green when
 * there is stock, red at nil, amber when Tally holds it negative (oversold,
 * or a receipt not yet entered). The unit rides with the number always,
 * because "18" and "18 Mtr" are different facts.
 */
function stockTone(quantity: number): 'success' | 'destructive' | 'warning' {
  if (quantity > 0) return 'success';
  return quantity < 0 ? 'warning' : 'destructive';
}

/** Nothing when Tally sent no figure: the caller decides whether that reads as a dash or as silence. */
export function StockBadge({ quantity, unit, className }: { quantity: string | null | undefined; unit: string; className?: string }) {
  if (quantity == null || quantity === '') return null;
  const value = Number(quantity);
  if (!Number.isFinite(value)) return null;
  return (
    <Badge variant={stockTone(value)} className={cn('tabular-nums', className)}>
      {value.toLocaleString('en-IN', { maximumFractionDigits: 3 })} {unit}
    </Badge>
  );
}
