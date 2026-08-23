import { useState } from 'react';
import { BooksIcon, CheckIcon, CopyIcon, LinkSimpleIcon, LockKeyIcon, ProhibitIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { StatusBadge } from '@/components/shared/status-badge';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { ReasonDialog } from '@/components/shared/reason-dialog';
import { SearchField } from '@/components/shared/search-field';

import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { useParties } from '@/features/masters/use-parties';
import { formatDate } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, PORTAL_KEY_DAYS, PORTAL_KEY_STATE_LABELS, type PortalKeyView } from '@vyuha/shared';

import { useIssuePortalKey, usePortalKeys, useRevokePortalKey } from './use-portal';

/**
 * 15 Area AL, from the inside: every customer link in one place.
 *
 * The panel on a party page answers "does this customer have a link"; this
 * screen answers the questions that have no party to start from — who has
 * one at all, which are about to lapse, which have never been opened, and
 * which to withdraw now. Without it the portal existed with no way into it
 * from the navigation, which is how a feature ships and is never used.
 *
 * The key itself appears once, in the row that issues it, and is gone on
 * the next render: the server keeps only a hash, so there is nothing to
 * show a second time (D-60).
 */

export function PortalLinksPage() {
  const canManage = usePermission(PERMISSIONS.PORTAL_MANAGE);
  const canReadReceivables = usePermission(PERMISSIONS.RECEIVABLES_VIEW);
  const canSee = canManage || canReadReceivables;
  const keys = usePortalKeys(null, { enabled: canSee });
  const parties = useParties({ page: 1, pageSize: 200 }, { enabled: canManage });
  const issue = useIssuePortalKey();
  const revoke = useRevokePortalKey();
  const [partyId, setPartyId] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ url: string; partyName: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // The reason is asked for the one link being withdrawn, in a dialog, rather
  // than a shared field in the toolbar — a reason with no link it belongs to
  // read as a filter, and left the search stranded beside it.
  const [withdrawing, setWithdrawing] = useState<PortalKeyView | null>(null);
  const [q, setQ] = useState('');

  if (!canSee) {
    return (
      <>
        <PageHeader description="The read-only links customers use to see their own orders, dispatches and statement." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot see customer links</EmptyTitle>
            <EmptyDescription>This needs portal.manage — the Admin and Accounts roles carry it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const rows = (keys.data ?? []).filter((key) => q.trim() === '' || key.partyName.toLowerCase().includes(q.trim().toLowerCase()));
  const partyOptions: PickerOption[] = (parties.data?.data ?? []).map((p) => ({ id: p.id, label: p.name, hint: p.parentGroup }));
  const chosen = partyOptions.find((o) => o.id === partyId) ?? null;

  const columns: RecordColumn<PortalKeyView>[] = [
    {
      key: 'party',
      header: 'Customer',
      cell: (row) => (
        <Link to={`/masters/parties/${row.partyId}`} className="font-medium underline-offset-4 hover:underline">
          {row.partyName}
        </Link>
      ),
    },
    { key: 'state', header: 'State', cell: (row) => <StatusBadge state={row.state} label={PORTAL_KEY_STATE_LABELS[row.state]} /> },
    { key: 'expires', header: 'Until', cell: (row) => formatDate(row.expiresAt.slice(0, 10)) },
    { key: 'opened', header: 'Opened', cell: (row) => (row.lastUsedAt === null ? <span className="text-muted-foreground">Never</span> : <span className="tabular-nums">{row.viewCount} · {formatDate(row.lastUsedAt.slice(0, 10))}</span>) },
    { key: 'issued', header: 'Issued', cell: (row) => `${formatDate(row.issuedAt.slice(0, 10))}${row.issuedByName === null ? '' : ` · ${row.issuedByName}`}`, secondary: true },
    {
      key: 'action',
      header: '',
      cell: (row) =>
        canManage && row.state === 'active' ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setWithdrawing(row);
            }}
          >
            <ProhibitIcon data-icon="inline-start" />
            Withdraw
          </Button>
        ) : row.revokeReason === null ? null : (
          <span className="text-muted-foreground text-xs">{row.revokeReason}</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader description={`One read-only link per customer, ${String(PORTAL_KEY_DAYS)} days, showing them their own orders, dispatches, invoices and statement. The link is the credential — there is no customer sign-in — so it is shown once and withdrawable the moment it should stop working.`} />

      {canManage ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <RecordPicker
            id="portal-party"
            label="Customer"
            showLabel
            className="sm:w-72"
            placeholder="Choose a customer"
            searchPlaceholder="Search parties"
            emptyMessage="No party matches."
            icon={<BooksIcon className="text-muted-foreground" />}
            options={partyOptions}
            loading={parties.isPending}
            value={chosen}
            onValueChange={(next) => {
              setPartyId(next?.id ?? null);
            }}
          />
          <Button
            disabled={partyId === null || issue.isPending}
            onClick={() => {
              if (partyId === null) return;
              issue.mutate(
                { partyId },
                {
                  onSuccess: (key) => {
                    setIssued({ url: key.url, partyName: key.partyName });
                    setCopied(false);
                    setPartyId(null);
                    toast.add({ type: 'success', title: `Link created for ${key.partyName}`, description: 'Copy it now; it is shown once.' });
                  },
                  onError: (error) => {
                    const copy = actionErrorCopy(error, 'Creating the link');
                    toast.add({ type: 'error', title: copy.title, description: copy.description });
                  },
                },
              );
            }}
          >
            {issue.isPending ? <Spinner data-icon="inline-start" /> : <LinkSimpleIcon data-icon="inline-start" />}
            Create a link
          </Button>
        </div>
      ) : null}

      {issued === null ? null : (
        <Field>
          <FieldLabel htmlFor="portal-new-link">Send {issued.partyName} this</FieldLabel>
          <div className="flex gap-2">
            <Input id="portal-new-link" readOnly value={issued.url} className="font-mono text-xs" />
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(issued.url).then(() => {
                  setCopied(true);
                });
              }}
            >
              {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <FieldDescription>Shown once. Only a hash is kept, so nobody can read it back — issue a new one instead, which withdraws this.</FieldDescription>
        </Field>
      )}

      <div className="sm:max-w-sm">
        <SearchField id="portal-search" label="Search customers" placeholder="Customer name" value={q} onValueChange={setQ} />
      </div>

      {keys.isError ? (
        <QueryErrorAlert
          error={keys.error}
          subject="the customer links"
          onRetry={() => {
            void keys.refetch();
          }}
        />
      ) : keys.data === undefined ? (
        <div role="status" aria-busy="true" aria-label="Loading customer links">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LinkSimpleIcon />
            </EmptyMedia>
            <EmptyTitle>{q.trim() === '' ? 'No customer has a link yet' : 'No customer matches that'}</EmptyTitle>
            <EmptyDescription>
              {canManage ? 'Choose a customer above to create one. They open it without signing in, so send it to somebody you mean to see the account.' : 'Links are created by Admin or Accounts.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <RecordTable
          columns={columns}
          rows={[...rows]}
          rowKey={(row) => row.id}
          mobilePrimary={(row) => row.partyName}
          mobileStatus={(row) => <StatusBadge state={row.state} label={PORTAL_KEY_STATE_LABELS[row.state]} />}
          mobileSupporting={(row) => `Until ${formatDate(row.expiresAt.slice(0, 10))} · ${row.lastUsedAt === null ? 'never opened' : `opened ${String(row.viewCount)} times`}`}
        />
      )}

      <ReasonDialog
        open={withdrawing !== null}
        onOpenChange={(open) => {
          if (!open) setWithdrawing(null);
        }}
        title="Withdraw this link"
        description={withdrawing === null ? '' : `${withdrawing.partyName}'s link stops working the moment you withdraw it.`}
        prompt="Why withdraw it?"
        hint="Kept on the record."
        confirmLabel="Withdraw link"
        pendingLabel="Withdrawing…"
        confirmIcon={<ProhibitIcon data-icon="inline-start" />}
        destructive
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={(reason) => {
          if (withdrawing === null) return;
          const row = withdrawing;
          revoke.mutate(
            { id: row.id, reason },
            {
              onSuccess: () => {
                setWithdrawing(null);
                toast.add({ type: 'success', title: `${row.partyName}'s link withdrawn`, description: 'It stopped working at once.' });
              },
              onError: (error) => {
                const copy = actionErrorCopy(error, 'Withdrawing the link');
                toast.add({ type: 'error', title: copy.title, description: copy.description });
              },
            },
          );
        }}
      />
    </>
  );
}
