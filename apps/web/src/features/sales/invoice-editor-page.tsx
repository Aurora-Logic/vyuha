import { CheckIcon, UploadSimpleIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import { Link, useNavigate, useParams } from 'react-router';

import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { DocumentEditor } from '@/features/documents/document-editor';
import type { PaperModel } from '@/features/documents/paper';
import { useDesignDraft } from '@/features/documents/use-design-draft';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { useParty } from '@/features/masters/use-parties';
import { usePermission } from '@/lib/session/permissions';
import { INVOICE_COPY_LABELS, PERMISSIONS, SALES_DOCUMENT_STATUS_LABELS } from '@vyuha/shared';

import { SyncStateBadge } from './sales-order-sheet';
import type { Estimate } from './types';
import { useInvoice, useInvoiceAction } from './use-invoices';

/**
 * The invoice, as the page it prints on (D-38). Raised from an order, so
 * nothing on it is typed here: the paper shows what the order packed, and
 * the bar carries Confirm and push, Push again, Cancel. The PDF prints the
 * three copies GST asks for — original for the recipient, duplicate for
 * the transporter, triplicate for the supplier — each page named.
 */
export function InvoiceEditorPage() {
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const canViewSelf = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_SELF);
  const canViewAll = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_ALL);
  const canView = canViewSelf || canViewAll;
  const canCreate = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const record = useInvoice(canView ? (params.id ?? null) : null);
  const settings = useDesignDraft();
  const party = useParty(record.data?.partyId ?? null);
  const act = useInvoiceAction();

  if (!canView) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WarningCircleIcon />
          </EmptyMedia>
          <EmptyTitle>You cannot view invoices</EmptyTitle>
          <EmptyDescription>This needs sales.document.view.self or sales.document.view.all.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (record.isError) {
    return (
      <QueryErrorAlert
        error={record.error}
        subject="that invoice"
        onRetry={() => {
          void record.refetch();
        }}
      />
    );
  }
  if (record.data === undefined || settings === null) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading the invoice" className="flex flex-col gap-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="mx-auto h-[420px] w-full max-w-[210mm]" />
      </div>
    );
  }
  const invoice: Estimate = record.data;
  const isDraft = invoice.status === 'DRAFT';
  const buyerStateCode = invoice.placeOfSupply ?? (party.data?.gstin ?? '').slice(0, 2).replace(/\D/gu, '');
  const model: PaperModel = {
    type: 'INVOICE',
    number: invoice.syncState === 'PUSHED' && invoice.remoteVoucherNumber ? invoice.remoteVoucherNumber : invoice.number,
    statusLabel: SALES_DOCUMENT_STATUS_LABELS[invoice.status],
    date: invoice.date,
    validUntil: null,
    buyer: { name: invoice.customerName, address: party.data?.address ?? '', gstin: party.data?.gstin ?? '', stateName: '', stateCode: buyerStateCode },
    shipTo: invoice.shipTo,
    details: invoice.details ?? {},
    reference: invoice.number,
    lines: invoice.lines.map((line) => ({ key: line.id, stockItemId: line.stockItemId, description: line.description, hsnCode: line.hsnCode ?? '', rateOverrideReason: line.rateOverrideReason ?? '', quantity: line.quantity, unit: line.unit ?? '', rate: line.rate, discountPct: line.discountPct, taxPct: line.taxPct, amount: line.amount, taxAmount: line.taxAmount })),
    totals: { subtotal: invoice.subtotal, discountTotal: invoice.discountTotal, taxTotal: invoice.taxTotal, grandTotal: invoice.grandTotal, preview: false },
    notes: invoice.notes ?? '',
    terms: invoice.terms ?? '',
    copyLabel: INVOICE_COPY_LABELS.original,
  };

  function run(action: 'confirm' | 'push' | 'cancel') {
    act.mutate(
      { id: invoice.id, action },
      {
        onSuccess: (saved) => {
          toast.add({
            type: 'success',
            title: action === 'cancel' ? `${saved.number} cancelled` : saved.syncState === 'QUEUED' ? `${saved.number} queued for Tally` : `${saved.number} confirmed`,
            description: action === 'confirm' ? 'The order moves, and dispatch may follow, once Tally accepts it (P8-2).' : action !== 'cancel' && saved.syncState === 'NOT_PUSHED' ? 'No agent connection can carry it yet; push it when one is issued.' : undefined,
          });
          if (action === 'cancel') void navigate('/sales/invoices');
        },
      },
    );
  }
  const copy = actionErrorCopy(act.error, 'Changing the invoice');

  return (
    <DocumentEditor
      docType="INVOICE"
      backTo="/sales/invoices"
      backLabel="Invoices"
      title={invoice.syncState === 'PUSHED' && invoice.remoteVoucherNumber ? `Invoice #${invoice.remoteVoucherNumber} (${invoice.number})` : `Invoice ${invoice.number}`}
      badges={
        <>
          <StatusBadge state={invoice.status} label={SALES_DOCUMENT_STATUS_LABELS[invoice.status]} />
          <SyncStateBadge record={invoice} />
        </>
      }
      dirty={false}
      failure={act.error ? copy : null}
      hint={null}
      model={model}
      printPath={`/print/invoices/${invoice.id}`}
      excel={{ path: `/sales/invoices/${invoice.id}/export.xlsx`, filename: `Invoice-${invoice.number}.xlsx` }}
      settings={settings}
      extras={
        <div className="flex flex-col gap-3 text-sm">
          {invoice.syncState === 'FAILED' && invoice.lastError ? (
            <Alert variant="destructive">
              <XCircleIcon />
              <AlertTitle>Tally rejected it</AlertTitle>
              <AlertDescription>
                <p className="font-mono text-xs">{invoice.lastError}</p>
                <p className="mt-1">Tally&rsquo;s own words. Fix the cause there or here, then push again.</p>
              </AlertDescription>
            </Alert>
          ) : null}
          {invoice.sourceDocumentId ? (
            <p className="text-muted-foreground">
              Raised against{' '}
              <Link to={`/sales/orders/${invoice.sourceDocumentId}`} className="underline-offset-4 hover:underline">
                its sales order
              </Link>
              . The PDF prints three copies — {INVOICE_COPY_LABELS.original}, {INVOICE_COPY_LABELS.duplicate}, {INVOICE_COPY_LABELS.triplicate} — each page named.
            </p>
          ) : null}
        </div>
      }
      actions={
        <>
          {isDraft && canCreate ? (
            <Button variant="ghost" size="sm" disabled={act.isPending} onClick={() => { run('cancel'); }}>
              <XCircleIcon data-icon="inline-start" />
              Cancel invoice
            </Button>
          ) : null}
          {isDraft && canCreate ? (
            <Button size="sm" disabled={act.isPending} onClick={() => { run('confirm'); }}>
              {act.isPending && act.variables?.action === 'confirm' ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
              Confirm and push
            </Button>
          ) : null}
          {invoice.status === 'CONFIRMED' && canCreate && (invoice.syncState === 'NOT_PUSHED' || invoice.syncState === 'FAILED') ? (
            <Button size="sm" disabled={act.isPending} onClick={() => { run('push'); }}>
              {act.isPending && act.variables?.action === 'push' ? <Spinner data-icon="inline-start" /> : <UploadSimpleIcon data-icon="inline-start" />}
              {invoice.syncState === 'FAILED' ? 'Push again' : 'Push to Tally'}
            </Button>
          ) : null}
        </>
      }
    />
  );
}
