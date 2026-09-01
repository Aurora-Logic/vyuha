import { useState } from 'react';
import { ArrowRightIcon, BooksIcon, BuildingsIcon, TrashIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { useNavigate } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { duplicateWarning } from '@/components/shared/duplicate-flag';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { DateField } from '@/features/attendance/pickers';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { useCompanyOptions } from '@/features/crm/use-crm';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { useParties } from '@/features/masters/use-parties';
import { PartyPicker } from '@/features/masters/party-picker';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatMoney } from '@/lib/format';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { ESTIMATE_TRANSITIONS, PARTY_LEDGER_GROUPS, PERMISSIONS, SALES_DOCUMENT_STATUS_LABELS, isEstimateStatus, type EstimateStatus } from '@vyuha/shared';

import { DocumentLinesEditor } from './document-lines-editor';
import type { Estimate, EstimateDraft } from './types';
import { useConvertEstimate, useDeleteEstimate, useSaveEstimate, useSetEstimateStatus } from './use-estimates';

/**
 * One estimate (REQ-W-01): the header, the line editor, the totals, and the
 * status controls. Wider than the record sheets because a line has six
 * columns; on a phone the lines stack. Every control is a keyboard control
 * and Ctrl+A saves; Enter on the last line's last box adds a line, the way
 * Tally's voucher entry runs on — Alt+N is the calculator's, globally.
 *
 * Amounts while typing are a preview (`previewLine`), replaced by the
 * server's figures on save; the footer says so until then.
 */

interface EstimateSheetProps {
  draft: EstimateDraft | null;
  record?: Estimate | null;
  onOpenChange: (open: boolean) => void;
}

export function EstimateSheet({ draft, record, onOpenChange }: EstimateSheetProps) {
  const isMobile = useIsMobile();
  return (
    <Sheet open={draft !== null} onOpenChange={onOpenChange}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-3xl max-md:max-h-[92vh]">
        {draft ? (
          <EstimateSheetBody
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

function EstimateSheetBody({ initial, record, onClose }: { initial: EstimateDraft; record: Estimate | null; onClose: () => void }) {
  const [draft, setDraft] = useState<EstimateDraft>(initial);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveEstimate();
  const setStatus = useSetEstimateStatus();
  const remove = useDeleteEstimate();
  const convert = useConvertEstimate();
  const navigate = useNavigate();
  const canSeeParties = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const canSeeCompanies = usePermission(PERMISSIONS.CRM_CONTACT_VIEW_SELF);
  const parties = useParties({ page: 1 }, { enabled: canSeeParties });
  const companies = useCompanyOptions({ enabled: canSeeCompanies });
  const isNew = initial.id === undefined;
  const editable = draft.status === 'DRAFT';

  const partyOptions: PickerOption[] = (parties.data?.data ?? []).map((p) => ({ id: p.id, label: p.name, ...(p.gstin === null ? {} : { hint: p.gstin }), ...(p.duplicate ? { warning: duplicateWarning(p.duplicate) } : {}) }));
  const companyOptions: PickerOption[] = (companies.data ?? []).map((c) => ({ id: c.id, label: c.name, ...(c.city === null ? {} : { hint: c.city }) }));
  const pick = (options: PickerOption[], id: string | null) => options.find((o) => o.id === id) ?? null;

  // Raised from a record (deal, company, party) the name arrives with the
  // options, not the URL: "Addressed to" shows the party's or company's name
  // until somebody types over it, and that is what is saved.
  const presetName = pick(partyOptions, draft.partyId)?.label ?? pick(companyOptions, draft.companyId)?.label ?? null;
  const customerName = draft.customerName.trim() === '' && presetName !== null ? presetName : draft.customerName;
  const effectiveDraft: EstimateDraft = customerName === draft.customerName ? draft : { ...draft, customerName };

  const customerMissing = draft.partyId === null && draft.companyId === null && customerName.trim() === '';
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  function submit() {
    if (customerMissing || save.isPending || !editable) return;
    save.mutate(effectiveDraft, {
      onSuccess: (saved) => {
        toast.add({ type: 'success', title: isNew ? `${saved.number} raised` : `${saved.number} saved`, description: `${saved.customerName} · ${formatMoney(saved.grandTotal)}` });
        onClose();
      },
    });
  }

  function move(status: EstimateStatus) {
    if (initial.id === undefined) return;
    setStatus.mutate(
      { id: initial.id, status },
      {
        onSuccess: (saved) => {
          toast.add({ type: 'success', title: `${saved.number} ${SALES_DOCUMENT_STATUS_LABELS[saved.status].toLowerCase()}` });
          onClose();
        },
      },
    );
  }

  const failure = save.error ?? setStatus.error ?? remove.error;
  const copy = actionErrorCopy(failure, save.error ? 'Saving the estimate' : setStatus.error ? 'Changing the status' : 'Deleting the estimate');
  const nextStatuses = isEstimateStatus(draft.status) ? ESTIMATE_TRANSITIONS[draft.status] : [];

  return (
    <ShortcutLayer id={`modal:estimate-${initial.id ?? 'new'}`}>
      <SheetShortcuts onSave={submit} />

      <SheetHeader className="shrink-0 border-b">
        <SheetTitle className="flex items-center gap-2">
          {isNew ? 'New estimate' : `Estimate ${initial.number ?? ''}`}
          {isNew ? null : <StatusBadge state={draft.status} label={SALES_DOCUMENT_STATUS_LABELS[draft.status]} />}
        </SheetTitle>
        <SheetDescription>
          {isNew
            ? 'Vyuha-owned; never pushed to Tally. Taxes are shown for information.'
            : editable
              ? 'A draft: lines and header may change. Sending it makes it read-only.'
              : `Read-only while ${SALES_DOCUMENT_STATUS_LABELS[draft.status].toLowerCase()}. ${record?.ownerName ? `Owned by ${record.ownerName}.` : ''}`}
        </SheetDescription>
      </SheetHeader>

      <Form onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto p-4">
        <FieldGroup>
          {failure ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>{copy.title}</AlertTitle>
              <AlertDescription>{copy.description}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            {canSeeParties ? (
              <Field>
                <FieldLabel htmlFor="estimate-party">Tally party</FieldLabel>
                <PartyPicker
                  // Sundry Debtors: a sales document is raised on a customer. Unfiltered this
                  // offered every supplier too.
                  parentGroup={PARTY_LEDGER_GROUPS.CUSTOMER}
                  id="estimate-party"
                  label="Tally party"
                  placeholder="Not a party yet"
                  icon={<BooksIcon className="text-muted-foreground" />}
                  enabled={canSeeParties}
                  clearable
                  clearLabel="Not a party yet"
                  disabled={!editable}
                  partyId={draft.partyId}
                  onValueChange={(next) => {
                    setDraft((current) => ({ ...current, partyId: next?.id ?? null, customerName: next?.name ?? current.customerName }));
                  }}
                />
              </Field>
            ) : null}
            {canSeeCompanies ? (
              <Field>
                <FieldLabel htmlFor="estimate-company">CRM company</FieldLabel>
                <RecordPicker
                  id="estimate-company"
                  label="CRM company"
                  placeholder="No company"
                  searchPlaceholder="Search companies"
                  emptyMessage="No company matches."
                  icon={<BuildingsIcon className="text-muted-foreground" />}
                  options={companyOptions}
                  loading={companies.isPending}
                  clearable
                  clearLabel="No company"
                  disabled={!editable}
                  value={pick(companyOptions, draft.companyId)}
                  onValueChange={(next) => {
                    setDraft((current) => ({
                      ...current,
                      companyId: next?.id ?? null,
                      customerName: current.partyId === null ? (next?.label ?? current.customerName) : current.customerName,
                    }));
                  }}
                />
              </Field>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field className="sm:col-span-1">
              <FieldLabel htmlFor="estimate-customer">Addressed to</FieldLabel>
              <Input
                id="estimate-customer"
                autoComplete="organization"
                placeholder="Customer name as printed"
                disabled={!editable}
                value={customerName}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, customerName: event.target.value }));
                }}
              />
            </Field>
            <Field>
              <FieldLabel>Date</FieldLabel>
              <DateField
                label="Estimate date"
                value={fromDateParam(draft.date)}
                onValueChange={(next) => {
                  if (editable) setDraft((current) => ({ ...current, date: toDateParam(next) }));
                }}
                yearsBack={1}
                yearsForward={1}
              />
            </Field>
            <Field>
              <FieldLabel>Valid until</FieldLabel>
              {draft.validUntil === null ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start font-normal"
                  disabled={!editable}
                  onClick={() => {
                    setDraft((current) => ({ ...current, validUntil: toDateParam(new Date(Date.now() + 30 * 86_400_000)) }));
                  }}
                >
                  <span className="text-muted-foreground">Open-ended — set a date</span>
                </Button>
              ) : (
                <div className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <DateField
                      label="Valid until"
                      value={fromDateParam(draft.validUntil)}
                      onValueChange={(next) => {
                        if (editable) setDraft((current) => ({ ...current, validUntil: toDateParam(next) }));
                      }}
                      yearsBack={0}
                      yearsForward={2}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Clear valid-until"
                    disabled={!editable}
                    onClick={() => {
                      setDraft((current) => ({ ...current, validUntil: null }));
                    }}
                  >
                    <XIcon />
                  </Button>
                </div>
              )}
            </Field>
          </div>

          <DocumentLinesEditor
            documentDate={draft.date}
            lines={draft.lines}
            onLinesChange={(next) => {
              setDraft((current) => ({ ...current, lines: next }));
            }}
            editable={editable}
            canPickItems={canSeeParties}
            partyId={draft.partyId}
            companyId={draft.companyId}
            saved={record}
            dirty={dirty}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="estimate-notes">Notes</FieldLabel>
              <Textarea id="estimate-notes" rows={3} disabled={!editable} value={draft.notes} onChange={(e) => { setDraft((c) => ({ ...c, notes: e.target.value })); }} />
            </Field>
            <Field>
              <FieldLabel htmlFor="estimate-terms">Terms</FieldLabel>
              <Textarea id="estimate-terms" rows={3} disabled={!editable} value={draft.terms} onChange={(e) => { setDraft((c) => ({ ...c, terms: e.target.value })); }} />
            </Field>
          </div>
        </FieldGroup>
      </Form>

      <SheetFooter className="shrink-0 flex-row flex-wrap justify-end gap-2 border-t">
        {!isNew && editable ? (
          confirmDelete ? (
            <span className="mr-auto flex items-center gap-2 text-sm">
              Delete this draft?
              <Button variant="destructive" size="sm" disabled={remove.isPending} onClick={() => { if (initial.id) remove.mutate(initial.id, { onSuccess: () => { toast.add({ type: 'success', title: `${initial.number ?? 'Draft'} deleted` }); onClose(); } }); }}>
                {remove.isPending ? <Spinner data-icon="inline-start" /> : <TrashIcon data-icon="inline-start" />}
                Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setConfirmDelete(false); }}>Keep</Button>
            </span>
          ) : (
            <Button variant="outline" className="mr-auto" onClick={() => { setConfirmDelete(true); }} aria-label={`Delete ${initial.number ?? 'draft'}`}>
              <TrashIcon data-icon="inline-start" />
              Delete
            </Button>
          )
        ) : null}
        {!isNew && draft.status === 'ACCEPTED' ? (
          // REQ-W-03: an accepted estimate becomes a sales order carrying its lines.
          <Button
            variant="outline"
            disabled={convert.isPending || draft.partyId === null}
            title={draft.partyId === null ? 'Addressed to a prospect: choose the Tally party on the order' : undefined}
            onClick={() => {
              if (initial.id === undefined) return;
              convert.mutate(
                { estimateId: initial.id },
                {
                  onSuccess: (order) => {
                    toast.add({ type: 'success', title: `${order.number} raised from ${initial.number ?? 'the estimate'}` });
                    void navigate(`/sales/orders/${order.id}`);
                  },
                  onError: (error) => {
                    toast.add({ type: 'error', title: 'Could not convert', description: error.message });
                  },
                },
              );
            }}
          >
            {convert.isPending ? <Spinner data-icon="inline-start" /> : <ArrowRightIcon data-icon="inline-start" />}
            Sales order
          </Button>
        ) : null}
        {!isNew && nextStatuses.length > 0 ? (
          <Select
            value=""
            onValueChange={(next: string | null) => {
              const parsed = nextStatuses.find((s) => s === next);
              if (parsed) move(parsed);
            }}
          >
            <SelectTrigger aria-label="Change status" className="w-40" disabled={setStatus.isPending}>
              <SelectValue placeholder="Mark as…">{() => 'Mark as…'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {nextStatuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {SALES_DOCUMENT_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          {editable ? 'Cancel' : 'Close'}
        </Button>
        {editable ? (
          <Button disabled={save.isPending || customerMissing} onClick={submit}>
            {save.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
            {save.isPending ? 'Saving' : 'Save'}
            <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
          </Button>
        ) : null}
      </SheetFooter>
    </ShortcutLayer>
  );
}

function SheetShortcuts({ onSave }: { onSave: () => void }) {
  useShortcut({ id: 'estimate-sheet.save', keys: 'ctrl+a', label: 'Accept / Save', scope: 'modal', allowInInput: true, run: onSave });
  return null;
}
