import { useState } from 'react';
import {
  CaretLeftIcon,
  CaretRightIcon,
  LockKeyIcon,
  ScrollIcon,
} from '@phosphor-icons/react';
import { parseISO } from 'date-fns';
import type { DateRange } from 'react-day-picker';

import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
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
import { Spinner } from '@/components/ui/spinner';
import { toDateParam } from '@/features/attendance/format';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { SampleDataNotice } from '@/features/attendance/sample-data-notice';
import { EMPTY_VALUE } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { AuditEntrySheet } from './audit-entry-sheet';
import { actorLabel, olderAction, printInstant } from './format';
import { ActorChip } from './actor-chip';
import { EMPTY_FILTERS, humaniseAction, type AuditEntry, type AuditFilters } from './types';
import { useAuditFacets, useAuditLog } from './use-audit-log';

/**
 * REQ-M-02 / PRD §5 screen 18: the audit viewer.
 *
 * The list carries who, what and when; the diff, the address and the request id
 * go in a sheet opened from the row. Putting a before/after pair in a table
 * cell would either truncate it into uselessness or make every row a different
 * height, and the request id is the field that turns "it failed for me" into
 * something findable in the server log -- it needs room to be copied, not room
 * to be glanced at.
 */

const ALL = '__all__';

const COLUMNS: RecordColumn<AuditEntry>[] = [
  {
    key: 'createdAt',
    header: 'When',
    cell: (row) => printInstant(row.createdAt),
    className: 'tabular-nums whitespace-nowrap',
  },
  {
    key: 'action',
    header: 'Action',
    cell: (row) => <span className="font-medium">{humaniseAction(row.action)}</span>,
  },
  { key: 'entityType', header: 'Entity', cell: (row) => row.entityType },
  { key: 'actor', header: 'By', cell: (row) => <ActorChip entry={row} /> },
  {
    key: 'impersonator',
    header: 'Acting as',
    // REQ-M-01 keeps both identities. A row with an impersonator is rare and
    // is exactly the row an auditor is looking for, so it is a column rather
    // than a detail.
    cell: (row) =>
      row.impersonator === null ? (
        EMPTY_VALUE
      ) : (
        <Badge variant="destructive">{row.impersonator.email ?? row.impersonator.id}</Badge>
      ),
    secondary: true,
  },
  {
    key: 'ip',
    header: 'From',
    cell: (row) => row.ip ?? EMPTY_VALUE,
    className: 'tabular-nums',
    secondary: true,
  },
];

export function AuditLogPage() {
  const canView = usePermission(PERMISSIONS.AUDIT_VIEW);

  if (!canView) {
    return (
      <>
        <PageHeader description="Every state-changing action, appended and never edited." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view the audit log</EmptyTitle>
            <EmptyDescription>
              This needs the audit.view permission. The trail records who did what to whose record,
              so it is not shown more widely.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return <AuditLogBody />;
}

function AuditLogBody() {
  const [filters, setFiltersRaw] = useState<AuditFilters>(EMPTY_FILTERS);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [open, setOpen] = useState<AuditEntry | null>(null);

  const query = useAuditLog(filters);
  // A failed facet query must not take the trail with it: no options simply
  // means the two dropdowns are not offered.
  const facets = useAuditFacets().data;

  const pages = query.data?.pages ?? [];
  /*
   * One page on screen at a time, rather than every page fetched so far.
   *
   * The trail is keyset-paged and stays that way -- technical design 6 says
   * "cursor for the audit log", and the repository explains why: the trail
   * grows while it is being read, so an OFFSET page two repeats rows page one
   * already showed every time something is audited in between. A numbered
   * jump-to-page needs an offset and a COUNT over an append-only table that
   * only ever grows, and would buy that bug.
   *
   * What was actually wrong was the reading experience: "Load older entries"
   * appended forever, so finding something from Tuesday meant scrolling past
   * everything since. Paging through the cursor gives discrete pages with none
   * of that -- Next fetches the next page only if it has not been fetched
   * already, Previous is free because the page is still in the cache.
   */
  const [pageIndex, setPageIndex] = useState(0);

  /**
   * Changing a filter is always a return to page one.
   *
   * Wrapped rather than reset in an effect: an effect would set the page a
   * render after the filter changed, which is a cascading render and, for one
   * frame, page three of a result that may only have one page. Here the two
   * move together and no caller can forget.
   */
  const setFilters: typeof setFiltersRaw = (next) => {
    setFiltersRaw(next);
    setPageIndex(0);
  };
  const older = olderAction({
    pageIndex,
    fetchedPages: pages.length,
    hasNextPage: query.hasNextPage,
    isFetching: query.isFetchingNextPage,
  });
  const current = pages[Math.min(pageIndex, Math.max(pages.length - 1, 0))];
  const rows = current?.value.data ?? [];
  const sample = current?.sample ?? false;
  const filtered =
    filters.action !== null ||
    filters.entityType !== null ||
    filters.from !== null ||
    filters.to !== null;

  // PRD §6.4: Alt+F2 changes the period.
  useShortcut({
    id: 'audit.change-period',
    keys: 'alt+f2',
    label: 'Change period',
    scope: 'screen',
    run: () => {
      setPeriodOpen(true);
    },
  });

  const period: DateRange = {
    from: filters.from ? parseISO(filters.from) : undefined,
    to: filters.to ? parseISO(filters.to) : undefined,
  };

  function setPeriod(next: DateRange) {
    setFilters((current) => ({
      ...current,
      from: next.from ? toDateParam(next.from) : null,
      to: next.to ? toDateParam(next.to) : null,
    }));
  }

  return (
    <>
      <PageHeader description="Every state-changing action, appended and never edited. Nothing here can be deleted." />

      <div className="flex flex-col gap-4">
        {/* Toolbar row (PRD §6.2). Wraps rather than scrolling at 360px. */}
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeField
            value={period}
            onValueChange={setPeriod}
            label="Audit period"
            open={periodOpen}
            onOpenChange={setPeriodOpen}
            hint={<ShortcutHint keys="alt+f2" className="ml-1 hidden md:inline-flex" />}
          />

          <div className="flex w-full gap-2 sm:contents">
            {facets && facets.actions.length > 0 ? (
              <Select
                value={filters.action ?? ALL}
                onValueChange={(next: string | null) => {
                  setFilters((current) => ({
                    ...current,
                    action: next === null || next === ALL ? null : next,
                  }));
                }}
              >
                <SelectTrigger
                  aria-label="Filter by action"
                  className="min-w-0 flex-1 sm:w-56 sm:flex-none"
                >
                  <SelectValue>
                    {(value: string) => (value === ALL ? 'All actions' : humaniseAction(value))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={ALL}>All actions</SelectItem>
                    {facets.actions.map((action) => (
                      <SelectItem key={action} value={action}>
                        {humaniseAction(action)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}

            {facets && facets.entityTypes.length > 1 ? (
              <Select
                value={filters.entityType ?? ALL}
                onValueChange={(next: string | null) => {
                  setFilters((current) => ({
                    ...current,
                    entityType: next === null || next === ALL ? null : next,
                  }));
                }}
              >
                <SelectTrigger
                  aria-label="Filter by entity"
                  className="min-w-0 flex-1 sm:w-44 sm:flex-none"
                >
                  <SelectValue>
                    {(value: string) => (value === ALL ? 'All entities' : value)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={ALL}>All entities</SelectItem>
                    {facets.entityTypes.map((entity) => (
                      <SelectItem key={entity} value={entity}>
                        {entity}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
          </div>

          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>

        {sample ? <SampleDataNotice what="audit log" /> : null}

        {query.isPending ? <ListSkeleton rows={10} label="Loading the audit log" /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="the audit log"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ScrollIcon />
              </EmptyMedia>
              <EmptyTitle>{filtered ? 'Nothing in this period' : 'Nothing recorded yet'}</EmptyTitle>
              <EmptyDescription>
                {filtered
                  ? 'No action matches these filters. Widen the period or clear the filters to see more.'
                  : 'The trail fills as people work. Every successful change writes a row here, and no code path can skip it.'}
              </EmptyDescription>
            </EmptyHeader>
            {filtered ? (
              <EmptyContent>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setFilters(EMPTY_FILTERS);
                  }}
                >
                  Clear filters
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <>
            <RecordTable
              columns={COLUMNS}
              rows={rows}
              rowKey={(row) => row.id}
              mobilePrimary={(row) => humaniseAction(row.action)}
              mobileStatus={(row) => <Badge variant="outline">{row.entityType}</Badge>}
              mobileSupporting={(row) => `${printInstant(row.createdAt)} · ${actorLabel(row)}`}
              onRowActivate={setOpen}
            />

            <div className="flex flex-wrap items-center gap-2">
              <p className="text-muted-foreground min-w-0 flex-1 text-xs">
                Page {pageIndex + 1}
                {/*
                  No "of N". A total needs a COUNT over a table that grows
                  forever, and the answer would be stale before it rendered.
                  Saying how many pages there are when we cannot know is worse
                  than not saying it.
                */}
                {' · '}
                {rows.length} entr{rows.length === 1 ? 'y' : 'ies'}, newest first. Open a row for
                the before and after.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={pageIndex === 0}
                onClick={() => {
                  setPageIndex((index) => Math.max(0, index - 1));
                }}
              >
                <CaretLeftIcon data-icon="inline-start" />
                Newer
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={older === 'disabled'}
                onClick={() => {
                  // Already fetched: move. Not yet: fetch, then move, so the
                  // button never lands on an empty page while the request is
                  // still in flight.
                  if (older === 'advance') {
                    setPageIndex((index) => index + 1);
                    return;
                  }
                  void query.fetchNextPage().then(() => {
                    setPageIndex((index) => index + 1);
                  });
                }}
              >
                {query.isFetchingNextPage ? <Spinner data-icon="inline-start" /> : null}
                Older
                <CaretRightIcon data-icon="inline-end" />
              </Button>
            </div>
          </>
        ) : null}
      </div>

      <AuditEntrySheet
        entry={open}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
      />
    </>
  );
}
