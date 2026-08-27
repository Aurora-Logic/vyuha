import { useState } from 'react';
import { ArrowsClockwiseIcon, CaretDownIcon, LockKeyIcon, PhoneIcon, SunIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS } from '@vyuha/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { DateField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useIsMobile } from '@/hooks/use-mobile';
import { apiRequest } from '@/lib/api/client';
import { EMPTY_VALUE, formatCount, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { toApiDate } from './period';
import {
  DESK_OUTCOME_LABELS,
  deltaText,
  logDeskOutcome,
  useCallSheet,
  useDeskToday,
  type CallSheetData,
  type DeskRowData,
} from './use-cfo';

/**
 * The Director's Desk (brief Part O): "which customers do we work on
 * today?" -- one ranked, deduplicated, capped list, not twenty. Each row is
 * a name, its loudest reason, the rupees at stake, an owner, and the score
 * that put it there, inspectable on demand. The call sheet (O4) is the
 * one-page brief behind a name; the outcome (O4.1) is the list's memory.
 */

function ScoreBreakdown({ row }: { row: DeskRowData }) {
  const parts: [string, number][] = [
    ['Value', row.breakdown.value],
    ['Urgency', row.breakdown.urgency],
    ['Risk', row.breakdown.risk],
    ['Opportunity', row.breakdown.opportunity],
  ];
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="tabular-nums" aria-label={`Score ${String(row.score)}, see how`} />}>
        {row.score}
      </PopoverTrigger>
      <PopoverContent className="w-64 text-sm">
        <p className="mb-2 font-medium">How this score was built</p>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 tabular-nums">
          {parts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right">{value}</dd>
            </div>
          ))}
          {row.breakdown.cooldown > 0 ? (
            <div className="contents">
              <dt className="text-muted-foreground">Cooldown</dt>
              <dd className="text-right">−{row.breakdown.cooldown}</dd>
            </div>
          ) : null}
        </dl>
        <p className="text-muted-foreground mt-2 text-xs">Opportunity is priced with Phase 5; until then it reads zero.</p>
      </PopoverContent>
    </Popover>
  );
}

function OutcomeForm({ partyId, onLogged }: { partyId: string; onLogged: () => void }) {
  const [outcome, setOutcome] = useState('');
  const [amount, setAmount] = useState('');
  const [nextDate, setNextDate] = useState<Date | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const needsAmount = outcome === 'ORDER_PLACED' || outcome === 'PROMISE_TO_PAY' || outcome === 'PARTIAL_PAYMENT';
  const needsDate = outcome === 'CALL_AGAIN' || outcome === 'PROMISE_TO_PAY';

  async function submit() {
    if (outcome === '') return;
    setSaving(true);
    try {
      await logDeskOutcome(partyId, {
        outcome,
        ...(amount.trim() === '' ? {} : { amount: amount.trim() }),
        ...(nextDate === null ? {} : { nextDate: toApiDate(nextDate) }),
        ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
      });
      toast.add({ type: 'success', title: 'Outcome logged', description: DESK_OUTCOME_LABELS[outcome] ?? outcome });
      setOutcome('');
      setAmount('');
      setNextDate(null);
      setNotes('');
      onLogged();
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not log the outcome', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel>Outcome</FieldLabel>
        <Select value={outcome} onValueChange={(v) => { setOutcome(v === null ? '' : String(v)); }}>
          <SelectTrigger aria-label="Outcome">
            <SelectValue placeholder="What happened?">
              {(v: string) => (v === '' ? 'What happened?' : (DESK_OUTCOME_LABELS[v] ?? v))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(DESK_OUTCOME_LABELS).map(([key, label]) => (
              <SelectItem key={key} value={key}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {needsAmount ? (
        <Field>
          <FieldLabel htmlFor="outcome-amount">Amount</FieldLabel>
          <Input id="outcome-amount" inputMode="decimal" value={amount} placeholder="0" onChange={(e) => { setAmount(e.target.value); }} />
        </Field>
      ) : null}
      {needsDate ? (
        <DateField label="Next date" showLabel value={nextDate ?? new Date()} onValueChange={setNextDate} />
      ) : null}
      <Field>
        <FieldLabel htmlFor="outcome-notes">Notes</FieldLabel>
        <Textarea id="outcome-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => { setNotes(e.target.value); }} />
      </Field>
      <Button disabled={outcome === '' || saving} onClick={() => void submit()}>
        {saving ? 'Logging' : 'Log outcome'}
      </Button>
    </div>
  );
}

function CallSheetBody({ sheet, onLogged }: { sheet: CallSheetData; onLogged: () => void }) {
  const n = sheet.numbers;
  const ageing = ['0-30', '31-60', '61-90', '91-180', '180+'].filter((b) => Number(n.ageing[b] ?? 0) > 0);
  return (
    <div className="flex flex-col gap-5 text-sm">
      <p className="text-muted-foreground text-xs">
        Owner {sheet.party.ownerLabel}
        {sheet.party.since ? ` · since ${formatDate(sheet.party.since)}` : ''}
        {sheet.party.creditLimit ? ` · limit ${formatMoney(sheet.party.creditLimit)}` : ''}
      </p>

      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Why today</h3>
        {sheet.why.primary ? <p>{sheet.why.primary.reason}</p> : <p className="text-muted-foreground">Nothing flags this customer right now.</p>}
        {sheet.why.others.length > 0 ? (
          <ul className="text-muted-foreground list-disc pl-5">
            {sheet.why.others.map((o) => (
              <li key={o.key}>{o.reason}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="font-medium">The numbers</h3>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
          <dt className="text-muted-foreground">This year</dt><dd className="text-right">{formatMoney(n.thisYear)}</dd>
          <dt className="text-muted-foreground">Last year</dt><dd className="text-right">{formatMoney(n.lastYear)} · {deltaText(n.delta)}</dd>
          <dt className="text-muted-foreground">Outstanding</dt><dd className="text-right">{formatMoney(n.outstanding)}</dd>
          <dt className="text-muted-foreground">Overdue</dt><dd className="text-right">{formatMoney(n.overdue)} · {formatCount(n.maxDaysOverdue)} days</dd>
          {ageing.length > 0 ? (
            <>
              <dt className="text-muted-foreground">Ageing</dt>
              <dd className="text-right">{ageing.map((b) => `${b} ${formatMoney(n.ageing[b] ?? '0')}`).join(' · ')}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Their delay costs us</dt><dd className="text-right">{formatMoney(n.delayCostPerYear)} a year</dd>
          <dt className="text-muted-foreground">Promises</dt><dd className="text-right">{formatCount(n.promisesMade)} made · {formatCount(n.promisesKept)} kept</dd>
          <dt className="text-muted-foreground">Real profit</dt><dd className="text-right">{EMPTY_VALUE} awaits M1</dd>
        </dl>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="font-medium">What they buy</h3>
        {sheet.buys.top.length > 0 ? (
          <p>Top: {sheet.buys.top.map((t) => `${t.group} ${String(t.share)}%`).join(' · ')}</p>
        ) : (
          <p className="text-muted-foreground">Nothing this financial year.</p>
        )}
        {sheet.buys.stopped.length > 0 ? (
          <p>Stopped: {sheet.buys.stopped.map((s) => `${s.group} (${formatMoney(s.lastYear)} last year)`).join(' · ')}</p>
        ) : null}
        <p className="text-muted-foreground text-xs">Should buy: cross-sell arrives with Phase 5.</p>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Last contact</h3>
        {sheet.lastContact ? (
          <p>
            {formatDate(sheet.lastContact.on)}, {sheet.lastContact.ownerLabel} — {DESK_OUTCOME_LABELS[sheet.lastContact.outcome] ?? sheet.lastContact.outcome}
            {sheet.lastContact.notes ? ` — “${sheet.lastContact.notes}”` : ''}
          </p>
        ) : (
          <p className="text-muted-foreground">No contact logged yet.</p>
        )}
      </section>

      {sheet.asks.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="font-medium">Suggested ask</h3>
          <ol className="list-decimal pl-5">
            {sheet.asks.map((ask) => (
              <li key={ask}>{ask}</li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="flex flex-col gap-2 border-t pt-4">
        <h3 className="font-medium">Outcome</h3>
        <OutcomeForm partyId={sheet.party.id} onLogged={onLogged} />
      </section>
    </div>
  );
}

export function DeskPage() {
  const canView = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const canTask = usePermission(PERMISSIONS.CRM_TASK_MANAGE);
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [cap, setCap] = useState(10);
  const [mixed, setMixed] = useState(false);
  const [openParty, setOpenParty] = useState<{ id: string; name: string } | null>(null);
  const desk = useDeskToday({ cap, mixed, enabled: canView });
  const sheet = useCallSheet(openParty?.id ?? null);

  async function assign(row: DeskRowData) {
    try {
      await apiRequest('/tasks', {
        method: 'POST',
        body: {
          title: `${row.primary.label}: ${row.party}`,
          description: `${row.primary.reason}. At stake: ${formatMoney(row.atStake)}.`,
          priority: 'HIGH',
          subjectType: 'party',
          subjectId: row.partyId,
        },
      });
      toast.add({ type: 'success', title: 'Task created', description: `${row.party} is on the board.` });
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not create the task', description: error instanceof Error ? error.message : 'Try again.' });
    }
  }

  if (!canView) {
    return (
      <>
        <PageHeader description="Which customers do we work on today? One list, not twenty." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot open the desk</EmptyTitle>
            <EmptyDescription>This needs the cfo.sales.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = desk.data;

  return (
    <>
      <PageHeader
        title={data ? `${formatDate(data.date)} · ${data.theme.label}` : "Director's desk"}
        description={data?.theme.hint ?? 'Which customers do we work on today? One list, not twenty.'}
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="icon-sm" aria-label="Refresh" disabled={desk.isFetching} onClick={() => void desk.refetch()}>
            <ArrowsClockwiseIcon />
          </Button>
          <Select value={String(cap)} onValueChange={(v) => { if (v !== null) setCap(Number(v)); }}>
            <SelectTrigger className="w-28" aria-label="Names per day">
              <SelectValue>{(v: string) => `${v} names`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {[5, 10, 20].map((n) => (
                <SelectItem key={n} value={String(n)}>{n} names</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="flex min-h-9 items-center gap-2">
            <Switch id="desk-mixed" checked={mixed} onCheckedChange={setMixed} />
            <Label htmlFor="desk-mixed" className="text-sm">Mixed mode</Label>
          </span>
          {data ? (
            <span className="text-muted-foreground text-xs">{formatCount(data.qualified)} qualified today</span>
          ) : null}
        </div>

        {data ? (
          <KpiGrid
            columns={4}
            tiles={[
              { label: 'Yesterday called', value: formatCount(data.strip.called), note: `${formatCount(data.strip.outcomes)} outcomes` },
              { label: 'Collected', value: formatMoney(data.strip.collected) },
              { label: 'Orders', value: formatCount(data.strip.orders), note: formatMoney(data.strip.orderValue) },
              { label: 'On the list', value: formatCount(data.rows.length), note: `of ${formatCount(data.cap)}` },
            ]}
          />
        ) : null}

        {desk.isPending ? <Skeleton className="h-64" /> : null}
        {desk.error ? <QueryErrorAlert error={desk.error} subject="desk" onRetry={() => void desk.refetch()} /> : null}

        {data && data.rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SunIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing to call today</EmptyTitle>
              <EmptyDescription>
                {data.qualified === 0
                  ? 'No customer qualifies under today’s theme. Mixed mode serves the top names whatever the reason.'
                  : 'Every qualifying name was served this week or is cooling down after a contact.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {data && data.rows.length > 0 ? (
          <div className="flex flex-col gap-3">
            {data.rows.map((row) => (
              <Card key={row.partyId}>
                <CardHeader>
                  <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    <span className="text-muted-foreground tabular-nums">{row.rank}.</span>
                    <span className="truncate">{row.party}</span>
                    <Badge variant="secondary">{row.primary.label}</Badge>
                  </CardTitle>
                  <CardAction className="flex items-center gap-2">
                    <ScoreBreakdown row={row} />
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <p className="text-sm">{row.primary.reason}</p>
                  <p className="text-muted-foreground text-xs">
                    {formatMoney(row.atStake)} at stake · owner {row.ownerLabel}
                    {row.lastContact ? ` · last contact ${formatDate(row.lastContact.on)}, ${DESK_OUTCOME_LABELS[row.lastContact.outcome] ?? row.lastContact.outcome}` : ''}
                  </p>
                  {row.others.length > 0 ? (
                    <Collapsible>
                      <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="-ml-2" />}>
                        <CaretDownIcon data-icon="inline-start" />
                        {formatCount(row.others.length)} more reason{row.others.length === 1 ? '' : 's'}
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <ul className="text-muted-foreground list-disc pl-5 text-sm">
                          {row.others.map((o) => (
                            <li key={o.key}>{o.reason}</li>
                          ))}
                        </ul>
                      </CollapsibleContent>
                    </Collapsible>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => { setOpenParty({ id: row.partyId, name: row.party }); }}>
                      <PhoneIcon data-icon="inline-start" />
                      Open call sheet
                    </Button>
                    {canTask ? (
                      <Button size="sm" variant="outline" onClick={() => void assign(row)}>
                        Assign
                      </Button>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : null}
      </div>

      <Sheet open={openParty !== null} onOpenChange={(open) => { if (!open) setOpenParty(null); }}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-lg">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{openParty?.name ?? ''}</SheetTitle>
            <SheetDescription>The one-page brief, and the outcome that closes the loop.</SheetDescription>
          </SheetHeader>
          <div className="max-h-[75vh] overflow-y-auto px-4 py-4 sm:max-h-none">
            {sheet.isPending && openParty ? <Skeleton className="h-64" /> : null}
            {sheet.error ? <QueryErrorAlert error={sheet.error} subject="call sheet" onRetry={() => void sheet.refetch()} /> : null}
            {sheet.data ? (
              <CallSheetBody
                sheet={sheet.data}
                onLogged={() => {
                  void queryClient.invalidateQueries({ queryKey: ['cfo', 'desk'] });
                }}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
