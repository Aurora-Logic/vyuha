import { useEffect, useState } from 'react';
import { AddressBookIcon, LockKeyIcon, PlusIcon } from '@phosphor-icons/react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { PersonChip } from '@/components/shared/person';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SearchField } from '@/components/shared/search-field';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { ContactSheet } from './contact-sheet';
import { contactToDraft, emptyContactDraft, type Contact, type ContactDraft } from './types';
import { useContact, useContacts } from './use-crm';

/**
 * Contacts (REQ-U-01): the people the sales team sells to and through.
 * Filter state lives in the URL like every register; the open record is the
 * route (`/crm/contacts/:id`), so a Go To selection, a duplicate-warning
 * link and a pasted address all land on the same sheet.
 */

const COLUMNS: RecordColumn<Contact>[] = [
  { key: 'name', header: 'Contact', cell: (row) => <span className="font-medium">{row.name}</span> },
  { key: 'company', header: 'Company', cell: (row) => row.companyName ?? EMPTY_VALUE },
  { key: 'designation', header: 'Designation', cell: (row) => row.designation ?? EMPTY_VALUE, secondary: true },
  { key: 'phone', header: 'Phone', cell: (row) => row.phone ?? EMPTY_VALUE, className: 'tabular-nums' },
  { key: 'email', header: 'Email', cell: (row) => row.email ?? EMPTY_VALUE, secondary: true },
  { key: 'owner', header: 'Owner', cell: (row) => <PersonChip name={row.ownerName} />, secondary: true },
];

export function ContactsPage() {
  const canViewSelf = usePermission(PERMISSIONS.CRM_CONTACT_VIEW_SELF);
  const canViewAll = usePermission(PERMISSIONS.CRM_CONTACT_VIEW_ALL);
  const canView = canViewSelf || canViewAll;
  const canManage = usePermission(PERMISSIONS.CRM_CONTACT_MANAGE);
  const [searchParams, setSearchParams] = useSearchParams();
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();

  const q = searchParams.get('q') ?? '';
  const companyId = searchParams.get('company') ?? '';
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

  const query = useContacts(
    { page, ...(q ? { q } : {}), ...(companyId ? { companyId } : {}) },
    { enabled: canView },
  );
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta ?? null;
  const open = useContact(canView ? openId : null);

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
    void navigate(`/crm/contacts${search ? `?${search}` : ''}`, { replace: true });
  }

  // PRD §6.4: Alt+C creates on the fly, here as everywhere else.
  useShortcut({
    id: 'crm.contacts.create',
    keys: 'alt+c',
    label: 'New contact',
    scope: 'screen',
    when: () => canManage,
    run: startNew,
  });

  const sheetDraft: ContactDraft | null = creating
    ? emptyContactDraft(companyId ? { companyId } : {})
    : open.data !== undefined && openId !== null
      ? contactToDraft(open.data)
      : null;

  if (!canView) {
    return (
      <>
        <PageHeader description="The people you sell to and through." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view contacts</EmptyTitle>
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
        description={
          canViewAll
            ? 'Every contact in the organisation. Nothing here reaches Tally until a deal is won.'
            : 'The contacts you own. Nothing here reaches Tally until a deal is won.'
        }
        action={
          canManage ? (
            <Button size="sm" onClick={startNew}>
              <PlusIcon data-icon="inline-start" />
              New contact
              <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
            </Button>
          ) : null
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            id="contact-search"
            label="Search contacts"
            value={draft}
            onValueChange={setDraft}
            placeholder="Name, phone, email or designation"
          />
        </div>

        {query.isPending ? <ListSkeleton rows={4} label="Loading contacts" /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="contacts"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AddressBookIcon />
              </EmptyMedia>
              <EmptyTitle>{q || companyId ? 'No contact matches that' : 'No contacts yet'}</EmptyTitle>
              <EmptyDescription>
                {q || companyId
                  ? 'Try a different name, phone or email, or clear the company filter.'
                  : canManage
                    ? 'Add the first one — a name is enough to start; the rest can follow.'
                    : 'Contacts appear here as the sales team adds them.'}
              </EmptyDescription>
            </EmptyHeader>
            {!q && !companyId && canManage ? (
              <EmptyContent>
                <Button size="sm" onClick={startNew}>
                  <PlusIcon data-icon="inline-start" />
                  New contact
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
              mobilePrimary={(row) => row.name}
              mobileSupporting={(row) =>
                [row.companyName, row.phone ?? row.email].filter((p): p is string => p !== null).join(' · ') ||
                EMPTY_VALUE
              }
              onRowActivate={(row) => {
                void navigate(`/crm/contacts/${row.id}${window.location.search}`);
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
          subject="that contact"
          onRetry={() => {
            void open.refetch();
          }}
        />
      ) : null}

      <ContactSheet
        draft={sheetDraft}
        onOpenChange={(isOpen) => {
          if (!isOpen) closeSheet();
        }}
      />
    </>
  );
}
