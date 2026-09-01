import { useState } from 'react';
import { BuildingsIcon, TrashIcon, UserIcon, UsersThreeIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
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
import { DeleteContactDialog } from './delete-dialogs';
import type { Contact, ContactDraft } from './types';
import { CompanyPicker } from './company-picker';
import { useContactDuplicates, useSaveContact } from './use-crm';

/**
 * One contact (REQ-U-01), created or edited in a Sheet — a bottom sheet on a
 * phone, a side panel on a desktop, like every form in this product.
 *
 * REQ-U-08 lives here: as the phone and email settle, the server is asked
 * whether anybody already carries them, and the answer is shown as a warning
 * that names them and links to them. It never blocks the save. A second
 * record for the same person is sometimes right — a new role at a new
 * company — and the person typing knows that; this only makes sure they
 * knew there was a first.
 */

interface ContactSheetProps {
  draft: ContactDraft | null;
  onOpenChange: (open: boolean) => void;
  /** After a save; the page decides whether to stay on the record or close. */
  onSaved?: (contact: Contact) => void;
  onDeleted?: () => void;
}

export function ContactSheet({ draft, onOpenChange, onSaved, onDeleted }: ContactSheetProps) {
  const isMobile = useIsMobile();
  return (
    <Sheet open={draft !== null} onOpenChange={onOpenChange}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-md max-md:max-h-[90vh]">
        {draft ? (
          <ContactSheetBody
            key={draft.id ?? 'new'}
            initial={draft}
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

function ContactSheetBody({
  initial,
  onClose,
  onSaved,
  onDeleted,
}: {
  initial: ContactDraft;
  onClose: () => void;
  onSaved?: (contact: Contact) => void;
  onDeleted?: () => void;
}) {
  const [draft, setDraft] = useState<ContactDraft>(initial);
  const [deleting, setDeleting] = useState(false);
  const save = useSaveContact();
  const canAssign = usePermission(PERMISSIONS.CRM_CONTACT_VIEW_ALL);
  const canManage = usePermission(PERMISSIONS.CRM_CONTACT_MANAGE);
  const owners = useManagerOptions();
  const isNew = initial.id === undefined;

  const duplicates = useContactDuplicates({
    phone: draft.phone,
    email: draft.email,
    excludeId: initial.id,
    enabled: true,
  });
  const found = duplicates.data ?? [];

  const ownerOptions: PickerOption[] = (owners.data ?? []).map((o) => ({
    id: o.id,
    label: o.name,
    ...(o.hint === undefined ? {} : { hint: o.hint }),
  }));
  const pick = (options: PickerOption[], id: string | null) => options.find((o) => o.id === id) ?? null;

  const nameMissing = draft.name.trim().length === 0;

  function submit() {
    if (nameMissing || save.isPending) return;
    save.mutate(draft, {
      onSuccess: (saved) => {
        toast.add({
          type: 'success',
          title: isNew ? 'Contact added' : 'Contact saved',
          description: saved.companyName === null ? saved.name : `${saved.name} · ${saved.companyName}`,
        });
        onSaved?.(saved);
        onClose();
      },
    });
  }

  const copy = actionErrorCopy(save.error, 'Saving the contact');

  return (
    <ShortcutLayer id={`modal:contact-${initial.id ?? 'new'}`}>
      <SaveShortcut onSave={submit} />

      <SheetHeader className="shrink-0 border-b">
        <SheetTitle>{isNew ? 'New contact' : initial.name}</SheetTitle>
        <SheetDescription>
          {isNew
            ? 'A person you sell to or through. Nothing here reaches Tally — a contact becomes a party only when they buy.'
            : 'Edit the contact. The change is audited under your name.'}
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

          <Field>
            <FieldLabel htmlFor="contact-name">Name</FieldLabel>
            <Input
              id="contact-name"
              autoFocus
              autoComplete="off"
              value={draft.name}
              onChange={(event) => {
                setDraft((current) => ({ ...current, name: event.target.value }));
              }}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="contact-phone">Phone</FieldLabel>
              <Input
                id="contact-phone"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={draft.phone}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, phone: event.target.value }));
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="contact-email">Email</FieldLabel>
              <Input
                id="contact-email"
                type="email"
                inputMode="email"
                autoComplete="off"
                value={draft.email}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, email: event.target.value }));
                }}
              />
            </Field>
          </div>

          {found.length > 0 ? (
            <Alert role="status" aria-live="polite">
              <UsersThreeIcon />
              <AlertTitle>
                {found.length === 1 ? 'A contact already has this' : `${found.length} contacts already have this`}
              </AlertTitle>
              <AlertDescription>
                <ul className="mt-1 flex flex-col gap-1">
                  {found.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-baseline gap-x-2">
                      <Link to={`/crm/contacts/${d.id}`} className="font-medium underline-offset-4 hover:underline">
                        {d.name}
                      </Link>
                      <span className="text-muted-foreground text-xs">
                        {[
                          d.companyName,
                          d.ownerName === null ? null : `owned by ${d.ownerName}`,
                          `same ${d.matchedOn.join(' and ')}`,
                        ]
                          .filter((p): p is string => p !== null)
                          .join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1">You can still save — this is a warning, not a refusal.</p>
              </AlertDescription>
            </Alert>
          ) : null}

          <Field>
            <FieldLabel htmlFor="contact-designation">Designation</FieldLabel>
            <Input
              id="contact-designation"
              autoComplete="off"
              placeholder="Purchase head, Director, Accounts"
              value={draft.designation}
              onChange={(event) => {
                setDraft((current) => ({ ...current, designation: event.target.value }));
              }}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="contact-company">Company</FieldLabel>
            <CompanyPicker
              id="contact-company"
              label="Company"
              placeholder="No company"
              icon={<BuildingsIcon className="text-muted-foreground" />}
              clearable
              clearLabel="No company"
              companyId={draft.companyId}
              onValueChange={(next) => {
                setDraft((current) => ({ ...current, companyId: next?.id ?? null }));
              }}
            />
          </Field>

          {canAssign ? (
            <Field>
              <FieldLabel htmlFor="contact-owner">Owner</FieldLabel>
              <RecordPicker
                id="contact-owner"
                label="Owner"
                placeholder={isNew ? 'You' : 'Nobody'}
                searchPlaceholder="Search by name or code"
                emptyMessage="Nobody matches that name or code."
                icon={<UserIcon className="text-muted-foreground" />}
                options={ownerOptions}
                loading={owners.isPending}
                clearable
                clearLabel={isNew ? 'You' : 'Nobody'}
                value={pick(ownerOptions, draft.ownerId)}
                onValueChange={(next) => {
                  setDraft((current) => ({ ...current, ownerId: next?.id ?? null }));
                }}
              />
              <FieldDescription>
                Who this contact belongs to. A view.self holder sees only what they own.
              </FieldDescription>
            </Field>
          ) : null}

          <Field>
            <FieldLabel htmlFor="contact-source">Source</FieldLabel>
            <Input
              id="contact-source"
              autoComplete="off"
              placeholder="Referral, website, an exhibition"
              value={draft.source}
              onChange={(event) => {
                setDraft((current) => ({ ...current, source: event.target.value }));
              }}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="contact-notes">Notes</FieldLabel>
            <Textarea
              id="contact-notes"
              rows={3}
              value={draft.notes}
              onChange={(event) => {
                setDraft((current) => ({ ...current, notes: event.target.value }));
              }}
            />
          </Field>
        </FieldGroup>
        {initial.id === undefined ? null : (
          <div className="mt-6 border-t pt-4">
            <ActivityTimeline subject={{ type: 'contact', id: initial.id }} canLog={canManage} />
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
        <Button className="flex-1 sm:flex-none" disabled={save.isPending || nameMissing} onClick={submit}>
          {save.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
          {save.isPending ? 'Saving' : 'Save'}
          <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
        </Button>
      </SheetFooter>

      {initial.id === undefined ? null : (
        <DeleteContactDialog
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
    id: 'contact-sheet.save',
    keys: 'ctrl+a',
    label: 'Accept / Save',
    scope: 'modal',
    allowInInput: true,
    run: onSave,
  });
  return null;
}
