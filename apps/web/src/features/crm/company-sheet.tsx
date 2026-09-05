import { useState } from 'react';
import { TrashIcon, UserIcon, UsersThreeIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useManagerOptions } from '@/features/employees/use-employee-mutations';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { useIsMobile } from '@/hooks/use-mobile';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { ActivityTimeline } from './activity-timeline';
import { companyDraftErrors } from './company-validation';
import { DeleteCompanyDialog } from './delete-dialogs';
import type { Company, CompanyDraft } from './types';
import { useSaveCompany } from './use-crm';

/**
 * One company (REQ-U-02): a prospect organisation. It may or may not become
 * a Tally party; when it does (REQ-U-03) the link shows here, read-only —
 * the party itself is Tally's.
 */

interface CompanySheetProps {
  draft: CompanyDraft | null;
  /** The record behind the draft, when editing; carries what the form does not (contact count, party link). */
  record?: Company | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (company: Company) => void;
  onDeleted?: () => void;
}

export function CompanySheet({ draft, record, onOpenChange, onSaved, onDeleted }: CompanySheetProps) {
  const isMobile = useIsMobile();
  return (
    <Sheet open={draft !== null} onOpenChange={onOpenChange}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-md max-md:max-h-[90vh]">
        {draft ? (
          <CompanySheetBody
            key={draft.id ?? 'new'}
            initial={draft}
            record={record ?? null}
            onClose={() => {
              onOpenChange(false);
            }}
            {...(onSaved === undefined ? {} : { onSaved })}
            {...(onDeleted === undefined ? {} : { onDeleted })}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function CompanySheetBody({
  initial,
  record,
  onClose,
  onSaved,
  onDeleted,
}: {
  initial: CompanyDraft;
  record: Company | null;
  onClose: () => void;
  onSaved?: (company: Company) => void;
  onDeleted?: () => void;
}) {
  const [draft, setDraft] = useState<CompanyDraft>(initial);
  const [attempted, setAttempted] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const save = useSaveCompany();
  const canAssign = usePermission(PERMISSIONS.CRM_CONTACT_VIEW_ALL);
  const canManage = usePermission(PERMISSIONS.CRM_CONTACT_MANAGE);
  const owners = useManagerOptions();
  const isNew = initial.id === undefined;

  const ownerOptions: PickerOption[] = (owners.data ?? []).map((o) => ({
    id: o.id,
    label: o.name,
    ...(o.hint === undefined ? {} : { hint: o.hint }),
  }));
  const errors = companyDraftErrors(draft);
  const valid = Object.keys(errors).length === 0;

  function submit() {
    setAttempted(true);
    if (!valid || save.isPending) return;
    save.mutate(draft, {
      onSuccess: (saved) => {
        toast.add({ type: 'success', title: isNew ? 'Company added' : 'Company saved', description: saved.name });
        onSaved?.(saved);
        onClose();
      },
    });
  }

  const copy = actionErrorCopy(save.error, 'Saving the company');

  return (
    <ShortcutLayer id={`modal:company-${initial.id ?? 'new'}`}>
      <SaveShortcut onSave={submit} />

      <SheetHeader className="shrink-0 border-b">
        <SheetTitle>{isNew ? 'New company' : initial.name}</SheetTitle>
        <SheetDescription>
          {isNew
            ? 'A prospect organisation. It becomes a Tally party only when a deal is won.'
            : record !== null && record.contactCount > 0
              ? `${record.contactCount} contact${record.contactCount === 1 ? '' : 's'}.`
              : 'No contacts yet.'}
        </SheetDescription>
      </SheetHeader>

      <Form onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto p-4">
        <FieldGroup>
          {save.isError ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>{copy.title}</AlertTitle>
              <AlertDescription>{copy.description}</AlertDescription>
            </Alert>
          ) : null}

          {record !== null && record.contactCount > 0 ? (
            <Alert>
              <UsersThreeIcon />
              <AlertTitle>
                {record.contactCount} contact{record.contactCount === 1 ? '' : 's'}
              </AlertTitle>
              <AlertDescription>
                <Link
                  to={`/crm/contacts?company=${record.id}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  Open them in Contacts
                </Link>
              </AlertDescription>
            </Alert>
          ) : null}

          <Field data-invalid={attempted && errors.name ? true : undefined}>
            <FieldLabel htmlFor="company-name">Name</FieldLabel>
            <Input
              id="company-name"
              autoFocus
              autoComplete="organization"
              aria-invalid={attempted && errors.name ? true : undefined}
              value={draft.name}
              onChange={(event) => {
                setDraft((current) => ({ ...current, name: event.target.value }));
              }}
            />
            {attempted && errors.name ? <FieldError>{errors.name}</FieldError> : null}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={attempted && errors.phone ? true : undefined}>
              <FieldLabel htmlFor="company-phone">Phone</FieldLabel>
              <Input
                id="company-phone"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                aria-invalid={attempted && errors.phone ? true : undefined}
                value={draft.phone}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, phone: event.target.value }));
                }}
              />
              {attempted && errors.phone ? <FieldError>{errors.phone}</FieldError> : null}
            </Field>
            <Field data-invalid={attempted && errors.email ? true : undefined}>
              <FieldLabel htmlFor="company-email">Email</FieldLabel>
              <Input
                id="company-email"
                type="email"
                inputMode="email"
                autoComplete="off"
                aria-invalid={attempted && errors.email ? true : undefined}
                value={draft.email}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, email: event.target.value }));
                }}
              />
              {attempted && errors.email ? <FieldError>{errors.email}</FieldError> : null}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={attempted && errors.website ? true : undefined}>
              <FieldLabel htmlFor="company-website">Website</FieldLabel>
              <Input
                id="company-website"
                inputMode="url"
                autoComplete="off"
                aria-invalid={attempted && errors.website ? true : undefined}
                placeholder="acme.example"
                value={draft.website}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, website: event.target.value }));
                }}
              />
              {attempted && errors.website ? <FieldError>{errors.website}</FieldError> : null}
            </Field>
            <Field data-invalid={attempted && errors.city ? true : undefined}>
              <FieldLabel htmlFor="company-city">City</FieldLabel>
              <Input
                id="company-city"
                autoComplete="off"
                aria-invalid={attempted && errors.city ? true : undefined}
                value={draft.city}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, city: event.target.value }));
                }}
              />
              {attempted && errors.city ? <FieldError>{errors.city}</FieldError> : null}
            </Field>
          </div>

          {canAssign ? (
            <Field>
              <FieldLabel htmlFor="company-owner">Owner</FieldLabel>
              <RecordPicker
                id="company-owner"
                label="Owner"
                placeholder={isNew ? 'You' : 'Nobody'}
                searchPlaceholder="Search by name or code"
                emptyMessage="Nobody matches that name or code."
                icon={<UserIcon className="text-muted-foreground" />}
                options={ownerOptions}
                loading={owners.isPending}
                clearable
                clearLabel={isNew ? 'You' : 'Nobody'}
                value={ownerOptions.find((o) => o.id === draft.ownerId) ?? null}
                onValueChange={(next) => {
                  setDraft((current) => ({ ...current, ownerId: next?.id ?? null }));
                }}
              />
              <FieldDescription>Who this company belongs to; a view.self holder sees only their own.</FieldDescription>
            </Field>
          ) : null}

          <Field data-invalid={attempted && errors.notes ? true : undefined}>
            <FieldLabel htmlFor="company-notes">Notes</FieldLabel>
            <Textarea
              id="company-notes"
              rows={3}
              aria-invalid={attempted && errors.notes ? true : undefined}
              value={draft.notes}
              onChange={(event) => {
                setDraft((current) => ({ ...current, notes: event.target.value }));
              }}
            />
            {attempted && errors.notes ? <FieldError>{errors.notes}</FieldError> : null}
          </Field>

          {record?.partyId ? (
            <FieldDescription>
              Linked to a Tally party.{' '}
              <Link to={`/masters/parties?q=${encodeURIComponent(record.name.slice(0, 80))}`} className="underline-offset-4 hover:underline">
                Open the party
              </Link>
            </FieldDescription>
          ) : null}
        </FieldGroup>
        {initial.id === undefined ? null : (
          <div className="mt-6 border-t pt-4">
            <ActivityTimeline subject={{ type: 'company', id: initial.id }} canLog={canManage} />
          </div>
        )}
      </Form>

      <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t">
        {isNew ? null : (
          <Button
            variant="outline"
            className="mr-auto"
            disabled={save.isPending}
            onClick={() => {
              setDeleting(true);
            }}
            aria-label={`Delete ${initial.name}`}
          >
            <TrashIcon data-icon="inline-start" />
            Delete
          </Button>
        )}
        <Button variant="outline" className="flex-1 sm:flex-none" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          Cancel
        </Button>
        <Button className="flex-1 sm:flex-none" disabled={save.isPending} onClick={submit}>
          {save.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
          {save.isPending ? 'Saving' : 'Save'}
          <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
        </Button>
      </SheetFooter>

      {initial.id === undefined ? null : (
        <DeleteCompanyDialog
          target={deleting ? { id: initial.id, name: initial.name } : null}
          onOpenChange={(open) => {
            setDeleting(open);
          }}
          onDeleted={() => {
            onDeleted?.();
            onClose();
          }}
        />
      )}
    </ShortcutLayer>
  );
}

function SaveShortcut({ onSave }: { onSave: () => void }) {
  useShortcut({
    id: 'company-sheet.save',
    keys: 'ctrl+a',
    label: 'Accept / Save',
    scope: 'modal',
    allowInInput: true,
    run: onSave,
  });
  return null;
}
