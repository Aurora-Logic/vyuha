import { useState } from 'react';
import { ReceiptIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useNavigate } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { DateField } from '@/features/attendance/pickers';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { formatMoney } from '@/lib/format';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';

import { ResponsiveDialog, ResponsiveDialogActions } from '@/components/shared/responsive-dialog';
import { lineBalances, trimZeros, type Estimate, type SalesLine } from './types';
import { useCreateInvoice } from './use-invoices';

/**
 * D-38: an invoice raised here, against an order, for the packed-and-
 * uninvoiced balance of its lines at the order's rates. The boxes start at
 * the full balance; a line typed down to zero is left for a later invoice.
 * It lands as a draft and opens for confirming, which queues the Sales
 * voucher; the order's invoiced quantities advance when Tally accepts it
 * (P8-2), and the invoice's packed quantities are spoken for meanwhile.
 */

const QUANTITY = /^\d{1,12}(\.\d{1,3})?$/u;

interface InvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: Estimate | null;
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => void;
}

export function InvoiceDialog({ open, onOpenChange, order, loading = false, loadError, onRetry }: InvoiceDialogProps) {
  const close = () => {
    onOpenChange(false);
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={order === null ? 'Raise invoice' : `Invoice ${order.number}`}
      description={
        order === null
          ? 'The packed and uninvoiced balance, at the order’s rates.'
          : `${order.customerName}. The packed and uninvoiced balance, at the order’s rates. Confirm the draft to queue the Sales voucher.`
      }
      className="sm:max-w-lg"
    >
      {loading ? (
        <div role="status" aria-busy="true" aria-label="Loading the order" className="flex flex-col gap-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : null}
      {loadError !== undefined && loadError !== null ? <QueryErrorAlert error={loadError} subject="that sales order" onRetry={onRetry ?? close} /> : null}
      {order === null ? (
        <ResponsiveDialogActions>
          <Button variant="outline" onClick={close}>
            <ACTION_ICONS.close data-icon="inline-start" />
            Close
          </Button>
        </ResponsiveDialogActions>
      ) : (
        <InvoiceForm key={order.id} order={order} onClose={close} />
      )}
    </ResponsiveDialog>
  );
}

function InvoiceForm({ order, onClose }: { order: Estimate; onClose: () => void }) {
  const navigate = useNavigate();
  const lines = order.lines.filter((line) => lineBalances(line).toInvoice > 0);
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((line) => [line.id, trimZeros(lineBalances(line).toInvoice.toFixed(3))])),
  );
  const [date, setDate] = useState(() => toDateParam(new Date()));
  const [notes, setNotes] = useState('');
  const create = useCreateInvoice();

  const problems = lines.map((line) => problemFor(line, quantities[line.id] ?? ''));
  const named = lines.filter((line) => Number(quantities[line.id] ?? '0') > 0);
  const invoiceable = order.status === 'CONFIRMED' && order.partyId !== null;
  const canSubmit = invoiceable && named.length > 0 && problems.every((p) => p === null) && !create.isPending;
  const preview = named.reduce((sum, line) => sum + Number(quantities[line.id] ?? '0') * Number(line.rate) * (1 - Number(line.discountPct) / 100), 0);

  function submit() {
    if (!canSubmit) return;
    create.mutate(
      {
        documentId: order.id,
        input: {
          date,
          lines: named.map((line) => ({ lineId: line.id, quantity: (quantities[line.id] ?? '0').trim() })),
          notes: notes.trim() === '' ? null : notes.trim(),
        },
      },
      {
        onSuccess: (invoice) => {
          toast.add({ type: 'success', title: `${invoice.number} raised against ${order.number}`, description: `${formatMoney(invoice.grandTotal)}. A draft: confirm it to queue the Sales voucher.` });
          onClose();
          void navigate(`/sales/invoices/${invoice.id}`);
        },
      },
    );
  }

  const copy = actionErrorCopy(create.error, 'Raising the invoice');

  return (
    <ShortcutLayer id={`modal:invoice-${order.id}`}>
      <InvoiceShortcut onSave={submit} />
      <FieldGroup>
        {create.error ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>{copy.title}</AlertTitle>
            <AlertDescription>{copy.description}</AlertDescription>
          </Alert>
        ) : null}

        {invoiceable ? null : (
          <Alert>
            <ReceiptIcon />
            <AlertTitle>{order.partyId === null ? `${order.number} has no Tally party` : 'Only a confirmed order is invoiced'}</AlertTitle>
            <AlertDescription>{order.partyId === null ? 'An invoice needs one; the Sales voucher must land on a ledger.' : 'Confirm it first.'}</AlertDescription>
          </Alert>
        )}

        {lines.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing on {order.number} is packed and uninvoiced.</p>
        ) : (
          <ol className="flex flex-col divide-y border">
            {lines.map((line, index) => {
              const balance = lineBalances(line);
              const problem = problems[index] ?? null;
              return (
                <li key={line.id} className="flex flex-col gap-2 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0 text-sm font-medium">
                      <span className="text-muted-foreground mr-2 text-xs tabular-nums">{String(line.lineNo)}.</span>
                      {line.description}
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      Packed {trimZeros(line.packedQty)} · Invoiced {trimZeros(line.invoicedQty)}
                      {balance.invoicing > 0 ? ` · In flight ${trimZeros(balance.invoicing.toFixed(3))}` : ''} · Balance {trimZeros(balance.toInvoice.toFixed(3))}
                      {line.unit ? ` ${line.unit}` : ''} @ {formatMoney(line.rate)}
                    </span>
                  </div>
                  <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-2">
                    <Input
                      aria-label={`Line ${String(line.lineNo)} invoiced quantity`}
                      aria-invalid={problem !== null || undefined}
                      inputMode="decimal"
                      className="tabular-nums"
                      placeholder="Qty"
                      disabled={!invoiceable}
                      value={quantities[line.id] ?? ''}
                      onChange={(event) => {
                        setQuantities((current) => ({ ...current, [line.id]: event.target.value }));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          submit();
                        }
                      }}
                    />
                    <span className="text-muted-foreground text-right text-xs tabular-nums">{Number(line.discountPct) > 0 ? `less ${trimZeros(line.discountPct)}%` : ''}</span>
                  </div>
                  {problem === null ? null : <FieldError>{problem}</FieldError>}
                </li>
              );
            })}
          </ol>
        )}

        {invoiceable && lines.length > 0 ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Invoice date</FieldLabel>
                <DateField
                  label="Invoice date"
                  value={fromDateParam(date)}
                  onValueChange={(next) => {
                    setDate(toDateParam(next));
                  }}
                  yearsBack={1}
                  yearsForward={1}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="invoice-notes">Notes</FieldLabel>
                <Textarea
                  id="invoice-notes"
                  rows={2}
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value);
                  }}
                />
                <FieldDescription>Carried into the voucher narration.</FieldDescription>
              </Field>
            </div>
            <FieldDescription className="text-right tabular-nums">Before tax, about {formatMoney(preview.toFixed(2))} — the server computes the figures.</FieldDescription>
          </>
        ) : null}
      </FieldGroup>

      <ResponsiveDialogActions>
        <Button variant="outline" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          {invoiceable && lines.length > 0 ? 'Cancel' : 'Close'}
        </Button>
        {invoiceable && lines.length > 0 ? (
          <Button disabled={!canSubmit} onClick={submit}>
            {create.isPending ? <Spinner data-icon="inline-start" /> : <ReceiptIcon data-icon="inline-start" />}
            {create.isPending ? 'Raising' : 'Raise invoice'}
            <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
          </Button>
        ) : null}
      </ResponsiveDialogActions>
    </ShortcutLayer>
  );
}

/** The API's own sentence, so the field teaches the same rule the server enforces. */
function problemFor(line: SalesLine, quantity: string): string | null {
  const trimmed = quantity.trim();
  if (trimmed === '' || Number(trimmed) === 0) return null;
  if (!QUANTITY.test(trimmed)) return 'A quantity with up to three decimals.';
  const balance = lineBalances(line).toInvoice;
  if (Number(trimmed) > balance + 1e-9) return `Line ${String(line.lineNo)} (${line.description}) has ${balance.toFixed(3)} packed and uninvoiced.`;
  return null;
}

function InvoiceShortcut({ onSave }: { onSave: () => void }) {
  useShortcut({ id: 'invoice-dialog.save', keys: 'ctrl+a', label: 'Accept / Raise invoice', scope: 'modal', allowInInput: true, run: onSave });
  return null;
}
