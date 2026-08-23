import { useState } from 'react';
import { CheckIcon, UploadSimpleIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatDate, formatRelativeAge } from '@/lib/format';
import { ShortcutLayer } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, SALES_DOCUMENT_STATUS_LABELS } from '@vyuha/shared';

import { DocumentLinesEditor } from './document-lines-editor';
import { SyncStateBadge } from './sales-order-sheet';
import { estimateToDraft, type Estimate } from './types';
import { useInvoiceAction } from './use-invoices';

/**
 * One Vyuha-raised invoice (D-38), read-only: it was raised from an order
 * for that order's packed balance at the order's rates, and its lines are
 * not edited here — a wrong invoice is cancelled as a draft and raised
 * again. Confirming is the moment it exists: the order's invoiced
 * quantities advance and the Sales voucher is queued; the sync badge is the
 * agent's last word (REQ-W-06).
 */

interface InvoiceSheetProps {
  invoice: Estimate | null;
  onOpenChange: (open: boolean) => void;
}

export function InvoiceSheet({ invoice, onOpenChange }: InvoiceSheetProps) {
  const isMobile = useIsMobile();
  return (
    <Sheet open={invoice !== null} onOpenChange={onOpenChange}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-3xl max-md:max-h-[92vh]">
        {invoice ? (
          <InvoiceSheetBody
            key={invoice.id}
            invoice={invoice}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function InvoiceSheetBody({ invoice, onClose }: { invoice: Estimate; onClose: () => void }) {
  const act = useInvoiceAction();
  const canCreate = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const isDraft = invoice.status === 'DRAFT';
  // Once per invoice (the body is keyed by id): the editor's keys must not change under it.
  const [lines] = useState(() => estimateToDraft(invoice).lines);

  function run(action: 'confirm' | 'push' | 'cancel') {
    act.mutate(
      { id: invoice.id, action },
      {
        onSuccess: (saved) => {
          toast.add({
            type: 'success',
            title:
              action === 'cancel'
                ? `${saved.number} cancelled`
                : saved.syncState === 'QUEUED'
                  ? `${saved.number} queued for Tally`
                  : `${saved.number} confirmed`,
            description:
              action === 'confirm'
                ? 'The order’s invoiced quantities moved on; dispatch can follow.'
                : action !== 'cancel' && saved.syncState === 'NOT_PUSHED'
                  ? 'No agent connection can carry it yet; push it when one is issued.'
                  : undefined,
          });
          if (action === 'cancel') onClose();
        },
      },
    );
  }

  const copy = actionErrorCopy(act.error, 'Changing the invoice');

  return (
    <ShortcutLayer id={`modal:invoice-${invoice.id}`}>
      <SheetHeader className="shrink-0 border-b">
        <SheetTitle className="flex flex-wrap items-center gap-2">
          {/* P8-1: the customer's number is Tally's; ours is the internal reference until Tally has answered. */}
          {invoice.syncState === 'PUSHED' && invoice.remoteVoucherNumber ? `Invoice #${invoice.remoteVoucherNumber}` : `Invoice ${invoice.number}`}
          {invoice.syncState === 'PUSHED' && invoice.remoteVoucherNumber ? <span className="text-muted-foreground text-sm font-normal">{invoice.number}</span> : null}
          <StatusBadge state={invoice.status} label={SALES_DOCUMENT_STATUS_LABELS[invoice.status]} />
          <SyncStateBadge record={invoice} />
        </SheetTitle>
        <SheetDescription>
          {invoice.syncState === 'PUSHED'
            ? `In Tally as voucher #${invoice.remoteVoucherNumber ?? '?'}${invoice.lastPushedAt ? `, ${formatRelativeAge(invoice.lastPushedAt)}` : ''}. That is the number the customer sees; the order's invoiced quantity moved when Tally accepted it.`
            : invoice.syncState === 'QUEUED'
              ? 'Queued: the agent will push it as a Sales voucher on its next poll and report back. The order moves, and dispatch may follow, once Tally accepts it (P8-2).'
              : isDraft
                ? 'A draft: confirm it to queue the Sales voucher. The order’s invoiced quantities advance when Tally accepts it.'
                : `${SALES_DOCUMENT_STATUS_LABELS[invoice.status]}.`}
        </SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <FieldGroup>
          {act.error ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>{copy.title}</AlertTitle>
              <AlertDescription>{copy.description}</AlertDescription>
            </Alert>
          ) : null}

          {invoice.syncState === 'FAILED' && invoice.lastError ? (
            <Alert variant="destructive">
              <XCircleIcon />
              <AlertTitle>Tally rejected it</AlertTitle>
              <AlertDescription>
                <p className="font-mono text-xs">{invoice.lastError}</p>
                <p className="mt-1">Tally&rsquo;s own words. Fix the cause there, then push again.</p>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel>Customer</FieldLabel>
              <p className="text-sm">{invoice.customerName}</p>
            </Field>
            <Field>
              <FieldLabel>Date</FieldLabel>
              <p className="text-sm tabular-nums">{formatDate(invoice.date)}</p>
            </Field>
            <Field>
              <FieldLabel>Against</FieldLabel>
              {invoice.sourceDocumentId === null ? (
                <p className="text-muted-foreground text-sm">No order</p>
              ) : (
                <Link to={`/sales/orders/${invoice.sourceDocumentId}`} className="text-sm underline-offset-4 hover:underline">
                  Open the sales order
                </Link>
              )}
            </Field>
          </div>

          <DocumentLinesEditor
            lines={lines}
            onLinesChange={() => undefined}
            editable={false}
            canPickItems={false}
            partyId={invoice.partyId}
            companyId={invoice.companyId}
            saved={invoice}
            dirty={false}
          />

          {invoice.notes || invoice.terms ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {invoice.notes ? (
                <Field>
                  <FieldLabel htmlFor="invoice-notes">Notes</FieldLabel>
                  <Textarea id="invoice-notes" rows={3} readOnly value={invoice.notes} />
                  <FieldDescription>Carried into the voucher narration.</FieldDescription>
                </Field>
              ) : null}
              {invoice.terms ? (
                <Field>
                  <FieldLabel htmlFor="invoice-terms">Terms</FieldLabel>
                  <Textarea id="invoice-terms" rows={3} readOnly value={invoice.terms} />
                </Field>
              ) : null}
            </div>
          ) : null}
        </FieldGroup>
      </div>

      <SheetFooter className="shrink-0 flex-row flex-wrap justify-end gap-2 border-t">
        {isDraft && canCreate ? (
          <Button variant="outline" className="mr-auto" disabled={act.isPending} onClick={() => { run('cancel'); }}>
            <XCircleIcon data-icon="inline-start" />
            Cancel invoice
          </Button>
        ) : null}
        {isDraft && canCreate ? (
          <Button variant="outline" disabled={act.isPending} onClick={() => { run('confirm'); }}>
            {act.isPending && act.variables?.action === 'confirm' ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
            Confirm and push
          </Button>
        ) : null}
        {invoice.status === 'CONFIRMED' && canCreate && (invoice.syncState === 'NOT_PUSHED' || invoice.syncState === 'FAILED') ? (
          <Button variant="outline" disabled={act.isPending} onClick={() => { run('push'); }}>
            {act.isPending && act.variables?.action === 'push' ? <Spinner data-icon="inline-start" /> : <UploadSimpleIcon data-icon="inline-start" />}
            {invoice.syncState === 'FAILED' ? 'Push again' : 'Push to Tally'}
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          <ACTION_ICONS.close data-icon="inline-start" />
          Close
        </Button>
      </SheetFooter>
    </ShortcutLayer>
  );
}
