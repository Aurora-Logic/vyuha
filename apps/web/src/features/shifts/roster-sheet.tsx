import { useState } from 'react';
import { WarningCircleIcon } from '@phosphor-icons/react';
import { addDays } from 'date-fns';
import type { DateRange } from 'react-day-picker';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { toDateParam } from '@/features/attendance/format';
import { DateRangeField } from '@/features/attendance/pickers';
import { useIsMobile } from '@/hooks/use-mobile';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';

import { EmployeePicker } from './employee-picker';
import { rosterErrorCopy } from './roster-error-copy';
import type { RosterCandidate, Shift } from './types';
import { useCreateRosterAssignment, useRosterCandidates } from './use-shifts';

/**
 * One employee on one shift for one date range (REQ-C-04).
 *
 * A sheet rather than a page: four fields is a form, and opening it from the
 * roster keeps the list it is about to change in view behind it. Dates go
 * through `DateRangeField` and never a native date input, on any screen, for
 * any reason (CLAUDE.md section 3).
 */

interface RosterSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shifts: readonly Shift[];
  /** Prefilled from the period the roster list is showing. */
  defaultPeriod: DateRange;
}

export function RosterSheet({ open, onOpenChange, shifts, defaultPeriod }: RosterSheetProps) {
  const isMobile = useIsMobile();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className="gap-0 sm:max-w-lg max-md:max-h-[90vh]"
      >
        {/* Remounted per opening, so the draft starts empty rather than
            holding whatever was abandoned last time. */}
        {open ? (
          <RosterSheetBody
            shifts={shifts}
            defaultPeriod={defaultPeriod}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function RosterSheetBody({
  shifts,
  defaultPeriod,
  onClose,
}: {
  shifts: readonly Shift[];
  defaultPeriod: DateRange;
  onClose: () => void;
}) {
  const [candidateSearch, setCandidateSearch] = useState('');
  const candidates = useRosterCandidates(useDebouncedValue(candidateSearch, 200));
  const create = useCreateRosterAssignment();

  const [employee, setEmployee] = useState<RosterCandidate | null>(null);
  const [shiftId, setShiftId] = useState<string>(shifts[0]?.id ?? '');
  const [period, setPeriod] = useState<DateRange>(() => ({
    from: defaultPeriod.from ?? new Date(),
    to: defaultPeriod.to ?? addDays(defaultPeriod.from ?? new Date(), 6),
  }));
  /** REQ-C-04: an assignment with no end runs until a later one supersedes it. */
  const [openEnded, setOpenEnded] = useState(false);
  const [touched, setTouched] = useState(false);

  const missingEmployee = employee === null;
  const missingShift = shiftId === '';

  function submit() {
    setTouched(true);
    if (missingEmployee || missingShift || !period.from) return;

    create.mutate(
      {
        employeeId: employee.id,
        shiftId,
        from: toDateParam(period.from),
        to: openEnded ? null : toDateParam(period.to ?? period.from),
      },
      {
        onSuccess: (assignment) => {
          toast.add({
            type: 'success',
            title: 'Rostered',
            description: `${assignment.employee.name} is on ${assignment.shift.name} from ${assignment.from}.`,
          });
          onClose();
        },
        // No error toast. The failure is rendered inside the sheet, beside the
        // dates that caused it, rather than in a corner the reader has already
        // looked away from.
      },
    );
  }

  return (
    <ShortcutLayer id="modal:roster-assign">
      <SaveShortcut onSave={submit} />

      <SheetHeader className="shrink-0 border-b">
        <SheetTitle>Assign a shift</SheetTitle>
        <SheetDescription>
          One employee, one shift, one range. Overlapping ranges are refused, so end the current
          assignment before starting another.
        </SheetDescription>
      </SheetHeader>

      <Form onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto p-4">
        <FieldGroup>
          {create.isError ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>{rosterErrorCopy(create.error).title}</AlertTitle>
              <AlertDescription>{rosterErrorCopy(create.error).description}</AlertDescription>
            </Alert>
          ) : null}

          {candidates.isError ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>Could not load the employee register</AlertTitle>
              <AlertDescription>
                Without it there is nobody to roster. Close this and try again.
              </AlertDescription>
            </Alert>
          ) : null}

          <Field>
            <FieldLabel>Employee</FieldLabel>
            <EmployeePicker
              label="Employee"
              value={employee}
              onValueChange={setEmployee}
              candidates={candidates.data ?? []}
              search={candidateSearch}
              onSearchChange={setCandidateSearch}
              loading={candidates.isPending}
            />
            {touched && missingEmployee ? (
              <FieldDescription>Choose who this assignment is for.</FieldDescription>
            ) : null}
          </Field>

          <Field>
            <FieldLabel>Shift</FieldLabel>
            <Select
              value={shiftId === '' ? null : shiftId}
              onValueChange={(next: string | null) => {
                if (next !== null) setShiftId(next);
              }}
            >
              <SelectTrigger aria-label="Shift" className="w-full">
                <SelectValue>
                  {(value: string) => {
                    const shift = shifts.find((row) => row.id === value);
                    return shift
                      ? `${shift.name} · ${shift.scheduledIn}–${shift.scheduledOut}`
                      : 'Choose a shift';
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {shifts.map((shift) => (
                    <SelectItem key={shift.id} value={shift.id}>
                      {shift.name} · {shift.scheduledIn}–{shift.scheduledOut}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {shifts.length === 0 ? (
              <FieldDescription>
                There are no shifts yet. Create one on the Shifts tab first.
              </FieldDescription>
            ) : null}
          </Field>

          <Field>
            <FieldLabel>Period</FieldLabel>
            <DateRangeField
              value={period}
              onValueChange={setPeriod}
              label="Assignment period"
              className="w-full"
            />
          </Field>

          <Field orientation="horizontal">
            <FieldLabel htmlFor="roster-open-ended">Open-ended</FieldLabel>
            <Switch id="roster-open-ended" checked={openEnded} onCheckedChange={setOpenEnded} />
          </Field>
          <FieldDescription>
            An open-ended assignment has no end date and runs until a later one supersedes it. The
            end date above is ignored while this is on.
          </FieldDescription>
        </FieldGroup>
      </Form>

      <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t">
        <Button variant="outline" className="flex-1 sm:flex-none" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          Cancel
        </Button>
        <Button className="flex-1 sm:flex-none" disabled={create.isPending} onClick={submit}>
          {create.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <ACTION_ICONS.save data-icon="inline-start" />
          )}
          {create.isPending ? 'Assigning' : 'Assign'}
          <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
        </Button>
      </SheetFooter>
    </ShortcutLayer>
  );
}

/**
 * Separate so the registration lands inside the layer the sheet pushes.
 * `ShortcutLayer` provides that layer through context, and a hook called in
 * the same component that renders the provider would register underneath it.
 */
function SaveShortcut({ onSave }: { onSave: () => void }) {
  useShortcut({
    id: 'roster-sheet.save',
    keys: 'ctrl+a',
    label: 'Accept / Save',
    scope: 'modal',
    // PRD section 6.4: Ctrl+A saves from any field, so it fires inside inputs.
    allowInInput: true,
    run: onSave,
  });
  return null;
}
