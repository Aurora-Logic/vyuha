import { useState } from 'react';
import { DownloadSimpleIcon, ClockClockwiseIcon, LockKeyIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatDate } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { downloadDocumentFile } from '@/features/documents/download';

import { ExportButton } from './export-button';
import { INSIGHT_PRESETS, rangeAsPickerValue, rangeFromParams, toApiDate } from './period';
import { useCustomReports } from './api';
import { deleteSchedule, saveSchedule, useExportCatalogue, useSchedules, type ScheduleRowData } from './use-cfo';

/**
 * The Export Centre (brief O6): every report of the module in one place,
 * exportable on demand for the chosen period, or scheduled -- daily,
 * weekly on Mondays, monthly on the 1st -- delivered by the nightly run
 * as a summary with a link, since the workbook itself stays behind a
 * signed-in session. Only reports the caller's own keys open are listed.
 */

type CatalogueRow = { report: string; title: string; blurb: string };
type ScheduleDraft = { id?: string; report: string; cadence: string; recipients: string };

export function ExportCentrePage() {
  const canView = usePermission(PERMISSIONS.CFO_EXPORT);
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);
  const catalogue = useExportCatalogue({ enabled: canView });
  const customReports = useCustomReports({ enabled: canView });
  const schedules = useSchedules({ enabled: canView });
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [bundling, setBundling] = useState(false);

  async function save() {
    if (draft === null || draft.recipients.trim().length < 3) return;
    setBusy(true);
    try {
      await saveSchedule(draft);
      await queryClient.invalidateQueries({ queryKey: ['cfo', 'schedules'] });
      toast.add({ type: 'success', title: `${draft.report} scheduled ${draft.cadence}` });
      setDraft(null);
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not save the schedule', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await deleteSchedule(id);
      await queryClient.invalidateQueries({ queryKey: ['cfo', 'schedules'] });
      toast.add({ type: 'success', title: 'Schedule removed' });
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not remove the schedule', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(false);
    }
  }

  const catalogueColumns: RecordColumn<CatalogueRow>[] = [
    { key: 'title', header: 'Report', cell: (row) => (
      <span className="flex flex-col"><span className="font-medium">{row.title}</span><span className="text-muted-foreground text-xs">{row.blurb}</span></span>
    ) },
    { key: 'format', header: 'Format', cell: () => 'Excel', secondary: true },
    { key: 'actions', header: '', cell: (row) => (
      <span className="flex justify-end gap-2">
        {/* A custom report is read on its own page, not exported as a workbook (S-3). */}
        {row.report.startsWith('custom:') ? null : <ExportButton report={row.report} range={range} label="Export" />}
        <Button size="sm" variant="outline" onClick={() => { setDraft({ report: row.report, cadence: 'weekly', recipients: '' }); }}>
          <ClockClockwiseIcon data-icon="inline-start" />
          Schedule
        </Button>
      </span>
    ), numeric: true },
  ];

  const catalogueRows: CatalogueRow[] = [
    ...(catalogue.data ?? []),
    ...(customReports.data ?? []).map((report) => ({
      report: `custom:${report.id}`,
      title: `Custom · ${report.name}`,
      blurb: report.description !== '' ? report.description : 'A report you composed; schedules link readers to its page.',
    })),
  ];

  const scheduleColumns: RecordColumn<ScheduleRowData>[] = [
    { key: 'report', header: 'Report', cell: (row) => row.report },
    { key: 'cadence', header: 'Cadence', cell: (row) => <Badge variant="secondary">{row.cadence}</Badge> },
    { key: 'recipients', header: 'Recipients', cell: (row) => row.recipients, secondary: true },
    { key: 'lastRunOn', header: 'Last sent', cell: (row) => (row.lastRunOn === null ? 'Never yet' : formatDate(row.lastRunOn)), secondary: true },
    { key: 'actions', header: '', cell: (row) => (
      <span className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => { setDraft({ id: row.id, report: row.report, cadence: row.cadence, recipients: row.recipients }); }}>Edit</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void remove(row.id)}>Remove</Button>
      </span>
    ), numeric: true },
  ];

  if (!canView) {
    return (
      <>
        <PageHeader description="Every report, exportable on demand or on a schedule." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot export</EmptyTitle>
            <EmptyDescription>This needs the cfo.export permission; every export is logged.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="The 'give me everything' screen: every report your keys open, exportable for the chosen period or delivered on a cadence. Every export is logged."
        action={
          <Button
            size="sm"
            disabled={bundling}
            onClick={() => {
              void (async () => {
                setBundling(true);
                try {
                  await downloadDocumentFile(`/cfo/export-all?from=${range.from}&to=${range.to}`, `vyuha-cfo-pack-${range.from}-to-${range.to}.zip`);
                } catch (error) {
                  toast.add({ type: 'error', title: 'Could not build the bundle', description: error instanceof Error ? error.message : 'Try again.' });
                } finally {
                  setBundling(false);
                }
              })();
            }}
          >
            <DownloadSimpleIcon data-icon="inline-start" />
            {bundling ? 'Bundling…' : 'Export everything'}
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeField
            label="Period for exports"
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
        </div>

        {catalogue.isPending ? <Skeleton className="h-48" /> : null}
        {catalogue.error ? <QueryErrorAlert error={catalogue.error} subject="the catalogue" onRetry={() => void catalogue.refetch()} /> : null}
        {catalogue.data ? (
          <RecordTable
            columns={catalogueColumns}
            rows={catalogueRows}
            rowKey={(row) => row.report}
            mobilePrimary={(row) => row.title}
            mobileSupporting={(row) => row.blurb}
          />
        ) : null}

        <SectionHeading title="Scheduled delivery" note="Daily, weekly on Mondays, or monthly on the 1st -- sent by the nightly run as a summary with a link." />
        {schedules.isPending ? <Skeleton className="h-24" /> : null}
        {schedules.data && schedules.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing scheduled yet. Schedule a report from the catalogue above.</p>
        ) : null}
        {schedules.data && schedules.data.length > 0 ? (
          <RecordTable
            columns={scheduleColumns}
            rows={[...schedules.data]}
            rowKey={(row) => row.id}
            mobilePrimary={(row) => `${row.report} · ${row.cadence}`}
            mobileSupporting={(row) => row.recipients}
          />
        ) : null}
      </div>

      <Dialog open={draft !== null} onOpenChange={(open) => { if (!open) setDraft(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Schedule {draft?.report ?? ''}</DialogTitle>
            <DialogDescription>Recipients get a summary and a link each run; the workbook needs a signed-in session.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>Cadence</FieldLabel>
            <Select value={draft?.cadence ?? 'weekly'} onValueChange={(v) => { if (v !== null) setDraft((d) => (d === null ? d : { ...d, cadence: String(v) })); }}>
              <SelectTrigger aria-label="Cadence"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly, on Mondays</SelectItem>
                <SelectItem value="monthly">Monthly, on the 1st</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="schedule-recipients">Recipients</FieldLabel>
            <Input id="schedule-recipients" placeholder="owner@company.in, ca@firm.in" value={draft?.recipients ?? ''} onChange={(e) => { setDraft((d) => (d === null ? d : { ...d, recipients: e.target.value })); }} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDraft(null); }}>Cancel</Button>
            <Button disabled={busy || (draft?.recipients.trim().length ?? 0) < 3} onClick={() => void save()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
