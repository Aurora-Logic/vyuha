import { useState } from 'react';
import { ClipboardIcon, ImageIcon, ReceiptIcon, TruckIcon, WarningCircleIcon } from '@phosphor-icons/react';

import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDate, formatMoney } from '@/lib/format';
import type { PortalDispatchView, PortalInvoiceView, PortalOrderView, PortalStatementRow } from '@vyuha/shared';

import { usePortal, usePortalMedia } from './use-portal';

/**
 * Area AL, what the customer sees. Everything here already existed; the
 * work was getting it to somebody with no account (REQ-AL-01/AL-02).
 *
 * Built for a phone opened from a WhatsApp message (REQ-AL-10): one fetch,
 * a headline figure first, then tabs — a customer wants "how much do I owe
 * and where is my lorry", in that order, and both are above the fold.
 *
 * Read-only. There is no action anywhere on this page, and there is no
 * sign-in: a wrong or withdrawn key says the same thing an unknown one
 * does, because the reader is not entitled to know which.
 */

type Tab = 'orders' | 'dispatches' | 'invoices' | 'statement';

export function PortalPage({ portalKey }: { portalKey: string }) {
  const portal = usePortal(portalKey);
  const [tab, setTab] = useState<Tab>('orders');

  if (portal.isPending) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6" aria-busy="true">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </main>
    );
  }

  if (portal.isError || portal.data === undefined) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WarningCircleIcon />
            </EmptyMedia>
            <EmptyTitle>This link no longer works</EmptyTitle>
            <EmptyDescription>It may have expired or been withdrawn. Ask your contact for a new one.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    );
  }

  const view = portal.data;
  const owed = Number(view.outstanding);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs">{view.organisationName}</p>
        <h1 className="text-xl font-medium">{view.partyName}</h1>
        <p className="text-muted-foreground text-xs">
          As at {formatDate(view.asOf.slice(0, 10))}. This link works until {formatDate(view.expiresAt.slice(0, 10))}.
        </p>
      </header>

      <dl className="divide-border grid grid-cols-2 divide-x divide-y border sm:grid-cols-4 sm:divide-y-0">
        <div className="flex flex-col gap-0.5 px-3 py-2">
          <dt className="text-muted-foreground text-[0.6875rem]">Outstanding</dt>
          <dd className="text-base font-medium tabular-nums">{formatMoney(view.outstanding)}</dd>
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2">
          <dt className="text-muted-foreground text-[0.6875rem]">Orders open</dt>
          <dd className="text-base font-medium tabular-nums">{String(view.orders.filter((o) => o.linesOpen > 0).length)}</dd>
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2">
          <dt className="text-muted-foreground text-[0.6875rem]">Dispatches</dt>
          <dd className="text-base font-medium tabular-nums">{String(view.dispatches.length)}</dd>
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2">
          <dt className="text-muted-foreground text-[0.6875rem]">Promised</dt>
          <dd className="text-base font-medium tabular-nums">
            {view.promises.length === 0 ? '—' : formatMoney(view.promises.reduce((sum, p) => sum + Number(p.amount), 0).toFixed(2))}
          </dd>
        </div>
      </dl>

      {owed > 0 && view.promises.length > 0 ? (
        <p className="text-muted-foreground text-sm">
          You told us to expect {formatMoney(view.promises.reduce((sum, p) => sum + Number(p.amount), 0).toFixed(2))} by{' '}
          {formatDate(view.promises.map((p) => p.promisedDate).sort()[0] ?? '')}.
        </p>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(next) => {
          setTab(String(next) as Tab);
        }}
      >
        <TabsList>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="dispatches">Dispatches</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="statement">Statement</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'orders' ? <Orders rows={view.orders} /> : null}
      {tab === 'dispatches' ? <Dispatches rows={view.dispatches} portalKey={portalKey} /> : null}
      {tab === 'invoices' ? <Invoices rows={view.invoices} /> : null}
      {tab === 'statement' ? <Statement rows={view.statement} outstanding={view.outstanding} /> : null}

      <p className="text-muted-foreground text-xs">
        A read-only view of your account with {view.organisationName}. Figures come from their books; if something looks wrong, reply to the message this link came in.
      </p>
    </main>
  );
}

function Orders({ rows }: { rows: readonly PortalOrderView[] }) {
  const columns: RecordColumn<PortalOrderView>[] = [
    { key: 'number', header: 'Order', cell: (row) => <span className="font-medium">{row.number}</span> },
    { key: 'date', header: 'Date', cell: (row) => formatDate(row.date) },
    { key: 'total', header: 'Value', cell: (row) => <span className="tabular-nums">{formatMoney(row.grandTotal)}</span> },
    { key: 'sent', header: 'Sent', cell: (row) => <span className="tabular-nums">{row.quantityDispatched} of {row.quantityOrdered}</span> },
    { key: 'state', header: 'State', cell: (row) => <Badge variant={row.fulfilment === 'Complete' ? 'default' : 'secondary'}>{row.fulfilment}</Badge> },
  ];
  if (rows.length === 0) return <Nothing icon={<ClipboardIcon />} title="No orders yet" />;
  return (
    <RecordTable
      columns={columns}
      rows={[...rows]}
      rowKey={(row) => row.number}
      mobilePrimary={(row) => row.number}
      mobileStatus={(row) => <Badge variant={row.fulfilment === 'Complete' ? 'default' : 'secondary'}>{row.fulfilment}</Badge>}
      mobileSupporting={(row) => `${formatDate(row.date)} · ${formatMoney(row.grandTotal)} · ${row.quantityDispatched} of ${row.quantityOrdered} sent`}
    />
  );
}

function Dispatches({ rows, portalKey }: { rows: readonly PortalDispatchView[]; portalKey: string }) {
  if (rows.length === 0) return <Nothing icon={<TruckIcon />} title="Nothing has been sent yet" />;
  return (
    <div className="flex flex-col gap-6">
      {rows.map((dispatch) => (
        <section key={dispatch.number} className="flex flex-col gap-3">
          <SectionHeading
            title={`${dispatch.number} · ${dispatch.orderNumber}`}
            note={[
              formatDate(dispatch.dispatchedAt.slice(0, 10)),
              dispatch.lrNumber === null ? null : `LR ${dispatch.lrNumber}`,
              dispatch.transporterName,
              dispatch.vehicleNumber,
              dispatch.deliveredAt === null ? null : `Delivered ${formatDate(dispatch.deliveredAt.slice(0, 10))}${dispatch.receivedBy === null ? '' : `, received by ${dispatch.receivedBy}`}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
          <ul className="text-sm">
            {dispatch.lines.map((line) => (
              <li key={line.description} className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
                <span>{line.description}</span>
                <span className="tabular-nums">
                  {line.quantity}
                  {line.unit === null ? '' : ` ${line.unit}`}
                </span>
              </li>
            ))}
          </ul>
          {dispatch.photos.length === 0 ? null : (
            <div className="flex flex-wrap gap-2">
              {dispatch.photos.map((photo) => (
                <Photo key={photo.fileId} portalKey={portalKey} fileId={photo.fileId} kind={photo.kind} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** REQ-AL-08: the bytes arrive behind a link minted for this request and no other. */
function Photo({ portalKey, fileId, kind }: { portalKey: string; fileId: string; kind: string }) {
  const [wanted, setWanted] = useState(false);
  const media = usePortalMedia(portalKey, wanted ? fileId : null);

  if (media.data !== undefined) {
    return (
      <a href={media.data.url} target="_blank" rel="noreferrer" className="block size-24 border">
        <img src={media.data.url} alt={`Dispatch photograph (${kind})`} className="size-full object-cover" />
      </a>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={media.isFetching}
      onClick={() => {
        setWanted(true);
      }}
    >
      {media.isFetching ? <Spinner data-icon="inline-start" /> : <ImageIcon data-icon="inline-start" />}
      {media.isError ? 'Not available' : `Show the ${kind}`}
    </Button>
  );
}

function Invoices({ rows }: { rows: readonly PortalInvoiceView[] }) {
  const columns: RecordColumn<PortalInvoiceView>[] = [
    { key: 'number', header: 'Invoice', cell: (row) => <span className="font-medium">{row.voucherNumber}</span> },
    { key: 'date', header: 'Date', cell: (row) => formatDate(row.date) },
    { key: 'amount', header: 'Amount', cell: (row) => <span className="tabular-nums">{formatMoney(row.amount)}</span> },
    { key: 'reference', header: 'Reference', cell: (row) => <span className="text-muted-foreground">{row.reference ?? '—'}</span>, secondary: true },
  ];
  if (rows.length === 0) return <Nothing icon={<ReceiptIcon />} title="No invoices yet" />;
  return (
    <RecordTable
      columns={columns}
      rows={[...rows]}
      rowKey={(row) => row.voucherNumber}
      mobilePrimary={(row) => row.voucherNumber}
      mobileSupporting={(row) => `${formatDate(row.date)} · ${formatMoney(row.amount)}`}
    />
  );
}

function Statement({ rows, outstanding }: { rows: readonly PortalStatementRow[]; outstanding: string }) {
  const columns: RecordColumn<PortalStatementRow>[] = [
    { key: 'date', header: 'Date', cell: (row) => formatDate(row.date) },
    { key: 'voucher', header: 'Document', cell: (row) => `${row.voucherType} ${row.voucherNumber}` },
    { key: 'debit', header: 'Charged', cell: (row) => <span className="tabular-nums">{row.debit === null ? '' : formatMoney(row.debit)}</span> },
    { key: 'credit', header: 'Paid', cell: (row) => <span className="tabular-nums">{row.credit === null ? '' : formatMoney(row.credit)}</span> },
    { key: 'running', header: 'Balance', cell: (row) => <span className="tabular-nums">{formatMoney(row.running)}</span> },
  ];
  if (rows.length === 0) return <Nothing icon={<ReceiptIcon />} title="Nothing on the account yet" />;
  return (
    <div className="flex flex-col gap-3">
      <RecordTable
        columns={columns}
        rows={[...rows]}
        rowKey={(row) => `${row.voucherType}-${row.voucherNumber}-${row.date}`}
        mobilePrimary={(row) => `${row.voucherType} ${row.voucherNumber}`}
        mobileSupporting={(row) => `${formatDate(row.date)} · ${row.debit === null ? `paid ${formatMoney(row.credit ?? '0')}` : `charged ${formatMoney(row.debit)}`}`}
      />
      <p className="text-sm font-medium tabular-nums">Outstanding: {formatMoney(outstanding)}</p>
    </div>
  );
}

function Nothing({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}
