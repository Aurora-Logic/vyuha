import { useState } from 'react';
import { BooksIcon, BuildingsIcon, TrashIcon, TrophyIcon, UserIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { NotesEditor } from '@/components/shared/notes-editor';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PresenceAvatars } from '@/components/shared/presence-avatars';
import { usePresence, useRecordViewers } from '@/lib/realtime/realtime-provider';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { DateField } from '@/features/attendance/pickers';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { useManagerOptions } from '@/features/employees/use-employee-mutations';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { PartyPicker } from '@/features/masters/party-picker';
import { useIsMobile } from '@/hooks/use-mobile';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { DEAL_PRIORITIES, PERMISSIONS, REALTIME_RESOURCES, type DealPriority } from '@vyuha/shared';

import { ActivityTimeline } from './activity-timeline';
import { DealAttachments } from './deal-attachments';
import { DealDocuments } from './deal-documents';
import { DeleteDealDialog } from './delete-dialogs';
import type { Deal, DealDraft } from './types';
import { useCompanyOptions } from './use-crm';
import { useCompanyContacts, useLinkCompanyParty, usePipelines, useSaveDeal } from './use-deals';

const NO_PRIORITY = '__none__';

const DEAL_PRIORITY_LABELS: Record<DealPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/**
 * One deal (REQ-U-05). Stage is a Select — moving through the pipeline needs
 * no mouse — and Ctrl+A saves. When a deal is won and its company has no
 * Tally party yet, the sheet offers the link (REQ-U-03): a picker over the
 * parties projection, chosen by a person, never matched by name.
 */

interface DealSheetProps {
  draft: DealDraft | null;
  record?: Deal | null;
  onOpenChange: (open: boolean) => void;
}

export function DealSheet({ draft, record, onOpenChange }: DealSheetProps) {
  const isMobile = useIsMobile();
  return (
    <Sheet open={draft !== null} onOpenChange={onOpenChange}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-md max-md:max-h-[90vh]">
        {draft ? (
          <DealSheetBody
            key={draft.id ?? 'new'}
            initial={draft}
            record={record ?? null}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function DealSheetBody({ initial, record, onClose }: { initial: DealDraft; record: Deal | null; onClose: () => void }) {
  const [draft, setDraft] = useState<DealDraft>(initial);
  const [deleting, setDeleting] = useState(false);
  const save = useSaveDeal();
  const link = useLinkCompanyParty();
  const canAssign = usePermission(PERMISSIONS.CRM_DEAL_VIEW_ALL);
  const canManageDeal = usePermission(PERMISSIONS.CRM_DEAL_MANAGE);
  const canSeeParties = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const pipelines = usePipelines();
  const companies = useCompanyOptions();
  const contacts = useCompanyContacts(draft.companyId);
  const owners = useManagerOptions();
  const isNew = initial.id === undefined;

  // REQ-U-10: say this deal is open for as long as the sheet is, and show
  // who else has it. A new deal has no id, so there is nothing to be in.
  const dealId = initial.id ?? null;
  usePresence(REALTIME_RESOURCES.CRM_DEAL, dealId);
  const viewers = useRecordViewers(REALTIME_RESOURCES.CRM_DEAL, dealId);

  const pipelineList = pipelines.data ?? [];
  const pipeline = pipelineList.find((p) => p.id === (draft.pipelineId ?? pipelineList.find((x) => x.isDefault)?.id)) ?? pipelineList[0] ?? null;
  const stages = pipeline?.stages ?? [];
  const currentStage = stages.find((s) => s.id === draft.stageId) ?? null;

  const wonWithoutParty = record !== null && record.status === 'won' && record.companyId !== null && record.partyId === null;

  const companyOptions: PickerOption[] = (companies.data ?? []).map((c) => ({ id: c.id, label: c.name, ...(c.city === null ? {} : { hint: c.city }) }));
  const contactOptions: PickerOption[] = (contacts.data ?? []).map((c) => ({ id: c.id, label: c.name, ...(c.designation === null ? {} : { hint: c.designation }) }));
  const ownerOptions: PickerOption[] = (owners.data ?? []).map((o) => ({ id: o.id, label: o.name, ...(o.hint === undefined ? {} : { hint: o.hint }) }));
  const pick = (options: PickerOption[], id: string | null) => options.find((o) => o.id === id) ?? null;

  const nameMissing = draft.name.trim().length === 0;
  const valueBad = draft.value.trim() !== '' && !/^\d{1,14}(\.\d{1,2})?$/u.test(draft.value.replace(/,/gu, '').trim());

  function submit() {
    if (nameMissing || valueBad || save.isPending) return;
    save.mutate(draft, {
      onSuccess: (saved) => {
        toast.add({
          type: 'success',
          title: isNew ? 'Deal added' : saved.status === 'won' && record?.status !== 'won' ? 'Deal won' : saved.status === 'lost' && record?.status !== 'lost' ? 'Deal marked lost' : 'Deal saved',
          description: saved.companyName === null ? saved.name : `${saved.name} · ${saved.companyName}`,
        });
        onClose();
      },
    });
  }

  const copy = actionErrorCopy(save.error ?? link.error, save.error ? 'Saving the deal' : 'Linking the party');

  return (
    <ShortcutLayer id={`modal:deal-${initial.id ?? 'new'}`}>
      <SaveShortcut onSave={submit} />

      <SheetHeader className="shrink-0 border-b">
        <SheetTitle className="flex items-center gap-2">
          {isNew ? 'New deal' : initial.name}
          {record?.status === 'won' ? <Badge>Won</Badge> : record?.status === 'lost' ? <Badge variant="outline">Lost</Badge> : null}
          {/* Beside the name, before the fields: whoever is about to type
              needs to know a colleague is already in here, and finding that
              out below the fold is finding it out too late. */}
          <PresenceAvatars viewers={viewers} className="ml-auto" />
        </SheetTitle>
        <SheetDescription>
          {isNew
            ? 'A deal has no accounting existence and is never pushed to Tally.'
            : record === null
              ? 'Edit the deal.'
              : `${record.pipelineName} · ${record.stageName} · ${String(record.probability)}%`}
        </SheetDescription>
      </SheetHeader>

      <Form onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto p-4">
        <FieldGroup>
          {save.isError || link.isError ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>{copy.title}</AlertTitle>
              <AlertDescription>{copy.description}</AlertDescription>
            </Alert>
          ) : null}

          {wonWithoutParty ? (
            <Alert>
              <TrophyIcon />
              <AlertTitle>Won — link {record.companyName} to its Tally party</AlertTitle>
              <AlertDescription>
                {canSeeParties ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <PartyPicker
                      label="Tally party"
                      placeholder="Choose the party Tally created"
                      icon={<BooksIcon className="text-muted-foreground" />}
                      enabled={wonWithoutParty && canSeeParties}
                      partyId={null}
                      onValueChange={(next) => {
                        if (next === null || record.companyId === null) return;
                        link.mutate(
                          { companyId: record.companyId, partyId: next.id },
                          {
                            onSuccess: () => {
                              toast.add({ type: 'success', title: 'Party linked', description: `${record.companyName ?? 'The company'} is now ${next.name} in Tally.` });
                            },
                          },
                        );
                      }}
                    />
                    <span className="text-muted-foreground text-xs">
                      Chosen by you, never matched by name. Invoices for this company go to that ledger.
                    </span>
                  </div>
                ) : (
                  'Somebody with masters.tally.view links the company to the party Tally created.'
                )}
              </AlertDescription>
            </Alert>
          ) : null}

          {record?.partyId !== null && record?.partyId !== undefined ? (
            <FieldDescription>
              Linked to a Tally party.{' '}
              <Link to={`/masters/parties?q=${encodeURIComponent((record.companyName ?? '').slice(0, 80))}`} className="underline-offset-4 hover:underline">
                Open the party
              </Link>
            </FieldDescription>
          ) : null}

          <Field>
            <FieldLabel htmlFor="deal-name">Name</FieldLabel>
            <Input
              id="deal-name"
              autoFocus
              autoComplete="off"
              value={draft.name}
              onChange={(event) => {
                setDraft((current) => ({ ...current, name: event.target.value }));
              }}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            {isNew && pipelineList.length > 1 ? (
              <Field>
                <FieldLabel htmlFor="deal-pipeline">Pipeline</FieldLabel>
                <Select
                  value={pipeline?.id ?? ''}
                  onValueChange={(next: string | null) => {
                    if (next) setDraft((current) => ({ ...current, pipelineId: next, stageId: null }));
                  }}
                >
                  <SelectTrigger id="deal-pipeline" aria-label="Pipeline" className="w-full">
                    <SelectValue>{(value: string) => pipelineList.find((p) => p.id === value)?.name ?? 'Choose'}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {pipelineList.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="deal-stage">Stage</FieldLabel>
              <Select
                value={draft.stageId ?? stages.find((s) => !s.isWon && !s.isLost)?.id ?? ''}
                onValueChange={(next: string | null) => {
                  if (next) setDraft((current) => ({ ...current, stageId: next }));
                }}
              >
                <SelectTrigger id="deal-stage" aria-label="Stage" className="w-full">
                  <SelectValue>{(value: string) => stages.find((s) => s.id === value)?.name ?? 'Choose'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                      <span className="text-muted-foreground ml-1 text-xs">
                        {s.isWon ? 'won' : s.isLost ? 'lost' : `${String(s.probability)}%`}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {currentStage !== null && (currentStage.isWon || currentStage.isLost) && record?.status === 'open' ? (
                <FieldDescription>Saving closes the deal as {currentStage.isWon ? 'won' : 'lost'}.</FieldDescription>
              ) : null}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="deal-value">Value</FieldLabel>
              <Input
                id="deal-value"
                inputMode="decimal"
                autoComplete="off"
                className="tabular-nums"
                placeholder="0.00"
                aria-invalid={valueBad}
                value={draft.value}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, value: event.target.value }));
                }}
              />
              {valueBad ? <FieldDescription>A number with up to two decimals.</FieldDescription> : null}
            </Field>
            <Field>
              <FieldLabel>Expected close</FieldLabel>
              {draft.expectedCloseDate === null ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start font-normal"
                  onClick={() => {
                    setDraft((current) => ({ ...current, expectedCloseDate: toDateParam(new Date()) }));
                  }}
                >
                  <span className="text-muted-foreground">Set a date</span>
                </Button>
              ) : (
                <div className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <DateField
                      label="Expected close date"
                      value={fromDateParam(draft.expectedCloseDate)}
                      onValueChange={(next) => {
                        setDraft((current) => ({ ...current, expectedCloseDate: toDateParam(next) }));
                      }}
                      yearsBack={1}
                      yearsForward={3}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Clear expected close date"
                    onClick={() => {
                      setDraft((current) => ({ ...current, expectedCloseDate: null }));
                    }}
                  >
                    <XIcon />
                  </Button>
                </div>
              )}
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="deal-company">Company</FieldLabel>
            <RecordPicker
              id="deal-company"
              label="Company"
              placeholder="No company"
              searchPlaceholder="Search companies"
              emptyMessage="No company matches that."
              icon={<BuildingsIcon className="text-muted-foreground" />}
              options={companyOptions}
              loading={companies.isPending}
              clearable
              clearLabel="No company"
              value={pick(companyOptions, draft.companyId)}
              onValueChange={(next) => {
                setDraft((current) => ({ ...current, companyId: next?.id ?? null, contactId: null }));
              }}
            />
          </Field>

          {draft.companyId !== null ? (
            <Field>
              <FieldLabel htmlFor="deal-contact">Contact</FieldLabel>
              <RecordPicker
                id="deal-contact"
                label="Contact"
                placeholder="No contact"
                searchPlaceholder="Search contacts at this company"
                emptyMessage="No contact at this company matches that."
                icon={<UserIcon className="text-muted-foreground" />}
                options={contactOptions}
                loading={contacts.isPending}
                clearable
                clearLabel="No contact"
                value={pick(contactOptions, draft.contactId)}
                onValueChange={(next) => {
                  setDraft((current) => ({ ...current, contactId: next?.id ?? null }));
                }}
              />
            </Field>
          ) : null}

          {canAssign ? (
            <Field>
              <FieldLabel htmlFor="deal-owner">Owner</FieldLabel>
              <RecordPicker
                id="deal-owner"
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
            </Field>
          ) : null}

          {/* Owner, 31 Aug 2026: the five things a pipeline review asks. */}
          <Field>
            <FieldLabel htmlFor="deal-lead-source">Lead source</FieldLabel>
            <Input
              id="deal-lead-source"
              placeholder="Referral, exhibition, cold call, existing customer"
              value={draft.leadSource}
              onChange={(event) => {
                setDraft((current) => ({ ...current, leadSource: event.target.value }));
              }}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="deal-priority">Priority</FieldLabel>
            <Select
              value={draft.priority ?? NO_PRIORITY}
              onValueChange={(next) => {
                if (next === null) return;
                setDraft((current) => ({ ...current, priority: next === NO_PRIORITY ? null : (next as DealPriority) }));
              }}
            >
              <SelectTrigger id="deal-priority" aria-label="Priority">
                <SelectValue>{(v: string) => (v === NO_PRIORITY ? 'Not set' : DEAL_PRIORITY_LABELS[v as DealPriority])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PRIORITY}>Not set</SelectItem>
                {DEAL_PRIORITIES.map((level) => (
                  <SelectItem key={level} value={level}>{DEAL_PRIORITY_LABELS[level]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel>Next follow-up</FieldLabel>
            {draft.nextFollowUpDate === null ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDraft((current) => ({ ...current, nextFollowUpDate: toDateParam(new Date()) }));
                }}
              >
                Set a date
              </Button>
            ) : (
              <span className="flex items-center gap-2">
                <DateField
                  label="Next follow-up"
                  value={fromDateParam(draft.nextFollowUpDate)}
                  onValueChange={(next) => {
                    setDraft((current) => ({ ...current, nextFollowUpDate: toDateParam(next) }));
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear the follow-up date"
                  onClick={() => {
                    setDraft((current) => ({ ...current, nextFollowUpDate: null }));
                  }}
                >
                  <XIcon />
                </Button>
              </span>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="deal-competitor">Competitor</FieldLabel>
            <Input
              id="deal-competitor"
              placeholder="Who else is quoting"
              value={draft.competitor}
              onChange={(event) => {
                setDraft((current) => ({ ...current, competitor: event.target.value }));
              }}
            />
          </Field>

          {/* Only where it belongs: a loss reason on an open deal is a
              question nobody asked. It stays visible once written, because
              the pattern of losses is the point of recording it. */}
          {record?.status === 'lost' || draft.lossReason !== '' ? (
            <Field>
              <FieldLabel htmlFor="deal-loss-reason">Loss reason</FieldLabel>
              <Input
                id="deal-loss-reason"
                placeholder="Price, delivery, specification, no decision"
                value={draft.lossReason}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, lossReason: event.target.value }));
                }}
              />
            </Field>
          ) : null}

          <Field>
            <FieldLabel htmlFor="deal-notes">Notes</FieldLabel>
            <NotesEditor
              id="deal-notes"
              value={draft.notes}
              onValueChange={(next) => {
                setDraft((current) => ({ ...current, notes: next }));
              }}
              placeholder="What was discussed, what was quoted, what happens next."
            />
          </Field>
        </FieldGroup>
        {record === null ? null : (
          <div className="mt-6 border-t pt-4">
            <DealAttachments dealId={record.id} />
          </div>
        )}
        {record === null ? null : (
          <div className="mt-6 border-t pt-4">
            <DealDocuments deal={record} />
          </div>
        )}
        {initial.id === undefined ? null : (
          <div className="mt-6 border-t pt-4">
            <ActivityTimeline subject={{ type: 'deal', id: initial.id }} canLog={canManageDeal} />
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
        <Button className="flex-1 sm:flex-none" disabled={save.isPending || nameMissing || valueBad} onClick={submit}>
          {save.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
          {save.isPending ? 'Saving' : 'Save'}
          <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
        </Button>
      </SheetFooter>

      {initial.id === undefined ? null : (
        <DeleteDealDialog
          target={deleting ? { id: initial.id, name: initial.name } : null}
          onOpenChange={(open) => {
            setDeleting(open);
          }}
          onDeleted={onClose}
        />
      )}
    </ShortcutLayer>
  );
}

function SaveShortcut({ onSave }: { onSave: () => void }) {
  useShortcut({
    id: 'deal-sheet.save',
    keys: 'ctrl+a',
    label: 'Accept / Save',
    scope: 'modal',
    allowInInput: true,
    run: onSave,
  });
  return null;
}
