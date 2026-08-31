import { useState } from 'react';
import { ArrowsClockwiseIcon, LockKeyIcon, ShieldCheckIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { apiRequest } from '@/lib/api/client';
import { formatCount, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { INSIGHT_PRESETS, rangeAsPickerValue, rangeFromParams, toApiDate } from './period';
import { ExportButton } from './export-button';
import { reviewException, useExceptions, type ExceptionRowData } from './use-cfo';

/**
 * Exception reports (brief F2): the vouchers that look wrong, each with
 * the voucher, the party, the value and why. Accept needs a reason;
 * Investigate creates a task. Reviewed rows grey out but stay for audit.
 * Checks the sync cannot feed say so rather than showing an empty list
 * as a clean bill.
 */

export function ExceptionsPage() {
  const canView = usePermission(PERMISSIONS.CFO_EXCEPTIONS_VIEW);
  const canTask = usePermission(PERMISSIONS.CRM_TASK_MANAGE);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);
  const query = useExceptions(range, { enabled: canView });
  const [tab, setTab] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<ExceptionRowData | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function accept() {
    if (accepting === null || reason.trim() === '') return;
    setBusy(true);
    try {
      await reviewException({ checkKey: accepting.checkKey, voucherId: accepting.voucherId, state: 'accepted', reason: reason.trim() });
      await queryClient.invalidateQueries({ queryKey: ['cfo', 'exceptions'] });
      toast.add({ type: 'success', title: `${accepting.voucherNumber} accepted` });
      setAccepting(null);
      setReason('');
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not accept', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function investigate(row: ExceptionRowData) {
    setBusy(true);
    try {
      await apiRequest('/tasks', {
        method: 'POST',
        body: {
          title: `Investigate ${row.voucherType} ${row.voucherNumber}: ${row.party}`,
          description: `${row.reason}. ${formatMoney(row.amount)} on ${formatDate(row.voucherDate)}.`,
          priority: 'HIGH',
          subjectType: 'voucher',
          subjectId: row.voucherId,
        },
      });
      await reviewException({ checkKey: row.checkKey, voucherId: row.voucherId, state: 'investigating', reason: '' });
      await queryClient.invalidateQueries({ queryKey: ['cfo', 'exceptions'] });
      toast.add({ type: 'success', title: 'Task created', description: `${row.voucherNumber} is on the board.` });
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not create the task', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (!canView) {
    return (
      <>
        <PageHeader description="The vouchers that look wrong, each with a reason." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view exceptions</EmptyTitle>
            <EmptyDescription>This needs the cfo.exceptions.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;
  const checks = data?.checks ?? [];
  const activeKey = tab ?? checks.find((c) => c.rows.some((r) => r.review === null))?.key ?? checks[0]?.key ?? '';

  const columns: RecordColumn<ExceptionRowData>[] = [
    { key: 'voucher', header: 'Voucher', cell: (row) => (
      <span className="flex flex-col">
        <span className="font-medium">{row.voucherType} {row.voucherNumber}</span>
        <span className="text-muted-foreground text-xs">{formatDate(row.voucherDate)}</span>
      </span>
    ) },
    { key: 'party', header: 'Party', cell: (row) => row.party },
    { key: 'amount', header: 'Value', cell: (row) => formatMoney(row.amount), numeric: true },
    { key: 'reason', header: 'Why', cell: (row) => row.reason, secondary: true },
    { key: 'review', header: 'Review', cell: (row) =>
      row.review === null ? (
        <span className="flex justify-end gap-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={(e) => { e.stopPropagation(); setAccepting(row); }}>Accept</Button>
          {canTask ? <Button size="sm" variant="outline" disabled={busy} onClick={(e) => { e.stopPropagation(); void investigate(row); }}>Investigate</Button> : null}
        </span>
      ) : (
        <span className="flex flex-col items-end">
          <Badge variant="secondary">{row.review.state === 'accepted' ? 'Accepted' : 'Investigating'}</Badge>
          {row.review.reason ? <span className="text-muted-foreground text-xs">{row.review.reason}</span> : null}
        </span>
      ), numeric: true },
  ];

  return (
    <>
      <PageHeader description="Nightly's morning list, on demand: the vouchers that look wrong, each with a reason. Accept with a reason, or investigate as a task." />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon-sm" aria-label="Refresh" disabled={query.isFetching} onClick={() => void query.refetch()}>
            <ArrowsClockwiseIcon />
          </Button>
          <DateRangeField
            label="Period"
            value={rangeAsPickerValue(range)}
            presets={INSIGHT_PRESETS}
            onValueChange={(next) => {
              if (!next.from || !next.to) return;
              const from = toApiDate(next.from);
              const to = toApiDate(next.to);
              setSearchParams((current) => { const p = new URLSearchParams(current); p.set('from', from); p.set('to', to); return p; }, { replace: true });
            }}
          />
          <span className="text-muted-foreground text-xs tabular-nums">{formatDate(range.from)} → {formatDate(range.to)}</span>
          <span className="ml-auto"><ExportButton report="exceptions" range={range} /></span>
        </div>

        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.error ? <QueryErrorAlert error={query.error} subject="exceptions" onRetry={() => void query.refetch()} /> : null}

        {data ? (
          <>
            <KpiGrid
              columns={3}
              tiles={[
                { label: 'Open exceptions', value: formatCount(data.open) },
                { label: 'Checks running', value: formatCount(checks.filter((c) => c.available).length), note: `of ${formatCount(checks.length)}` },
                { label: 'Reviewed', value: formatCount(checks.reduce((n, c) => n + c.rows.filter((r) => r.review !== null).length, 0)) },
              ]}
            />
            {checks.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><ShieldCheckIcon /></EmptyMedia>
                  <EmptyTitle>Nothing to check</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <Tabs value={activeKey} onValueChange={(v) => { setTab(String(v)); }}>
                <TabsList className="no-scrollbar max-w-full overflow-x-auto">
                  {checks.map((c) => (
                    <TabsTrigger key={c.key} value={c.key} className="px-3">
                      {c.label}
                      {c.available ? <Badge variant={c.rows.some((r) => r.review === null) ? 'destructive' : 'secondary'} className="ml-1">{formatCount(c.rows.length)}</Badge> : null}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {checks.map((c) => (
                  <TabsContent key={c.key} value={c.key} className="flex flex-col gap-3">
                    <p className="text-muted-foreground text-sm">{c.hint}</p>
                    {!c.available ? (
                      <Empty className="border">
                        <EmptyHeader>
                          <EmptyTitle>Not measurable yet</EmptyTitle>
                          <EmptyDescription>{c.note}</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : c.rows.length === 0 ? (
                      <Empty className="border">
                        <EmptyHeader>
                          <EmptyMedia variant="icon"><ShieldCheckIcon /></EmptyMedia>
                          <EmptyTitle>Nothing flagged in this period</EmptyTitle>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <RecordTable
                        columns={columns}
                        rows={[...c.rows]}
                        rowKey={(row) => row.voucherId}
                        rowClassName={(row) => (row.review === null ? undefined : 'opacity-60')}
                        mobilePrimary={(row) => `${row.voucherType} ${row.voucherNumber} · ${row.party}`}
                        mobileStatus={(row) => (row.review === null ? <Badge variant="destructive">Open</Badge> : <Badge variant="secondary">{row.review.state === 'accepted' ? 'Accepted' : 'Investigating'}</Badge>)}
                        mobileSupporting={(row) => `${formatMoney(row.amount)} · ${row.reason}`}
                        onRowActivate={(row) => void navigate(`/masters/vouchers/${row.voucherId}`)}
                      />
                    )}
                  </TabsContent>
                ))}
              </Tabs>
            )}
          </>
        ) : null}
      </div>

      <Dialog open={accepting !== null} onOpenChange={(open) => { if (!open) { setAccepting(null); setReason(''); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Accept {accepting?.voucherNumber ?? ''}</DialogTitle>
            <DialogDescription>Accepted rows stay on the list, greyed, with your reason beside them.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="exception-reason">Reason</FieldLabel>
            <Textarea id="exception-reason" rows={3} maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); }} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAccepting(null); setReason(''); }}>Cancel</Button>
            <Button disabled={busy || reason.trim() === ''} onClick={() => void accept()}>Accept</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
