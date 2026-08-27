import { useState } from 'react';
import { LockKeyIcon } from '@phosphor-icons/react';
import { METRIC_REGISTRY, PERMISSIONS, type MetricDefinition } from '@vyuha/shared';

import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { DefinitionBody } from '@/components/shared/definition-panel';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatDate } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

/**
 * Definitions (CFO brief Q4): the registry as a screen, and its change
 * log -- every definition with its version and effective date, so a user
 * comparing an old export with a new one can see why they differ.
 */

const COLUMNS: RecordColumn<MetricDefinition>[] = [
  { key: 'id', header: 'Id', cell: (row) => <span className="font-mono text-xs">{row.id}</span>, className: 'w-16' },
  { key: 'label', header: 'Metric', cell: (row) => (
    <span className="flex flex-col">
      <span className="font-medium">{row.label}</span>
      <span className="text-muted-foreground text-xs">{row.meaning}</span>
    </span>
  ) },
  { key: 'formula', header: 'Formula', cell: (row) => <span className="font-mono text-xs">{row.formula}</span>, secondary: true },
  { key: 'built', header: 'Shown on', cell: (row) => (row.builtIn === null ? <Badge variant="outline">Not built yet</Badge> : row.builtIn), secondary: true },
  { key: 'version', header: 'Version', cell: (row) => `v${String(row.version)} · ${formatDate(row.effectiveFrom)}`, secondary: true },
];

export function DefinitionsPage() {
  const canView = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const isMobile = useIsMobile();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<MetricDefinition | null>(null);

  if (!canView) {
    return (
      <>
        <PageHeader description="Every metric's definition, version and source." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view definitions</EmptyTitle>
            <EmptyDescription>This needs the cfo.sales.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const needle = search.trim().toLowerCase();
  const rows = METRIC_REGISTRY.filter((m) => needle === '' || `${m.id} ${m.label} ${m.technicalName} ${m.meaning}`.toLowerCase().includes(needle));

  return (
    <>
      <PageHeader description="One source for every definition. A screen never invents a label; a change here is a version with an effective date, and that is the change log." />
      <div className="flex flex-col gap-4">
        <Input
          aria-label="Search definitions"
          placeholder="Search by id, name or meaning"
          value={search}
          className="max-w-sm"
          onChange={(event) => { setSearch(event.target.value); }}
        />
        <RecordTable
          columns={COLUMNS}
          rows={rows}
          rowKey={(row) => row.id}
          mobilePrimary={(row) => `${row.id} · ${row.label}`}
          mobileSupporting={(row) => row.formula}
          onRowActivate={setOpen}
        />
      </div>
      <Sheet open={open !== null} onOpenChange={(next) => { if (!next) setOpen(null); }}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-md">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{open ? `${open.id} · ${open.label}` : ''}</SheetTitle>
            <SheetDescription>How this is calculated.</SheetDescription>
          </SheetHeader>
          {open ? (
            <div className="max-h-[75vh] overflow-y-auto px-4 py-4 sm:max-h-none">
              <DefinitionBody metric={open} onOpenRelated={(id) => { const next = METRIC_REGISTRY.find((m) => m.id === id); if (next) setOpen(next); }} />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
