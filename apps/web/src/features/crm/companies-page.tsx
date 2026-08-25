import { useEffect, useState } from 'react';
import { BuildingsIcon, LockKeyIcon, PlusIcon } from '@phosphor-icons/react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { PersonChip } from '@/components/shared/person';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { useUrlSort } from '@/components/shared/use-url-sort';
import { SearchField } from '@/components/shared/search-field';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { COMPANY_SORT_FIELDS, PERMISSIONS } from '@vyuha/shared';

import { CompanySheet } from './company-sheet';
import { companyToDraft, emptyCompanyDraft, type Company, type CompanyDraft } from './types';
import { useCompanies, useCompany } from './use-crm';

/**
 * Companies (REQ-U-02): prospect organisations, linked to a Tally party only
 * on conversion (REQ-U-03). Same shape as Contacts, on purpose.
 */

const COLUMNS: RecordColumn<Company>[] = [
  {
    key: 'name',
    header: 'Company',
    sortField: 'name',
    cell: (row) => (
      <span className="flex items-center gap-2">
        <span className="font-medium">{row.name}</span>
        {row.partyId === null ? null : <Badge variant="outline">Tally party</Badge>}
      </span>
    ),
  },
  { key: 'city', header: 'City', cell: (row) => row.city ?? EMPTY_VALUE, secondary: true },
  { key: 'phone', header: 'Phone', cell: (row) => row.phone ?? EMPTY_VALUE, className: 'tabular-nums' },
  { key: 'website', header: 'Website', cell: (row) => row.website ?? EMPTY_VALUE, secondary: true },
  { key: 'contacts', header: 'Contacts', cell: (row) => String(row.contactCount), numeric: true },
  { key: 'owner', header: 'Owner', cell: (row) => <PersonChip name={row.ownerName} />, secondary: true },
];

function ListSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading companies" className="border">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} aria-hidden className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0">
          <Skeleton className="h-3 w-40 shrink-0" />
          <Skeleton className="hidden h-3 w-24 shrink-0 sm:block" />
          <Skeleton className="ml-auto h-3 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function CompaniesPage() {
  const canViewSelf = usePermission(PERMISSIONS.CRM_CONTACT_VIEW_SELF);
  const canViewAll = usePermission(PERMISSIONS.CRM_CONTACT_VIEW_ALL);
  const canView = canViewSelf || canViewAll;
  const canManage = usePermission(PERMISSIONS.CRM_CONTACT_MANAGE);
  const [searchParams, setSearchParams] = useSearchParams();
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { sort, activeSort, onSortChange } = useUrlSort(COMPANY_SORT_FIELDS);

  const q = searchParams.get('q') ?? '';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const openId = params.id ?? null;
  const creating = searchParams.get('new') === '1';

  const [draft, setDraft] = useState(q);
  const [syncedQ, setSyncedQ] = useState(q);
  if (syncedQ !== q) {
    setSyncedQ(q);
    if (draft.trim() !== q) setDraft(q);
  }
  useEffect(() => {
    if (draft.trim() === q) return undefined;
    const timer = window.setTimeout(() => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          const value = draft.trim();
          if (value) next.set('q', value);
          else next.delete('q');
          next.delete('page');
          return next;
        },
        { replace: true },
      );
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [draft, q, setSearchParams]);

  const query = useCompanies({ page, ...(q ? { q } : {}), ...(sort ? { sort } : {}) }, { enabled: canView });
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta ?? null;
  const open = useCompany(canView ? openId : null);

  function startNew() {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('new', '1');
        return next;
      },
      { replace: true },
    );
  }

  function closeSheet() {
    const next = new URLSearchParams(window.location.search);
    next.delete('new');
    const search = next.toString();
    void navigate(`/crm/companies${search ? `?${search}` : ''}`, { replace: true });
  }

  useShortcut({
    id: 'crm.companies.create',
    keys: 'alt+c',
    label: 'New company',
    scope: 'screen',
    when: () => canManage,
    run: startNew,
  });

  const sheetDraft: CompanyDraft | null = creating
    ? emptyCompanyDraft()
    : open.data !== undefined && openId !== null
      ? companyToDraft(open.data)
      : null;

  if (!canView) {
    return (
      <>
        <PageHeader description="Prospect organisations." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view companies</EmptyTitle>
            <EmptyDescription>
              This needs crm.contact.view.self or crm.contact.view.all. Ask an administrator for the Sales role.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Prospect organisations. A company becomes a Tally party only when a deal is won; until then it lives here alone."
        action={
          canManage ? (
            <Button size="sm" onClick={startNew}>
              <PlusIcon data-icon="inline-start" />
              New company
              <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
            </Button>
          ) : null
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            id="company-search"
            label="Search companies"
            value={draft}
            onValueChange={setDraft}
            placeholder="Name, city or website"
          />
        </div>

        {query.isPending ? <ListSkeleton /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="companies"
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
              <EmptyTitle>{q ? 'No company matches that' : 'No companies yet'}</EmptyTitle>
              <EmptyDescription>
                {q
                  ? 'Try a different name, city or website.'
                  : canManage
                    ? 'Add the first one — a name is enough to start.'
                    : 'Companies appear here as the sales team adds them.'}
              </EmptyDescription>
            </EmptyHeader>
            {!q && canManage ? (
              <EmptyContent>
                <Button size="sm" onClick={startNew}>
                  <PlusIcon data-icon="inline-start" />
                  New company
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
              sort={activeSort}
              onSortChange={onSortChange}
              mobilePrimary={(row) => row.name}
              mobileStatus={(row) =>
                row.contactCount === 0 ? null : (
                  <Badge variant="outline">
                    {row.contactCount} contact{row.contactCount === 1 ? '' : 's'}
                  </Badge>
                )
              }
              mobileSupporting={(row) =>
                [row.city, row.phone ?? row.website].filter((p): p is string => p !== null).join(' · ') || EMPTY_VALUE
              }
              onRowActivate={(row) => {
                void navigate(`/crm/companies/${row.id}${window.location.search}`);
              }}
            />
            {meta !== null && meta.total > meta.pageSize ? (
              <RecordPagination page={meta.page} pageSize={meta.pageSize} total={meta.total} />
            ) : null}
          </>
        ) : null}
      </div>

      {openId !== null && open.isError ? (
        <QueryErrorAlert
          error={open.error}
          subject="that company"
          onRetry={() => {
            void open.refetch();
          }}
        />
      ) : null}

      <CompanySheet
        draft={sheetDraft}
        record={open.data ?? null}
        onOpenChange={(isOpen) => {
          if (!isOpen) closeSheet();
        }}
      />
    </>
  );
}
