import { useState } from 'react';
import {
  ArrowsClockwiseIcon,
  CloudArrowDownIcon,
  KeyIcon,
  LockKeyIcon,
  PlugIcon,
  PlusIcon,
  WebhooksLogoIcon,
} from '@phosphor-icons/react';
import { formatDistanceToNow, parseISO } from 'date-fns';

import { CopyField } from '@/components/shared/copy-field';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { Textarea } from '@/components/ui/textarea';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatRelativeAge } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import {
  STATUS_LABELS,
  STATUS_VARIANT,
  statusExplanation,
  type IntegrationConnection,
  type SyncException,
} from './types';
import {
  useCreateConnection,
  useFullRePull,
  useIntegrations,
  useIssueToken,
  usePullNow,
  useResolveException,
  useSetWebhookSecret,
  useSyncExceptions,
} from './use-integrations';

/**
 * Technical design §14 / PRD §5: the Tally seam, now with its two writes.
 *
 * Phase 0 shipped this read-only and said so on screen, because a button with
 * no endpoint behind it teaches the reader to distrust the whole screen. The
 * endpoints exist now (Phase 6b), so the buttons do: create a connection, and
 * issue — or rotate — its agent token. The token is shown exactly once, in
 * the dialog that issued it; only its hash survives on the server, so there
 * is nothing a later screen could show.
 */

/**
 * "Never", not a dash. A connection that has never been heard from is a fact
 * about the connection, and an em dash reads as a missing value.
 */
function heartbeatAge(value: string | null): string {
  if (value === null) return 'Never';
  const parsed = parseISO(value);
  if (Number.isNaN(parsed.getTime())) return EMPTY_VALUE;
  return `${formatDistanceToNow(parsed)} ago`;
}

export function IntegrationsPage() {
  const canManage = usePermission(PERMISSIONS.INTEGRATION_MANAGE);
  const query = useIntegrations({ enabled: canManage });
  const rows = query.data?.data ?? [];
  const staleAfterMinutes = query.data?.staleAfterMinutes ?? null;

  const create = useCreateConnection();
  const issue = useIssueToken();
  const pull = usePullNow();
  const fullPull = useFullRePull();

  /** The connection whose full re-pull is being confirmed (REQ-R-05). */
  const [repulling, setRepulling] = useState<IntegrationConnection | null>(null);

  /** The OpsTally handshake: paste the secret, read back the URL. */
  const setSecret = useSetWebhookSecret();
  const [connecting, setConnecting] = useState<IntegrationConnection | null>(null);
  const [secretDraft, setSecretDraft] = useState('');
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyGuid, setCompanyGuid] = useState('');

  /** The rotation being confirmed, then the token being shown — one at a time. */
  const [rotating, setRotating] = useState<IntegrationConnection | null>(null);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  /** The exception being resolved, and the operator's note about it. */
  const exceptions = useSyncExceptions({ enabled: canManage });
  const resolve = useResolveException();
  const [resolving, setResolving] = useState<SyncException | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');

  function submitCreate() {
    create.mutate(
      {
        name: name.trim(),
        ...(companyName.trim() === '' ? {} : { companyName: companyName.trim() }),
        ...(companyGuid.trim() === '' ? {} : { companyGuid: companyGuid.trim() }),
      },
      {
        onSuccess: () => {
          toast.add({
            type: 'success',
            title: 'Connection created',
            description: 'Issue its agent token next; the agent cannot connect without one.',
          });
          setAdding(false);
          setName('');
          setCompanyName('');
          setCompanyGuid('');
        },
      },
    );
  }

  function runPull(connection: IntegrationConnection) {
    pull.mutate(
      { connectionId: connection.id },
      {
        onSuccess: (result) => {
          const allOpen = result.queued === 0;
          toast.add({
            type: 'success',
            title: allOpen ? 'Pulls are already queued' : 'Pull queued',
            description: allOpen
              ? `${connection.name} has open pulls for every master; the agent takes them on its next poll.`
              : `Parties, stock items and price lists queued; the agent picks them up on its next poll of ${connection.name}.`,
          });
        },
        // The server names what is missing — an unbound company, an entity
        // type without a writer — and its sentence is better than a generic
        // one composed here.
        onError: (error) => {
          toast.add({ type: 'error', title: 'The pull was not queued', description: error.message });
        },
      },
    );
  }

  function submitResolution() {
    if (resolving === null) return;
    resolve.mutate(
      { exceptionId: resolving.id, note: resolutionNote.trim() },
      {
        onSuccess: () => {
          toast.add({
            type: 'success',
            title: 'Exception resolved',
            description: 'It leaves this list; the journal keeps what happened.',
          });
          setResolving(null);
          setResolutionNote('');
        },
      },
    );
  }

  function submitSecret() {
    if (connecting === null) return;
    setSecret.mutate(
      { connectionId: connecting.id, secret: secretDraft.trim() },
      {
        onSuccess: (result) => {
          setSecretDraft('');
          setWebhookUrl(result.webhookUrl);
        },
      },
    );
  }

  function runFullRePull() {
    if (repulling === null) return;
    const name = repulling.name;
    fullPull.mutate(
      { connectionId: repulling.id },
      {
        onSuccess: () => {
          setRepulling(null);
          toast.add({
            type: 'success',
            title: 'Full re-pull queued',
            description: `${name} re-reads every master from the beginning on its next polls.`,
          });
        },
        // Leaves the dialog open so the refusal (a pull mid-flight, an
        // unbound company) is read where the decision was being made.
      },
    );
  }

  function runIssue(connection: IntegrationConnection) {
    issue.mutate(
      { connectionId: connection.id },
      {
        onSuccess: (result) => {
          setRotating(null);
          setIssuedToken(result.token);
        },
      },
    );
  }

  const columns: RecordColumn<IntegrationConnection>[] = [
    {
      key: 'name',
      header: 'Connection',
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: 'company',
      header: 'Tally company',
      cell: (row) => row.companyName ?? EMPTY_VALUE,
      secondary: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_LABELS[row.status]}</Badge>,
    },
    {
      key: 'transport',
      header: 'Source',
      cell: (row) =>
        row.transport === 'webhook' ? 'OpsTally webhook' : row.transport === 'agent' ? 'Vyuha agent' : EMPTY_VALUE,
      secondary: true,
    },
    {
      key: 'heartbeat',
      // One column, two meanings the reader can tell apart: an agent
      // heartbeats on a clock; OpsTally delivers only when Tally changed.
      header: 'Last heard',
      cell: (row) => heartbeatAge(row.lastHeartbeatAt),
      className: 'tabular-nums',
    },
    {
      key: 'pull',
      header: 'Sync',
      cell: (row) =>
        row.transport === 'webhook' ? (
          // A push door has no pull: a full resync is triggered from the
          // OpsTally Agent ("stock.snapshot"), not from here.
          <span className="text-muted-foreground text-xs">Resync from the OpsTally Agent</span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            // Without a credential nothing could ever claim the job; the
            // reason is stated where the button is, not discovered on press.
            disabled={!row.tokenIssued || pull.isPending}
            title={row.tokenIssued ? undefined : 'Issue the agent token first'}
            onClick={() => {
              runPull(row);
            }}
          >
            <CloudArrowDownIcon data-icon="inline-start" />
            Pull now
          </Button>
        ),
    },
    {
      key: 'repull',
      header: '',
      cell: (row) =>
        row.transport === 'webhook' ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={!row.tokenIssued}
            title={row.tokenIssued ? undefined : 'Issue the agent token first'}
            onClick={() => {
              fullPull.reset();
              setRepulling(row);
            }}
          >
            Full re-pull
          </Button>
        ),
    },
    {
      key: 'credential',
      header: 'Credential',
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          {/* The first credential decides the door; after that only its own
              rotation is offered. Before either, both are — side by side, so
              the choice is visible rather than discovered. */}
          {row.transport !== 'webhook' ? (
            <Button
              variant="outline"
              size="sm"
              disabled={issue.isPending}
              onClick={() => {
                issue.reset();
                if (row.tokenIssued) setRotating(row);
                else runIssue(row);
              }}
            >
              <KeyIcon data-icon="inline-start" />
              {row.tokenIssued ? 'Rotate token' : 'Issue agent token'}
            </Button>
          ) : null}
          {row.transport !== 'agent' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSecret.reset();
                setSecretDraft('');
                setWebhookUrl(null);
                setConnecting(row);
              }}
            >
              <WebhooksLogoIcon data-icon="inline-start" />
              {row.transport === 'webhook' ? 'Replace OpsTally secret' : 'Connect OpsTally'}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  if (!canManage) {
    return (
      <>
        <PageHeader description="Connections to systems outside this application." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view integration connections</EmptyTitle>
            <EmptyDescription>
              This needs the integration.manage permission. A connection carries a credential the
              agent authenticates with, so the list is not shown more widely.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Connections to systems outside this application. TallyPrime is the first."
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => {
                void query.refetch();
              }}
            >
              <ArrowsClockwiseIcon data-icon="inline-start" />
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => {
                create.reset();
                setAdding(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              Add connection
            </Button>
          </div>
        }
      />

      <div className="flex flex-col gap-4">
        {/* A failed fresh issue has no dialog to land in — the rotate
            confirm renders its own error, but the first-time path calls the
            endpoint directly, and a silent failure here means an admin
            cannot tell whether a token was minted on a lost response. */}
        {issue.isError && rotating === null && issuedToken === null ? (
          <Alert variant="destructive">
            <AlertTitle>The token was not issued</AlertTitle>
            <AlertDescription>{issue.error.message}</AlertDescription>
          </Alert>
        ) : null}

        {query.isPending ? <ListSkeleton rows={2} label="Loading integrations" /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="integrations"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlugIcon />
              </EmptyMedia>
              <EmptyTitle>No connections</EmptyTitle>
              <EmptyDescription>
                One connection per Tally company (a Tally installation holding four financial
                years as four companies is four connections). Add the first, then either connect
                OpsTally with its signing secret or issue a Vyuha agent token — the first
                credential decides how data arrives.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <>
            <RecordTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              mobilePrimary={(row) => row.name}
              mobileStatus={(row) => (
                <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_LABELS[row.status]}</Badge>
              )}
              mobileSupporting={(row) =>
                `${row.companyName ?? row.system} · ${row.transport === 'webhook' ? 'OpsTally' : 'agent'} · last heard ${heartbeatAge(row.lastHeartbeatAt)}`
              }
            />

            {/* A status word is not enough on this screen: "Never connected"
                and "Heartbeat overdue" are different problems with different
                fixes, and REQ-Q-05 stores which specific problem an ERROR is.
                The stale window is the server's own number, read from the
                response rather than restated here. */}
            <dl className="flex flex-col gap-2 border p-4 text-sm">
              {rows.map((row) => (
                <div key={row.id} className="flex flex-col gap-0.5">
                  <dt className="text-xs font-medium">{row.name}</dt>
                  <dd className="text-muted-foreground text-xs">
                    {statusExplanation(row, staleAfterMinutes ?? 0)}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}

        {/* REQ-T-01: every unresolved conflict, rejection or ambiguity, with
            Tally's verbatim words. Rendered only when there is something or
            the fetch failed -- a permanent empty section would teach the
            reader to stop looking at exactly the list that must be looked at. */}
        {exceptions.isError ? (
          <QueryErrorAlert
            error={exceptions.error}
            subject="sync exceptions"
            onRetry={() => {
              void exceptions.refetch();
            }}
          />
        ) : null}
        {exceptions.isSuccess && exceptions.data.data.length > 0 ? (
          <div className="flex flex-col gap-3 border p-4">
            <SectionHeading
              title="Sync exceptions"
              note="Each needs a person; resolving asks what was done."
            />
            <ul className="flex flex-col divide-y">
              {exceptions.data.data.map((exception) => (
                <li key={exception.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{exception.connectionName}</span>
                    <Badge variant="outline">{exception.kind.replaceAll('_', ' ')}</Badge>
                    {exception.entityType === null ? null : (
                      <Badge variant="outline">{exception.entityType.replaceAll('_', ' ')}</Badge>
                    )}
                    <span className="text-muted-foreground text-xs">
                      {formatRelativeAge(exception.createdAt)}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto"
                      onClick={() => {
                        resolve.reset();
                        setResolutionNote('');
                        setResolving(exception);
                      }}
                    >
                      Resolve
                    </Button>
                  </div>
                  {/* Tally's words, not a paraphrase (REQ-T-01). */}
                  <p className="text-muted-foreground text-sm break-words">{exception.tallyError}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border p-4">
          <SectionHeading
            title="How OpsTally connects"
            note="OpsTally Webhooks reference, v1."
          />
          <ol className="text-muted-foreground flex list-decimal flex-col gap-2 pl-5 text-sm">
            <li>
              Install OpsTally Agent on the machine running TallyPrime and select the company to
              sync. It talks to Tally on localhost port 9000 and only ever calls out.
            </li>
            <li>
              In the Agent&apos;s settings, set the webhook URL — press Connect OpsTally on the
              connection above, paste the signing secret the Agent generated, and copy the URL it
              answers with back into the Agent.
            </li>
            <li>
              Send a test event from the Agent. The first delivery binds this connection to that
              install and to Tally&apos;s exact company name; the status turns Connected.
            </li>
            <li>
              From then on, every change in Tally arrives signed: ledgers under Sundry Debtors and
              Creditors become parties, stock items arrive with quantity and prices, vouchers are
              kept for the sales and receivables phases. Retries are safe — repeats are ignored.
            </li>
          </ol>
        </div>

        <div className="flex flex-col gap-3 border p-4">
          <SectionHeading
            title="How the Vyuha agent connects"
            note="Technical design section 14."
          />
          <ol className="text-muted-foreground flex list-decimal flex-col gap-2 pl-5 text-sm">
            <li>
              The agent runs on the machine that runs TallyPrime and talks to it on localhost port
              9000. That port never faces the internet.
            </li>
            <li>
              Every call is outbound from the agent to this application, so no inbound firewall
              rule is needed at the office.
            </li>
            <li>
              The agent authenticates with a per-connection token. Only its hash is stored here,
              and the token itself is shown once when it is issued.
            </li>
            <li>
              Each call updates the heartbeat. A heartbeat that stops arriving turns the status
              stale and raises a notification, rather than failing silently.
            </li>
            <li>
              Masters are matched by Tally GUID, never by name. A name match is a suggestion for a
              person to confirm; two employees with the same name is not hypothetical.
            </li>
          </ol>
        </div>
      </div>

      <Dialog
        open={adding}
        onOpenChange={(next) => {
          if (!next) setAdding(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a Tally connection</DialogTitle>
            <DialogDescription>
              One connection per Tally company. The company GUID can be bound later,
              but no job runs until it is.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="connection-name">Connection name</Label>
              <Input
                id="connection-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                placeholder="Head office 2026-27"
                maxLength={80}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="connection-company">Tally company name</Label>
              <Input
                id="connection-company"
                value={companyName}
                onChange={(event) => {
                  setCompanyName(event.target.value);
                }}
                placeholder="G C Communication (2026-27)"
                maxLength={120}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="connection-guid">Company GUID, if known</Label>
              <Input
                id="connection-guid"
                value={companyGuid}
                onChange={(event) => {
                  setCompanyGuid(event.target.value);
                }}
                placeholder="Copied from Tally; the agent reports it on its first heartbeat"
                maxLength={80}
              />
            </div>
            {create.isError ? (
              <Alert variant="destructive">
                <AlertTitle>The connection was not created</AlertTitle>
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <DialogFooter className="flex-row justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setAdding(false);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={name.trim() === '' || create.isPending}
              onClick={submitCreate}
            >
              {create.isPending ? 'Creating' : 'Create connection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={rotating !== null}
        onOpenChange={(next) => {
          if (!next) setRotating(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the token for {rotating?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The current token stops working the moment the new one is issued, and the running
              agent is disconnected until it is reconfigured with the new token. Rotation is how a
              credential is revoked; there is no separate revoke.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {issue.isError ? (
            <Alert variant="destructive">
              <AlertTitle>The token was not rotated</AlertTitle>
              <AlertDescription>{issue.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={issue.isPending}
              onClick={(event) => {
                // Stays open while the request runs, so the error state has
                // somewhere to land; success closes it via runIssue.
                event.preventDefault();
                if (rotating !== null) runIssue(rotating);
              }}
            >
              {issue.isPending ? 'Rotating' : 'Rotate token'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={repulling !== null}
        onOpenChange={(next) => {
          if (!next) setRepulling(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Full re-pull for {repulling?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every master is re-read from the beginning, and masters that no longer
              exist in Tally are marked absent — never deleted. Nothing in Tally changes; this
              only rebuilds the copy here. The work runs on the agent's next polls.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {fullPull.isError ? (
            <Alert variant="destructive">
              <AlertTitle>The re-pull was not queued</AlertTitle>
              <AlertDescription>{fullPull.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={fullPull.isPending}
              onClick={(event) => {
                event.preventDefault();
                runFullRePull();
              }}
            >
              {fullPull.isPending ? 'Queueing' : 'Re-pull everything'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={connecting !== null}
        onOpenChange={(next) => {
          if (!next) setConnecting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {connecting?.transport === 'webhook'
                ? `Replace the OpsTally secret for ${connecting.name}`
                : `Connect OpsTally to ${connecting?.name ?? 'this connection'}`}
            </DialogTitle>
            <DialogDescription>
              Paste the signing secret from the OpsTally Agent&apos;s settings (it starts with
              whsec_). It is stored sealed and never shown again; only the signature it produces
              crosses the wire. Replacing it re-binds this connection to whichever install signs
              with the new one.
            </DialogDescription>
          </DialogHeader>
          {webhookUrl === null ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="webhook-secret">Signing secret</Label>
                <Input
                  id="webhook-secret"
                  value={secretDraft}
                  onChange={(event) => {
                    setSecretDraft(event.target.value);
                  }}
                  placeholder="whsec_…"
                  autoComplete="off"
                  maxLength={256}
                />
              </div>
              {setSecret.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>The secret was not stored</AlertTitle>
                  <AlertDescription>{setSecret.error.message}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                Stored. Now paste this URL into the OpsTally Agent&apos;s webhook setting and send a
                test event.
              </p>
              <CopyField value={webhookUrl} label="Webhook URL" id="opstally-webhook-url" />
            </div>
          )}
          <DialogFooter className="flex-row justify-end gap-2">
            {webhookUrl === null ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    setConnecting(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={!secretDraft.trim().startsWith('whsec_') || setSecret.isPending}
                  onClick={submitSecret}
                >
                  {setSecret.isPending ? 'Storing' : 'Store secret'}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => {
                  setConnecting(null);
                }}
              >
                Done
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resolving !== null}
        onOpenChange={(next) => {
          if (!next) setResolving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve this exception?</DialogTitle>
            <DialogDescription>
              Say what was done — the note is what stops the same problem returning in a month
              with nobody remembering this round. The journal keeps the exchange either way.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground border p-3 text-sm break-words">
              {resolving?.tallyError}
            </p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="resolution-note">What was done</Label>
              <Textarea
                id="resolution-note"
                value={resolutionNote}
                onChange={(event) => {
                  setResolutionNote(event.target.value);
                }}
                placeholder="Voucher corrected in Tally; re-pull queued"
                maxLength={2000}
                rows={3}
              />
            </div>
            {resolve.isError ? (
              <Alert variant="destructive">
                <AlertTitle>The exception was not resolved</AlertTitle>
                <AlertDescription>{resolve.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <DialogFooter className="flex-row justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setResolving(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={resolutionNote.trim().length < 3 || resolve.isPending}
              onClick={submitResolution}
            >
              {resolve.isPending ? 'Resolving' : 'Resolve exception'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={issuedToken !== null}
        onOpenChange={(next) => {
          if (!next) setIssuedToken(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Agent token — shown once</DialogTitle>
            <DialogDescription>
              Paste this into the agent's configuration on the Tally machine now. Only its hash is
              stored here, so closing this dialog is final: a lost token means issuing a new one.
            </DialogDescription>
          </DialogHeader>
          {issuedToken === null ? null : (
            <CopyField value={issuedToken} label="Agent token" id="issued-agent-token" />
          )}
          <DialogFooter className="flex-row justify-end gap-2">
            <Button
              onClick={() => {
                setIssuedToken(null);
              }}
            >
              I have stored it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
