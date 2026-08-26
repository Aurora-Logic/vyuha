import { useState } from 'react';
import { PlusIcon, SquaresFourIcon } from '@phosphor-icons/react';
import { useNavigate } from 'react-router';

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
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatRelativeAge } from '@/lib/format';

import { useCustomReports, useCustomReportMutations, type CustomReport } from './api';

/**
 * The custom reports list (owner, 26 Aug 2026): yours and the ones shared
 * with everyone, newest change first. Creation asks only for a name -- the
 * report opens straight into edit, where the widgets are the real work.
 */

const COLUMNS: RecordColumn<CustomReport>[] = [
  {
    key: 'name',
    header: 'Name',
    cell: (row) => (
      <span className="flex items-center gap-2">
        <span className="font-medium">{row.name}</span>
        {row.shared ? <Badge variant="secondary">Shared</Badge> : null}
      </span>
    ),
  },
  { key: 'owner', header: 'By', cell: (row) => (row.editable ? 'You' : row.ownerName), secondary: true },
  { key: 'widgets', header: 'Widgets', cell: (row) => String(row.widgets.length), numeric: true },
  {
    key: 'updated',
    header: 'Updated',
    cell: (row) => formatRelativeAge(row.updatedAt),
    className: 'tabular-nums',
    secondary: true,
  },
];

export function CustomReportsPage() {
  const navigate = useNavigate();
  const query = useCustomReports();
  const { create } = useCustomReportMutations();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  async function createReport() {
    const trimmed = name.trim();
    if (trimmed === '') return;
    try {
      const report = await create.mutateAsync({ name: trimmed, shared: false, widgets: [] });
      setOpen(false);
      setName('');
      void navigate(`/reports/custom/${report.id}?edit=1`);
    } catch (error) {
      toast.add({
        type: 'error',
        title: 'Could not create the report',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    }
  }

  const rows = query.data ?? [];

  return (
    <>
      <PageHeader
        description="Reports composed from the area metrics: yours, and the ones their authors shared."
        action={
          <Button
            size="sm"
            onClick={() => {
              setOpen(true);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            New report
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        {query.isPending ? (
          <div role="status" aria-busy="true" aria-label="Loading reports" className="border">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} aria-hidden className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="ml-auto h-3 w-16" />
              </div>
            ))}
          </div>
        ) : null}

        {query.isError ? (
          <QueryErrorAlert error={query.error} subject="reports" onRetry={() => void query.refetch()} />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SquaresFourIcon />
              </EmptyMedia>
              <EmptyTitle>No custom reports yet</EmptyTitle>
              <EmptyDescription>
                Compose one from the area metrics — a widget per question, sized and ordered as you
                read them. Only you see it until you mark it shared.
              </EmptyDescription>
            </EmptyHeader>
            <Button
              size="sm"
              onClick={() => {
                setOpen(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              New report
            </Button>
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <RecordTable
            columns={COLUMNS}
            rows={rows}
            rowKey={(row) => row.id}
            mobilePrimary={(row) => row.name}
            mobileStatus={(row) => (row.shared ? <Badge variant="secondary">Shared</Badge> : null)}
            mobileSupporting={(row) => `${row.editable ? 'You' : row.ownerName} · ${String(row.widgets.length)} widget${row.widgets.length === 1 ? '' : 's'}`}
            onRowActivate={(row) => {
              void navigate(`/reports/custom/${row.id}`);
            }}
          />
        ) : null}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New report</DialogTitle>
            <DialogDescription>Name it; the widgets come next, in the editor.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="new-report-name">Name</FieldLabel>
            <Input
              id="new-report-name"
              value={name}
              maxLength={80}
              placeholder="Collections week"
              onChange={(event) => {
                setName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void createReport();
                }
              }}
            />
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button disabled={name.trim() === '' || create.isPending} onClick={() => void createReport()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
