import { useState, type ReactNode } from 'react';
import { MapPinIcon, WarningCircleIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';

import { formatCoordinate, parseMapsLink, type MapsLinkResult } from './maps-link';
import { Form } from '@/components/shared/form';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { toast } from '@/components/ui/toast';
import { useHolidayCalendarOptions } from '@/features/holidays/use-holidays';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { useIsMobile } from '@/hooks/use-mobile';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';

import { CODE_HELP, codeProblem, nameProblem } from './field-rules';
import type { DepartmentSummary, DesignationSummary, LocationSummary } from './types';
import {
  useEmployeeOptions,
  useSaveDepartment,
  useSaveDesignation,
  useSaveLocation,
  type DepartmentDraft,
  type DesignationDraft,
  type LocationDraft,
} from './use-masters';

/**
 * The edit form for each of the three org masters (REQ-A-01, REQ-A-02).
 *
 * A sheet rather than a page, for the reason the shift and leave type forms
 * give: each of these is four to eight fields, the reader is comparing rows
 * while they change one, and losing the table would cost them the comparison.
 * Bottom edge on a phone, right on a desktop -- the same surface switch every
 * other form in this product uses.
 *
 * All three share one surface and one body chrome, so the header, the footer,
 * the Ctrl+A binding and the failure alert cannot drift between them. The body
 * is remounted per record, so a draft typed for one row can never be saved
 * against the next one somebody opens.
 */

function MasterSheetSurface({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className="gap-0 sm:max-w-lg max-md:max-h-[90vh]"
      >
        {children}
      </SheetContent>
    </Sheet>
  );
}

interface BodyChromeProps {
  layerId: string;
  title: string;
  description: string;
  pending: boolean;
  error: unknown;
  /** Names the failed action in the alert: "Saving the department". */
  failureAction: string;
  onSubmit: () => void;
  onCancel: () => void;
  children: ReactNode;
}

function MasterSheetBody({
  layerId,
  title,
  description,
  pending,
  error,
  failureAction,
  onSubmit,
  onCancel,
  children,
}: BodyChromeProps) {
  const copy = actionErrorCopy(error, failureAction);

  return (
    // The sheet's shortcuts take precedence and the screen's are suspended
    // while it is open (technical design §9).
    <ShortcutLayer id={layerId}>
      <SaveShortcut onSave={onSubmit} />

      <SheetHeader className="shrink-0 border-b">
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>{description}</SheetDescription>
      </SheetHeader>

      {/* min-h-0 is load-bearing: without it this flex child refuses to shrink
          below its content and pushes the footer off the sheet. */}
      <Form onSubmit={onSubmit} className="min-h-0 flex-1 overflow-y-auto p-4">
        <FieldGroup>
          {error != null ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>{copy.title}</AlertTitle>
              <AlertDescription>{copy.description} Your edits are still here.</AlertDescription>
            </Alert>
          ) : null}
          {children}
        </FieldGroup>
      </Form>

      {/* Two short actions fit one row at 360px, so they stay in one row rather
          than stacking and putting Save furthest from the thumb. */}
      <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t">
        <Button variant="outline" className="flex-1 sm:flex-none" onClick={onCancel}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          Cancel
        </Button>
        <Button className="flex-1 sm:flex-none" disabled={pending} onClick={onSubmit}>
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
 * Separate so the registration lands inside the layer the body pushes. A hook
 * called in the component that renders the provider would register into the
 * layer underneath it.
 */
function SaveShortcut({ onSave }: { onSave: () => void }) {
  useShortcut({
    id: 'master-sheet.save',
    keys: 'ctrl+a',
    label: 'Accept / Save',
    scope: 'modal',
    // PRD §6.4: Ctrl+A saves from any field, so it fires inside inputs too.
    allowInInput: true,
    run: onSave,
  });
  return null;
}

// --------------------------------------------------------------- department

interface DepartmentSheetProps {
  /** The row being edited, `'new'` to create, or null when closed. */
  target: DepartmentSummary | 'new' | null;
  onOpenChange: (open: boolean) => void;
  /** Every department, for the parent picker. */
  departments: readonly DepartmentSummary[];
}

export function DepartmentSheet({ target, onOpenChange, departments }: DepartmentSheetProps) {
  return (
    <MasterSheetSurface open={target !== null} onOpenChange={onOpenChange}>
      {target === null ? null : (
        <DepartmentBody
          key={target === 'new' ? 'new' : target.id}
          target={target}
          departments={departments}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      )}
    </MasterSheetSurface>
  );
}

function DepartmentBody({
  target,
  departments,
  onClose,
}: {
  target: DepartmentSummary | 'new';
  departments: readonly DepartmentSummary[];
  onClose: () => void;
}) {
  const existing = target === 'new' ? null : target;
  const [draft, setDraft] = useState<DepartmentDraft>(() => ({
    id: existing?.id ?? null,
    name: existing?.name ?? '',
    code: existing?.code ?? '',
    headEmployeeId: existing?.head?.id ?? null,
    parentId: existing?.parent?.id ?? null,
  }));
  const [touched, setTouched] = useState(false);

  const employees = useEmployeeOptions();
  const save = useSaveDepartment();

  const nameIssue = nameProblem(draft.name);
  const codeIssue = codeProblem(draft.code);

  const employeeOptions: PickerOption[] = (employees.data ?? []).map((person) => ({
    id: person.id,
    label: person.name,
    hint: person.employeeCode,
  }));
  const head = employeeOptions.find((option) => option.id === draft.headEmployeeId) ?? null;

  // A department is not offered as its own parent. The server checks the whole
  // chain for a loop; this removes only the case reachable in one click.
  const parentOptions: PickerOption[] = departments
    .filter((row) => row.id !== existing?.id)
    .map((row) => ({ id: row.id, label: row.name, hint: row.code }));
  const parent = parentOptions.find((option) => option.id === draft.parentId) ?? null;

  function submit() {
    setTouched(true);
    if (nameIssue !== null || codeIssue !== null) return;
    save.mutate(
      { ...draft, name: draft.name.trim(), code: draft.code.trim() },
      {
        onSuccess: (saved) => {
          // PRD §6.6: the toast repeats the action the button named.
          toast.add({
            type: 'success',
            title: existing === null ? 'Department created' : 'Department saved',
            description: `${saved.name} (${saved.code}).`,
          });
          onClose();
        },
      },
    );
  }

  return (
    <MasterSheetBody
      layerId={`modal:department-${existing?.id ?? 'new'}`}
      title={existing === null ? 'New department' : existing.name}
      description={
        existing === null
          ? 'A department groups employees, and is what most reports are filtered by.'
          : `Code ${existing.code}. Employees on it move with it.`
      }
      pending={save.isPending}
      error={save.error}
      failureAction="Saving the department"
      onSubmit={submit}
      onCancel={onClose}
    >
      <Field>
        <FieldLabel htmlFor="department-name">Name</FieldLabel>
        <Input
          id="department-name"
          value={draft.name}
          autoFocus
          onChange={(event) => {
            setDraft((current) => ({ ...current, name: event.target.value }));
          }}
        />
        {touched && nameIssue !== null ? <FieldDescription>{nameIssue}</FieldDescription> : null}
      </Field>

      <Field>
        <FieldLabel htmlFor="department-code">Code</FieldLabel>
        <Input
          id="department-code"
          value={draft.code}
          onChange={(event) => {
            setDraft((current) => ({ ...current, code: event.target.value }));
          }}
        />
        <FieldDescription>{touched && codeIssue !== null ? codeIssue : CODE_HELP}</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="department-head">Head</FieldLabel>
        <RecordPicker
          id="department-head"
          label="Head of department"
          placeholder="Nobody named"
          searchPlaceholder="Search by name or code"
          emptyMessage="Nobody matches that name or code."
          options={employeeOptions}
          loading={employees.isPending}
          clearable
          clearLabel="Nobody"
          value={head}
          onValueChange={(next) => {
            setDraft((current) => ({ ...current, headEmployeeId: next?.id ?? null }));
          }}
        />
        <FieldDescription>Active employees only. Optional.</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="department-parent">Parent department</FieldLabel>
        <RecordPicker
          id="department-parent"
          label="Parent department"
          placeholder="Top level"
          searchPlaceholder="Search by name or code"
          emptyMessage="No department matches that."
          options={parentOptions}
          clearable
          clearLabel="Top level"
          value={parent}
          onValueChange={(next) => {
            setDraft((current) => ({ ...current, parentId: next?.id ?? null }));
          }}
        />
        <FieldDescription>
          A hierarchy. The server refuses a parent that would close a loop.
        </FieldDescription>
      </Field>
    </MasterSheetBody>
  );
}

// -------------------------------------------------------------- designation

interface DesignationSheetProps {
  target: DesignationSummary | 'new' | null;
  onOpenChange: (open: boolean) => void;
}

export function DesignationSheet({ target, onOpenChange }: DesignationSheetProps) {
  return (
    <MasterSheetSurface open={target !== null} onOpenChange={onOpenChange}>
      {target === null ? null : (
        <DesignationBody
          key={target === 'new' ? 'new' : target.id}
          target={target}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      )}
    </MasterSheetSurface>
  );
}

function DesignationBody({
  target,
  onClose,
}: {
  target: DesignationSummary | 'new';
  onClose: () => void;
}) {
  const existing = target === 'new' ? null : target;
  const [draft, setDraft] = useState<DesignationDraft>(() => ({
    id: existing?.id ?? null,
    name: existing?.name ?? '',
    code: existing?.code ?? '',
    grade: existing?.grade ?? null,
  }));
  const [touched, setTouched] = useState(false);

  const save = useSaveDesignation();
  const nameIssue = nameProblem(draft.name);
  const codeIssue = codeProblem(draft.code);

  function submit() {
    setTouched(true);
    if (nameIssue !== null || codeIssue !== null) return;
    const grade = draft.grade?.trim() ?? '';
    save.mutate(
      {
        ...draft,
        name: draft.name.trim(),
        code: draft.code.trim(),
        // Empty means "no grade". The server's schema has a minimum length and
        // would reject the empty string rather than read it as absent.
        grade: grade === '' ? null : grade,
      },
      {
        onSuccess: (saved) => {
          toast.add({
            type: 'success',
            title: existing === null ? 'Designation created' : 'Designation saved',
            description: `${saved.name} (${saved.code}).`,
          });
          onClose();
        },
      },
    );
  }

  return (
    <MasterSheetBody
      layerId={`modal:designation-${existing?.id ?? 'new'}`}
      title={existing === null ? 'New designation' : existing.name}
      description={
        existing === null
          ? 'A job title, with an optional grade. Employee records point at one.'
          : `Code ${existing.code}.`
      }
      pending={save.isPending}
      error={save.error}
      failureAction="Saving the designation"
      onSubmit={submit}
      onCancel={onClose}
    >
      <Field>
        <FieldLabel htmlFor="designation-name">Name</FieldLabel>
        <Input
          id="designation-name"
          value={draft.name}
          autoFocus
          onChange={(event) => {
            setDraft((current) => ({ ...current, name: event.target.value }));
          }}
        />
        {touched && nameIssue !== null ? <FieldDescription>{nameIssue}</FieldDescription> : null}
      </Field>

      <Field>
        <FieldLabel htmlFor="designation-code">Code</FieldLabel>
        <Input
          id="designation-code"
          value={draft.code}
          onChange={(event) => {
            setDraft((current) => ({ ...current, code: event.target.value }));
          }}
        />
        <FieldDescription>{touched && codeIssue !== null ? codeIssue : CODE_HELP}</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="designation-grade">Grade</FieldLabel>
        <Input
          id="designation-grade"
          value={draft.grade ?? ''}
          onChange={(event) => {
            setDraft((current) => ({ ...current, grade: event.target.value }));
          }}
        />
        <FieldDescription>Optional. Up to 32 characters, for example G4.</FieldDescription>
      </Field>
    </MasterSheetBody>
  );
}

// ----------------------------------------------------------------- location

interface LocationSheetProps {
  target: LocationSummary | 'new' | null;
  onOpenChange: (open: boolean) => void;
}

export function LocationSheet({ target, onOpenChange }: LocationSheetProps) {
  return (
    <MasterSheetSurface open={target !== null} onOpenChange={onOpenChange}>
      {target === null ? null : (
        <LocationBody
          key={target === 'new' ? 'new' : target.id}
          target={target}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      )}
    </MasterSheetSurface>
  );
}

/** Blank means "not set", which for a coordinate is a different fact from zero. */
function readCoordinate(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function LocationBody({
  target,
  onClose,
}: {
  target: LocationSummary | 'new';
  onClose: () => void;
}) {
  const existing = target === 'new' ? null : target;
  const [draft, setDraft] = useState(() => ({
    name: existing?.name ?? '',
    code: existing?.code ?? '',
    address: existing?.address ?? '',
    timezone: existing?.timezone ?? '',
    geofenceLat: existing?.geofenceLat === null ? '' : String(existing?.geofenceLat ?? ''),
    geofenceLng: existing?.geofenceLng === null ? '' : String(existing?.geofenceLng ?? ''),
    geofenceRadiusM: String(existing?.geofenceRadiusM ?? 100),
    ipAllowlist: (existing?.ipAllowlist ?? []).join('\n'),
    holidayCalendarId: existing?.holidayCalendarId ?? null,
  }));
  const [touched, setTouched] = useState(false);
  // Not part of the draft: the link is a way of filling the two coordinates,
  // not a field of the record, and storing it would leave a stale URL beside
  // numbers somebody later corrected by hand.
  const [mapsLink, setMapsLink] = useState('');
  const [mapsResult, setMapsResult] = useState<MapsLinkResult>({ kind: 'empty' });

  const save = useSaveLocation();
  const calendars = useHolidayCalendarOptions();
  const nameIssue = nameProblem(draft.name);
  const codeIssue = codeProblem(draft.code);

  // The year rides as the hint: calendars are per-year, and two years of
  // "Maharashtra" are otherwise indistinguishable in the list.
  const calendarOptions: PickerOption[] = (calendars.data ?? []).map((row) => ({
    id: row.id,
    label: row.name,
    hint: String(row.year),
  }));
  const calendar = calendarOptions.find((option) => option.id === draft.holidayCalendarId) ?? null;

  const lat = readCoordinate(draft.geofenceLat);
  const lng = readCoordinate(draft.geofenceLng);
  // The server checks this against the merged row and answers 400. Saying it
  // here means the reader learns which half is missing before a round trip
  // rather than from a field error after one.
  const halfGeofence = (lat === null) !== (lng === null);
  const radius = Number(draft.geofenceRadiusM.trim());
  const radiusIssue =
    !Number.isInteger(radius) || radius < 10 || radius > 10_000
      ? 'A radius is a whole number of metres between 10 and 10,000.'
      : null;

  const blocked = nameIssue !== null || codeIssue !== null || halfGeofence || radiusIssue !== null;

  function submit() {
    setTouched(true);
    if (blocked) return;

    const address = draft.address.trim();
    const timezone = draft.timezone.trim();
    const payload: LocationDraft = {
      id: existing?.id ?? null,
      name: draft.name.trim(),
      code: draft.code.trim(),
      address: address === '' ? null : address,
      timezone: timezone === '' ? null : timezone,
      geofenceLat: lat,
      geofenceLng: lng,
      geofenceRadiusM: radius,
      ipAllowlist: draft.ipAllowlist
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
      holidayCalendarId: draft.holidayCalendarId,
    };

    save.mutate(payload, {
      onSuccess: (saved) => {
        toast.add({
          type: 'success',
          title: existing === null ? 'Location created' : 'Location saved',
          description: `${saved.name} (${saved.code}).`,
        });
        onClose();
      },
    });
  }

  return (
    <MasterSheetBody
      layerId={`modal:location-${existing?.id ?? 'new'}`}
      title={existing === null ? 'New location' : existing.name}
      description={
        existing === null
          ? 'A place people work from. The geofence and the allowlist decide where a web punch is accepted.'
          : `Code ${existing.code}.`
      }
      pending={save.isPending}
      error={save.error}
      failureAction="Saving the location"
      onSubmit={submit}
      onCancel={onClose}
    >
      <Field>
        <FieldLabel htmlFor="location-name">Name</FieldLabel>
        <Input
          id="location-name"
          value={draft.name}
          autoFocus
          onChange={(event) => {
            setDraft((current) => ({ ...current, name: event.target.value }));
          }}
        />
        {touched && nameIssue !== null ? <FieldDescription>{nameIssue}</FieldDescription> : null}
      </Field>

      <Field>
        <FieldLabel htmlFor="location-code">Code</FieldLabel>
        <Input
          id="location-code"
          value={draft.code}
          onChange={(event) => {
            setDraft((current) => ({ ...current, code: event.target.value }));
          }}
        />
        <FieldDescription>{touched && codeIssue !== null ? codeIssue : CODE_HELP}</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="location-address">Address</FieldLabel>
        <Textarea
          id="location-address"
          rows={2}
          value={draft.address}
          onChange={(event) => {
            setDraft((current) => ({ ...current, address: event.target.value }));
          }}
        />
        <FieldDescription>Optional, and kept for reference only.</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="location-timezone">Timezone</FieldLabel>
        <Input
          id="location-timezone"
          placeholder="Asia/Kolkata"
          value={draft.timezone}
          onChange={(event) => {
            setDraft((current) => ({ ...current, timezone: event.target.value }));
          }}
        />
        <FieldDescription>
          An IANA zone name. Leave it blank to use the organisation timezone — a wrong zone here
          silently shifts every attendance date for this location.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="location-calendar">Holiday calendar</FieldLabel>
        <RecordPicker
          id="location-calendar"
          label="Holiday calendar"
          placeholder="No calendar"
          searchPlaceholder="Search calendars"
          emptyMessage="No calendar matches that."
          options={calendarOptions}
          loading={calendars.isPending}
          clearable
          clearLabel="No calendar"
          value={calendar}
          onValueChange={(next) => {
            setDraft((current) => ({ ...current, holidayCalendarId: next?.id ?? null }));
          }}
        />
        <FieldDescription>
          Employees here inherit this calendar unless their own record names one (REQ-H-02).
          Calendars are per-year; the year shows beside the name.
        </FieldDescription>
      </Field>

      {/* The paste field comes before the two number fields on purpose: it is
          how this gets filled in practice. Nobody types a latitude — they
          press Share in Google Maps and paste. The numbers below stay, both
          because a short link cannot be parsed and because somebody has to be
          able to see and correct what was read. */}
      <Field>
        <FieldLabel htmlFor="location-maps-link">Paste a Google Maps link</FieldLabel>
        <Input
          id="location-maps-link"
          placeholder="https://www.google.com/maps/@19.0759837,72.8776559,17z"
          value={mapsLink}
          onChange={(event) => {
            const text = event.target.value;
            setMapsLink(text);
            const result = parseMapsLink(text);
            setMapsResult(result);
            if (result.kind === 'found') {
              setDraft((current) => ({
                ...current,
                geofenceLat: formatCoordinate(result.latitude),
                geofenceLng: formatCoordinate(result.longitude),
              }));
            }
          }}
        />
        <FieldDescription>
          Optional shortcut. It fills the two fields below; it is not stored.
        </FieldDescription>
      </Field>

      {mapsResult.kind === 'found' ? (
        <Alert>
          <MapPinIcon />
          <AlertTitle>Centre read from the link</AlertTitle>
          <AlertDescription>
            {formatCoordinate(mapsResult.latitude)}, {formatCoordinate(mapsResult.longitude)} — check
            it against the map before saving.
          </AlertDescription>
        </Alert>
      ) : null}

      {mapsResult.kind === 'short-link' || mapsResult.kind === 'unrecognised' ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>
            {mapsResult.kind === 'short-link'
              ? 'That link hides its coordinates'
              : 'No coordinates in that'}
          </AlertTitle>
          <AlertDescription>{mapsResult.message}</AlertDescription>
        </Alert>
      ) : null}

      <Field>
        <FieldLabel htmlFor="location-lat">Geofence latitude</FieldLabel>
        <Input
          id="location-lat"
          type="number"
          inputMode="decimal"
          step="any"
          min={-90}
          max={90}
          className="tabular-nums"
          value={draft.geofenceLat}
          onChange={(event) => {
            setDraft((current) => ({ ...current, geofenceLat: event.target.value }));
          }}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="location-lng">Geofence longitude</FieldLabel>
        <Input
          id="location-lng"
          type="number"
          inputMode="decimal"
          step="any"
          min={-180}
          max={180}
          className="tabular-nums"
          value={draft.geofenceLng}
          onChange={(event) => {
            setDraft((current) => ({ ...current, geofenceLng: event.target.value }));
          }}
        />
        <FieldDescription>
          Both halves or neither: a centre with one coordinate is not a centre, and the
          server refuses it.
        </FieldDescription>
      </Field>

      {halfGeofence ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>The geofence centre is half set</AlertTitle>
          <AlertDescription>
            Fill in both the latitude and the longitude, or clear both. Left as it is, the save is
            refused.
          </AlertDescription>
        </Alert>
      ) : null}

      <Field>
        <FieldLabel htmlFor="location-radius">Geofence radius (metres)</FieldLabel>
        <Input
          id="location-radius"
          type="number"
          inputMode="numeric"
          min={10}
          max={10_000}
          className="tabular-nums"
          value={draft.geofenceRadiusM}
          onChange={(event) => {
            setDraft((current) => ({ ...current, geofenceRadiusM: event.target.value }));
          }}
        />
        <FieldDescription>
          {touched && radiusIssue !== null
            ? radiusIssue
            : 'Between 10 and 10,000. It does nothing without a centre.'}
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="location-allowlist">IP allowlist</FieldLabel>
        <Textarea
          id="location-allowlist"
          rows={3}
          className="font-mono"
          placeholder={'203.0.113.4\n198.51.100.0/24'}
          value={draft.ipAllowlist}
          onChange={(event) => {
            setDraft((current) => ({ ...current, ipAllowlist: event.target.value }));
          }}
        />
        <FieldDescription>
          One address or CIDR block per line, up to 50. An empty list blocks web punch
          from this location; it does not mean everything is allowed.
        </FieldDescription>
      </Field>
    </MasterSheetBody>
  );
}
