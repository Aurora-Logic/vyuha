import { useState } from 'react';
import { ArrowCounterClockwiseIcon, LockKeyIcon, TrashIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router';

import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { ReasonDialog } from '@/components/shared/reason-dialog';
import { RecordPagination } from '@/components/shared/record-pagination';
import { PersonChip } from '@/components/shared/person';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SearchField } from '@/components/shared/search-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatDate } from '@/lib/format';
import { usePermissions } from '@/lib/session/permissions';
import {
  SOFT_DELETABLE_ENTITIES,
  type PermissionKey,
  type SoftDeletableEntity,
} from '@vyuha/shared';

import { ENTITY_LABELS, ENTITY_PERMISSION, type RecycleBinEntry } from './types';
import { useRecycleBin, useRestore } from './use-recycle-bin';

/**
 * REQ-B-09a: "Admin can restore any soft-deleted record from a Recycle Bin
 * screen, within a retention window (default 90 days)."
 *
 * Header, toolbar, one table, pagination — the same four rows every list screen
 * in this product has (PRD §6.2), so this one is structurally indistinguishable
 * from the employee list despite listing seven different kinds of record at
 * once. The `Kind` column is what makes one table honest across seven types;
 * the alternative, a tab per type, would hide six sevenths of the bin behind a
 * click and make "what did we delete last week" unanswerable.
 *
 * The retention window is not enforced anywhere yet — nothing purges the bin —
 * so the screen does not claim it does. See the note in the report.
 */

const PAGE_SIZE = 25;

function printDeletedAt(value: string): string {
  return formatDate(value.slice(0, 10));
}

/** Every record type the caller holds the manage key for. */
function manageableTypes(held: ReadonlySet<PermissionKey>): readonly SoftDeletableEntity[] {
  return SOFT_DELETABLE_ENTITIES.filter((entity) =>
    held.has(ENTITY_PERMISSION[entity] as PermissionKey),
  );
}

export function RecycleBinPage() {
  const held = usePermissions();
  const allowed = manageableTypes(held);

  if (allowed.length === 0) {
    return (
      <>
        <PageHeader description="Records that were deleted, and who deleted them." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot see the recycle bin</EmptyTitle>
            <EmptyDescription>
              It lists deleted departments, designations, locations, shifts, leave types, holiday
              calendars and roles. Seeing one needs the permission that manages it, and your
              account holds none of them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return <RecycleBinBody allowed={allowed} />;
}

function RecycleBinBody({ allowed }: { allowed: readonly SoftDeletableEntity[] }) {
  const [searchParams] = useSearchParams();
  const [entityType, setEntityType] = useState<SoftDeletableEntity | 'all'>('all');
  const [search, setSearch] = useState('');
  const [restoring, setRestoring] = useState<RecycleBinEntry | null>(null);

  const page = Number(searchParams.get('page') ?? '1');
  const query = useRecycleBin({
    entityType: entityType === 'all' ? undefined : entityType,
    q: search.trim().length > 0 ? search.trim() : undefined,
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZE,
  });
  const restore = useRestore();

  const rows = query.data?.data ?? [];

  const columns: RecordColumn<RecycleBinEntry>[] = [
    {
      key: 'name',
      header: 'Record',
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: 'kind',
      header: 'Kind',
      cell: (row) => <Badge variant="secondary">{row.entityLabel}</Badge>,
    },
    {
      key: 'code',
      header: 'Code',
      cell: (row) => row.code ?? '—',
      className: 'font-mono text-xs',
      secondary: true,
    },
    {
      key: 'deletedBy',
      header: 'Deleted by',
      cell: (row) =>
        row.deletedBy ? (
          <PersonChip name={row.deletedBy.name} />
        ) : (
          // Not the em dash PersonChip would give a null: the row was deleted by
          // somebody, the trail just predates the column.
          <span className="text-muted-foreground">Not recorded</span>
        ),
      secondary: true,
    },
    {
      key: 'deletedAt',
      header: 'Deleted on',
      cell: (row) => printDeletedAt(row.deletedAt),
      className: 'tabular-nums',
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (row) => row.reason ?? 'Not recorded',
      secondary: true,
    },
    {
      key: 'restore',
      header: 'Restore',
      cell: (row) => (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            restore.reset();
            setRestoring(row);
          }}
        >
          <ArrowCounterClockwiseIcon data-icon="inline-start" />
          Restore
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader description="Nothing is ever hard-deleted. Anything removed lands here with who removed it and why, and can be put back." />

      <div className="flex flex-col gap-4">
        {/* Toolbar row (PRD §6.2). Wraps at 360px rather than scrolling. */}
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            id="recycle-bin-search"
            label="Search deleted records by name"
            value={search}
            onValueChange={setSearch}
            placeholder="Search by name"
            className="min-w-0 flex-1 sm:max-w-xs"
          />
          <Select
            value={entityType}
            onValueChange={(value: string | null) => {
              // Parsed, not cast. The value comes back from a DOM control and
              // an unknown string would otherwise become a query parameter the
              // server rejects with a 400 the screen cannot explain.
              const parsed = SOFT_DELETABLE_ENTITIES.find((entity) => entity === value);
              setEntityType(parsed ?? 'all');
            }}
          >
            <SelectTrigger
              aria-label="Filter by kind"
              className="w-full sm:w-52"
            >
              {/* A render function, not `placeholder`. Base UI's Value shows the
                  raw value when it is given neither, so the trigger read "all"
                  rather than "Every kind" — caught in the browser, not here. */}
              <SelectValue>
                {(value: string) =>
                  ENTITY_LABELS[value as SoftDeletableEntity] ?? 'Every kind'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">Every kind</SelectItem>
                {allowed.map((entity) => (
                  <SelectItem key={entity} value={entity}>
                    {ENTITY_LABELS[entity]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {query.isPending ? <ListSkeleton rows={5} label="Loading the recycle bin" /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="the recycle bin"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TrashIcon />
              </EmptyMedia>
              <EmptyTitle>
                {search.trim().length > 0 || entityType !== 'all'
                  ? 'Nothing matches those filters'
                  : 'The recycle bin is empty'}
              </EmptyTitle>
              <EmptyDescription>
                {search.trim().length > 0 || entityType !== 'all'
                  ? 'Clear the search or choose a different kind.'
                  : 'Nothing has been deleted. When something is, it lands here rather than disappearing, and stays until somebody restores it.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <>
            <RecordTable
              columns={columns}
              rows={rows}
              rowKey={(row) => `${row.entityType}:${row.id}`}
              mobilePrimary={(row) => row.name}
              mobileStatus={(row) => <Badge variant="secondary">{row.entityLabel}</Badge>}
              mobileSupporting={(row) =>
                `${printDeletedAt(row.deletedAt)} · ${row.deletedBy?.name ?? 'actor not recorded'}`
              }
              onRowActivate={(row) => {
                restore.reset();
                setRestoring(row);
              }}
            />
            <RecordPagination
              page={query.data?.meta.page ?? 1}
              pageSize={query.data?.meta.pageSize ?? PAGE_SIZE}
              total={query.data?.meta.total ?? 0}
            />
          </>
        ) : null}
      </div>

      <ReasonDialog
        open={restoring !== null}
        onOpenChange={(next) => {
          if (!next) setRestoring(null);
        }}
        title={restoring === null ? 'Restore' : `Restore ${restoring.name}?`}
        description={
          restoring === null
            ? ''
            : `The ${restoring.entityLabel.toLowerCase()} comes back into every list and picker it used to appear in.`
        }
        consequences={
          restoring === null
            ? []
            : [
                restoring.reason === null
                  ? 'No reason was recorded when it was deleted.'
                  : `It was deleted because: ${restoring.reason}`,
                'Its code or name must still be free. If somebody has taken it, the restore is refused.',
              ]
        }
        prompt="Why is this being restored?"
        hint="Kept on the deletion record alongside the reason it was removed."
        confirmLabel="Restore"
        pendingLabel="Restoring"
        confirmIcon={<ArrowCounterClockwiseIcon data-icon="inline-start" />}
        pending={restore.isPending}
        error={restore.error}
        onConfirm={(reason) => {
          if (restoring === null) return;
          restore.mutate(
            { entityType: restoring.entityType, id: restoring.id, reason },
            {
              onSuccess: () => {
                toast.add({
                  type: 'success',
                  title: `${restoring.name} restored`,
                  description: 'It is back in its own list, and the reason is in the audit log.',
                });
                setRestoring(null);
              },
              // No toast and no optimistic removal on failure. The dialog keeps
              // the error, because a record that was not restored must never
              // vanish from the bin.
            },
          );
        }}
      />
    </>
  );
}
