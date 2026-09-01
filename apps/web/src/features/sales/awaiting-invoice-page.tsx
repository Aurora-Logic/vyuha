import { useState } from 'react';
import { ArrowSquareOutIcon, ClipboardIcon, LinkIcon, LockKeyIcon, ReceiptIcon, ReceiptXIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useNavigate, useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { FulfilmentTabs } from './fulfilment-tabs';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { RowActions, type RowAction } from '@/components/shared/row-actions';
import { TabsToolbar } from '@/components/shared/tabs-toolbar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { EMPTY_VALUE, formatDate, formatMoney, formatRelativeAge } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { InvoiceDialog } from './invoice-dialog';
import { ResponsiveDialog, ResponsiveDialogActions } from '@/components/shared/responsive-dialog';
import { trimZeros, type AwaitingInvoiceEntry, type UnlinkedInvoice } from './types';
import { useSalesOrder } from './use-estimates';
import { useAwaitingInvoice, useLinkInvoice, useUnlinkedInvoices } from './use-fulfilment';

/**
 * The billing handshake (12 §3.3), the one place the flow waits on a person
 * in another system. Two tabs: what is packed and waiting for an invoice,
 * with how long it has waited (REQ-AA-11, AA-15); and Sales vouchers that
 * arrived with no order behind them (REQ-AA-13), each linked by hand to one
 * of the party's open orders — never guessed by party and date (D-21).
 */

const OVERDUE_HOURS = 24;

const WAITING_COLUMNS: RecordColumn<AwaitingInvoiceEntry>[] = [
  { key: 'number', header: 'Order', cell: (row) => <span className="font-medium tabular-nums">{row.number}</span> },
  { key: 'customer', header: 'Customer', cell: (row) => row.customerName },
  { key: 'qty', header: 'Packed, uninvoiced', cell: (row) => trimZeros(row.packedUninvoicedQty), numeric: true },
  { key: 'since', header: 'Waiting since', cell: (row) => formatRelativeAge(row.waitingSince), className: 'tabular-nums' },
  { key: 'hours', header: 'Waiting', cell: (row) => <WaitingBadge hours={row.waitingHours} /> },
];

/** REQ-AA-15: how long, and amber once it has waited a day. */
function WaitingBadge({ hours }: { hours: number }) {
  const overdue = hours >= OVERDUE_HOURS;
  const label = hours < 1 ? 'under an hour' : hours < 48 ? `${String(hours)}h` : `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
  return (
    <Badge variant="outline" className={overdue ? 'border-warning text-warning' : undefined}>
      {label}
    </Badge>
  );
}

const UNLINKED_COLUMNS: RecordColumn<UnlinkedInvoice>[] = [
  { key: 'voucher', header: 'Voucher', cell: (row) => <span className="font-medium tabular-nums">{row.voucherNumber}</span> },
  { key: 'date', header: 'Date', cell: (row) => formatDate(row.date), className: 'tabular-nums' },
  { key: 'party', header: 'Party', cell: (row) => row.partyName },
  { key: 'amount', header: 'Amount', cell: (row) => formatMoney(row.amount), numeric: true },
  { key: 'narration', header: 'Narration', cell: (row) => row.narration ?? EMPTY_VALUE, secondary: true, className: 'max-w-[16rem] truncate' },
  {
    key: 'candidates',
    header: 'Open orders',
    cell: (row) => (row.candidateOrders.length === 0 ? <span className="text-muted-foreground">None for this party</span> : `${String(row.candidateOrders.length)} candidate${row.candidateOrders.length === 1 ? '' : 's'}`),
  },
];

export function AwaitingInvoicePage() {
  const canViewSelf = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_SELF);
  const canViewAll = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_ALL);
  const canView = canViewSelf || canViewAll;
  const canCreate = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const tab = searchParams.get('tab') === 'unlinked' ? 'unlinked' : 'waiting';

  const waiting = useAwaitingInvoice({ enabled: canView });
  const unlinked = useUnlinkedInvoices({ enabled: canView });
  const [invoicing, setInvoicing] = useState<string | null>(null);
  const [linking, setLinking] = useState<UnlinkedInvoice | null>(null);
  const invoicingOrder = useSalesOrder(invoicing);

  function changeTab(next: string) {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next === 'unlinked') params.set('tab', 'unlinked');
        else params.delete('tab');
        return params;
      },
      { replace: true },
    );
  }

  if (!canView) {
    return (
      <>
        <PageHeader description="Packed and waiting for the accountant, and invoices with no order behind them." />
        <FulfilmentTabs current="invoice" />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view the billing queue</EmptyTitle>
            <EmptyDescription>This needs sales.document.view.self or sales.document.view.all — the Sales role carries it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const waitingRows = waiting.data ?? [];
  const unlinkedRows = unlinked.data ?? [];

  const waitingActions = (row: AwaitingInvoiceEntry): RowAction[] => [
    {
      key: 'invoice',
      label: 'Raise invoice',
      icon: ReceiptIcon,
      onSelect: () => {
        setInvoicing(row.documentId);
      },
      ...(canCreate ? {} : { unavailableReason: 'Raising an invoice needs sales.document.create.' }),
    },
    {
      key: 'open',
      label: 'Open order',
      icon: ArrowSquareOutIcon,
      onSelect: () => {
        void navigate(`/sales/orders/${row.documentId}`);
      },
    },
  ];

  const unlinkedActions = (row: UnlinkedInvoice): RowAction[] => [
    {
      key: 'link',
      label: 'Link to an order',
      icon: LinkIcon,
      onSelect: () => {
        setLinking(row);
      },
      ...(canCreate ? {} : { unavailableReason: 'Linking an invoice needs sales.document.create.' }),
    },
  ];

  return (
    <>
      <PageHeader description="Packed and waiting for the accountant, and Sales vouchers with no order behind them. Billing happens in Tally; the link is made on the pull, or here by hand." />

      <Tabs value={tab} className="gap-4" onValueChange={changeTab}>
        <TabsToolbar
          list={
            <TabsList>
              <TabsTrigger value="waiting" className="px-3">
                <ReceiptXIcon data-icon="inline-start" />
                Waiting
              </TabsTrigger>
              <TabsTrigger value="unlinked" className="px-3">
                <LinkIcon data-icon="inline-start" />
                Unlinked invoices
              </TabsTrigger>
            </TabsList>
          }
        >
          <TabsContent value="waiting" className="flex flex-col gap-4">
            {waiting.isPending ? <ListSkeleton rows={4} label="Loading the billing queue" /> : null}
            {waiting.isError ? (
              <QueryErrorAlert
                error={waiting.error}
                subject="the billing queue"
                onRetry={() => {
                  void waiting.refetch();
                }}
              />
            ) : null}
            {waiting.isSuccess && waitingRows.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ReceiptXIcon />
                  </EmptyMedia>
                  <EmptyTitle>Nothing is waiting for an invoice</EmptyTitle>
                  <EmptyDescription>Every packed quantity is invoiced. Orders arrive here as the pick queue packs them.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {waitingRows.length > 0 ? (
              <RecordTable
                columns={[...WAITING_COLUMNS, { key: 'actions', header: 'Actions', cell: (row) => <RowActions label={`Actions for ${row.number}`} actions={waitingActions(row)} />, className: 'w-12 text-right' }]}
                rows={waitingRows}
                rowKey={(row) => row.documentId}
                mobilePrimary={(row) => `${row.number} · ${row.customerName}`}
                mobileStatus={(row) => (
                  <span className="flex items-center gap-1">
                    <WaitingBadge hours={row.waitingHours} />
                    <RowActions label={`Actions for ${row.number}`} actions={waitingActions(row)} />
                  </span>
                )}
                mobileSupporting={(row) => `${trimZeros(row.packedUninvoicedQty)} packed and uninvoiced · since ${formatRelativeAge(row.waitingSince)}`}
                onRowActivate={(row) => {
                  void navigate(`/sales/orders/${row.documentId}`);
                }}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="unlinked" className="flex flex-col gap-4">
            {unlinked.isPending ? <ListSkeleton rows={4} label="Loading unlinked invoices" /> : null}
            {unlinked.isError ? (
              <QueryErrorAlert
                error={unlinked.error}
                subject="unlinked invoices"
                onRetry={() => {
                  void unlinked.refetch();
                }}
              />
            ) : null}
            {unlinked.isSuccess && unlinkedRows.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <LinkIcon />
                  </EmptyMedia>
                  <EmptyTitle>Every Sales voucher has its order</EmptyTitle>
                  <EmptyDescription>A voucher whose narration names the order number links itself on the pull. Anything it cannot place waits here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {unlinkedRows.length > 0 ? (
              <RecordTable
                columns={[...UNLINKED_COLUMNS, { key: 'actions', header: 'Actions', cell: (row) => <RowActions label={`Actions for voucher ${row.voucherNumber}`} actions={unlinkedActions(row)} />, className: 'w-12 text-right' }]}
                rows={unlinkedRows}
                rowKey={(row) => row.voucherId}
                mobilePrimary={(row) => `${row.voucherNumber} · ${row.partyName}`}
                mobileStatus={(row) => <RowActions label={`Actions for voucher ${row.voucherNumber}`} actions={unlinkedActions(row)} />}
                mobileSupporting={(row) => `${formatDate(row.date)} · ${formatMoney(row.amount)}${row.narration ? ` · ${row.narration}` : ''}`}
                onRowActivate={(row) => {
                  setLinking(row);
                }}
              />
            ) : null}
          </TabsContent>
        </TabsToolbar>
      </Tabs>

      <InvoiceDialog
        open={invoicing !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setInvoicing(null);
        }}
        order={invoicingOrder.data ?? null}
        loading={invoicing !== null && invoicingOrder.isPending}
        loadError={invoicingOrder.error}
        onRetry={() => {
          void invoicingOrder.refetch();
        }}
      />

      <LinkInvoiceDialog
        voucher={linking}
        canLink={canCreate}
        onOpenChange={(isOpen) => {
          if (!isOpen) setLinking(null);
        }}
      />
    </>
  );
}

/** The manual half of D-21: one voucher, one of the party's open orders, and the link. */
function LinkInvoiceDialog({ voucher, canLink, onOpenChange }: { voucher: UnlinkedInvoice | null; canLink: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <ResponsiveDialog
      open={voucher !== null}
      onOpenChange={onOpenChange}
      title={voucher === null ? 'Link invoice' : `Link ${voucher.voucherNumber}`}
      description={voucher === null ? undefined : `${voucher.partyName} · ${formatDate(voucher.date)} · ${formatMoney(voucher.amount)}. Choose which of the party’s open orders it bills.`}
      className="sm:max-w-md"
    >
      {voucher === null ? null : (
        <LinkInvoiceForm
          key={voucher.voucherId}
          voucher={voucher}
          canLink={canLink}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      )}
    </ResponsiveDialog>
  );
}

function LinkInvoiceForm({ voucher, canLink, onClose }: { voucher: UnlinkedInvoice; canLink: boolean; onClose: () => void }) {
  const [order, setOrder] = useState<PickerOption | null>(null);
  const link = useLinkInvoice();
  const options: PickerOption[] = voucher.candidateOrders.map((o) => ({ id: o.documentId, label: o.number, hint: `${formatDate(o.date)} · ${formatMoney(o.grandTotal)}` }));
  const copy = actionErrorCopy(link.error, 'Linking the invoice');

  function submit() {
    if (order === null || link.isPending || !canLink) return;
    link.mutate(
      { documentId: order.id, voucherId: voucher.voucherId },
      {
        onSuccess: (saved) => {
          toast.add({ type: 'success', title: `${voucher.voucherNumber} linked to ${saved.number}`, description: 'Its item lines advanced the order’s invoiced quantities.' });
          onClose();
        },
      },
    );
  }

  return (
    <>
      <FieldGroup>
        {link.error ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>{copy.title}</AlertTitle>
            <AlertDescription>{copy.description}</AlertDescription>
          </Alert>
        ) : null}
        {voucher.narration ? <p className="text-muted-foreground text-xs">Narration: {voucher.narration}</p> : null}
        {voucher.candidateOrders.length === 0 ? (
          <Alert>
            <ClipboardIcon />
            <AlertTitle>No open order for this party</AlertTitle>
            <AlertDescription>Only a confirmed order of the same party with packed, uninvoiced quantity can take an invoice. It waits here until one exists.</AlertDescription>
          </Alert>
        ) : (
          <Field>
            <FieldLabel htmlFor="link-order">Sales order</FieldLabel>
            <RecordPicker
              id="link-order"
              label="Sales order"
              placeholder="Choose the order it bills"
              searchPlaceholder="Search orders"
              emptyMessage="No open order matches."
              icon={<ClipboardIcon className="text-muted-foreground" />}
              options={options}
              disabled={!canLink}
              value={order}
              onValueChange={setOrder}
            />
            <FieldDescription>{canLink ? 'Never guessed by party and date: you are the link (D-21).' : 'Linking an invoice needs sales.document.create.'}</FieldDescription>
          </Field>
        )}
      </FieldGroup>
      <ResponsiveDialogActions>
        <Button variant="outline" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          {canLink && voucher.candidateOrders.length > 0 ? 'Cancel' : 'Close'}
        </Button>
        {canLink && voucher.candidateOrders.length > 0 ? (
          <Button disabled={order === null || link.isPending} onClick={submit}>
            {link.isPending ? <Spinner data-icon="inline-start" /> : <LinkIcon data-icon="inline-start" />}
            {link.isPending ? 'Linking' : 'Link'}
          </Button>
        ) : null}
      </ResponsiveDialogActions>
    </>
  );
}
