import { useState } from 'react';
import { PARTY_LEDGER_GROUPS } from '@vyuha/shared';
import { BooksIcon, WarningCircleIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { DateField } from '@/features/attendance/pickers';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { PartyPicker } from '@/features/masters/party-picker';
import { ResponsiveDialog, ResponsiveDialogActions } from '@/components/shared/responsive-dialog';
import { formatDate, formatMoney } from '@/lib/format';

import { useOpenBills, useTakePromise } from './use-collections';

/**
 * REQ-AJ-01: what a customer said, written down -- the amount, the day,
 * and which bills it is against. The bills are the party's own open ones,
 * so a promise cannot name a bill that is not there; naming none means
 * any receipt from the party counts towards it.
 *
 * Nothing here says whether the promise was kept. That is read from the
 * receipts Tally sends, and the dialog says so, because a collector who
 * expects to tick it off later should learn that here rather than by
 * hunting for the button.
 */
export function PromiseDialog({ open, onOpenChange, partyId, partyName }: { open: boolean; onOpenChange: (open: boolean) => void; partyId: string | null; partyName?: string }) {
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={partyName === undefined ? 'Record a promise to pay' : `${partyName}: a promise to pay`}
      description="What they said they would pay, by when, and against which bills. Whether it is kept is read from the receipts Tally sends — there is no button for it here."
      className="sm:max-w-lg"
    >
      <PromiseForm
        partyId={partyId}
        onDone={() => {
          onOpenChange(false);
        }}
        onCancel={() => {
          onOpenChange(false);
        }}
      />
    </ResponsiveDialog>
  );
}

function PromiseForm({ partyId, onDone, onCancel }: { partyId: string | null; onDone: () => void; onCancel: () => void }) {
  const [party, setParty] = useState<string | null>(partyId);
  const [amount, setAmount] = useState('');
  const [promisedDate, setPromisedDate] = useState(toDateParam(new Date()));
  const [bills, setBills] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const openBills = useOpenBills(party);
  const take = useTakePromise();

  const outstanding = (openBills.data ?? []).reduce((sum, bill) => sum + Number(bill.outstanding), 0);
  const named = (openBills.data ?? []).filter((bill) => bills.includes(bill.billName));
  const namedTotal = named.reduce((sum, bill) => sum + Number(bill.outstanding), 0);
  const today = toDateParam(new Date());

  const problem =
    party === null
      ? 'Pick the customer.'
      : amount.trim() === '' || !/^\d{1,14}(\.\d{1,2})?$/u.test(amount.trim()) || Number(amount) <= 0
        ? 'An amount with up to two decimals, more than zero.'
        : promisedDate < today
          ? 'A promise is for today or a day after it.'
          : null;
  const copy = take.error ? actionErrorCopy(take.error, 'Recording the promise') : null;

  function submit(): void {
    setTouched(true);
    if (problem !== null || party === null || take.isPending) return;
    take.mutate(
      { partyId: party, amount: amount.trim(), promisedDate, bills, ...(notes.trim() === '' ? {} : { notes: notes.trim() }) },
      {
        onSuccess: (promise) => {
          toast.add({
            type: 'success',
            title: `${promise.partyName} promised ${formatMoney(promise.amount)}`,
            description: `By ${formatDate(promise.promisedDate)}. It reads as kept the moment the receipts against ${bills.length === 0 ? 'this customer' : 'those bills'} cover it.`,
          });
          onDone();
        },
      },
    );
  }

  return (
    <>
      <FieldGroup>
        {copy ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>{copy.title}</AlertTitle>
            <AlertDescription>{copy.description}</AlertDescription>
          </Alert>
        ) : null}

        {partyId === null ? (
          <PartyPicker
            showLabel
            id="promise-party"
            label="Customer"
            placeholder="Tally party"
            parentGroup={PARTY_LEDGER_GROUPS.CUSTOMER}
            icon={<BooksIcon className="text-muted-foreground" />}
            partyId={party}
            onValueChange={(next) => {
              setParty(next?.id ?? null);
              setBills([]);
            }}
          />
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={touched && problem !== null && party !== null ? true : undefined}>
            <FieldLabel htmlFor="promise-amount">Amount promised</FieldLabel>
            <Input
              id="promise-amount"
              inputMode="decimal"
              className="tabular-nums"
              placeholder="0.00"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <FieldDescription>
              {openBills.data === undefined ? 'Against the bills below.' : `${formatMoney(outstanding.toFixed(2))} is open in all.`}
            </FieldDescription>
          </Field>
          <DateField label="Promised by" showLabel value={fromDateParam(promisedDate)} onValueChange={(next) => { setPromisedDate(toDateParam(next)); }} yearsBack={0} yearsForward={2} />
        </div>

        <Field>
          <FieldLabel>Against which bills</FieldLabel>
          {party === null ? (
            <FieldDescription>Pick the customer first.</FieldDescription>
          ) : openBills.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : (openBills.data ?? []).length === 0 ? (
            <FieldDescription>Nothing is open for this customer. Any receipt will count towards the promise.</FieldDescription>
          ) : (
            <>
              <ul className="flex max-h-56 flex-col divide-y overflow-y-auto border">
                {(openBills.data ?? []).map((bill) => (
                  <li key={bill.billName} className="flex min-h-11 items-center gap-3 px-3 py-2">
                    <Checkbox
                      id={`bill-${bill.billName}`}
                      checked={bills.includes(bill.billName)}
                      onCheckedChange={(checked) => {
                        setBills((current) => (checked === true ? [...current, bill.billName] : current.filter((b) => b !== bill.billName)));
                      }}
                    />
                    <Label htmlFor={`bill-${bill.billName}`} className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 font-normal">
                      <span className="truncate font-medium">{bill.billName}</span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {bill.billDate === null ? '' : formatDate(bill.billDate)} · {formatMoney(bill.outstanding)}
                      </span>
                      {bill.overdue ? <Badge variant="destructive">Overdue</Badge> : null}
                    </Label>
                  </li>
                ))}
              </ul>
              <FieldDescription>
                {bills.length === 0 ? 'None named: any receipt from this customer counts towards the promise.' : `${String(bills.length)} named, ${formatMoney(namedTotal.toFixed(2))} between them.`}
              </FieldDescription>
            </>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="promise-notes">Notes</FieldLabel>
          <Textarea
            id="promise-notes"
            rows={2}
            placeholder="What they actually said, and who said it"
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
          <FieldDescription>Visible to anyone working the account.</FieldDescription>
        </Field>

        {touched && problem !== null ? <FieldError>{problem}</FieldError> : null}
      </FieldGroup>

      <ResponsiveDialogActions>
        <Button variant="outline" onClick={onCancel}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          <ACTION_ICONS.cancel data-icon="inline-start" />
          Cancel
        </Button>
        <Button disabled={take.isPending} onClick={submit}>
          {take.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
          Record the promise
        </Button>
      </ResponsiveDialogActions>
    </>
  );
}
