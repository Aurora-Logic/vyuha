import { useState } from 'react';
import { WarningCircleIcon } from '@phosphor-icons/react';
import { parseISO } from 'date-fns';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { toDateParam } from '@/features/attendance/format';
import {
  DateField,
  EMPLOYEE_DATE_YEARS_BACK,
  EMPLOYEE_DATE_YEARS_FORWARD,
} from '@/features/attendance/pickers';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { useIsMobile } from '@/hooks/use-mobile';
import { humaniseEnum } from '@/lib/format';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import {
  EMPLOYMENT_TYPES,
  employeeDisplayName,
  type EmployeeListItem,
  type EmploymentType,
} from '@vyuha/shared';

import { useHolidayCalendarOptions } from '@/features/holidays/use-holidays';

import { useDepartments } from './use-departments';
import { useEmployee, type EmployeeRecord } from './use-employee';
import {
  useCreateEmployee,
  useDesignationOptions,
  useLocationOptions,
  useManagerOptions,
  useUpdateEmployee,
  type EmployeeFormValues,
} from './use-employee-mutations';

/**
 * One employee record, created or edited (REQ-A-03, REQ-A-04, REQ-A-07).
 *
 * A sheet rather than a page, for the reason every other form in this product
 * is one: the reader is looking at the register while they change a row, and
 * losing the list would cost them the context they opened the form from. Bottom
 * edge on a phone, right on a desktop.
 *
 * The employee code is editable exactly once, when the record is created.
 * REQ-A-04 makes it immutable afterwards and the server answers 422 for a
 * change, so on an edit the field is disabled and says why rather than being
 * removed -- a code that vanished when you opened the form would read as data
 * loss.
 *
 * Status and last working date are not here. Retiring somebody is REQ-A-05's
 * own action with its own confirm, not a dropdown buried in a fourteen-field
 * form.
 */

interface EmployeeSheetProps {
  /** The row being edited, `'new'` to create, or null when closed. */
  target: EmployeeListItem | 'new' | null;
  onOpenChange: (open: boolean) => void;
}

export function EmployeeSheet({ target, onOpenChange }: EmployeeSheetProps) {
  const isMobile = useIsMobile();

  return (
    <Sheet open={target !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className="gap-0 sm:max-w-lg max-md:max-h-[90vh]"
      >
        {/* Remounted per record, so a draft typed for one person can never be
            saved against the next one somebody opens. */}
        {target === null ? null : target === 'new' ? (
          <EmployeeForm
            key="new"
            employee={null}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : (
          <EmployeeLoader
            key={target.id}
            row={target}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Mirrors the server's `employeeCodeField`, so the rule is learned while typing. */
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/** The same default the server's `createEmployeeSchema` applies. */
const DEFAULT_EMPLOYMENT_TYPE: EmploymentType = 'PERMANENT';

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The record behind the row, fetched before anything is editable.
 *
 * The register carries twelve of the fourteen fields this form writes -- it has
 * no `personalEmail` and no `isFieldStaff` -- and a PATCH built from the row
 * alone would send null and false for both and silently wipe them. So the form
 * does not open on a guess: it opens on `GET /employees/:id`, which is the only
 * source that has every field.
 */
function EmployeeLoader({ row, onClose }: { row: EmployeeListItem; onClose: () => void }) {
  const query = useEmployee(row.id);

  if (query.isSuccess) return <EmployeeForm employee={query.data} onClose={onClose} />;

  const copy = actionErrorCopy(query.error, 'Opening the record');

  return (
    <>
      <SheetHeader className="shrink-0 border-b">
        <SheetTitle>{employeeDisplayName(row.firstName, row.lastName)}</SheetTitle>
        <SheetDescription>{row.employeeCode}</SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {query.isError ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>{copy.title}</AlertTitle>
            <AlertDescription>
              {copy.description} Nothing is editable until the whole record is here, because saving
              half of it would clear the other half.
            </AlertDescription>
          </Alert>
        ) : (
          <div
            role="status"
            aria-busy="true"
            aria-label="Loading the employee record"
            className="flex flex-col gap-4"
          >
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} aria-hidden className="flex flex-col gap-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))}
          </div>
        )}
      </div>

      <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t">
        <Button variant="outline" className="flex-1 sm:flex-none" onClick={onClose}>
          <ACTION_ICONS.close data-icon="inline-start" />
          Close
        </Button>
        {query.isError ? (
          <Button
            className="flex-1 sm:flex-none"
            onClick={() => {
              void query.refetch();
            }}
          >
            <ACTION_ICONS.retry data-icon="inline-start" />
            Try again
          </Button>
        ) : null}
      </SheetFooter>
    </>
  );
}

function EmployeeForm({
  employee,
  onClose,
}: {
  /** Null when creating. */
  employee: EmployeeRecord | null;
  onClose: () => void;
}) {
  const existing = employee;

  const [draft, setDraft] = useState(() => ({
    employeeCode: existing?.employeeCode ?? '',
    firstName: existing?.firstName ?? '',
    lastName: existing?.lastName ?? '',
    workEmail: existing?.workEmail ?? '',
    personalEmail: existing?.personalEmail ?? '',
    mobile: existing?.mobile ?? '',
    dateOfJoining: existing?.dateOfJoining ?? toDateParam(new Date()),
    employmentType: existing?.employmentType ?? DEFAULT_EMPLOYMENT_TYPE,
    departmentId: existing?.department?.id ?? null,
    designationId: existing?.designation?.id ?? null,
    locationId: existing?.location?.id ?? null,
    reportingManagerId: existing?.reportingManager?.id ?? null,
    isFieldStaff: existing?.isFieldStaff ?? false,
    holidayCalendarId: existing?.holidayCalendarId ?? null,
  }));
  const [touched, setTouched] = useState(false);

  const departments = useDepartments();
  const designations = useDesignationOptions();
  const locations = useLocationOptions();
  const managers = useManagerOptions();
  const calendars = useHolidayCalendarOptions();

  const create = useCreateEmployee();
  const update = useUpdateEmployee();
  const pending = create.isPending || update.isPending;
  const error: unknown = create.error ?? update.error;

  const codeIssue =
    existing !== null
      ? null
      : draft.employeeCode.trim() === ''
        ? 'An employee code is required, and cannot be changed afterwards.'
        : !CODE_PATTERN.test(draft.employeeCode.trim())
          ? 'Letters, digits, dot, underscore, slash and hyphen.'
          : null;
  const nameIssue = draft.firstName.trim() === '' ? 'A first name is required.' : null;
  const blocked = codeIssue !== null || nameIssue !== null;

  const departmentOptions: PickerOption[] = (departments.data ?? []).map((row) => ({
    id: row.id,
    label: row.name,
  }));
  const designationOptions: PickerOption[] = (designations.data ?? []).map((row) => ({
    id: row.id,
    label: row.name,
    ...(row.hint === undefined ? {} : { hint: row.hint }),
  }));
  const locationOptions: PickerOption[] = (locations.data ?? []).map((row) => ({
    id: row.id,
    label: row.name,
    ...(row.hint === undefined ? {} : { hint: row.hint }),
  }));
  // The year rides as the hint: calendars are per-year, and two years of
  // "Maharashtra" are otherwise indistinguishable in the list.
  const calendarOptions: PickerOption[] = (calendars.data ?? []).map((row) => ({
    id: row.id,
    label: row.name,
    hint: String(row.year),
  }));
  // REQ-A-07: nobody reports to themselves. The server checks the whole chain;
  // this removes the one case reachable in a single click.
  const managerOptions: PickerOption[] = (managers.data ?? [])
    .filter((row) => row.id !== existing?.id)
    .map((row) => ({ id: row.id, label: row.name, ...(row.hint === undefined ? {} : { hint: row.hint }) }));

  function find(options: PickerOption[], id: string | null): PickerOption | null {
    return options.find((option) => option.id === id) ?? null;
  }

  function submit() {
    setTouched(true);
    if (blocked) return;

    const values: EmployeeFormValues = {
      employeeCode: draft.employeeCode.trim(),
      firstName: draft.firstName.trim(),
      lastName: blankToNull(draft.lastName),
      workEmail: blankToNull(draft.workEmail),
      personalEmail: blankToNull(draft.personalEmail),
      mobile: blankToNull(draft.mobile),
      dateOfJoining: draft.dateOfJoining,
      employmentType: draft.employmentType,
      departmentId: draft.departmentId,
      designationId: draft.designationId,
      locationId: draft.locationId,
      reportingManagerId: draft.reportingManagerId,
      isFieldStaff: draft.isFieldStaff,
      holidayCalendarId: draft.holidayCalendarId,
    };

    const onSuccess = (saved: { firstName: string; lastName: string | null; employeeCode: string }) => {
      // PRD §6.6: the toast repeats the action the button named.
      toast.add({
        type: 'success',
        title: existing === null ? 'Employee created' : 'Employee saved',
        description: `${employeeDisplayName(saved.firstName, saved.lastName)} (${saved.employeeCode}).`,
      });
      onClose();
    };

    if (existing === null) create.mutate(values, { onSuccess });
    else update.mutate({ id: existing.id, values }, { onSuccess });
  }

  const copy = actionErrorCopy(error, existing === null ? 'Creating the employee' : 'Saving the employee');

  return (
    // The sheet's shortcuts take precedence and the screen's are suspended
    // while it is open (technical design §9).
    <ShortcutLayer id={`modal:employee-${existing?.id ?? 'new'}`}>
      <SaveShortcut onSave={submit} />

      <SheetHeader className="shrink-0 border-b">
        <SheetTitle>
          {existing === null
            ? 'New employee'
            : employeeDisplayName(existing.firstName, existing.lastName)}
        </SheetTitle>
        <SheetDescription>
          {existing === null
            ? 'The record, not a login. An account is invited separately.'
            : `${existing.employeeCode}. Everything except the code is editable, with an audit trail.`}
        </SheetDescription>
      </SheetHeader>

      {/* min-h-0 is load-bearing: without it this flex child refuses to shrink
          below its content and pushes the footer off the sheet. */}
      <Form onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto p-4">
        <FieldGroup>
          {error != null ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>{copy.title}</AlertTitle>
              <AlertDescription>{copy.description} Your edits are still here.</AlertDescription>
            </Alert>
          ) : null}

          <Field>
            <FieldLabel htmlFor="employee-code">Employee code</FieldLabel>
            <Input
              id="employee-code"
              className="tabular-nums"
              value={draft.employeeCode}
              disabled={existing !== null}
              autoFocus={existing === null}
              onChange={(event) => {
                setDraft((current) => ({ ...current, employeeCode: event.target.value }));
              }}
            />
            <FieldDescription>
              {existing !== null
                ? 'The code is fixed once the record exists, because every report and export cites it.'
                : touched && codeIssue !== null
                  ? codeIssue
                  : 'Unique across the organisation, and permanent once saved.'}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="employee-first-name">First name</FieldLabel>
            <Input
              id="employee-first-name"
              value={draft.firstName}
              autoFocus={existing !== null}
              onChange={(event) => {
                setDraft((current) => ({ ...current, firstName: event.target.value }));
              }}
            />
            {touched && nameIssue !== null ? <FieldDescription>{nameIssue}</FieldDescription> : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="employee-last-name">Last name</FieldLabel>
            <Input
              id="employee-last-name"
              value={draft.lastName}
              onChange={(event) => {
                setDraft((current) => ({ ...current, lastName: event.target.value }));
              }}
            />
            <FieldDescription>Optional. Some records carry one name only.</FieldDescription>
          </Field>

          <FieldSet>
            <FieldLegend>Contact</FieldLegend>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="employee-work-email">Work email</FieldLabel>
                <Input
                  id="employee-work-email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  value={draft.workEmail}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, workEmail: event.target.value }));
                  }}
                />
                <FieldDescription>
                  What an invite would be sent to. It does not create a login on its own.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="employee-personal-email">Personal email</FieldLabel>
                <Input
                  id="employee-personal-email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  value={draft.personalEmail}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, personalEmail: event.target.value }));
                  }}
                />
                <FieldDescription>
                  Optional, and never used to sign in. Clearing it removes it from the record.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="employee-mobile">Mobile</FieldLabel>
                <Input
                  id="employee-mobile"
                  type="tel"
                  inputMode="tel"
                  className="tabular-nums"
                  value={draft.mobile}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, mobile: event.target.value }));
                  }}
                />
                <FieldDescription>
                  Digits, spaces, brackets and a leading plus. Six characters or more.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </FieldSet>

          <FieldSet>
            <FieldLegend>Employment</FieldLegend>
            <FieldGroup>
              <Field orientation="responsive">
                <FieldLabel>Date of joining</FieldLabel>
                <DateField
                  label="Date of joining"
                  value={parseISO(draft.dateOfJoining)}
                  // Fifty years of year dropdown rather than the two a date
                  // near the present needs. Somebody hired in 2009 is sixteen
                  // years of month-at-a-time paging away from today.
                  yearsBack={EMPLOYEE_DATE_YEARS_BACK}
                  yearsForward={EMPLOYEE_DATE_YEARS_FORWARD}
                  onValueChange={(next) => {
                    setDraft((current) => ({ ...current, dateOfJoining: toDateParam(next) }));
                  }}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="employee-employment-type">Employment type</FieldLabel>
                <Select
                  value={draft.employmentType}
                  onValueChange={(next: string | null) => {
                    const parsed = EMPLOYMENT_TYPES.find((value) => value === next);
                    if (parsed) setDraft((current) => ({ ...current, employmentType: parsed }));
                  }}
                >
                  <SelectTrigger
                    id="employee-employment-type"
                    aria-label="Employment type"
                    className="w-full"
                  >
                    <SelectValue>{(value: string) => humaniseEnum(value)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {EMPLOYMENT_TYPES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {humaniseEnum(value)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="employee-department">Department</FieldLabel>
                <RecordPicker
                  id="employee-department"
                  label="Department"
                  placeholder="No department"
                  searchPlaceholder="Search departments"
                  emptyMessage="No department matches that."
                  options={departmentOptions}
                  loading={departments.isPending}
                  clearable
                  clearLabel="No department"
                  value={find(departmentOptions, draft.departmentId)}
                  onValueChange={(next) => {
                    setDraft((current) => ({ ...current, departmentId: next?.id ?? null }));
                  }}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="employee-designation">Designation</FieldLabel>
                <RecordPicker
                  id="employee-designation"
                  label="Designation"
                  placeholder="No designation"
                  searchPlaceholder="Search designations"
                  emptyMessage="No designation matches that."
                  options={designationOptions}
                  loading={designations.isPending}
                  clearable
                  clearLabel="No designation"
                  value={find(designationOptions, draft.designationId)}
                  onValueChange={(next) => {
                    setDraft((current) => ({ ...current, designationId: next?.id ?? null }));
                  }}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="employee-location">Location</FieldLabel>
                <RecordPicker
                  id="employee-location"
                  label="Location"
                  placeholder="No location"
                  searchPlaceholder="Search locations"
                  emptyMessage="No location matches that."
                  options={locationOptions}
                  loading={locations.isPending}
                  clearable
                  clearLabel="No location"
                  value={find(locationOptions, draft.locationId)}
                  onValueChange={(next) => {
                    setDraft((current) => ({ ...current, locationId: next?.id ?? null }));
                  }}
                />
                <FieldDescription>
                  Decides the geofence and the holiday calendar this person inherits.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="employee-calendar">Holiday calendar</FieldLabel>
                <RecordPicker
                  id="employee-calendar"
                  label="Holiday calendar"
                  placeholder="The location's calendar"
                  searchPlaceholder="Search calendars"
                  emptyMessage="No calendar matches that."
                  options={calendarOptions}
                  loading={calendars.isPending}
                  clearable
                  clearLabel="The location's calendar"
                  value={find(calendarOptions, draft.holidayCalendarId)}
                  onValueChange={(next) => {
                    setDraft((current) => ({ ...current, holidayCalendarId: next?.id ?? null }));
                  }}
                />
                <FieldDescription>
                  An override for this one person (REQ-H-02). Left empty, the location above
                  decides.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="employee-manager">Reports to</FieldLabel>
                <RecordPicker
                  id="employee-manager"
                  label="Reporting manager"
                  placeholder="Nobody"
                  searchPlaceholder="Search by name or code"
                  emptyMessage="Nobody matches that name or code."
                  options={managerOptions}
                  loading={managers.isPending}
                  clearable
                  clearLabel="Nobody"
                  value={find(managerOptions, draft.reportingManagerId)}
                  onValueChange={(next) => {
                    setDraft((current) => ({ ...current, reportingManagerId: next?.id ?? null }));
                  }}
                />
                <FieldDescription>
                  The server refuses a manager that would close a reporting loop.
                </FieldDescription>
              </Field>

              <Field orientation="horizontal">
                <FieldLabel htmlFor="employee-field-staff">Field staff</FieldLabel>
                <Switch
                  id="employee-field-staff"
                  checked={draft.isFieldStaff}
                  onCheckedChange={(next: boolean) => {
                    setDraft((current) => ({ ...current, isFieldStaff: next }));
                  }}
                />
              </Field>
              <FieldDescription>
                Exempt from the geofence. Their punches are recorded as On Duty.
              </FieldDescription>
            </FieldGroup>
          </FieldSet>
        </FieldGroup>
      </Form>

      {/* Two short actions fit one row at 360px, so they stay in one row rather
          than stacking and putting Save furthest from the thumb. */}
      <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t">
        <Button variant="outline" className="flex-1 sm:flex-none" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          Cancel
        </Button>
        <Button className="flex-1 sm:flex-none" disabled={pending} onClick={submit}>
          {pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <ACTION_ICONS.save data-icon="inline-start" />
          )}
          {pending ? 'Saving' : 'Save'}
          <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
        </Button>
      </SheetFooter>
    </ShortcutLayer>
  );
}

/**
 * Separate so the registration lands inside the layer the sheet pushes. A hook
 * called in the component that renders the provider would register into the
 * layer underneath it.
 */
function SaveShortcut({ onSave }: { onSave: () => void }) {
  useShortcut({
    id: 'employee-sheet.save',
    keys: 'ctrl+a',
    label: 'Accept / Save',
    scope: 'modal',
    // PRD §6.4: Ctrl+A saves from any field, so it fires inside inputs too.
    allowInInput: true,
    run: onSave,
  });
  return null;
}
