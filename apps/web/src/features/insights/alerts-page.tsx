import { useState } from 'react';
import { ArrowsClockwiseIcon, BellSlashIcon, LockKeyIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Field, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { DateField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatCount, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { toApiDate } from './period';
import { snoozeAlert, useAlerts, type AlertData } from './use-cfo';

/**
 * Alerts (CFO brief Part L, Q5): mostly about not firing. One per customer
 * a day carrying every reason, ranked by rupees, capped at ten with the
 * rest in a digest line, snoozable with a reason and a date. Every alert
 * says what, how much, since when, why, and one action.
 */

export function AlertsPage() {
  const canView = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useAlerts({ enabled: canView });
  const [snoozing, setSnoozing] = useState<{ alertKey: string; partyId: string | null; subject: string } | null>(null);
  const [until, setUntil] = useState<Date>(() => new Date(Date.now() + 14 * 86_400_000));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function snooze() {
    if (snoozing === null || reason.trim() === '') return;
    setBusy(true);
    try {
      await snoozeAlert({ alertKey: snoozing.alertKey, partyId: snoozing.partyId, until: toApiDate(until), reason: reason.trim() });
      await queryClient.invalidateQueries({ queryKey: ['cfo', 'alerts'] });
      toast.add({ type: 'success', title: `${snoozing.subject} snoozed until ${toApiDate(until)}` });
      setSnoozing(null);
      setReason('');
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not snooze', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (!canView) {
    return (
      <>
        <PageHeader description="What needs a decision today, and nothing that does not." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view alerts</EmptyTitle>
            <EmptyDescription>This needs the cfo.sales.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;
  const live = data?.alerts.filter((a) => a.snoozed === null) ?? [];
  const snoozed = data?.alerts.filter((a) => a.snoozed !== null) ?? [];

  function AlertCard({ alert }: { alert: AlertData }) {
    return (
      <Card className={alert.snoozed ? 'opacity-60' : undefined}>
        <CardHeader>
          <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <span className="truncate">{alert.subject}</span>
            {alert.reasons.some((r) => r.immediate) ? <Badge variant="destructive">Immediate</Badge> : null}
            {alert.snoozed ? <Badge variant="secondary">Snoozed to {formatDate(alert.snoozed.until)}</Badge> : null}
          </CardTitle>
          <CardAction>
            <span className="text-sm font-semibold tabular-nums">{formatMoney(alert.exposure)}</span>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <ul className="list-disc pl-5 text-sm">
            {alert.reasons.map((r) => (
              <li key={r.key}><span className="font-medium">{r.label}</span> — {r.why}</li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            {alert.since ? `Since ${formatDate(alert.since)} · ` : ''}Do: {alert.action}
            {alert.snoozed ? ` · snoozed: ${alert.snoozed.reason}` : ''}
          </p>
          <div className="flex flex-wrap gap-2">
            {alert.partyId ? (
              <Button size="sm" onClick={() => void navigate(`/masters/vouchers?party=${alert.partyId ?? ''}`)}>Open vouchers</Button>
            ) : null}
            {alert.snoozed === null ? (
              <Button size="sm" variant="outline" onClick={() => { setSnoozing({ alertKey: 'customer', partyId: alert.partyId, subject: alert.subject }); }}>
                <BellSlashIcon data-icon="inline-start" />
                Snooze
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        description="What needs a decision today: one alert per customer with every reason, ranked by rupees, capped at ten. The rest wait in the digest."
        action={
          <Button variant="outline" size="icon-sm" aria-label="Refresh" disabled={query.isFetching} onClick={() => void query.refetch()}>
            <ArrowsClockwiseIcon />
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.error ? <QueryErrorAlert error={query.error} subject="alerts" onRetry={() => void query.refetch()} /> : null}
        {data ? (
          <>
            <KpiGrid
              columns={4}
              tiles={[
                { label: 'Alerts today', value: formatCount(live.length), note: `cap ${formatCount(data.cap)}` },
                { label: 'In the digest', value: formatCount(data.digest.count), note: formatMoney(data.digest.exposure) },
                { label: 'Company-level', value: formatCount(data.companyAlerts.length) },
                { label: 'Snoozed', value: formatCount(snoozed.length) },
              ]}
            />

            {data.companyAlerts.length > 0 ? (
              <div className="flex flex-col gap-2">
                {data.companyAlerts.map((a) => (
                  <Card key={a.key}>
                    <CardHeader>
                      <CardTitle className="text-sm font-medium">{a.label}</CardTitle>
                      <CardAction><span className="text-sm font-semibold tabular-nums">{formatMoney(a.amount)}</span></CardAction>
                    </CardHeader>
                    <CardContent className="flex items-center justify-between gap-2">
                      <p className="text-sm">{a.why}</p>
                      <Button size="sm" variant="outline" onClick={() => { setSnoozing({ alertKey: a.key, partyId: null, subject: a.label }); }}>Snooze</Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : null}

            {live.length === 0 && data.companyAlerts.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><BellSlashIcon /></EmptyMedia>
                  <EmptyTitle>Nothing needs a decision today</EmptyTitle>
                  <EmptyDescription>An alert system that cries wolf is switched off within a fortnight. Quiet is the point.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}

            <div className="flex flex-col gap-3">
              {live.map((a) => <AlertCard key={a.partyId ?? a.subject} alert={a} />)}
              {snoozed.map((a) => <AlertCard key={`s-${a.partyId ?? a.subject}`} alert={a} />)}
            </div>

            <p className="text-muted-foreground text-xs">
              Two-evaluation confirmation, hysteresis and three-day escalation need the nightly job&rsquo;s memory and arrive with it; limit breaches fire immediately either way.
            </p>
          </>
        ) : null}
      </div>

      <Dialog open={snoozing !== null} onOpenChange={(open) => { if (!open) { setSnoozing(null); setReason(''); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Snooze {snoozing?.subject ?? ''}</DialogTitle>
            <DialogDescription>Snoozes are logged and reviewed monthly: say why, and until when.</DialogDescription>
          </DialogHeader>
          <DateField label="Until" showLabel value={until} onValueChange={setUntil} />
          <Field>
            <FieldLabel htmlFor="snooze-reason">Reason</FieldLabel>
            <Textarea id="snooze-reason" rows={2} maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); }} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSnoozing(null); setReason(''); }}>Cancel</Button>
            <Button disabled={busy || reason.trim() === ''} onClick={() => void snooze()}>Snooze</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
