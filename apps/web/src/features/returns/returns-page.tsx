import { useState } from 'react';
import { ArrowUUpLeftIcon, LinkIcon, LockKeyIcon, ReceiptIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router';

import { StatusBadge } from '@/components/shared/status-badge';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SearchField } from '@/components/shared/search-field';
import { SectionHeading } from '@/components/shared/section-heading';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, RETURN_STATE_LABELS, type SalesReturnSummary, type UnlinkedCreditNote } from '@vyuha/shared';

import { ReturnReceiptDialog } from './return-receipt-dialog';
import { ReturnSheet } from './return-sheet';
import { useLinkCreditNote, useReturns, useUnlinkedCreditNotes } from './use-returns';

/**
 * Area AK's screen. Two lists and a form: what has come back, and the
 * credit notes Tally sent that name no return. The second is the mirror of
 * the awaiting-invoice queue (12 §3.3) and exists for the same reason —
 * a link nobody can see is a link nobody trusts.
 */

const TABS = ['open', 'all', 'credit-notes'] as const;
type Tab = (typeof TABS)[number];

export function ReturnsPage() {
  const canView = usePermission(PERMISSIONS.RETURNS_VIEW);
  const canManage = usePermission(PERMISSIONS.RETURNS_MANAGE);
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : 'open';
  const page = Number(searchParams.get('page') ?? '1');
  const q = searchParams.get('q') ?? '';
  const [receiving, setReceiving] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const returns = useReturns(
    { page, pageSize: 25, ...(tab === 'open' ? { state: 'awaiting_credit_note' } : {}), ...(q === '' ? {} : { q }) },
    { enabled: canView && tab !== 'credit-notes' },
  );

  function setParams(next: Record<string, string | null>): void {
    setSearchParams(
      (current) => {
        const out = new URLSearchParams(current);
        for (const [key, value] of Object.entries(next)) {
          if (value === null) out.delete(key);
          else out.set(key, value);
        }
        return out;
      },
      { replace: true },
    );
  }

  if (!canView) {
    return (
      <>
        <PageHeader description="What customers sent back, why, and what happened next." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view returns</EmptyTitle>
            <EmptyDescription>This needs returns.view — the Sales, Sales manager and Accounts roles carry it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const columns: RecordColumn<SalesReturnSummary>[] = [
    { key: 'number', header: 'Return', cell: (row) => <span className="font-medium">{row.number}</span> },
    { key: 'customer', header: 'Customer', cell: (row) => row.customerName },
    { key: 'receivedOn', header: 'Received', cell: (row) => formatDate(row.receivedOn) },
    { key: 'quantity', header: 'Quantity', cell: (row) => <span className="tabular-nums">{row.quantity}</span> },
    { key: 'reasons', header: 'Why', cell: (row) => row.reasons.join(', ') },
    {
      key: 'state',
      header: 'State',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusBadge state={row.state} label={RETURN_STATE_LABELS[row.state]} />
          {row.scrapLines > 0 ? <Badge variant="destructive">{row.scrapLines} scrap</Badge> : null}
          {row.replacementNumber === null ? null : <Badge variant="outline">{row.replacementNumber}</Badge>}
        </span>
      ),
    },
    { key: 'creditNote', header: 'Credit note', cell: (row) => row.creditNoteNumber ?? '—', secondary: true },
  ];

  return (
    <>
      <PageHeader
        description="Goods that came back: how many, why, in what state, and where they went. Vyuha raises no credit note — each receipt waits for Tally's, and a restock rises in Tally, not here."
        action={
          canManage ? (
            <Button
              size="sm"
              onClick={() => {
                setReceiving(true);
              }}
            >
              <ArrowUUpLeftIcon data-icon="inline-start" />
              Receive a return
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <Tabs
          value={tab}
          onValueChange={(next) => {
            const chosen = String(next);
            setParams({ tab: chosen === 'open' ? null : chosen, page: null });
          }}
        >
          <TabsList>
            <TabsTrigger value="open">Awaiting credit note</TabsTrigger>
            <TabsTrigger value="all">All returns</TabsTrigger>
            {canManage ? <TabsTrigger value="credit-notes">Unlinked credit notes</TabsTrigger> : null}
          </TabsList>
        </Tabs>
        {tab === 'credit-notes' ? null : (
          <SearchField
            id="returns-search"
            label="Search returns"
            placeholder="Return number or customer"
            value={q}
            onValueChange={(next) => {
              setParams({ q: next === '' ? null : next, page: null });
            }}
          />
        )}
      </div>

      {tab === 'credit-notes' ? (
        <UnlinkedCreditNotes onLinked={setSelected} />
      ) : returns.isError ? (
        <QueryErrorAlert
          error={returns.error}
          subject="returns"
          onRetry={() => {
            void returns.refetch();
          }}
        />
      ) : returns.data === undefined ? (
        <div role="status" aria-busy="true" aria-label="Loading returns">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : returns.data.data.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ArrowUUpLeftIcon />
            </EmptyMedia>
            <EmptyTitle>{tab === 'open' ? 'Nothing is waiting on a credit note' : 'Nothing has come back'}</EmptyTitle>
            <EmptyDescription>{canManage ? 'When goods arrive at the desk, record them here with a photograph.' : 'Returns recorded at the desk appear here.'}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <RecordTable
            columns={columns}
            rows={[...returns.data.data]}
            rowKey={(row) => row.id}
            onRowActivate={(row) => {
              setSelected(row.id);
            }}
            mobilePrimary={(row) => `${row.number} · ${row.customerName}`}
            mobileSupporting={(row) => `${formatDate(row.receivedOn)} · ${row.quantity} back · ${RETURN_STATE_LABELS[row.state]}`}
          />
          {returns.data.meta.total > returns.data.meta.pageSize ? (
            <RecordPagination page={returns.data.meta.page} pageSize={returns.data.meta.pageSize} total={returns.data.meta.total} />
          ) : null}
        </>
      )}

      <ReturnReceiptDialog open={receiving} onOpenChange={setReceiving} />
      <ReturnSheet
        returnId={selected}
        onOpenChange={(next) => {
          if (!next) setSelected(null);
        }}
      />
    </>
  );
}

/** REQ-AK-06: never guessed at by party and date — a person picks the return. */
function UnlinkedCreditNotes({ onLinked }: { onLinked: (returnId: string) => void }) {
  const unlinked = useUnlinkedCreditNotes();
  const link = useLinkCreditNote();
  const [choice, setChoice] = useState<Record<string, string>>({});

  if (unlinked.isError) {
    return (
      <QueryErrorAlert
        error={unlinked.error}
        subject="the unlinked credit notes"
        onRetry={() => {
          void unlinked.refetch();
        }}
      />
    );
  }
  if (unlinked.data === undefined) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading credit notes">
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (unlinked.data.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ReceiptIcon />
          </EmptyMedia>
          <EmptyTitle>Every credit note is accounted for</EmptyTitle>
          <EmptyDescription>A credit note naming a return in its narration links itself on the next pull.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const columns: RecordColumn<UnlinkedCreditNote>[] = [
    { key: 'voucher', header: 'Credit note', cell: (row) => <span className="font-medium">{row.voucherNumber}</span> },
    { key: 'date', header: 'Date', cell: (row) => formatDate(row.date) },
    { key: 'party', header: 'Customer', cell: (row) => row.partyName },
    { key: 'amount', header: 'Amount', cell: (row) => <span className="tabular-nums">{formatMoney(row.amount)}</span> },
    { key: 'narration', header: 'Narration', cell: (row) => <span className="text-muted-foreground">{row.narration ?? '—'}</span>, secondary: true },
    {
      key: 'link',
      header: 'Against',
      cell: (row) =>
        row.candidateReturns.length === 0 ? (
          <span className="text-muted-foreground text-sm">No open return for this customer</span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <Select
              value={choice[row.voucherId] ?? null}
              onValueChange={(next) => {
                setChoice((current) => ({ ...current, [row.voucherId]: next ?? '' }));
              }}
            >
              <SelectTrigger aria-label={`Return for ${row.voucherNumber}`} className="w-48">
                <SelectValue placeholder="Choose a return" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {row.candidateReturns.map((candidate) => (
                    <SelectItem key={candidate.returnId} value={candidate.returnId}>
                      {candidate.number} · {candidate.quantity} back
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={link.isPending || (choice[row.voucherId] ?? '') === ''}
              onClick={() => {
                const returnId = choice[row.voucherId] ?? '';
                if (returnId === '') return;
                link.mutate(
                  { returnId, voucherId: row.voucherId },
                  {
                    onSuccess: (view) => {
                      toast.add({ type: 'success', title: `${row.voucherNumber} linked`, description: `${view.number} is credited.` });
                      onLinked(view.id);
                    },
                    onError: (error) => {
                      const copy = actionErrorCopy(error, 'Linking');
                      toast.add({ type: 'error', title: copy.title, description: copy.description });
                    },
                  },
                );
              }}
            >
              <LinkIcon data-icon="inline-start" />
              Link
            </Button>
          </span>
        ),
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading title="Credit notes with no return behind them" note="Choose the receipt each one answers. Nothing is matched by party and date alone." />
      <RecordTable
        columns={columns}
        rows={[...unlinked.data]}
        rowKey={(row) => row.voucherId}
        mobilePrimary={(row) => `${row.voucherNumber} · ${row.partyName}`}
        mobileSupporting={(row) => `${formatDate(row.date)} · ${formatMoney(row.amount)}`}
      />
    </section>
  );
}
