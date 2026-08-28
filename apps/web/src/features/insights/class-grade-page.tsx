import { useState } from 'react';
import { ArrowsClockwiseIcon, LockKeyIcon } from '@phosphor-icons/react';
import { useNavigate } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ClassBadge, GradeBadge } from '@/components/shared/customer-badges';
import { DefinitionLink } from '@/components/shared/definition-panel';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { MatrixGrid } from '@/components/shared/matrix-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { DateField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useIsMobile } from '@/hooks/use-mobile';
import { EMPTY_VALUE, formatCount, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { ExportButton } from './export-button';
import { defaultRange, toApiDate } from './period';
import {
  applyClassImport,
  assignClass,
  previewClassImport,
  snoozeAlert,
  useClassGrade,
  useMismatches,
  useNeglected,
  useTiers,
  type ClassGradeData,
  type ImportRowData,
  type MismatchRowData,
  type NeglectedRowData,
} from './use-cfo';

/** P7: a class change defaults to the 1st of the next month, never mid-period. */
function firstOfNextMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

const IMPORT_STATUS_LABEL: Record<ImportRowData['status'], string> = {
  'change': 'Will change',
  'unchanged': 'Unchanged',
  'unknown-party': 'Unknown customer',
  'ambiguous-party': 'Ambiguous name',
  'unknown-class': 'Unknown class',
  'applied': 'Applied',
  'failed': 'Failed',
};

/**
 * Class x payment grade (brief Q2.2): the manual class down the side, the
 * system's grade across the top, count and rupees in every cell. The
 * A+ / D cell is the concentrated risk in one number -- your most
 * important customers who pay late -- and it is invisible when the two
 * gradings look alike.
 */

type Cell = ClassGradeData['cells'][number];

const PARTY_COLUMNS: RecordColumn<Cell['parties'][number]>[] = [
  { key: 'party', header: 'Customer', cell: (row) => row.party },
  { key: 'outstanding', header: 'Outstanding', cell: (row) => formatMoney(row.outstanding), numeric: true },
];

export function ClassGradePage() {
  const canView = usePermission(PERMISSIONS.CFO_RECEIVABLES_VIEW);
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const query = useClassGrade({ enabled: canView });
  const tiers = useTiers({ enabled: canView });
  const [open, setOpen] = useState<Cell | null>(null);

  if (!canView) {
    return (
      <>
        <PageHeader description="Customer class against payment grade." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view this grid</EmptyTitle>
            <EmptyDescription>This needs the cfo.receivables.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;
  const tierOf = (code: string) => tiers.data?.find((t) => t.code === code);
  const find = (tierCode: string, grade: string) => data?.cells.find((c) => c.tierCode === tierCode && c.grade === grade);
  const concentrated = data?.cells.filter((c) => c.tierCode === 'A+' && (c.grade === 'D' || c.grade === 'E')) ?? [];

  return (
    <>
      <PageHeader
        description="How important they are to us, against how they pay. The top-left is where you earn; the top-right is your concentrated risk."
        action={
          <span className="flex items-center gap-2">
            <ExportButton report="class-grade" range={defaultRange()} />
            <Button variant="outline" size="icon-sm" aria-label="Refresh" disabled={query.isFetching} onClick={() => void query.refetch()}>
              <ArrowsClockwiseIcon />
            </Button>
          </span>
        }
      />
      <div className="flex flex-col gap-4">
        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.error ? <QueryErrorAlert error={query.error} subject="class and grade grid" onRetry={() => void query.refetch()} /> : null}
        {data ? (
          <>
            <KpiGrid
              columns={3}
              tiles={[
                { label: 'Key accounts paying late', value: formatCount(concentrated.reduce((n, c) => n + c.count, 0)), note: formatMoney(concentrated.reduce((s, c) => s + Number(c.amount), 0).toFixed(2)) },
                { label: 'Unclassed on the book', value: formatCount(data.unclassed.count), note: formatMoney(data.unclassed.amount) },
                { label: 'Classes', value: formatCount(data.classes.length), info: <DefinitionLink id="D18" /> },
              ]}
            />
            <MatrixGrid
              rows={data.classes.map((c) => ({ key: c, label: `${c} · ${tierOf(c)?.label ?? ''}` }))}
              columns={data.grades.map((g) => ({ key: g, label: `Pays ${g}` }))}
              rowHeader={(row) => (
                <span className="flex items-center gap-2">
                  <ClassBadge code={row.key} label={tierOf(row.key)?.label} token={tierOf(row.key)?.colourToken} />
                  <span className="truncate">{tierOf(row.key)?.label ?? row.key}</span>
                </span>
              )}
              columnHeader={(col) => (
                <span className="inline-flex items-center gap-1">
                  <GradeBadge grade={col.key} />
                </span>
              )}
              cellOf={(tierCode, grade) => {
                const cell = find(tierCode, grade);
                return cell === undefined ? undefined : { count: cell.count, amount: Number(cell.amount) };
              }}
              toneOf={(tierCode, grade) => {
                const trouble = grade === 'D' || grade === 'E';
                return { tone: trouble ? 'var(--destructive)' : 'var(--fresh-1)', emphasis: trouble && tierCode === 'A+' ? 0.55 : 0.35 };
              }}
              onCell={(tierCode, grade) => {
                const cell = find(tierCode, grade);
                if (cell) setOpen(cell);
              }}
              totals
            />
            <p className="text-muted-foreground text-xs">
              Classes are set by people with a reason and an effective date; grades are read nightly from payment behaviour (D18). The two never share a colour.
            </p>
          </>
        ) : null}

        <MismatchSection />
        <NeglectedSection />
        <ImportSection />
      </div>

      <Sheet open={open !== null} onOpenChange={(next) => { if (!next) setOpen(null); }}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-lg">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{open ? `Class ${open.tierCode} · pays ${open.grade}` : ''}</SheetTitle>
            <SheetDescription>{open ? `${formatCount(open.count)} customers · ${formatMoney(open.amount)} outstanding` : ''}</SheetDescription>
          </SheetHeader>
          {open ? (
            <div className="overflow-y-auto px-4 pb-6">
              <RecordTable
                columns={PARTY_COLUMNS}
                rows={[...open.parties]}
                rowKey={(row) => row.partyId}
                onRowActivate={(row) => void navigate(`/masters/vouchers?party=${row.partyId}`)}
                mobilePrimary={(row) => row.party}
                mobileSupporting={(row) => `${formatMoney(row.outstanding)} outstanding`}
              />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * P5: the system proposes, a person decides. Accept applies the suggestion
 * from the 1st of next month; Keep snoozes the suggestion for a quarter,
 * matching the review cadence, so the list stays short enough to be read.
 */
function MismatchSection() {
  const canAssign = usePermission(PERMISSIONS.CFO_TIER_ASSIGN);
  const query = useMismatches({ enabled: canAssign });
  const [busy, setBusy] = useState<string | null>(null);
  if (!canAssign) return null;
  const rows = query.data ?? [];

  async function accept(row: MismatchRowData) {
    setBusy(row.partyId);
    try {
      await assignClass(row.partyId, { tierCode: row.suggested, reason: `Accepted suggestion: ${row.why}`, effectiveFrom: toApiDate(firstOfNextMonth()) });
      toast.add({ type: 'success', title: `${row.party} to class ${row.suggested} from ${toApiDate(firstOfNextMonth())}` });
      await query.refetch();
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not apply the class', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(null);
    }
  }

  async function keep(row: MismatchRowData) {
    setBusy(row.partyId);
    try {
      const until = new Date(Date.now() + 90 * 86_400_000);
      await snoozeAlert({ alertKey: 'class-mismatch', partyId: row.partyId, until: toApiDate(until), reason: 'Kept the current class after review' });
      toast.add({ type: 'success', title: `${row.party} kept as ${row.current ?? 'unclassed'} until ${toApiDate(until)}` });
      await query.refetch();
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not keep', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(null);
    }
  }

  const columns: RecordColumn<MismatchRowData>[] = [
    { key: 'party', header: 'Customer', cell: (row) => row.party },
    {
      key: 'move',
      header: 'Current to suggested',
      cell: (row) => (
        <span className="flex items-center gap-1.5">
          {row.current === null ? <Badge variant="outline">Unclassed</Badge> : <ClassBadge code={row.current} />}
          <span className="text-muted-foreground">to</span>
          <ClassBadge code={row.suggested} />
        </span>
      ),
    },
    { key: 'why', header: 'Why', cell: (row) => row.why, secondary: true },
    { key: 'net', header: 'Net 12m', cell: (row) => formatMoney(row.netTY), numeric: true },
    {
      key: 'actions',
      header: '',
      cell: (row) => (
        <span className="flex justify-end gap-1.5">
          <Button size="sm" disabled={busy === row.partyId} onClick={() => void accept(row)}>Accept</Button>
          <Button size="sm" variant="outline" disabled={busy === row.partyId} onClick={() => void keep(row)}>Keep 90d</Button>
        </span>
      ),
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title="Suggested reclassifications"
        note="The trailing year's revenue against the class someone chose. Under-classified customers are being under-served; over-classified ones keep credit terms they no longer earn."
      />
      {query.isPending ? <Skeleton className="h-24" /> : null}
      {query.error ? <QueryErrorAlert error={query.error} subject="class suggestions" onRetry={() => void query.refetch()} /> : null}
      {query.isSuccess && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Every classed customer sits where the revenue says they should. New suggestions appear as the year moves.</p>
      ) : null}
      {rows.length > 0 ? (
        <RecordTable
          columns={columns}
          rows={[...rows]}
          rowKey={(row) => row.partyId}
          mobilePrimary={(row) => row.party}
          mobileStatus={(row) => (
            <span className="flex gap-1.5">
              <Button size="sm" disabled={busy === row.partyId} onClick={() => void accept(row)}>Accept</Button>
              <Button size="sm" variant="outline" disabled={busy === row.partyId} onClick={() => void keep(row)}>Keep 90d</Button>
            </span>
          )}
          mobileSupporting={(row) => `${row.current ?? 'Unclassed'} to ${row.suggested}: ${row.why}`}
        />
      ) : null}
    </section>
  );
}

/** O2.1: A+ wants contact every 30 days, A every 45 -- this is who slipped. */
function NeglectedSection() {
  const canView = usePermission(PERMISSIONS.CFO_TEAM_VIEW);
  const navigate = useNavigate();
  const query = useNeglected({ enabled: canView });
  if (!canView) return null;
  const rows = query.data ?? [];

  const columns: RecordColumn<NeglectedRowData>[] = [
    { key: 'party', header: 'Customer', cell: (row) => row.party },
    { key: 'class', header: 'Class', cell: (row) => <ClassBadge code={row.tierCode} /> },
    { key: 'owner', header: 'Owner', cell: (row) => row.ownerLabel, secondary: true },
    { key: 'last', header: 'Last touch', cell: (row) => row.lastTouch ?? EMPTY_VALUE, className: 'tabular-nums', secondary: true },
    {
      key: 'since',
      header: 'Gone quiet',
      cell: (row) => `${formatCount(row.daysSince)} days, wants every ${formatCount(row.contactEveryDays)}`,
    },
    { key: 'outstanding', header: 'Outstanding', cell: (row) => formatMoney(row.outstanding), numeric: true },
  ];

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title="Neglected key accounts"
        note="Past their class's contact frequency, counting a logged outcome or an order as contact. The most expensive failure a distributor makes."
      />
      {query.isPending ? <Skeleton className="h-24" /> : null}
      {query.error ? <QueryErrorAlert error={query.error} subject="neglected accounts" onRetry={() => void query.refetch()} /> : null}
      {query.isSuccess && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Every key account has been touched inside its contact window.</p>
      ) : null}
      {rows.length > 0 ? (
        <RecordTable
          columns={columns}
          rows={[...rows]}
          rowKey={(row) => row.partyId}
          onRowActivate={(row) => void navigate(`/masters/parties/${row.partyId}`)}
          mobilePrimary={(row) => row.party}
          mobileStatus={(row) => <ClassBadge code={row.tierCode} />}
          mobileSupporting={(row) => `${formatCount(row.daysSince)} days quiet, wants every ${formatCount(row.contactEveryDays)} (${row.ownerLabel})`}
        />
      ) : null}
    </section>
  );
}

/**
 * P4 import: the first full classification of an existing base is fastest
 * done in a spreadsheet with the sales team in a room; this takes the
 * paste. Nothing is written until the preview has been shown.
 */
function ImportSection() {
  const canAssign = usePermission(PERMISSIONS.CFO_TIER_ASSIGN);
  const [text, setText] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState<Date>(firstOfNextMonth());
  const [preview, setPreview] = useState<ImportRowData[] | null>(null);
  const [busy, setBusy] = useState(false);
  if (!canAssign) return null;
  const changes = preview?.filter((row) => row.status === 'change').length ?? 0;

  async function runPreview() {
    setBusy(true);
    try {
      setPreview(await previewClassImport({ text, effectiveFrom: toApiDate(effectiveFrom) }));
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not read the paste', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function runApply() {
    setBusy(true);
    try {
      const result = await applyClassImport({ text, effectiveFrom: toApiDate(effectiveFrom) });
      toast.add({ type: 'success', title: `${formatCount(result.applied)} classes assigned` });
      setPreview(result.rows);
      setText('');
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not apply the import', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(false);
    }
  }

  const previewColumns: RecordColumn<ImportRowData>[] = [
    { key: 'line', header: 'Line', cell: (row) => String(row.line), className: 'tabular-nums', secondary: true },
    { key: 'party', header: 'Customer', cell: (row) => row.party },
    {
      key: 'status',
      header: 'What happens',
      cell: (row) => (
        <Badge variant={row.status === 'change' || row.status === 'applied' ? 'secondary' : row.status === 'unchanged' ? 'outline' : 'destructive'}>
          {IMPORT_STATUS_LABEL[row.status]}
        </Badge>
      ),
    },
    { key: 'note', header: 'Detail', cell: (row) => row.note, secondary: true },
  ];

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title="Paste a classification sheet"
        note="One customer per line from Excel: name, class, optional reason. Preview first; only rows that change anything are written, each with its own audit entry."
      />
      <Textarea
        aria-label="Classification rows"
        placeholder={'Asha Traders\tA+\tKey account\nBharat Cables\tB'}
        value={text}
        rows={5}
        onChange={(e) => { setText(e.target.value); setPreview(null); }}
      />
      <div className="flex flex-wrap items-end gap-2">
        <DateField label="Effective from" showLabel value={effectiveFrom} onValueChange={setEffectiveFrom} />
        <Button variant="outline" disabled={busy || text.trim() === ''} onClick={() => void runPreview()}>Preview</Button>
        <Button disabled={busy || preview === null || changes === 0} onClick={() => void runApply()}>
          {changes === 0 ? 'Apply' : `Apply ${formatCount(changes)} ${changes === 1 ? 'change' : 'changes'}`}
        </Button>
      </div>
      {preview !== null && preview.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing readable in the paste. One customer per line, the class after the name.</p>
      ) : null}
      {preview !== null && preview.length > 0 ? (
        <RecordTable
          columns={previewColumns}
          rows={preview}
          rowKey={(row) => String(row.line)}
          mobilePrimary={(row) => row.party}
          mobileStatus={(row) => <Badge variant={row.status === 'change' || row.status === 'applied' ? 'secondary' : 'outline'}>{IMPORT_STATUS_LABEL[row.status]}</Badge>}
          mobileSupporting={(row) => row.note}
        />
      ) : null}
    </section>
  );
}
