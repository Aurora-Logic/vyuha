import { useState } from 'react';
import { PaperPlaneTiltIcon, WarningCircleIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { DateField } from '@/features/leave/date-field';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { TimeField } from '@/features/attendance/pickers';
import { toDateParam } from '@/features/attendance/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { formatDate } from '@/lib/format';
import {
  REGULARIZATION_KINDS,
  REGULARIZATION_KIND_HELP,
  REGULARIZATION_KIND_LABELS,
  REGULARIZATION_KIND_TIMES,
  type RegularizationKind,
  type RegularizationPolicyView,
} from '@vyuha/shared';

import { useRaiseRegularization } from './use-regularization';

/**
 * REQ-F-01: correct a day that went wrong.
 *
 * Two things shape this form.
 *
 * **The kind decides which times are asked for.** `REGULARIZATION_KIND_TIMES`
 * in the shared package is the single table for that: this form enables its
 * fields from it, the schema refines against it, and the server refuses against
 * the same schema. Three copies of "a missing OUT does not move the IN" would
 * be three chances to disagree, and the one that matters is the server's.
 *
 * **The calendar is bounded by the settings, not by a constant.** REQ-F-02's
 * window and monthly cap are org settings; the policy endpoint sends both plus
 * how much of the month is spent, so the picker can refuse the dates the server
 * would refuse rather than letting somebody choose one and be told after.
 */

interface RegularizationFormProps {
  policy: RegularizationPolicyView | null;
  policyPending: boolean;
  /** False when the session lacks regularization.raise; the form says why. */
  canRaise: boolean;
  /** Pre-selected when arriving from a day on My Attendance. */
  initialDate?: string | undefined;
  initialKind?: RegularizationKind | undefined;
}

interface FormErrors {
  date?: string;
  requestedIn?: string;
  requestedOut?: string;
  reason?: string;
}

/** `YYYY-MM-DD` as a Date at local midnight; never `new Date(value)`. */
function fromParam(value: string): Date {
  const [year = '1970', month = '01', day = '01'] = value.split('-');
  return new Date(Number(year), Number(month) - 1, Number(day));
}

export function RegularizationForm({
  policy,
  policyPending,
  canRaise,
  initialDate,
  initialKind,
}: RegularizationFormProps) {
  const [kind, setKind] = useState<RegularizationKind>(initialKind ?? 'MISSING_OUT');
  const [date, setDate] = useState<Date | undefined>(
    initialDate === undefined ? undefined : fromParam(initialDate),
  );
  const [requestedIn, setRequestedIn] = useState('09:00');
  const [requestedOut, setRequestedOut] = useState('18:00');
  const [reason, setReason] = useState('');
  // Errors appear after the first attempt rather than while somebody is still
  // filling the form in; a field that is red before it has been touched reads
  // as a broken form.
  const [attempted, setAttempted] = useState(false);

  // Arriving from a *different* day on My Attendance has to move the form, not
  // just the URL. That reset is done by the caller re-keying this component on
  // the two values rather than by an effect that writes state — an effect
  // would also fire on the first render, and would fight a manual edit made
  // after arriving.

  const rules = REGULARIZATION_KIND_TIMES[kind];
  const wantsIn = rules.in !== 'forbidden';
  const wantsOut = rules.out !== 'forbidden';

  const raise = useRaiseRegularization();
  const exhausted = policy !== null && policy.remainingThisMonth <= 0;

  const errors: FormErrors = {};
  if (!date) errors.date = 'Choose the day to correct.';
  else if (policy) {
    const chosen = toDateParam(date);
    if (chosen > policy.today) errors.date = 'That day has not been worked yet.';
    else if (chosen < policy.earliestDate) {
      errors.date = `Corrections go back to ${formatDate(policy.earliestDate)}.`;
    }
  }
  if (reason.trim().length < 3) errors.reason = 'Say what happened, in a few words at least.';

  const valid = Object.keys(errors).length === 0;

  function reset() {
    setDate(undefined);
    setReason('');
    setAttempted(false);
  }

  function submit() {
    setAttempted(true);
    if (!valid || !date) return;

    raise.mutate(
      {
        date: toDateParam(date),
        kind,
        // The kind decides which half travels. Sending the other one is a 400
        // from the shared schema, and it would move a punch nobody mentioned.
        requestedIn: wantsIn ? requestedIn : null,
        requestedOut: wantsOut ? requestedOut : null,
        reason: reason.trim(),
        // No upload endpoint exists, so sending null is the honest thing;
        // nothing the reader chose is discarded.
        attachmentFileId: null,
      },
      {
        onSuccess: () => {
          // PRD §6.6: the toast repeats the action the button named.
          toast.add({
            type: 'success',
            title: 'Correction raised',
            description: 'It is now waiting for your approver.',
          });
          reset();
        },
        onError: (error) => {
          const copy = actionErrorCopy(error, 'Raise a correction');
          toast.add({ type: 'error', title: copy.title, description: copy.description });
        },
      },
    );
  }

  // PRD §6.4: Ctrl+A accepts from any field in the form.
  useShortcut({
    id: 'regularizations.raise',
    keys: 'ctrl+a',
    label: 'Raise the correction',
    scope: 'screen',
    when: () => canRaise && !raise.isPending && !exhausted,
    run: submit,
  });

  if (policyPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the correction limits"
        className="flex flex-col gap-5"
      >
        <div className="grid gap-5 sm:grid-cols-2 md:grid-cols-3">
          {['kind', 'date', 'time'].map((key) => (
            <div key={key} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="pointer-coarse:h-11 h-8 w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="pointer-coarse:h-11 h-8 w-40" />
      </div>
    );
  }

  return (
    <Form onSubmit={submit} className="flex flex-col gap-5">
      {/*
        A grid rather than a stack, for the reason the leave form gives:
        stacked, every control takes a row of its own and the form runs tall
        while width sits empty beside it. One column at 360px, where a pair of
        side-by-side time buttons would each be 150px and truncate.
      */}
      <FieldGroup className="grid gap-5 sm:grid-cols-2 md:grid-cols-3">
        <Field className="sm:col-span-2 md:col-span-1">
          <FieldLabel htmlFor="reg-kind">What went wrong</FieldLabel>
          <Select
            value={kind}
            onValueChange={(next: string | null) => {
              if (next !== null) setKind(next as RegularizationKind);
            }}
          >
            <SelectTrigger id="reg-kind" className="w-full">
              <SelectValue>
                {(value: string | null) =>
                  value === null
                    ? 'Choose what happened'
                    : REGULARIZATION_KIND_LABELS[value as RegularizationKind]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {REGULARIZATION_KINDS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {REGULARIZATION_KIND_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>{REGULARIZATION_KIND_HELP[kind]}</FieldDescription>
        </Field>

        <Field data-invalid={attempted && errors.date ? true : undefined}>
          <FieldLabel htmlFor="reg-date">Day to correct</FieldLabel>
          <DateField
            id="reg-date"
            label="Day to correct"
            value={date}
            invalid={attempted && Boolean(errors.date)}
            // The picker refuses what the server would refuse, so nobody
            // chooses a date and is told about it afterwards (REQ-F-02).
            disabled={
              policy
                ? { before: fromParam(policy.earliestDate), after: fromParam(policy.today) }
                : undefined
            }
            onValueChange={setDate}
          />
          {policy ? (
            <FieldDescription>
              Back to {formatDate(policy.earliestDate)}, which is{' '}
              {policy.windowDays} day{policy.windowDays === 1 ? '' : 's'} including today.
            </FieldDescription>
          ) : null}
          {attempted ? <FieldError>{errors.date}</FieldError> : null}
        </Field>

        {/* Both fields are rendered whenever the kind wants them, and simply
            absent otherwise. A disabled control that never becomes enabled is
            noise; the help text above already said which times this kind
            asks for. */}
        {wantsIn ? (
          <Field>
            <FieldLabel htmlFor="reg-in">Time you arrived</FieldLabel>
            <TimeField
              id="reg-in"
              label="Time you arrived"
              value={requestedIn}
              onValueChange={setRequestedIn}
            />
            {rules.in === 'optional' ? (
              <FieldDescription>Leave it as it is if the in punch was right.</FieldDescription>
            ) : null}
          </Field>
        ) : null}

        {wantsOut ? (
          <Field>
            <FieldLabel htmlFor="reg-out">Time you left</FieldLabel>
            <TimeField
              id="reg-out"
              label="Time you left"
              value={requestedOut}
              onValueChange={setRequestedOut}
            />
            {rules.out === 'optional' ? (
              <FieldDescription>Leave it as it is if the out punch was right.</FieldDescription>
            ) : null}
          </Field>
        ) : null}

        <Field
          className="sm:col-span-2 md:col-span-3"
          data-invalid={attempted && errors.reason ? true : undefined}
        >
          <FieldLabel htmlFor="reg-reason">Reason</FieldLabel>
          <Textarea
            id="reg-reason"
            value={reason}
            rows={3}
            maxLength={500}
            placeholder="Say what happened. Your approver reads this and nothing else."
            aria-invalid={attempted && Boolean(errors.reason)}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            onKeyDown={(event) => {
              // PRD §6.4: Esc clears the field it is typed in, and only stops
              // there when it had something to clear.
              if (event.key === 'Escape' && reason.length > 0) {
                event.preventDefault();
                event.stopPropagation();
                setReason('');
              }
            }}
          />
          <FieldDescription>Required. A correction with no reason cannot be judged.</FieldDescription>
          {attempted ? <FieldError>{errors.reason}</FieldError> : null}
        </Field>

        <Field className="sm:col-span-2 md:col-span-3" data-disabled>
          <FieldLabel htmlFor="reg-attachment">Attachment</FieldLabel>
          <Input id="reg-attachment" type="file" disabled />
          <FieldDescription>
            Optional under REQ-F-01, and not available yet: there is no file upload endpoint on the
            server, so an attachment chosen here could not be sent. The rest submits without one.
          </FieldDescription>
        </Field>
      </FieldGroup>

      {/* The allowance, stated before the button rather than after a refusal.
          One border, directly on the page surface — no card inside a card. */}
      {policy ? (
        <p
          aria-live="polite"
          className={
            exhausted
              ? 'text-destructive flex items-start gap-2 border p-3 text-xs'
              : 'text-muted-foreground border p-3 text-xs'
          }
        >
          {exhausted ? <WarningCircleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : null}
          <span>
            {policy.maxPerMonth === 0
              ? 'Corrections are switched off for this organisation.'
              : exhausted
                ? `You have used all ${String(policy.maxPerMonth)} corrections this month. The next one can be raised next month.`
                : `${String(policy.remainingThisMonth)} of ${String(policy.maxPerMonth)} corrections left this month.`}
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!canRaise || raise.isPending || exhausted}>
          {raise.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <PaperPlaneTiltIcon data-icon="inline-start" />
          )}
          Raise the correction
          <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
        </Button>
        <Button type="button" variant="ghost" onClick={reset} disabled={raise.isPending}>
          <ACTION_ICONS.clearFilters data-icon="inline-start" />
          Clear
        </Button>
        {!canRaise ? (
          <span className="text-muted-foreground text-xs">
            Raising a correction needs the regularization.raise permission.
          </span>
        ) : null}
      </div>
    </Form>
  );
}
