import { useState } from 'react';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { DateField } from '@/features/leave/date-field';
import { toDateParam } from '@/features/attendance/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { ON_DUTY_MAX_DAYS } from '@vyuha/shared';

import { useRaiseOnDuty } from './use-regularization';

/**
 * REQ-F-04: "date range + reason + optional client/site name".
 *
 * Unlike a correction, this is raised *ahead* of the days it covers — it is a
 * declaration of field duty, not a repair of something that already went
 * wrong. So there is no backward window, no monthly cap, and no future-date
 * refusal; the only bound is `ON_DUTY_MAX_DAYS`, which exists because approval
 * recomputes every covered day inline.
 */

interface OnDutyFormProps {
  /** False when the session lacks regularization.raise; the form says why. */
  canRaise: boolean;
}

interface FormErrors {
  fromDate?: string;
  toDate?: string;
  reason?: string;
}

function daysBetween(from: Date, to: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY) + 1;
}

export function OnDutyForm({ canRaise }: OnDutyFormProps) {
  const [fromDate, setFromDate] = useState<Date | undefined>(undefined);
  const [toDate, setToDate] = useState<Date | undefined>(undefined);
  const [siteName, setSiteName] = useState('');
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);

  const raise = useRaiseOnDuty();

  const errors: FormErrors = {};
  if (!fromDate) errors.fromDate = 'Choose the first day.';
  if (!toDate) errors.toDate = 'Choose the last day.';
  if (fromDate && toDate) {
    if (toDate.getTime() < fromDate.getTime()) {
      errors.toDate = 'The last day cannot be before the first day.';
    } else if (daysBetween(fromDate, toDate) > ON_DUTY_MAX_DAYS) {
      errors.toDate = `An on-duty request covers at most ${String(ON_DUTY_MAX_DAYS)} days. Raise it in shorter stretches.`;
    }
  }
  if (reason.trim().length < 3) errors.reason = 'Say where you are working and why.';

  const valid = Object.keys(errors).length === 0;
  const covered = fromDate && toDate && !errors.toDate ? daysBetween(fromDate, toDate) : null;

  function reset() {
    setFromDate(undefined);
    setToDate(undefined);
    setSiteName('');
    setReason('');
    setAttempted(false);
  }

  function submit() {
    setAttempted(true);
    if (!valid || !fromDate || !toDate) return;

    raise.mutate(
      {
        fromDate: toDateParam(fromDate),
        toDate: toDateParam(toDate),
        reason: reason.trim(),
        siteName: siteName.trim().length > 0 ? siteName.trim() : null,
      },
      {
        onSuccess: () => {
          toast.add({
            type: 'success',
            title: 'On-duty request raised',
            description: 'It is now waiting for your approver.',
          });
          reset();
        },
        onError: (error) => {
          const copy = actionErrorCopy(error, 'Raise an on-duty request');
          toast.add({ type: 'error', title: copy.title, description: copy.description });
        },
      },
    );
  }

  // PRD §6.4: Ctrl+A accepts from any field in the form. Only one of the two
  // forms on this screen is mounted at a time, so the key is unambiguous.
  useShortcut({
    id: 'on-duty.raise',
    keys: 'ctrl+a',
    label: 'Raise the on-duty request',
    scope: 'screen',
    when: () => canRaise && !raise.isPending,
    run: submit,
  });

  return (
    <Form onSubmit={submit} className="flex flex-col gap-5">
      <FieldGroup className="grid gap-5 sm:grid-cols-2 md:grid-cols-3">
        <Field data-invalid={attempted && errors.fromDate ? true : undefined}>
          <FieldLabel htmlFor="od-from">First day</FieldLabel>
          <DateField
            id="od-from"
            label="First day on duty"
            value={fromDate}
            invalid={attempted && Boolean(errors.fromDate)}
            onValueChange={(next) => {
              setFromDate(next);
              // Moving the start past the end would leave an inverted range on
              // screen; the end follows rather than going red.
              if (next && toDate && toDate.getTime() < next.getTime()) setToDate(next);
            }}
          />
          {attempted ? <FieldError>{errors.fromDate}</FieldError> : null}
        </Field>

        <Field data-invalid={attempted && errors.toDate ? true : undefined}>
          <FieldLabel htmlFor="od-to">Last day</FieldLabel>
          <DateField
            id="od-to"
            label="Last day on duty"
            value={toDate}
            defaultMonth={fromDate}
            invalid={attempted && Boolean(errors.toDate)}
            disabled={fromDate ? { before: fromDate } : undefined}
            onValueChange={setToDate}
          />
          {covered !== null ? (
            <FieldDescription>
              {covered} day{covered === 1 ? '' : 's'}, counted as present once approved.
            </FieldDescription>
          ) : null}
          {attempted ? <FieldError>{errors.toDate}</FieldError> : null}
        </Field>

        <Field>
          <FieldLabel htmlFor="od-site">Client or site</FieldLabel>
          <Input
            id="od-site"
            value={siteName}
            maxLength={160}
            placeholder="Where you are working"
            onChange={(event) => {
              setSiteName(event.target.value);
            }}
          />
          <FieldDescription>Optional, and useful on the approver&apos;s list.</FieldDescription>
        </Field>

        <Field
          className="sm:col-span-2 md:col-span-3"
          data-invalid={attempted && errors.reason ? true : undefined}
        >
          <FieldLabel htmlFor="od-reason">Reason</FieldLabel>
          <Textarea
            id="od-reason"
            value={reason}
            rows={3}
            maxLength={500}
            placeholder="Say what the field duty is for."
            aria-invalid={attempted && Boolean(errors.reason)}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            onKeyDown={(event) => {
              // PRD §6.4: Esc clears the field it is typed in.
              if (event.key === 'Escape' && reason.length > 0) {
                event.preventDefault();
                event.stopPropagation();
                setReason('');
              }
            }}
          />
          {attempted ? <FieldError>{errors.reason}</FieldError> : null}
        </Field>
      </FieldGroup>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!canRaise || raise.isPending}>
          {raise.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <PaperPlaneTiltIcon data-icon="inline-start" />
          )}
          Raise the request
          <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
        </Button>
        <Button type="button" variant="ghost" onClick={reset} disabled={raise.isPending}>
          <ACTION_ICONS.clearFilters data-icon="inline-start" />
          Clear
        </Button>
        {!canRaise ? (
          <span className="text-muted-foreground text-xs">
            Raising a request needs the regularization.raise permission.
          </span>
        ) : null}
      </div>
    </Form>
  );
}
