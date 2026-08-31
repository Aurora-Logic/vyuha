import { useState } from 'react';
import {
  PlusIcon,
  UploadSimpleIcon,
  UsersThreeIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { useNavigate, useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { RowActions } from '@/components/shared/row-actions';
import { useUrlSort } from '@/components/shared/use-url-sort';
import { SearchField } from '@/components/shared/search-field';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/client';
import { EMPTY_VALUE, formatDate, humaniseEnum } from '@/lib/format';
import { useSearchDraft } from '@/lib/use-search-draft';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import {
  DEFAULT_PAGE_SIZE,
  EMPLOYEE_SORT_FIELDS,
  EMPLOYEE_STATUSES,
  MAX_PAGE_SIZE,
  PERMISSIONS,
  employeeDisplayName,
  type EmployeeListItem,
  type EmployeeStatus,
} from '@vyuha/shared';

import { employeeActions } from './employee-actions';
import { EmployeeSheet } from './employee-sheet';
import { EmployeeImportSheet } from './import-sheet';
import { EmployeeInviteDialog } from './invite-dialog';
import { EmployeeLifecycleDialog, type LifecycleTarget } from './lifecycle-dialog';
import { STATUS_LABELS, STATUS_VARIANT } from './status';
import { useDepartments } from './use-departments';
import { useEmployees } from './use-employees';

/**
 * REQ-A-03 / PRD §5 screen 10: the employee register.
 *
 * Filter state lives in the query string, not in component state. A filtered
 * list has to be a link somebody can paste into a message and has to survive a
 * reload — which is also why the search box writes to the URL on a debounce
 * rather than on every keystroke, so the history is a list of searches rather
 * than a list of prefixes.
 */

const ALL_DEPARTMENTS = '__all_departments__';
const ALL_STATUSES = 'ALL';

function isEmployeeStatus(value: string | null): value is EmployeeStatus {
  return value !== null && (EMPLOYEE_STATUSES as readonly string[]).includes(value);
}

function readPositiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  // Number('') is 0 and Number('abc') is NaN. Both are somebody hand-editing
  // the URL, and both should land on the default rather than on page NaN.
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

const BASE_COLUMNS: RecordColumn<EmployeeListItem>[] = [
  {
    key: 'employeeCode',
    header: 'Code',
    // Tabular numerals, not right alignment: a code is an identifier, so the
    // digits should line up column-to-column but the field still reads
    // left-to-right (PRD §6.3).
    cell: (row) => <span className="font-medium tabular-nums">{row.employeeCode}</span>,
    className: 'tabular-nums',
    sortField: 'employeeCode',
  },
  {
    key: 'name',
    header: 'Employee',
    cell: (row) => employeeDisplayName(row.firstName, row.lastName),
    // The column is written first-name-first, so first name is what the header
    // orders by; lastName is a sort field the server also knows but no column
    // surfaces it.
    sortField: 'firstName',
  },
  {
    key: 'department',
    header: 'Department',
    cell: (row) => row.department?.name ?? EMPTY_VALUE,
  },
  {
    key: 'designation',
    header: 'Designation',
    cell: (row) => row.designation?.name ?? EMPTY_VALUE,
    secondary: true,
  },
  {
    key: 'location',
    header: 'Location',
    cell: (row) => row.location?.name ?? EMPTY_VALUE,
    secondary: true,
  },
  {
    key: 'employmentType',
    header: 'Type',
    cell: (row) => humaniseEnum(row.employmentType),
    secondary: true,
    sortField: 'employmentType',
  },
  {
    key: 'dateOfJoining',
    header: 'Joined',
    // REQ-L-01: dd-MM-yyyy, never the raw ISO string the API sends.
    cell: (row) => formatDate(row.dateOfJoining),
    className: 'tabular-nums',
    sortField: 'dateOfJoining',
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_LABELS[row.status]}</Badge>,
    sortField: 'status',
  },
];

/**
 * What the reader is told when the list will not load, and what to do next.
 *
 * The endpoint is deployed separately from this screen, so "there is no such
 * endpoint" is a state a real person can reach, and saying "something went
 * wrong" for it would send them looking in the wrong place (PRD §6.6: errors
 * say what happened and what to do).
 */
function messageFor(error: unknown): { title: string; description: string } {
  if (!(error instanceof ApiError)) {
    return {
      title: 'Could not load employees',
      description: 'Something went wrong on the way. Try again.',
    };
  }
  switch (error.code) {
    case 'NETWORK_ERROR':
      return {
        title: 'Could not reach the server',
        description: 'Check that the API is running, then try again.',
      };
    case 'NOT_FOUND':
      return {
        title: 'The employees endpoint is not available',
        description:
          'The server has no employee list at this address yet. Nothing is wrong with this screen; there is nothing for it to read.',
      };
    case 'FORBIDDEN':
    case 'OUT_OF_SCOPE':
      return {
        title: 'You cannot view these employee records',
        description:
          'This needs the employee.view permission, and shows only the people in your scope. Ask an administrator to widen it.',
      };
    case 'TOKEN_EXPIRED':
    case 'TOKEN_INVALID':
      return {
        title: 'Your session has ended',
        description: 'Sign in again to carry on.',
      };
    default:
      return { title: 'Could not load employees', description: error.message };
  }
}

/**
 * The loading state mirrors the table it is standing in for — same border,
 * same row rhythm — so the page does not visibly resize when the rows arrive.
 */
function EmployeesSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading employees" className="border">
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0"
        >
          <Skeleton className="h-3 w-14 shrink-0" />
          <Skeleton className="h-3 w-32 shrink-0" />
          <Skeleton className="hidden h-3 w-24 shrink-0 sm:block" />
          <Skeleton className="hidden h-3 w-20 shrink-0 xl:block" />
          <Skeleton className="ml-auto h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function EmployeesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { sort, activeSort, onSortChange } = useUrlSort(EMPLOYEE_SORT_FIELDS);
  const canManage = usePermission(PERMISSIONS.EMPLOYEE_MANAGE);
  const [sheet, setSheet] = useState<EmployeeListItem | 'new' | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleTarget | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [inviting, setInviting] = useState<EmployeeListItem | null>(null);

  // PRD §6.4: Alt+C creates a master on the fly. An employee is a master.
  useShortcut({
    id: 'employees.create',
    keys: 'alt+c',
    label: 'New employee',
    scope: 'screen',
    when: () => canManage,
    run: () => {
      setSheet('new');
    },
  });

  // PRD §6.4: Alt+O is Import. REQ-A-06 is the only import on this screen.
  useShortcut({
    id: 'employees.import',
    keys: 'alt+o',
    label: 'Import employees',
    scope: 'screen',
    when: () => canManage,
    run: () => {
      setImportOpen(true);
    },
  });

  const page = readPositiveInt(searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = readPositiveInt(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const q = searchParams.get('q')?.trim() ?? '';
  const departmentId = searchParams.get('departmentId');
  const statusParam = searchParams.get('status');
  const status = isEmployeeStatus(statusParam) ? statusParam : null;

  // The search box is typed into continuously and committed to the URL on a
  // pause, so it needs a local value. `syncedQ` is what makes the two agree
  // again when the URL moves on its own — a Back press, or Clear filters.
  // Adjusting state during render rather than in an effect is the documented
  // way to do this; an effect would render the stale value first.
  const [draft, setDraft] = useSearchDraft();

  // Base UI hands back null when a select is cleared, which this one cannot be
  // — there is always a chosen option — but the handler has to accept it.
  function setStatus(next: string | null) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === null || next === ALL_STATUSES) params.delete('status');
      else params.set('status', next);
      params.delete('page');
      return params;
    });
  }

  function setDepartment(next: string | null) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === null || next === ALL_DEPARTMENTS) params.delete('departmentId');
      else params.set('departmentId', next);
      params.delete('page');
      return params;
    });
  }

  function clearFilters() {
    setDraft('');
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.delete('q');
      params.delete('status');
      params.delete('departmentId');
      params.delete('page');
      return params;
    });
  }

  const filtered = q.length > 0 || status !== null || departmentId !== null;
  const query = useEmployees({ page, pageSize, q, status, departmentId, ...(sort ? { sort } : {}) });
  // A failed picker must not take the table with it, so the error is swallowed
  // here on purpose: no options simply means no department filter is offered.
  const departments = useDepartments().data ?? [];

  const rows = query.data?.data ?? [];
  const total = query.data?.meta.total ?? 0;

  /**
   * What a row offers, and the sentence that replaces a verb the viewer may
   * not use.
   *
   * There is no delete, on purpose and permanently. REQ-A-05 retires an
   * employee — INACTIVE plus a last working date — and the menu says "Retire"
   * rather than borrowing a word for something the product does not do. The
   * transitions offered depend on where the record already is, so an inactive
   * person is offered reactivation rather than a second retirement.
   */
  function actionsFor(row: EmployeeListItem) {
    const actions = employeeActions({
      employee: row,
      canManage,
      onEdit: () => {
        setSheet(row);
      },
      onLifecycle: setLifecycle,
      onInvite: () => {
        setInviting(row);
      },
    });
    return (
      <RowActions
        label={`Actions for ${employeeDisplayName(row.firstName, row.lastName)}`}
        actions={actions}
      />
    );
  }

  const columns: RecordColumn<EmployeeListItem>[] = [
    ...BASE_COLUMNS,
    { key: 'actions', header: 'Actions', className: 'w-12 text-right', cell: actionsFor },
  ];

  return (
    <>
      <PageHeader
        description="Every employee on record, with their department, location and status."
        action={
          canManage ? (
            <>
              {/* REQ-A-06. Outline rather than the primary fill: creating one
                  record is the ordinary act here, loading a file is not. The
                  empty state below has promised this since it was written. */}
              <Button
                variant="outline"
                onClick={() => {
                  setImportOpen(true);
                }}
              >
                <UploadSimpleIcon data-icon="inline-start" />
                Import
                <ShortcutHint keys="alt+o" className="ml-1 hidden md:inline-flex" />
              </Button>
              <Button
                onClick={() => {
                  setSheet('new');
                }}
              >
                <PlusIcon data-icon="inline-start" />
                New employee
                <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
              </Button>
            </>
          ) : (
            <span className="text-muted-foreground text-xs">
              Adding and editing needs the employee.manage permission.
            </span>
          )
        }
      />

      <div className="flex flex-col gap-4">
        {/* Toolbar row (PRD §6.2). Wraps to two rows at 360px rather than
            scrolling sideways. */}
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            id="employee-search"
            label="Search employees"
            placeholder="Code or name"
            value={draft}
            onValueChange={setDraft}
            className="w-full sm:w-64"
          />

          {/* The two filters share one row on a phone. Each was w-full, so each
              claimed a row of its own and the toolbar cost 148px of a 780px
              screen before a single employee appeared. They are 44px either
              way — this buys the height back from the layout rather than from
              the touch target. `sm:contents` dissolves this wrapper above the
              breakpoint so the desktop toolbar keeps its original single-row
              wrap. */}
          <div className="flex w-full gap-2 sm:contents">
          <Select value={status ?? ALL_STATUSES} onValueChange={setStatus}>
            <SelectTrigger
              aria-label="Filter by status"
              className="min-w-0 flex-1 sm:w-40 sm:flex-none"
            >
              <SelectValue>
                {(value: string) =>
                  isEmployeeStatus(value) ? STATUS_LABELS[value] : 'All statuses'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>All statuses</SelectItem>
              {EMPLOYEE_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {STATUS_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Only rendered once the options are in. A picker that appears
              empty and fills in a moment later reads as broken, and one with a
              single option is furniture - an organisation with one department
              does not need to filter by it. */}
          {departments.length > 1 ? (
            <Select value={departmentId ?? ALL_DEPARTMENTS} onValueChange={setDepartment}>
              <SelectTrigger
                aria-label="Filter by department"
                className="min-w-0 flex-1 sm:w-48 sm:flex-none"
              >
                <SelectValue>
                  {(value: string) =>
                    departments.find((d) => d.id === value)?.name ?? 'All departments'
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_DEPARTMENTS}>All departments</SelectItem>
                {departments.map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          </div>

          {filtered ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <ACTION_ICONS.clearFilters data-icon="inline-start" />
              Clear filters
            </Button>
          ) : null}
        </div>

        {query.isPending ? <EmployeesSkeleton /> : null}

        {query.isError ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>{messageFor(query.error).title}</AlertTitle>
            <AlertDescription>
              {messageFor(query.error).description}
              {query.error instanceof ApiError && query.error.requestId ? (
                <span className="mt-1 block font-mono text-[0.6875rem]">
                  Request {query.error.requestId}
                </span>
              ) : null}
            </AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void query.refetch();
                }}
              >
                Try again
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersThreeIcon />
              </EmptyMedia>
              <EmptyTitle>{filtered ? 'No matching employees' : 'No employees yet'}</EmptyTitle>
              <EmptyDescription>
                {filtered
                  ? 'No record matches this search and status. Widen the filters to see more.'
                  : 'Employee records appear here once they are created or imported from Excel.'}
              </EmptyDescription>
            </EmptyHeader>
            {filtered ? (
              <EmptyContent>
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  <ACTION_ICONS.clearFilters data-icon="inline-start" />
                  Clear filters
                </Button>
              </EmptyContent>
            ) : canManage ? (
              <EmptyContent>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSheet('new');
                  }}
                >
                  <PlusIcon data-icon="inline-start" />
                  New employee
                </Button>
                {/* The sentence above says records can be "imported from
                    Excel". Until now there was no way to do it, which made
                    the empty state a promise the product could not keep. */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setImportOpen(true);
                  }}
                >
                  <UploadSimpleIcon data-icon="inline-start" />
                  Import from a spreadsheet
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
              sort={activeSort}
              onSortChange={onSortChange}
              mobilePrimary={(row) => employeeDisplayName(row.firstName, row.lastName)}
              mobileStatus={(row) => (
                <div className="flex items-center gap-1">
                  <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_LABELS[row.status]}</Badge>
                  {actionsFor(row)}
                </div>
              )}
              mobileSupporting={(row) =>
                `${row.employeeCode} · ${row.department?.name ?? 'No department'}`
              }
              // PRD §6.4: Enter drills into the focused row, and a tap does the
              // same thing on a phone. RecordTable owns both, so the register
              // and the muster cannot disagree about what activating a row does.
              //
              // Kept here, unlike the master lists, because this row genuinely
              // drills down: it opens a person's own page rather than a form.
              // The menu stops the click reaching this handler itself.
              onRowActivate={(row) => {
                void navigate(`/employees/${row.id}`);
              }}
            />
            <RecordPagination page={page} pageSize={pageSize} total={total} />
          </>
        ) : null}
      </div>

      <EmployeeSheet
        target={sheet}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
      />
      <EmployeeLifecycleDialog
        target={lifecycle}
        onOpenChange={(open) => {
          if (!open) setLifecycle(null);
        }}
      />
      <EmployeeImportSheet open={importOpen} onOpenChange={setImportOpen} />
      {/* REQ-B-03. The register is where somebody stands when they realise a
          new starter cannot sign in, so the invitation is issued from here
          rather than from a screen of its own. */}
      <EmployeeInviteDialog
        employee={inviting}
        onOpenChange={(open) => {
          if (!open) setInviting(null);
        }}
      />
    </>
  );
}
