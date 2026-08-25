import { useState } from 'react';
import {
  BuildingsIcon,
  IdentificationBadgeIcon,
  MapPinIcon,
  PlusIcon,
} from '@phosphor-icons/react';
import { useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { RowActions, type RowAction } from '@/components/shared/row-actions';
import { SearchField } from '@/components/shared/search-field';
import { useUrlSort } from '@/components/shared/use-url-sort';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { TabsToolbar, TabsToolbarAction } from '@/components/shared/tabs-toolbar';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { MASTER_SORT_FIELDS, PERMISSIONS } from '@vyuha/shared';

import { DeleteMasterDialog, type DeleteTarget } from './delete-master-dialog';
import { DepartmentSheet, DesignationSheet, LocationSheet } from './master-sheets';
import type { DepartmentSummary, DesignationSummary, LocationSummary } from './types';
import { useDepartmentList, useDesignationList, useLocationList } from './use-masters';

/**
 * REQ-A-01, REQ-A-02: departments, designations and locations — the three
 * masters every employee record points at, and the three that had API CRUD and
 * no screen at all.
 *
 * One screen with three tabs rather than three routes. They are small flat
 * lists that are set up in one sitting and then touched a few times a year;
 * three sidebar entries for three tables of a dozen rows would cost more
 * navigation than the tables are worth, and an administrator filling in a new
 * organisation moves between all three in the same minute.
 *
 * The write key is not the same for all three: departments and designations are
 * `employee.manage`, a location is `settings.manage`, because a location row
 * carries the geofence and the IP allowlist that decide where a punch is
 * accepted. Each tab reflects its own key rather than one blanket check.
 *
 * The route is `/organisation`; the router and the sidebar are wired by the
 * parent slice.
 */

const PAGE_SIZE = 50;

/**
 * The page number, from the URL.
 *
 * `RecordPagination` writes `?page=`, so reading it anywhere else would give
 * two sources of truth and a table that paged the URL without paging itself.
 * Hand-edited nonsense lands on page 1 rather than on page NaN.
 */
function usePageParam(): number {
  const [searchParams] = useSearchParams();
  const raw = searchParams.get('page');
  if (raw === null) return 1;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** Drops `?page=`, for anything that narrows the list under the reader. */
function useResetPage(): () => void {
  const [, setSearchParams] = useSearchParams();
  return () => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('page');
        return next;
      },
      // Replace, so Back leaves the screen rather than walking through every
      // page the reader passed on the way to this filter.
      { replace: true },
    );
  };
}

function ListSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="border">
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0"
        >
          <Skeleton className="h-3 w-36 shrink-0" />
          <Skeleton className="h-3 w-16 shrink-0" />
          <Skeleton className="hidden h-3 w-28 shrink-0 sm:block" />
          <Skeleton className="ml-auto h-4 w-8 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * The two verbs every row on this screen offers, and the sentence that replaces
 * them when the viewer may not use one.
 *
 * Built here rather than inside `RowActions` because the reason depends on the
 * master: a location needs `settings.manage` where a department needs
 * `employee.manage`, and a single blanket message would name the wrong key on
 * two tabs out of three.
 */
function rowActions(input: {
  canManage: boolean;
  permission: string;
  noun: string;
  onEdit: () => void;
  onDelete: () => void;
}): RowAction[] {
  const blocked = input.canManage
    ? undefined
    : `Needs the ${input.permission} permission, which your account does not hold.`;

  return [
    {
      key: 'edit',
      label: `Edit ${input.noun}`,
      icon: ACTION_ICONS.edit,
      onSelect: input.onEdit,
      ...(blocked === undefined ? {} : { unavailableReason: blocked }),
    },
    {
      key: 'delete',
      label: `Delete ${input.noun}`,
      icon: ACTION_ICONS.remove,
      destructive: true,
      onSelect: input.onDelete,
      ...(blocked === undefined ? {} : { unavailableReason: blocked }),
    },
  ];
}

// ------------------------------------------------------------- departments

function DepartmentsTab() {
  const canManage = usePermission(PERMISSIONS.EMPLOYEE_MANAGE);
  const [search, setSearch] = useState('');
  const page = usePageParam();
  const resetPage = useResetPage();
  const [sheet, setSheet] = useState<DepartmentSummary | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const { sort, activeSort, onSortChange } = useUrlSort(MASTER_SORT_FIELDS);

  const query = useDepartmentList({ q: search.trim(), page, ...(sort ? { sort } : {}) });
  const rows = query.data?.data ?? [];

  // PRD §6.4: Alt+C creates a master on the fly.
  useShortcut({
    id: 'org-masters.create-department',
    keys: 'alt+c',
    label: 'New department',
    scope: 'screen',
    when: () => canManage,
    run: () => {
      setSheet('new');
    },
  });

  const columns: RecordColumn<DepartmentSummary>[] = [
    {
      key: 'name',
      header: 'Department',
      sortField: 'name',
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    { key: 'code', header: 'Code', sortField: 'code', cell: (row) => row.code, className: 'tabular-nums' },
    { key: 'parent', header: 'Parent', cell: (row) => row.parent?.name ?? 'Top level' },
    {
      key: 'head',
      header: 'Head',
      cell: (row) => row.head?.name ?? EMPTY_VALUE,
      secondary: true,
    },
    {
      key: 'actions',
      header: 'Actions',
      className: 'w-12 text-right',
      cell: (row) => (
        <RowActions
          label={`Actions for ${row.name}`}
          actions={rowActions({
            canManage,
            permission: 'employee.manage',
            noun: 'department',
            onEdit: () => {
              setSheet(row);
            },
            onDelete: () => {
              setDeleting({ entityType: 'department', id: row.id, name: row.name });
            },
          })}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <TabsToolbarAction>
        <Button
          size="sm"
          disabled={!canManage}
          onClick={() => {
            setSheet('new');
          }}
        >
          <PlusIcon data-icon="inline-start" />
          New department
          <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
        </Button>
      </TabsToolbarAction>

      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          id="department-search"
          label="Search departments by name or code"
          placeholder="Name or code"
          value={search}
          onValueChange={(value) => {
            setSearch(value);
            // Narrowing the list invalidates the page number: page 3 of one
            // page of results is an empty screen that reads as no matches.
            resetPage();
          }}
          className="min-w-0 flex-1 sm:max-w-xs"
        />
        {canManage ? null : (
          <span className="text-muted-foreground text-xs">
            Editing needs the employee.manage permission.
          </span>
        )}
      </div>

      {query.isPending ? <ListSkeleton label="Loading departments" /> : null}

      {query.isError ? (
        <QueryErrorAlert
          error={query.error}
          subject="departments"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}

      {query.isSuccess && rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BuildingsIcon />
            </EmptyMedia>
            <EmptyTitle>
              {search.trim() === '' ? 'No departments yet' : 'No matching departments'}
            </EmptyTitle>
            <EmptyDescription>
              {search.trim() === ''
                ? 'A department groups employees and is what most reports are filtered by. Create the first one before importing anybody.'
                : 'No department matches that name or code. Clear the search to see them all.'}
            </EmptyDescription>
          </EmptyHeader>
          {search.trim() === '' && canManage ? (
            <EmptyContent>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSheet('new');
                }}
              >
                <PlusIcon data-icon="inline-start" />
                New department
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : null}

      {rows.length > 0 ? (
        <>
          <RecordTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            mobilePrimary={(row) => row.name}
            sort={activeSort}
            onSortChange={onSortChange}
            mobileStatus={(row) => (
              <RowActions
                label={`Actions for ${row.name}`}
                actions={rowActions({
                  canManage,
                  permission: 'employee.manage',
                  noun: 'department',
                  onEdit: () => {
                    setSheet(row);
                  },
                  onDelete: () => {
                    setDeleting({ entityType: 'department', id: row.id, name: row.name });
                  },
                })}
              />
            )}
            mobileSupporting={(row) =>
              `${row.code} · ${row.parent === null ? 'top level' : `under ${row.parent.name}`}`
            }
          />
          <RecordPagination
            page={query.data?.meta.page ?? page}
            pageSize={query.data?.meta.pageSize ?? PAGE_SIZE}
            total={query.data?.meta.total ?? 0}
          />
        </>
      ) : null}

      <DepartmentSheet
        target={sheet}
        departments={rows}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
      />
      <DeleteMasterDialog
        target={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------ designations

function DesignationsTab() {
  const canManage = usePermission(PERMISSIONS.EMPLOYEE_MANAGE);
  const [search, setSearch] = useState('');
  const page = usePageParam();
  const resetPage = useResetPage();
  const [sheet, setSheet] = useState<DesignationSummary | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);

  const query = useDesignationList({ q: search.trim(), page });
  const rows = query.data?.data ?? [];

  useShortcut({
    id: 'org-masters.create-designation',
    keys: 'alt+c',
    label: 'New designation',
    scope: 'screen',
    when: () => canManage,
    run: () => {
      setSheet('new');
    },
  });

  const actionsFor = (row: DesignationSummary) => (
    <RowActions
      label={`Actions for ${row.name}`}
      actions={rowActions({
        canManage,
        permission: 'employee.manage',
        noun: 'designation',
        onEdit: () => {
          setSheet(row);
        },
        onDelete: () => {
          setDeleting({ entityType: 'designation', id: row.id, name: row.name });
        },
      })}
    />
  );

  const columns: RecordColumn<DesignationSummary>[] = [
    {
      key: 'name',
      header: 'Designation',
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    { key: 'code', header: 'Code', cell: (row) => row.code, className: 'tabular-nums' },
    {
      key: 'grade',
      header: 'Grade',
      cell: (row) => (row.grade === null ? EMPTY_VALUE : <Badge variant="secondary">{row.grade}</Badge>),
    },
    {
      key: 'actions',
      header: 'Actions',
      className: 'w-12 text-right',
      cell: actionsFor,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <TabsToolbarAction>
        <Button
          size="sm"
          disabled={!canManage}
          onClick={() => {
            setSheet('new');
          }}
        >
          <PlusIcon data-icon="inline-start" />
          New designation
          <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
        </Button>
      </TabsToolbarAction>

      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          id="designation-search"
          label="Search designations by name or code"
          placeholder="Name or code"
          value={search}
          onValueChange={(value) => {
            setSearch(value);
            resetPage();
          }}
          className="min-w-0 flex-1 sm:max-w-xs"
        />
        {canManage ? null : (
          <span className="text-muted-foreground text-xs">
            Editing needs the employee.manage permission.
          </span>
        )}
      </div>

      {query.isPending ? <ListSkeleton label="Loading designations" /> : null}

      {query.isError ? (
        <QueryErrorAlert
          error={query.error}
          subject="designations"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}

      {query.isSuccess && rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IdentificationBadgeIcon />
            </EmptyMedia>
            <EmptyTitle>
              {search.trim() === '' ? 'No designations yet' : 'No matching designations'}
            </EmptyTitle>
            <EmptyDescription>
              {search.trim() === ''
                ? 'A designation is the job title on an employee record, with an optional grade beside it.'
                : 'No designation matches that name or code. Clear the search to see them all.'}
            </EmptyDescription>
          </EmptyHeader>
          {search.trim() === '' && canManage ? (
            <EmptyContent>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSheet('new');
                }}
              >
                <PlusIcon data-icon="inline-start" />
                New designation
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : null}

      {rows.length > 0 ? (
        <>
          <RecordTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            mobilePrimary={(row) => row.name}
            mobileStatus={actionsFor}
            mobileSupporting={(row) => `${row.code}${row.grade === null ? '' : ` · ${row.grade}`}`}
          />
          <RecordPagination
            page={query.data?.meta.page ?? page}
            pageSize={query.data?.meta.pageSize ?? PAGE_SIZE}
            total={query.data?.meta.total ?? 0}
          />
        </>
      ) : null}

      <DesignationSheet
        target={sheet}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
      />
      <DeleteMasterDialog
        target={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    </div>
  );
}

// --------------------------------------------------------------- locations

function LocationsTab() {
  const canManage = usePermission(PERMISSIONS.SETTINGS_MANAGE);
  const [search, setSearch] = useState('');
  const page = usePageParam();
  const resetPage = useResetPage();
  const [sheet, setSheet] = useState<LocationSummary | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);

  const query = useLocationList({ q: search.trim(), page });
  const rows = query.data?.data ?? [];

  useShortcut({
    id: 'org-masters.create-location',
    keys: 'alt+c',
    label: 'New location',
    scope: 'screen',
    when: () => canManage,
    run: () => {
      setSheet('new');
    },
  });

  const actionsFor = (row: LocationSummary) => (
    <RowActions
      label={`Actions for ${row.name}`}
      actions={rowActions({
        canManage,
        permission: 'settings.manage',
        noun: 'location',
        onEdit: () => {
          setSheet(row);
        },
        onDelete: () => {
          setDeleting({
            entityType: 'location',
            id: row.id,
            name: row.name,
            consequences: [
              'Any punch rule that depended on its geofence or IP allowlist stops applying.',
            ],
          });
        },
      })}
    />
  );

  const columns: RecordColumn<LocationSummary>[] = [
    {
      key: 'name',
      header: 'Location',
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    { key: 'code', header: 'Code', cell: (row) => row.code, className: 'tabular-nums' },
    {
      key: 'timezone',
      header: 'Timezone',
      cell: (row) => row.timezone ?? 'Organisation default',
      secondary: true,
    },
    {
      key: 'geofence',
      header: 'Geofence',
      // REQ-D-08: a centre is what makes geofenced punch possible at all, so
      // "not set" is a state worth reading at a glance rather than a blank.
      cell: (row) =>
        row.geofenceLat === null || row.geofenceLng === null ? (
          <span className="text-muted-foreground">Not set</span>
        ) : (
          <span className="tabular-nums">{row.geofenceRadiusM} m</span>
        ),
    },
    {
      key: 'allowlist',
      header: 'IP rules',
      cell: (row) => (
        <span className="tabular-nums">{row.ipAllowlist.length}</span>
      ),
      numeric: true,
      secondary: true,
    },
    {
      key: 'actions',
      header: 'Actions',
      className: 'w-12 text-right',
      cell: actionsFor,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <TabsToolbarAction>
        <Button
          size="sm"
          disabled={!canManage}
          onClick={() => {
            setSheet('new');
          }}
        >
          <PlusIcon data-icon="inline-start" />
          New location
          <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
        </Button>
      </TabsToolbarAction>

      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          id="location-search"
          label="Search locations by name or code"
          placeholder="Name or code"
          value={search}
          onValueChange={(value) => {
            setSearch(value);
            resetPage();
          }}
          className="min-w-0 flex-1 sm:max-w-xs"
        />
        {canManage ? null : (
          <span className="text-muted-foreground text-xs">
            Editing needs the settings.manage permission.
          </span>
        )}
      </div>

      {query.isPending ? <ListSkeleton label="Loading locations" /> : null}

      {query.isError ? (
        <QueryErrorAlert
          error={query.error}
          subject="locations"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}

      {query.isSuccess && rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MapPinIcon />
            </EmptyMedia>
            <EmptyTitle>
              {search.trim() === '' ? 'No locations yet' : 'No matching locations'}
            </EmptyTitle>
            <EmptyDescription>
              {search.trim() === ''
                ? 'A location is a place people work from. Its geofence and IP allowlist decide where a web punch is accepted.'
                : 'No location matches that name or code. Clear the search to see them all.'}
            </EmptyDescription>
          </EmptyHeader>
          {search.trim() === '' && canManage ? (
            <EmptyContent>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSheet('new');
                }}
              >
                <PlusIcon data-icon="inline-start" />
                New location
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : null}

      {rows.length > 0 ? (
        <>
          <RecordTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            mobilePrimary={(row) => row.name}
            mobileStatus={actionsFor}
            mobileSupporting={(row) =>
              `${row.code} · ${
                row.geofenceLat === null || row.geofenceLng === null
                  ? 'no geofence'
                  : `${String(row.geofenceRadiusM)} m geofence`
              }`
            }
          />
          <RecordPagination
            page={query.data?.meta.page ?? page}
            pageSize={query.data?.meta.pageSize ?? PAGE_SIZE}
            total={query.data?.meta.total ?? 0}
          />
        </>
      ) : null}

      <LocationSheet
        target={sheet}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
      />
      <DeleteMasterDialog
        target={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    </div>
  );
}

/** The three masters this screen owns; also which panel is mounted. */
type MasterTab = 'departments' | 'designations' | 'locations';

export function OrgMastersPage() {
  const resetPage = useResetPage();
  const [tab, setTab] = useState<MasterTab>('departments');

  return (
    <>
      <PageHeader description="Departments, designations and locations — the three masters every employee record points at." />

      <Tabs
        value={tab}
        className="gap-4"
        // The three tabs share one `?page=`, so moving between them has to drop
        // it. Without this, leaving departments on page 2 would open a
        // one-page designation list on page 2, which renders as no rows and
        // reads as an empty master.
        onValueChange={(next) => {
          setTab(next as MasterTab);
          resetPage();
        }}
      >
        <TabsToolbar
          list={
            <TabsList>
              <TabsTrigger value="departments" className="px-3">
                <BuildingsIcon data-icon="inline-start" />
                Departments
              </TabsTrigger>
              <TabsTrigger value="designations" className="px-3">
                <IdentificationBadgeIcon data-icon="inline-start" />
                Designations
              </TabsTrigger>
              <TabsTrigger value="locations" className="px-3">
                <MapPinIcon data-icon="inline-start" />
                Locations
              </TabsTrigger>
            </TabsList>
          }
        >
          {/* Only the visible tab is mounted, and that is a correctness rule
              rather than a saving.

              Each panel registers Alt+C for "create the thing this tab is
              about" (PRD 6.4). Tabs keeps every panel mounted, so all three
              registered the same key in the same screen layer, the registry
              refused the duplicate exactly as it should, and the throw took the
              whole screen into the error boundary -- Organisation was
              unreachable, showing "This screen stopped responding".

              Mounting one panel also stops two list queries firing for tabs
              nobody is looking at, but that is the smaller half. */}
          <TabsContent value="departments">
            {tab === 'departments' ? <DepartmentsTab /> : null}
          </TabsContent>
          <TabsContent value="designations">
            {tab === 'designations' ? <DesignationsTab /> : null}
          </TabsContent>
          <TabsContent value="locations">
            {tab === 'locations' ? <LocationsTab /> : null}
          </TabsContent>
        </TabsToolbar>
      </Tabs>
    </>
  );
}
