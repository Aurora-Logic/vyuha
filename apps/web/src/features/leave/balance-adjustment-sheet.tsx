import { useState } from 'react';

import { useDebouncedValue } from '@/lib/use-debounced-value';
import { ScalesIcon, SealWarningIcon, WarningCircleIcon } from '@phosphor-icons/react';

import { Form } from '@/components/shared/form';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { SectionHeading } from '@/components/shared/section-heading';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { toast } from '@/components/ui/toast';
import { useEmployees } from '@/features/employees/use-employees';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatDate } from '@/lib/format';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';

import { actionErrorCopy } from './api-error-copy';
import {
  ADJUSTMENT_PROBLEM_LABELS,
  adjustmentProblems,
  projectedClosing,
  signedDays,
  type AdjustmentDirection,
  type AdjustmentDraft,
} from './balance-adjustment';
import { formatDays } from './leave-days';
import {
  useAdjustBalance,
  useAdjustmentLedger,
  useEmployeeBalances,
} from './use-balance-adjustment';
import { useLeaveTypes } from './use-leave';

/**
 * `POST /leave/balances/adjust` (REQ-G-03), which had no surface at all.
 *
 * It is on the launch critical path — a pilot cannot start without opening
 * balances loaded — and it is also the most dangerous control in the leave
 * area, because the ledger it writes to is append-only in the database itself:
 * a DELETE against `leave_ledger` raises "Table leave_ledger is append-only".
 * A wrong row is corrected by writing an opposite one, never by removal.
 *
 * So the sheet is built to read as a correction rather than as a grant. The
 * warning is the first thing in it, the reason is mandatory and its
 * description says why (it is the only account of the movement — an accrual
 * points at a period and an availed at a request, this points only at whoever
 * typed it), and the existing corrections for the same person are listed
 * underneath, because the most common mistake with this control is making the
 * same correction twice.
 *
 * Direction is two labelled buttons rather than a minus sign somebody types. A
 * "-5" and a "5" look almost identical in a narrow field and mean opposite
 * things to a person's leave.
 */

const DIRECTIONS: readonly { value: AdjustmentDirection; label: string }[] = [
  { value: 'ADD', label: 'Add days' },
  { value: 'REMOVE', label: 'Remove days' },
];

const LEAVE_YEAR_START_MONTH = 3; // April, zero-based.

function currentLeaveYear(): number {
  const now = new Date();
  return now.getMonth() >= LEAVE_YEAR_START_MONTH ? now.getFullYear() : now.getFullYear() - 1;
}

interface BalanceAdjustmentSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BalanceAdjustmentSheet({ open, onOpenChange }: BalanceAdjustmentSheetProps) {
  const isMobile = useIsMobile();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className="gap-0 sm:max-w-xl max-md:max-h-[92vh]"
      >
        {open ? (
          <AdjustmentBody
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function AdjustmentBody({ onClose }: { onClose: () => void }) {
  const thisYear = currentLeaveYear();
  const [employee, setEmployee] = useState<PickerOption | null>(null);
  const [leaveType, setLeaveType] = useState<PickerOption | null>(null);
  const [year, setYear] = useState(thisYear);
  const [direction, setDirection] = useState<AdjustmentDirection>('ADD');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const adjust = useAdjustBalance();
  // Typed at the server: this read 200 people once and filtered them here, so
  // on a larger register the rest could not have a balance corrected at all.
  const [employeeSearch, setEmployeeSearch] = useState('');
  const debouncedEmployee = useDebouncedValue(employeeSearch, 200).trim();
  const employeesQuery = useEmployees({
    page: 1,
    pageSize: 25,
    q: debouncedEmployee,
    status: 'ACTIVE',
    departmentId: null,
  });
  const typesQuery = useLeaveTypes();
  const balancesQuery = useEmployeeBalances(employee?.id ?? null, year);
  const ledgerQuery = useAdjustmentLedger(employee?.id ?? null, year);

  const draft: AdjustmentDraft = {
    employeeId: employee?.id ?? null,
    leaveTypeId: leaveType?.id ?? null,
    direction,
    amount,
    reason,
  };
  const problems = adjustmentProblems(draft);
  const days = signedDays(draft);

  const employeeOptions: PickerOption[] = (employeesQuery.data?.data ?? []).map((row) => ({
    id: row.id,
    label: [row.firstName, row.lastName].filter(Boolean).join(' '),
    hint: row.employeeCode,
  }));
  const typeOptions: PickerOption[] = (typesQuery.data?.data ?? []).map((row) => ({
    id: row.id,
    label: row.name,
    hint: row.code,
  }));

  const current = (balancesQuery.data?.data ?? []).find(
    (balance) => balance.leaveType.id === leaveType?.id,
  );
  const adjustments = ledgerQuery.data?.data ?? [];

  function submit() {
    setSubmitted(true);
    if (problems.length > 0 || days === null || adjust.isPending) return;
    if (employee === null || leaveType === null) return;

    adjust.mutate(
      { employeeId: employee.id, leaveTypeId: leaveType.id, year, days, reason: reason.trim() },
      {
        onSuccess: (balance) => {
          toast.add({
            type: 'success',
            title: 'Balance corrected',
            description: `${employee.label}, ${balance.leaveType.name} ${String(year)}: closing balance is now ${formatDays(balance.closing)}.`,
          });
          onClose();
        },
      },
    );
  }

  // PRD §6.4: Ctrl+A accepts from any field in a form.
  useShortcut({
    id: 'balance-adjustment.save',
    keys: 'ctrl+a',
    label: 'Post the correction',
    scope: 'modal',
    allowInInput: true,
    when: () => problems.length === 0 && !adjust.isPending,
    run: submit,
  });

  const copy = actionErrorCopy(adjust.error, 'The correction');
  const years = [thisYear - 2, thisYear - 1, thisYear, thisYear + 1];

  return (
    <ShortcutLayer id="modal:balance-adjustment">
      <SheetHeader className="shrink-0 border-b">
        <SheetTitle>Correct a leave balance</SheetTitle>
        <SheetDescription>
          For opening balances and for putting right a number that is wrong. This is not how leave
          is granted or taken — those movements come from the accrual job and from applications.
        </SheetDescription>
      </SheetHeader>

      <Form onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto p-4">
        <FieldGroup>
          {/* First, before any field: what this control actually does. */}
          <Alert variant="destructive">
            <SealWarningIcon />
            <AlertTitle>A correction cannot be taken back</AlertTitle>
            <AlertDescription>
              It writes a row to the leave ledger, which is append-only — the database refuses to
              delete from it. A mistake is put right by posting the opposite correction, and both
              rows stay on the record for good. The reason you write is the only account of why the
              number moved.
            </AlertDescription>
          </Alert>

          {adjust.isError ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>{copy.title}</AlertTitle>
              <AlertDescription>{copy.description} Nothing was written.</AlertDescription>
            </Alert>
          ) : null}

          {employeesQuery.isError || typesQuery.isError ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>The pickers could not be filled</AlertTitle>
              <AlertDescription>
                Correcting a balance means naming a person and a leave type. This needs the
                employee.view and leave.policy.manage permissions.
              </AlertDescription>
            </Alert>
          ) : null}

          <Field>
            <FieldLabel htmlFor="adjust-employee">Employee</FieldLabel>
            <RecordPicker
              id="adjust-employee"
              label="Employee"
              placeholder="Choose an employee"
              searchPlaceholder="Search by name or code"
              emptyMessage="No employee matches that."
              loading={employeesQuery.isPending}
              options={
                employee && !employeeOptions.some((row) => row.id === employee.id)
                  ? [employee, ...employeeOptions]
                  : employeeOptions
              }
              value={employee}
              search={employeeSearch}
              onSearchChange={setEmployeeSearch}
              onValueChange={setEmployee}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="adjust-type">Leave type</FieldLabel>
            <RecordPicker
              id="adjust-type"
              label="Leave type"
              placeholder="Choose a leave type"
              searchPlaceholder="Search by name or code"
              emptyMessage="No leave type matches that."
              loading={typesQuery.isPending}
              options={typeOptions}
              value={leaveType}
              onValueChange={setLeaveType}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="adjust-year">Leave year</FieldLabel>
            <Select
              value={String(year)}
              onValueChange={(next: string | null) => {
                if (next !== null) setYear(Number(next));
              }}
            >
              <SelectTrigger id="adjust-year" aria-label="Leave year" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {years.map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {String(value)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              Named by the calendar year the leave year opens in. The year starts in April
, so a correction dated February belongs to the year before.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Direction</FieldLabel>
            <ToggleGroup
              variant="outline"
              className="w-full"
              value={[direction]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === 'ADD' || next === 'REMOVE') setDirection(next);
              }}
            >
              {DIRECTIONS.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value} className="min-h-11 flex-1">
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <Field>
            <FieldLabel htmlFor="adjust-amount">Days</FieldLabel>
            <Input
              id="adjust-amount"
              type="number"
              inputMode="decimal"
              min={0}
              step={0.5}
              value={amount}
              placeholder="0"
              aria-invalid={submitted && problems.some((p) => p.startsWith('AMOUNT'))}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
            <FieldDescription>
              Always a positive number; the direction above decides whether it is added or removed.
              Half days are allowed.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="adjust-reason">Reason</FieldLabel>
            <Textarea
              id="adjust-reason"
              rows={3}
              value={reason}
              placeholder="Opening balance carried in from the previous system"
              aria-invalid={submitted && problems.includes('REASON_TOO_SHORT')}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <FieldDescription>
              Required. Every other ledger movement points at its cause — an accrual at a period, an
              availed at a request. This one points only at you, so the sentence you write is the
              whole explanation somebody finds months later.
            </FieldDescription>
          </Field>

          {submitted && problems.length > 0 ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>This correction cannot be posted yet</AlertTitle>
              <AlertDescription>
                <ul className="flex flex-col gap-0.5">
                  {problems.map((problem) => (
                    <li key={problem}>{ADJUSTMENT_PROBLEM_LABELS[problem]}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {current !== undefined && days !== null ? (
            <Alert>
              <ScalesIcon />
              <AlertTitle>
                {formatDays(current.closing)} becomes {formatDays(projectedClosing(current, days))}
              </AlertTitle>
              <AlertDescription>
                {employee?.label}, {current.leaveType.name} {String(year)}. Opening{' '}
                {String(current.opening)}, accrued {String(current.accrued)}, availed{' '}
                {String(current.availed)}, adjusted {String(current.adjusted)}.
              </AlertDescription>
            </Alert>
          ) : null}

          {employee !== null && balancesQuery.isSuccess && current === undefined && leaveType !== null ? (
            <Alert>
              <ScalesIcon />
              <AlertTitle>No balance row exists yet for this type and year</AlertTitle>
              <AlertDescription>
                That is normal for an opening balance. The correction creates the row, and the
                closing balance will be exactly what you post here.
              </AlertDescription>
            </Alert>
          ) : null}

          {adjustments.length > 0 ? (
            <>
              <Separator />
              <div className="flex flex-col gap-2">
                <SectionHeading
                  title="Corrections already posted"
                  note="For this person and this leave year. Posting the same correction twice is the usual mistake."
                />
                <ul className="flex flex-col divide-y border">
                  {adjustments.map((entry) => (
                    <li key={entry.id} className="flex flex-col gap-0.5 px-3 py-2">
                      <span className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="font-medium">{entry.leaveType.name}</span>
                        <span className="tabular-nums">
                          {entry.days > 0 ? '+' : ''}
                          {String(entry.days)}
                        </span>
                      </span>
                      <span className="text-muted-foreground text-[0.6875rem]">
                        {formatDate(entry.createdAt.slice(0, 10))} · {entry.note ?? 'No reason recorded'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : null}
        </FieldGroup>
      </Form>

      <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t">
        <Button variant="outline" className="flex-1 sm:flex-none" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          className="flex-1 sm:flex-none"
          disabled={adjust.isPending}
          onClick={submit}
        >
          {adjust.isPending ? <Spinner data-icon="inline-start" /> : <ScalesIcon data-icon="inline-start" />}
          Post the correction
          <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
        </Button>
      </SheetFooter>
    </ShortcutLayer>
  );
}
