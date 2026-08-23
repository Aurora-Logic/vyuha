import { PlusIcon, TrashIcon } from '@phosphor-icons/react';

import { type PickerOption } from '@/components/shared/record-picker';
import { ItemPicker } from '@/features/masters/item-picker';
import { type StockItem } from '@/features/masters/use-stock-items';
import { Button } from '@/components/ui/button';
import { FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

import { ResolvedRateHint } from '@/features/pricing/resolved-rate-hint';

import { ItemHistoryAffordance } from './item-history-popover';
import { newLine, previewLine, type LineDraft } from './types';

/**
 * The one line editor every sales document uses (estimate, sales order, and
 * whatever pushes next): item picker that prefills, six boxes a line, Enter
 * on the last box appends a line the way voucher entry runs on, the item
 * history affordance one click from the rate, and the totals — a preview
 * while typing, the server's figures once saved.
 */

/**
 * Retained for the few callers that still map an item to a picker row of their
 * own; the line editor now reads the whole catalogue through {@link ItemPicker}
 * and no longer takes a preloaded page.
 */
export interface StockItemOption extends PickerOption {
  readonly unit: string;
  readonly salePrice: string | null;
  readonly gstRate: string | null;
}

export interface DocumentTotals {
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
}

interface DocumentLinesEditorProps {
  lines: LineDraft[];
  onLinesChange: (next: LineDraft[]) => void;
  editable: boolean;
  /** Whether the item picker is offered at all (masters.tally.view). */
  canPickItems: boolean;
  partyId: string | null;
  companyId: string | null;
  /** 15 REQ-AN-13: the price lists resolve at the document's date; null reads as today. */
  documentDate?: string | null;
  /** The saved figures, or null for a new document. Shown when the draft is clean. */
  saved: DocumentTotals | null;
  dirty: boolean;
}

export function DocumentLinesEditor({
  lines,
  onLinesChange,
  editable,
  canPickItems,
  partyId,
  companyId,
  documentDate = null,
  saved,
  dirty,
}: DocumentLinesEditorProps) {
  const preview = lines.map(previewLine);
  const previewSubtotal = preview.reduce((sum, p, i) => sum + (p === null ? 0 : Number(lines[i]?.quantity ?? 0) * Number(lines[i]?.rate ?? 0)), 0);
  const previewNet = preview.reduce((sum, p) => sum + (p?.amount ?? 0), 0);
  const previewTax = preview.reduce((sum, p) => sum + (p?.tax ?? 0), 0);
  const record = saved;

  function updateLine(key: string, patch: Partial<LineDraft>) {
    onLinesChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }
  function addLine() {
    if (!editable) return;
    onLinesChange([...lines, newLine()]);
    window.requestAnimationFrame(() => {
      const next = document.querySelector<HTMLInputElement>(`input[aria-label="Line ${String(lines.length + 1)} description"]`);
      next?.focus();
    });
  }
  function removeLine(key: string) {
    onLinesChange(lines.length === 1 ? [newLine()] : lines.filter((l) => l.key !== key));
  }
  function chooseItem(key: string, item: StockItem | null) {
    updateLine(key, {
      stockItemId: item?.id ?? null,
      description: item?.name ?? '',
      unit: item?.unit ?? '',
      // 15 REQ-AN-13: the rate is left blank on purpose. The server resolves it
      // from the price lists at the document's date, and falls back to this very
      // Tally rate when no list names the item -- so prefilling it here only
      // hid the list. The picker's hint still shows what Tally holds.
      rate: '',
      taxPct: item?.gstRate === null || item?.gstRate === undefined ? '0' : String(Number(item.gstRate)),
    });
  }

  return (
    <>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Lines</span>
          {editable ? (
            <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <PlusIcon data-icon="inline-start" />
            Add line
            </Button>
          ) : null}
        </div>

        <ol className="flex flex-col divide-y border">
          {lines.map((line, index) => {
            const p = preview[index] ?? null;
            return (
            <li key={line.key} className="flex flex-col gap-2 p-3">
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <div className="flex flex-col gap-1">
                  {canPickItems ? (
                  <ItemPicker
                    id={`line-item-${line.key}`}
                    label={`Line ${String(index + 1)} item`}
                    placeholder="Stock item, or type a description below"
                    searchPlaceholder="Search stock items"
                    emptyMessage="No item matches. Leave it and type a description."
                    clearable
                    clearLabel="No stock item"
                    disabled={!editable}
                    value={line.stockItemId === null ? null : { id: line.stockItemId, label: line.description }}
                    onValueChange={(next) => {
                      chooseItem(line.key, next);
                    }}
                  />
                  ) : null}
                  <Input
                  aria-label={`Line ${String(index + 1)} description`}
                  placeholder="Description"
                  disabled={!editable}
                  value={line.description}
                  onChange={(event) => {
                    updateLine(line.key, { description: event.target.value });
                  }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Input aria-label={`Line ${String(index + 1)} quantity`} inputMode="decimal" className="tabular-nums" placeholder="Qty" disabled={!editable} value={line.quantity} onChange={(e) => { updateLine(line.key, { quantity: e.target.value }); }} />
                  <Input aria-label={`Line ${String(index + 1)} rate`} inputMode="decimal" className="tabular-nums" placeholder="Rate" disabled={!editable} value={line.rate} onChange={(e) => { updateLine(line.key, { rate: e.target.value }); }} />
                  <Input aria-label={`Line ${String(index + 1)} discount percent`} inputMode="decimal" className="tabular-nums" placeholder="Disc %" disabled={!editable} value={line.discountPct} onChange={(e) => { updateLine(line.key, { discountPct: e.target.value }); }} />
                  <Input
                  aria-label={`Line ${String(index + 1)} tax percent`}
                  inputMode="decimal"
                  className="tabular-nums"
                  placeholder="Tax %"
                  disabled={!editable}
                  value={line.taxPct}
                  onChange={(e) => { updateLine(line.key, { taxPct: e.target.value }); }}
                  onKeyDown={(e) => {
                    // Enter on the last box of the last line appends a line, as voucher entry does.
                    if (e.key === 'Enter' && index === lines.length - 1) {
                      e.preventDefault();
                      addLine();
                    }
                  }}
                  />
                </div>
                <div className="flex items-start justify-end gap-1">
                  <ItemHistoryAffordance stockItemId={line.stockItemId} partyId={partyId} companyId={companyId} />
                  {editable ? (
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${String(index + 1)}`} onClick={() => { removeLine(line.key); }}>
                    <TrashIcon />
                  </Button>
                  ) : null}
                </div>
              </div>
              {canPickItems ? (
                <ResolvedRateHint
                  partyId={partyId}
                  stockItemId={line.stockItemId}
                  quantity={line.quantity}
                  date={documentDate}
                  rate={line.rate}
                  reason={line.rateOverrideReason}
                  editable={editable}
                  lineNo={index + 1}
                  onUseRate={(rate) => {
                    updateLine(line.key, { rate: rate.replace(/\.?0+$/u, '') });
                  }}
                  onReasonChange={(reason) => {
                    updateLine(line.key, { rateOverrideReason: reason });
                  }}
                />
              ) : null}
              <div className="text-muted-foreground flex justify-end gap-4 text-xs tabular-nums">
                <span>{line.unit ? `per ${line.unit}` : ''}</span>
                <span>{p === null ? '—' : `${formatMoney(p.amount.toFixed(2))}${p.tax > 0 ? ` + tax ${formatMoney(p.tax.toFixed(2))}` : ''}`}</span>
              </div>
            </li>
            );
          })}
        </ol>

        <dl className="ml-auto grid w-full max-w-xs grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd className="text-right">{formatMoney((dirty || record === null ? previewSubtotal : Number(record.subtotal)).toFixed(2))}</dd>
          <dt className="text-muted-foreground">Discount</dt>
          <dd className="text-right">{formatMoney((dirty || record === null ? previewSubtotal - previewNet : Number(record.discountTotal)).toFixed(2))}</dd>
          <dt className="text-muted-foreground">Tax (for information)</dt>
          <dd className="text-right">{formatMoney((dirty || record === null ? previewTax : Number(record.taxTotal)).toFixed(2))}</dd>
          <dt className="font-medium">Total</dt>
          <dd className={cn('text-right font-medium')}>{formatMoney((dirty || record === null ? previewNet + previewTax : Number(record.grandTotal)).toFixed(2))}</dd>
        </dl>
        {dirty && editable ? <FieldDescription className="text-right">Preview — the server computes the figures on save.</FieldDescription> : null}
    </>
  );
}
