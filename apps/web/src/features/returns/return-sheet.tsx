import { useState } from 'react';
import { ArrowUUpLeftIcon, ReceiptIcon, TruckIcon, WarningIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { StatusBadge } from '@/components/shared/status-badge';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, REPLACEMENT_CHARGES, REPLACEMENT_CHARGE_LABELS, RETURN_CONDITION_LABELS, RETURN_DISPOSITION_LABELS, RETURN_STATE_LABELS, type ReplacementCharge, type ReturnLineView } from '@vyuha/shared';

import { useCancelReturn, useDecideReplacement, useReturn, useSetDisposition } from './use-returns';

/**
 * One return, and the three things anyone does with it: change what
 * happens to a line, link Tally's credit note when it arrives, and decide
 * whether the replacement is chargeable or free (D-51 — no default, because
 * a wrong one either gives goods away or bills for a company error).
 */

export function ReturnSheet({ returnId, onOpenChange }: { returnId: string | null; onOpenChange: (open: boolean) => void }) {
  const canManage = usePermission(PERMISSIONS.RETURNS_MANAGE);
  const canScrap = usePermission(PERMISSIONS.RETURNS_DISPOSITION);
  const canRaiseOrder = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const detail = useReturn(returnId);
  const disposition = useSetDisposition();
  const replacement = useDecideReplacement();
  const cancel = useCancelReturn();
  const [charge, setCharge] = useState<ReplacementCharge | ''>('');
  const [reason, setReason] = useState('');

  const view = detail.data ?? null;

  const columns: RecordColumn<ReturnLineView>[] = [
    { key: 'description', header: 'Item', cell: (row) => <span className="font-medium">{row.description}</span> },
    { key: 'quantity', header: 'Quantity', cell: (row) => <span className="tabular-nums">{row.quantity}{row.unit ? ` ${row.unit}` : ''}</span> },
    { key: 'reason', header: 'Reason', cell: (row) => <span>{row.reason}{row.reasonNote === null ? '' : ` · ${row.reasonNote}`}</span> },
    { key: 'condition', header: 'Condition', cell: (row) => RETURN_CONDITION_LABELS[row.condition] },
    {
      key: 'disposition',
      header: 'Then',
      cell: (row) =>
        canScrap && view !== null && view.state !== 'cancelled' && row.disposition === 'restock' ? (
          <Button
            variant="outline"
            size="sm"
            disabled={disposition.isPending || reason.trim().length < 3}
            onClick={() => {
              disposition.mutate(
                { returnId: view.id, input: { lineId: row.id, disposition: 'scrap', reason: reason.trim() } },
                {
                  onSuccess: () => {
                    setReason('');
                    toast.add({ type: 'success', title: 'Written off', description: `Line ${String(row.lineNo)} is scrap.` });
                  },
                  onError: (error) => {
                    const copy = actionErrorCopy(error, 'Scrapping');
                    toast.add({ type: 'error', title: copy.title, description: copy.description });
                  },
                },
              );
            }}
          >
            Scrap it
          </Button>
        ) : (
          <Badge variant={row.disposition === 'scrap' ? 'destructive' : 'outline'}>{RETURN_DISPOSITION_LABELS[row.disposition]}</Badge>
        ),
    },
    { key: 'replaced', header: 'Replaced', cell: (row) => <span className="tabular-nums">{row.replacedQty}</span> },
  ];

  return (
    <Sheet
      open={returnId !== null}
      onOpenChange={(next) => {
        if (!next) {
          setCharge('');
          setReason('');
        }
        onOpenChange(next);
      }}
    >
      <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader className="shrink-0 border-b">
          <SheetTitle>{view?.number ?? 'Return'}</SheetTitle>
          <SheetDescription>
            {view === null ? 'Reading the receipt.' : `${view.customerName} · received ${formatDate(view.receivedOn)}${view.receivedByName === null ? '' : ` by ${view.receivedByName}`}`}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {detail.isError ? (
            <QueryErrorAlert
              error={detail.error}
              subject="the return"
              onRetry={() => {
                void detail.refetch();
              }}
            />
          ) : view === null ? (
            <div role="status" aria-busy="true" aria-label="Reading the return" className="flex flex-col gap-4">
              <Skeleton className="h-8 w-40" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge state={view.state} label={RETURN_STATE_LABELS[view.state]} />
                {view.sourceNumber === null ? null : (
                  <Badge variant="outline">
                    Against{' '}
                    <Link to={`/sales/orders/${view.sourceDocumentId ?? ''}`} className="underline-offset-4 hover:underline">
                      {view.sourceNumber}
                    </Link>
                  </Badge>
                )}
                {view.replacementCharge === null ? null : <Badge variant="outline">{REPLACEMENT_CHARGE_LABELS[view.replacementCharge]}</Badge>}
              </div>

              {view.notes === null ? null : <p className="text-muted-foreground text-sm">{view.notes}</p>}

              <section className="flex flex-col gap-3">
                <SectionHeading title="What came back" note="A restock does not move stock here — it rises in Tally when the credit note is passed." />
                <RecordTable
                  columns={columns}
                  rows={[...view.lines]}
                  rowKey={(row) => row.id}
                  mobilePrimary={(row) => row.description}
                  mobileSupporting={(row) => `${row.quantity}${row.unit ? ` ${row.unit}` : ''} · ${row.reason} · ${RETURN_DISPOSITION_LABELS[row.disposition]}`}
                />
                {canScrap && view.state !== 'cancelled' ? (
                  <Field>
                    <FieldLabel htmlFor="scrap-reason">Why it is scrap</FieldLabel>
                    <Input
                      id="scrap-reason"
                      placeholder="Sheath cut through; unsellable"
                      value={reason}
                      onChange={(event) => {
                        setReason(event.target.value);
                      }}
                    />
                    <FieldDescription>Writing goods off is recorded with the sentence you write here.</FieldDescription>
                  </Field>
                ) : null}
              </section>

              {view.attachments.length === 0 ? null : (
                <section className="flex flex-col gap-3">
                  <SectionHeading title="Photographs" note={`${String(view.attachments.length)} taken at the desk.`} />
                  <div className="flex flex-wrap gap-2">
                    {view.attachments.map((attachment) => (
                      <AttachmentThumb key={attachment.id} returnId={view.id} fileId={attachment.fileId} kind={attachment.kind} />
                    ))}
                  </div>
                </section>
              )}

              <section className="flex flex-col gap-3">
                <SectionHeading title="Credit note" note="Tally's, always. Vyuha raises none." />
                {view.creditNote === null ? (
                  <p className="text-muted-foreground flex items-center gap-2 text-sm">
                    <WarningIcon className="text-muted-foreground" />
                    Waiting. A credit note naming {view.number} in its narration links itself; anything else is linked by hand from the queue.
                  </p>
                ) : (
                  <p className="text-sm">
                    <span className="font-medium">{view.creditNote.voucherNumber}</span> · {formatDate(view.creditNote.date)} · {formatMoney(view.creditNote.amount)} · linked {view.creditNote.method === 'narration' ? 'by its narration' : 'by hand'}
                  </p>
                )}
              </section>

              <section className="flex flex-col gap-3">
                <SectionHeading title="Replacement" note="A replacement is an ordinary order with this return's number on it." />
                {view.replacement === null ? (
                  canManage && canRaiseOrder && view.state !== 'cancelled' ? (
                    <div className="flex flex-wrap items-end gap-3">
                      <Field className="w-56">
                        <FieldLabel htmlFor="replacement-charge">Chargeable or free</FieldLabel>
                        <Select
                          value={charge === '' ? null : charge}
                          onValueChange={(next) => {
                            setCharge((next ?? ''));
                          }}
                        >
                          <SelectTrigger id="replacement-charge">
                            <SelectValue placeholder="Choose" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {REPLACEMENT_CHARGES.map((value) => (
                                <SelectItem key={value} value={value}>
                                  {REPLACEMENT_CHARGE_LABELS[value]}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <FieldDescription>There is no default: one gives goods away, the other bills for a company error.</FieldDescription>
                      </Field>
                      <Button
                        disabled={charge === '' || replacement.isPending}
                        onClick={() => {
                          if (charge === '') return;
                          replacement.mutate(
                            { returnId: view.id, input: { charge } },
                            {
                              onSuccess: (next) => {
                                toast.add({ type: 'success', title: 'Replacement raised', description: `${next.replacement?.number ?? 'The order'} is a draft; confirm it to start picking.` });
                              },
                              onError: (error) => {
                                const copy = actionErrorCopy(error, 'Raising the replacement');
                                toast.add({ type: 'error', title: copy.title, description: copy.description });
                              },
                            },
                          );
                        }}
                      >
                        {replacement.isPending ? <Spinner data-icon="inline-start" /> : <ArrowUUpLeftIcon data-icon="inline-start" />}
                        Raise it
                      </Button>
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">None raised.</p>
                  )
                ) : (
                  <p className="flex items-center gap-2 text-sm">
                    <TruckIcon className="text-muted-foreground" />
                    <Link to={`/sales/orders/${view.replacement.documentId}`} className="font-medium underline-offset-4 hover:underline">
                      {view.replacement.number}
                    </Link>
                    <span className="text-muted-foreground">
                      {view.replacement.status.toLowerCase()} · {formatMoney(view.replacement.grandTotal)} · {String(view.replacement.dispatchCount)} dispatch{view.replacement.dispatchCount === 1 ? '' : 'es'}
                    </span>
                  </p>
                )}
              </section>

              {view.cancelledReason === null ? null : <p className="text-muted-foreground text-sm">Cancelled: {view.cancelledReason}</p>}
            </div>
          )}
        </div>

        <SheetFooter className="shrink-0 flex-row flex-wrap justify-end gap-2 border-t">
          {view !== null && canManage && view.state === 'awaiting_credit_note' && view.replacement === null ? (
            <Button
              variant="outline"
              disabled={cancel.isPending || reason.trim().length < 3}
              onClick={() => {
                cancel.mutate(
                  { returnId: view.id, reason: reason.trim() },
                  {
                    onSuccess: () => {
                      setReason('');
                      toast.add({ type: 'success', title: `${view.number} cancelled` });
                    },
                    onError: (error) => {
                      const copy = actionErrorCopy(error, 'Cancelling');
                      toast.add({ type: 'error', title: copy.title, description: copy.description });
                    },
                  },
                );
              }}
            >
              <ReceiptIcon data-icon="inline-start" />
              Cancel the receipt
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            <ACTION_ICONS.close data-icon="inline-start" />
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** The photograph itself, behind a signed URL minted when the thumbnail renders. */
function AttachmentThumb({ returnId, fileId, kind }: { returnId: string; fileId: string; kind: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (url !== null) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block size-20 border">
        <img src={url} alt={`Return photograph (${kind})`} className="size-full object-cover" />
      </a>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void fetchAttachmentUrl(returnId, fileId)
          .then(setUrl)
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      {busy ? <Spinner data-icon="inline-start" /> : null}
      Show the {kind}
    </Button>
  );
}

async function fetchAttachmentUrl(returnId: string, fileId: string): Promise<string> {
  const { apiRequest } = await import('@/lib/api/client');
  const result = await apiRequest<{ url: string }>(`/sales/returns/${returnId}/attachments/${fileId}/url`);
  return result.url;
}
