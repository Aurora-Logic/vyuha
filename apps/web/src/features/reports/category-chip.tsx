import type { ReportCategory } from '@vyuha/shared';

import { REPORT_CATEGORY_ICONS } from '@/components/shared/entity-icons';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * A category, coloured.
 *
 * Ten categories is past the point where a reader tells hues apart reliably,
 * so the colour is reinforcement and the word is the identity -- which is why
 * the label stays in normal ink and the hue lives in the category's icon and a
 * tint beside it. `dataviz` puts it plainly: a light categorical hue is
 * illegible as text, and identity comes from the marked glyph next to the
 * words, never from colouring the words. The icon carries the category's shape
 * too, so it is known without the colour -- a truck is Fulfilment either way.
 *
 * Fixed per category, never cycled by position. Filtering the catalogue must
 * not repaint the survivors -- Inventory is cyan whether it is the third chip
 * on screen or the only one.
 *
 * Spread around the wheel rather than grouped by theme, because adjacent
 * categories in the reading order are the ones most often seen together and
 * should be the least alike. Books is the deliberate exception: the ledger is
 * a mirror of Tally and gets the one neutral.
 */
const CATEGORY_TONE: Record<ReportCategory, { dot: string; text: string; tint: string }> = {
  Attendance: { dot: 'bg-blue-500', text: 'text-blue-500', tint: 'bg-blue-500/8 border-blue-500/25' },
  Leave: { dot: 'bg-teal-500', text: 'text-teal-500', tint: 'bg-teal-500/8 border-teal-500/25' },
  Approvals: { dot: 'bg-violet-500', text: 'text-violet-500', tint: 'bg-violet-500/8 border-violet-500/25' },
  Books: { dot: 'bg-slate-400', text: 'text-slate-400', tint: 'bg-slate-400/8 border-slate-400/25' },
  Receivables: { dot: 'bg-amber-500', text: 'text-amber-500', tint: 'bg-amber-500/8 border-amber-500/25' },
  Customers: { dot: 'bg-emerald-500', text: 'text-emerald-500', tint: 'bg-emerald-500/8 border-emerald-500/25' },
  Inventory: { dot: 'bg-cyan-500', text: 'text-cyan-500', tint: 'bg-cyan-500/8 border-cyan-500/25' },
  Vendors: { dot: 'bg-fuchsia-500', text: 'text-fuchsia-500', tint: 'bg-fuchsia-500/8 border-fuchsia-500/25' },
  Fulfilment: { dot: 'bg-orange-500', text: 'text-orange-500', tint: 'bg-orange-500/8 border-orange-500/25' },
  /*
   * Rose, not the destructive token. These reports are a category whose ideal
   * state is empty, not an error -- an empty exceptions report is the system
   * working. Reusing the status colour would make a healthy report look like a
   * broken one, and `dataviz` reserves those four for state.
   */
  Exceptions: { dot: 'bg-rose-500', text: 'text-rose-500', tint: 'bg-rose-500/8 border-rose-500/25' },
};

/**
 * The 500 step in both themes on purpose. It is the one that holds its hue
 * against a light surface and a dark one; a step chosen per mode would drift
 * apart, and the dot is small enough that lightness matters less than the hue
 * staying recognisably the same colour in either.
 */
export function CategoryChip({ category, className }: { category: ReportCategory; className?: string }) {
  const tone = CATEGORY_TONE[category];
  const Glyph = REPORT_CATEGORY_ICONS[category];
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-normal', tone.tint, className)}>
      <Glyph aria-hidden className={cn('shrink-0', tone.text)} />
      {category}
    </Badge>
  );
}

export { CATEGORY_TONE };
