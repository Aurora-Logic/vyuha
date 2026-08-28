import { UploadSimpleIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import { Link, useParams } from 'react-router';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { PaperPage, PaperPageSkeleton } from '@/features/documents/paper-page';
import { dispatchAsPaper } from '@/features/documents/paper-record';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { usePermission } from '@/lib/session/permissions';
import { DISPATCH_MODE_LABELS, PERMISSIONS } from '@vyuha/shared';

import { DispatchNotifications, DispatchPhotographs, DeliverSection } from './dispatch-sections';
import { SyncStateBadge } from './sales-order-sheet';
import { useDispatch, usePushDispatch } from './use-dispatches';
import { useSalesOrder } from './use-estimates';

/**
 * One dispatch as the Delivery Note it prints (REQ-AA-16, AA-31): what
 * left, for whom, how it travelled — on the same paper as the order it
 * left for, quantities only. Push to Tally when the agent has not carried
 * it; the photographs and the customer's notification sit beneath.
 */
export function DispatchPaperPage() {
  const params = useParams<{ id?: string }>();
  // P8-5: the delivery note and its re-push are fulfilment work.
  const canView = usePermission(PERMISSIONS.SALES_FULFIL);
  const canAct = canView;
  const dispatch = useDispatch(canView ? (params.id ?? null) : null);
  const order = useSalesOrder(dispatch.data?.documentId ?? null);
  const push = usePushDispatch();

  if (!canView) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WarningCircleIcon />
          </EmptyMedia>
          <EmptyTitle>You cannot view dispatches</EmptyTitle>
          <EmptyDescription>This needs sales.document.view.self or sales.document.view.all.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const failed = [dispatch, order].find((q) => q.isError);
  if (failed !== undefined) {
    return (
      <QueryErrorAlert
        error={failed.error}
        subject="that dispatch"
        onRetry={() => {
          void failed.refetch();
        }}
      />
    );
  }
  if (dispatch.data === undefined || order.data === undefined) return <PaperPageSkeleton label="Loading the delivery note" />;
  const record = dispatch.data;
  const copy = actionErrorCopy(push.error, 'Pushing the Delivery Note');

  return (
    <PaperPage
      docType="DELIVERY_NOTE"
      record={dispatchAsPaper(record, order.data)}
      backTo="/sales/dispatches"
      backLabel="Dispatches"
      title={record.syncState === 'PUSHED' && record.remoteVoucherNumber ? `Delivery note #${record.remoteVoucherNumber} (${record.number})` : `Delivery note ${record.number}`}
      badges={
        <>
          <Badge variant="outline">{DISPATCH_MODE_LABELS[record.mode]}</Badge>
          <SyncStateBadge record={record} />
        </>
      }
      failure={push.error ? copy : null}
      printPath={`/print/dispatches/${record.id}`}
      excel={{ path: `/sales/dispatches/${record.id}/export.xlsx`, filename: `Delivery-Note-${record.number}.xlsx` }}
      actions={
        canAct && (record.syncState === 'NOT_PUSHED' || record.syncState === 'FAILED') ? (
          <Button
            size="sm"
            disabled={push.isPending}
            onClick={() => {
              push.mutate(record.id, {
                onSuccess: (saved) => {
                  toast.add({ type: 'success', title: `${saved.number} queued for Tally`, description: 'The agent pushes the Delivery Note on its next poll.' });
                },
              });
            }}
          >
            {push.isPending ? <Spinner data-icon="inline-start" /> : <UploadSimpleIcon data-icon="inline-start" />}
            {record.syncState === 'FAILED' ? 'Push again' : 'Push to Tally'}
          </Button>
        ) : null
      }
      extras={
        <div className="flex flex-col gap-6">
          {record.lastError ? (
            <Alert variant="destructive">
              <XCircleIcon />
              <AlertTitle>{record.syncState === 'FAILED' ? 'Tally rejected the Delivery Note' : 'Tally has since changed it'}</AlertTitle>
              <AlertDescription>
                <p className="font-mono text-xs">{record.lastError}</p>
                <p className="mt-1">{record.syncState === 'FAILED' ? 'Tally’s own words. Fix the cause there, then push again.' : 'Seen on the pull (D-38). The goods left either way; the accountant decides what replaces the voucher.'}</p>
              </AlertDescription>
            </Alert>
          ) : null}
          <p className="text-muted-foreground text-sm">
            {record.customerName} · against{' '}
            <Link to={`/sales/orders/${record.documentId}`} className="underline-offset-4 hover:underline">
              {record.orderNumber}
            </Link>
            {record.dispatchedByName ? ` · dispatched by ${record.dispatchedByName}` : ''}
            {record.syncState === 'PUSHED' ? `. In Tally as Delivery Note #${record.remoteVoucherNumber ?? '?'}.` : record.syncState === 'QUEUED' ? '. Queued: the agent pushes the Delivery Note on its next poll.' : '.'}
          </p>
          <DeliverSection dispatch={record} />
          <DispatchPhotographs dispatch={record} />
          <DispatchNotifications dispatch={record} />
        </div>
      }
    />
  );
}
