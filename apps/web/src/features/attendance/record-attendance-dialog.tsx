import { useState } from 'react';
import { UserGearIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { adminPunchSchema, PUNCH_TYPES, type PunchType } from '@vyuha/shared';

import { Form } from '@/components/shared/form';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { toast } from '@/components/ui/toast';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { EmployeePicker } from '@/features/shifts/employee-picker';
import { type RosterCandidate } from '@/features/shifts/types';
import { useRosterCandidates } from '@/features/shifts/use-shifts';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { apiRequest } from '@/lib/api/client';
import { ShortcutLayer } from '@/lib/keyboard/registry';

import { DateField, TimeField } from './pickers';

/**
 * Owner, 21 Aug 2026: an admin records an IN or OUT for an employee, or for
 * themselves, from Approvals. The entry is a separate event beside the
 * employee's own punches - it never replaces one - and needs a reason, which
 * is what the day record and the audit log will show.
 */

const MIN_REASON = 10;

function toInstant(date: Date, clock: string): string {
  const [hours = '0', minutes = '0'] = clock.split(':');
  const at = new Date(date);
  at.setHours(Number(hours), Number(minutes), 0, 0);
  return at.toISOString();
}

export function RecordAttendanceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? <RecordAttendanceForm onClose={() => { onOpenChange(false); }} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RecordAttendanceForm({ onClose }: { onClose: () => void }) {
  const [candidateSearch, setCandidateSearch] = useState('');
  const candidates = useRosterCandidates(useDebouncedValue(candidateSearch, 200));
  const queryClient = useQueryClient();
  const [employee, setEmployee] = useState<RosterCandidate | null>(null);
  const [type, setType] = useState<PunchType>('IN');
  const [date, setDate] = useState<Date>(() => new Date());
  const [clock, setClock] = useState(() => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(Math.floor(now.getMinutes() / 5) * 5).padStart(2, '0')}`;
  });
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);

  const record = useMutation({
    mutationFn: async (body: unknown) => {
      await apiRequest<unknown>('/punches/admin', { method: 'POST', body: adminPunchSchema.parse(body) });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
      void queryClient.invalidateQueries({ queryKey: ['punches'] });
    },
  });

  const reasonShort = reason.trim().length < MIN_REASON;
  const missingEmployee = employee === null;

  function submit() {
    setAttempted(true);
    if (missingEmployee || reasonShort || record.isPending) return;
    record.mutate(
      { employeeId: employee.id, type, at: toInstant(date, clock), reason: reason.trim() },
      {
        onSuccess: () => {
          toast.add({ type: 'success', title: `${type === 'IN' ? 'Punch in' : 'Punch out'} recorded for ${employee.name}` });
          onClose();
        },
        onError: (error: Error) => {
          const copy = actionErrorCopy(error, 'Record attendance');
          toast.add({ type: 'error', title: copy.title, description: copy.description });
        },
      },
    );
  }

  return (
    <ShortcutLayer id="modal:record-attendance">
      <DialogHeader>
        <DialogTitle>Record attendance</DialogTitle>
        <DialogDescription>
          An IN or OUT recorded by you, beside the employee's own punches. It never replaces one, and it is labelled as yours.
        </DialogDescription>
      </DialogHeader>

      <Form onSubmit={submit} className="flex flex-col gap-4">
        <Field data-invalid={attempted && missingEmployee ? true : undefined}>
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
          {attempted && missingEmployee ? <FieldError>Pick who this is for.</FieldError> : null}
        </Field>

        <Field>
          <FieldLabel>Event</FieldLabel>
          <ToggleGroup
            value={[type]}
            onValueChange={(next: string[]) => {
              const [first] = next;
              if (first === 'IN' || first === 'OUT') setType(first);
            }}
            variant="outline"
            className="w-full"
          >
            {PUNCH_TYPES.map((candidate) => (
              <ToggleGroupItem key={candidate} value={candidate} className="flex-1">
                {candidate === 'IN' ? 'Punch in' : 'Punch out'}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>Date</FieldLabel>
            <DateField label="Date" value={date} onValueChange={setDate} disabled={(day) => day.getTime() > Date.now()} />
          </Field>
          <Field>
            <FieldLabel>Time</FieldLabel>
            <TimeField label="Time" value={clock} onValueChange={setClock} />
          </Field>
        </div>

        <Field data-invalid={attempted && reasonShort ? true : undefined}>
          <FieldLabel htmlFor="record-reason">Reason</FieldLabel>
          <Textarea
            id="record-reason"
            value={reason}
            rows={3}
            maxLength={500}
            aria-invalid={attempted && reasonShort}
            placeholder="Why this is being recorded by you, in a sentence."
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          <FieldDescription>Shown on the day record and kept in the audit log.</FieldDescription>
          {attempted && reasonShort ? <FieldError>At least {MIN_REASON} characters.</FieldError> : null}
        </Field>

        <DialogFooter className="flex-row justify-end gap-2">
          <Button type="button" variant="outline" className="flex-1 sm:flex-none" disabled={record.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1 sm:flex-none" disabled={record.isPending}>
            {record.isPending ? <Spinner data-icon="inline-start" /> : <UserGearIcon data-icon="inline-start" />}
            Record
          </Button>
        </DialogFooter>
      </Form>
    </ShortcutLayer>
  );
}
