import { useState } from 'react';

import { useDebouncedValue } from '@/lib/use-debounced-value';
import { CheckCircleIcon, GiftIcon, WarningCircleIcon } from '@phosphor-icons/react';

import { Form } from '@/components/shared/form';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
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
import { toDateParam } from '@/features/attendance/format';
import { useEmployees } from '@/features/employees/use-employees';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatDate } from '@/lib/format';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';

import { actionErrorCopy } from './api-error-copy';
import { DateField } from './date-field';
import { formatDays } from './leave-days';
import { useGrantCompOff } from './use-team-leave';

/**
 * REQ-G-11's write side: "HR or an approver grants comp-off credits against a
 * specific worked holiday/weekly-off date."
 *
 * A credit is minted against a *date somebody worked*, so the date is the
 * subject of this form and not a detail of it. The expiry is derived by the
 * server from the organisation's window and is shown rather than asked for —
 * the endpoint accepts an override, and offering one here would invite a
 * per-credit expiry policy that nobody could then explain to the employee.
 *
 * Half a day is the only fraction the contract allows (`0.5 | 1`), so the
 * control is two options rather than a number field that can hold 0.3.
 */

const DAY_OPTIONS = [
  { value: '1', label: 'Full day' },
  { value: '0.5', label: 'Half day' },
] as const;

interface CompOffGrantSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fills the date when the sheet is opened from a day on the calendar. */
  defaultDate?: Date;
}

export function CompOffGrantSheet({ open, onOpenChange, defaultDate }: CompOffGrantSheetProps) {
  const isMobile = useIsMobile();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className="gap-0 sm:max-w-lg max-md:max-h-[92vh]"
      >
        {open ? (
          <CompOffGrantBody
            defaultDate={defaultDate}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function CompOffGrantBody({ defaultDate, onClose }: { defaultDate?: Date; onClose: () => void }) {
  const [employee, setEmployee] = useState<PickerOption | null>(null);
  const [earnedFor, setEarnedFor] = useState<Date | undefined>(defaultDate);
  const [days, setDays] = useState<'1' | '0.5'>('1');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const grant = useGrantCompOff();
  // The picker needs the register. An approver who does not also hold
  // employee.view gets an empty list and a stated reason rather than a control
  // that silently never fills.
  // Typed at the server: this read 200 people once and filtered them here, so
  // on a larger register the rest could not be granted a comp-off at all.
  const [employeeSearch, setEmployeeSearch] = useState('');
  const debouncedEmployee = useDebouncedValue(employeeSearch, 200).trim();
  const employeesQuery = useEmployees({
    page: 1,
    pageSize: 25,
    q: debouncedEmployee,
    status: 'ACTIVE',
    departmentId: null,
  });
  const options: PickerOption[] = (employeesQuery.data?.data ?? []).map((row) => ({
    id: row.id,
    label: [row.firstName, row.lastName].filter(Boolean).join(' '),
    hint: row.employeeCode,
  }));

  const ready = employee !== null && earnedFor !== undefined;

  function submit() {
    if (!ready || grant.isPending) return;
    setSubmitted(true);
    grant.mutate(
      {
        employeeId: employee.id,
        earnedForDate: toDateParam(earnedFor),
        days: days === '1' ? 1 : 0.5,
        note: note.trim().length > 0 ? note.trim() : null,
      },
      {
        onSuccess: (credit) => {
          toast.add({
            type: 'success',
            title: 'Comp-off granted',
            description: `${formatDays(credit.days)} for ${employee.label}, expiring ${formatDate(credit.expiresOn)}.`,
          });
          onClose();
        },
      },
    );
  }

  // PRD §6.4: Ctrl+A accepts from any field in a form.
  useShortcut({
    id: 'comp-off-grant.save',
    keys: 'ctrl+a',
    label: 'Grant the credit',
    scope: 'modal',
    allowInInput: true,
    when: () => ready && !grant.isPending,
    run: submit,
  });

  const copy = actionErrorCopy(grant.error, 'The comp-off grant');

  return (
    <ShortcutLayer id="modal:comp-off-grant">
      <SheetHeader className="shrink-0 border-b">
        <SheetTitle>Grant comp-off</SheetTitle>
        <SheetDescription>
          Against a holiday or weekly off this person actually worked. The credit lands on their
          Compensatory Off balance and expires on the date the organisation&apos;s window sets.
        </SheetDescription>
      </SheetHeader>

      <Form onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto p-4">
        <FieldGroup>
          {grant.isError ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>{copy.title}</AlertTitle>
              <AlertDescription>{copy.description} Nothing was credited.</AlertDescription>
            </Alert>
          ) : null}

          {employeesQuery.isError ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>The employee list could not be read</AlertTitle>
              <AlertDescription>
                Granting a credit means naming a person, which needs the employee.view permission.
                Ask an administrator to grant it.
              </AlertDescription>
            </Alert>
          ) : null}

          <Field>
            <FieldLabel htmlFor="comp-off-employee">Employee</FieldLabel>
            <RecordPicker
              id="comp-off-employee"
              label="Employee"
              placeholder="Choose an employee"
              searchPlaceholder="Search by name or code"
              emptyMessage="No employee matches that."
              loading={employeesQuery.isPending}
              options={employee && !options.some((row) => row.id === employee.id) ? [employee, ...options] : options}
              value={employee}
              search={employeeSearch}
              onSearchChange={setEmployeeSearch}
              onValueChange={setEmployee}
            />
            <FieldDescription>
              Only active employees are listed. A credit is granted to one person at a time, because
              the worked date is theirs.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="comp-off-date">Worked date</FieldLabel>
            <DateField
              id="comp-off-date"
              label="Worked date"
              value={earnedFor}
              onValueChange={setEarnedFor}
              defaultMonth={defaultDate}
              placeholder="Choose the date worked"
              invalid={submitted && earnedFor === undefined}
            />
            <FieldDescription>
              The holiday or weekly off that was worked. One credit per date per person; a second
              grant for the same date is refused.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>How much was worked</FieldLabel>
            <ToggleGroup
              variant="outline"
              className="w-full"
              value={[days]}
              onValueChange={(value) => {
                // Base UI hands back an empty array when the pressed item is
                // pressed again. There is no "neither", so the deselect is
                // ignored — the same rule the punch screen's half-day control
                // follows.
                const next = value[0];
                if (next === '1' || next === '0.5') setDays(next);
              }}
            >
              {DAY_OPTIONS.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value} className="min-h-11 flex-1">
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>
              A worked holiday is a day or a half day. Nothing smaller is grantable.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="comp-off-note">Note</FieldLabel>
            <Textarea
              id="comp-off-note"
              rows={2}
              value={note}
              placeholder="Why this credit was granted"
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
            <FieldDescription>
              Optional, and worth writing: it is stored on the ledger row beside the credit, so it
              is what explains the days months later.
            </FieldDescription>
          </Field>

          {ready ? (
            <Alert>
              <CheckCircleIcon />
              <AlertTitle>
                {formatDays(days === '1' ? 1 : 0.5)} for {employee.label}
              </AlertTitle>
              <AlertDescription>
                Earned for {formatDate(toDateParam(earnedFor))}. The expiry is set by the
                organisation&apos;s comp-off window and is shown on the employee&apos;s own screen
                once granted.
              </AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
      </Form>

      <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t">
        <Button variant="outline" className="flex-1 sm:flex-none" onClick={onClose}>
          Cancel
        </Button>
        <Button className="flex-1 sm:flex-none" disabled={!ready || grant.isPending} onClick={submit}>
          {grant.isPending ? <Spinner data-icon="inline-start" /> : <GiftIcon data-icon="inline-start" />}
          Grant credit
          <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
        </Button>
      </SheetFooter>
    </ShortcutLayer>
  );
}
