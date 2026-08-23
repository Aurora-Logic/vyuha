import { useState } from 'react';
import { CheckIcon, CopyIcon, LinkSimpleIcon, ProhibitIcon } from '@phosphor-icons/react';

import { StatusBadge } from '@/components/shared/status-badge';
import { SectionHeading } from '@/components/shared/section-heading';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { formatDate } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, PORTAL_KEY_DAYS, PORTAL_KEY_STATE_LABELS } from '@vyuha/shared';

import { useIssuePortalKey, usePortalKeys, useRevokePortalKey } from './use-portal';

/**
 * Area AL from the inside: the one link this customer has, when it dies,
 * and the button that kills it now (REQ-AL-07).
 *
 * The key is shown exactly once, in the reply that created it, and this
 * panel holds it in memory only for as long as the page is open — long
 * enough to copy into a message, and no longer. Reloading does not bring it
 * back, because the server does not keep it either.
 */
export function PortalLinkPanel({ partyId, partyName }: { partyId: string; partyName: string }) {
  const canManage = usePermission(PERMISSIONS.PORTAL_MANAGE);
  const canReadReceivables = usePermission(PERMISSIONS.RECEIVABLES_VIEW);
  const canSee = canManage || canReadReceivables;
  const keys = usePortalKeys(partyId, { enabled: canSee });
  const issue = useIssuePortalKey();
  const revoke = useRevokePortalKey();
  const [issued, setIssued] = useState<{ url: string; id: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [reason, setReason] = useState('');

  if (!canSee) return null;

  const live = (keys.data ?? []).find((key) => key.state === 'active') ?? null;
  const past = (keys.data ?? []).filter((key) => key.state !== 'active');

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title="Customer link"
        note={`A read-only page of their own orders, dispatches and statement. One link per customer, ${String(PORTAL_KEY_DAYS)} days, withdrawable at any moment.`}
      />

      {keys.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : live === null ? (
        <p className="text-muted-foreground text-sm">No link is open for {partyName}.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <StatusBadge state={live.state} label={PORTAL_KEY_STATE_LABELS[live.state]} />
          <span className="text-muted-foreground">
            Issued {formatDate(live.issuedAt.slice(0, 10))}
            {live.issuedByName === null ? '' : ` by ${live.issuedByName}`} · until {formatDate(live.expiresAt.slice(0, 10))} ·{' '}
            {live.lastUsedAt === null ? 'never opened' : `opened ${String(live.viewCount)} times, last ${formatDate(live.lastUsedAt.slice(0, 10))}`}
          </span>
        </div>
      )}

      {issued !== null ? (
        <Field>
          <FieldLabel htmlFor="portal-link">Send them this</FieldLabel>
          <div className="flex gap-2">
            <Input id="portal-link" readOnly value={issued.url} className="font-mono text-xs" />
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
          <FieldDescription>Shown once. It is stored only as a hash, so nobody — including us — can read it back.</FieldDescription>
        </Field>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap items-end gap-3">
          <Button
            variant={live === null ? 'default' : 'outline'}
            disabled={issue.isPending}
            onClick={() => {
              issue.mutate(
                { partyId },
                {
                  onSuccess: (key) => {
                    setIssued({ url: key.url, id: key.id });
                    setCopied(false);
                    toast.add({ type: 'success', title: live === null ? 'Link created' : 'Link replaced', description: live === null ? 'Copy it now; it is shown once.' : 'The previous link stopped working immediately.' });
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
            {live === null ? 'Create a link' : 'Replace the link'}
          </Button>
          {live === null ? null : (
            <>
              <Field className="w-64">
                <FieldLabel htmlFor="portal-revoke-reason">Why withdraw it</FieldLabel>
                <Input
                  id="portal-revoke-reason"
                  placeholder="The buyer left the company"
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              </Field>
              <Button
                variant="outline"
                disabled={revoke.isPending || reason.trim().length < 3}
                onClick={() => {
                  revoke.mutate(
                    { id: live.id, reason: reason.trim() },
                    {
                      onSuccess: () => {
                        setReason('');
                        setIssued(null);
                        toast.add({ type: 'success', title: 'Link withdrawn', description: 'It stopped working at once.' });
                      },
                      onError: (error) => {
                        const copy = actionErrorCopy(error, 'Withdrawing the link');
                        toast.add({ type: 'error', title: copy.title, description: copy.description });
                      },
                    },
                  );
                }}
              >
                <ProhibitIcon data-icon="inline-start" />
                Withdraw
              </Button>
            </>
          )}
        </div>
      ) : null}

      {past.length === 0 ? null : (
        <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
          {past.slice(0, 5).map((key) => (
            <li key={key.id}>
              {PORTAL_KEY_STATE_LABELS[key.state]} {key.revokedAt === null ? formatDate(key.expiresAt.slice(0, 10)) : formatDate(key.revokedAt.slice(0, 10))}
              {key.revokeReason === null ? '' : ` — ${key.revokeReason}`}
              {key.revokedByName === null ? '' : ` (${key.revokedByName})`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
