import { useState } from 'react';
import { addDays } from 'date-fns';
import { ArrowRightIcon, BooksIcon, BuildingsIcon, TrashIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { ResolvedRateHint } from '@/features/pricing/resolved-rate-hint';
import { DateField } from '@/features/attendance/pickers';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { CompanyPicker } from '@/features/crm/company-picker';
import { useCompany } from '@/features/crm/use-crm';
import { DocumentEditor } from '@/features/documents/document-editor';
import { useDesignDraft } from '@/features/documents/use-design-draft';
import { useDraftBackup } from '@/features/documents/use-draft-backup';
import { PaperField, type PaperEditing, type PaperLine, type PaperModel } from '@/features/documents/paper';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { ItemPicker } from '@/features/masters/item-picker';
import { PartyPicker } from '@/features/masters/party-picker';
import { useParty } from '@/features/masters/use-parties';
import { type StockItem } from '@/features/masters/use-stock-items';
import { formatMoney } from '@/lib/format';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { ESTIMATE_TRANSITIONS, PARTY_LEDGER_GROUPS, PERMISSIONS, SALES_DOCUMENT_STATUS_LABELS, isEstimateStatus, type EstimateStatus } from '@vyuha/shared';

import { ItemHistoryAffordance } from './item-history-popover';
import { emptyEstimateDraft, estimateToDraft, newLine, previewLine, previewTotals, type Estimate, type EstimateDraft, type LineDraft } from './types';
import { useConvertEstimate, useDeleteEstimate, useEstimate, useSaveEstimate, useSetEstimateStatus } from './use-estimates';

/**
 * The estimate, as the page it prints on (REQ-W-01). The paper is the
 * editor: the buyer, the consignee, the dates, the details grid, every line
 * (item, HSN, quantity, rate, discount) and the terms are typed where they
 * will print. Enter on the last line adds one; the i beside a line shows
 * what this customer was charged for the item before (REQ-W-02).
 *
 * The page uses the whole screen: the paper is zoomed to fit the window's
 * height so a whole estimate is seen without scrolling, and the design rail
 * (templates, accent, what the page shows, the business details) opens on
 * request rather than sitting beside the paper. Preview flips the paper to
 * print view; PDF opens the print route in its own tab, where the browser's
 * print-to-PDF makes an A4 page; Excel downloads the workbook. Ctrl+A saves.
 */

export function EstimateEditorPage() {
  const params = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const isNew = params.id === undefined || params.id === 'new';
  const canViewSelf = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_SELF);
  const canViewAll = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_ALL);
  const canView = canViewSelf || canViewAll;
  const canCreate = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const record = useEstimate(canView && !isNew ? (params.id ?? null) : null);
  const settings = useDesignDraft();

  if (!canView || (isNew && !canCreate)) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WarningCircleIcon />
          </EmptyMedia>
          <EmptyTitle>{isNew ? 'You cannot raise estimates' : 'You cannot view estimates'}</EmptyTitle>
          <EmptyDescription>{isNew ? 'This needs sales.document.create — the Sales role carries it.' : 'This needs sales.document.view.self or sales.document.view.all.'}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (!isNew && record.isError) {
    return (
      <QueryErrorAlert
        error={record.error}
        subject="that estimate"
        onRetry={() => {
          void record.refetch();
        }}
      />
    );
  }
  if ((!isNew && record.data === undefined) || settings === null) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading the estimate" className="flex flex-col gap-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="mx-auto h-[420px] w-full max-w-[210mm]" />
      </div>
    );
  }
  const initial: EstimateDraft = isNew
    ? emptyEstimateDraft(toDateParam(new Date()), {
        ...(searchParams.get('deal') ? { dealId: searchParams.get('deal') } : {}),
        ...(searchParams.get('company') ? { companyId: searchParams.get('company') } : {}),
        ...(searchParams.get('party') ? { partyId: searchParams.get('party') } : {}),
        // An estimate is an offer for a while: thirty days unless the salesperson says otherwise.
        validUntil: toDateParam(addDays(new Date(), 30)),
        terms: settings.draft.designs.ESTIMATE.defaultTerms,
      })
    : estimateToDraft(record.data as Estimate);
  return <EstimateEditor key={isNew ? 'new' : (record.data as Estimate).id} initial={initial} record={isNew ? null : (record.data as Estimate)} settings={settings} />;
}

function EstimateEditor({ initial, record, settings }: { initial: EstimateDraft; record: Estimate | null; settings: NonNullable<ReturnType<typeof useDesignDraft>> }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<EstimateDraft>(initial);
  // What the server last confirmed; dirty is measured against this, not the prop the page mounted with.
  const [base, setBase] = useState<EstimateDraft>(initial);
  const adopt = (next: EstimateDraft) => {
    setDraft(next);
    setBase(next);
  };
  // Crash insurance for a new document: the unsaved draft mirrors into
  // sessionStorage and comes back if the tab reloads mid-typing.
  const backup = useDraftBackup('estimate', draft, record === null);

  const [backupOffered, setBackupOffered] = useState(false);
  if (!backupOffered && backup.restored !== null && record === null && JSON.stringify(backup.restored) !== JSON.stringify(draft)) {
    setBackupOffered(true);
    setDraft(backup.restored);
  }

  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveEstimate();
  const setStatus = useSetEstimateStatus();
  const remove = useDeleteEstimate();
  const convert = useConvertEstimate();
  const canSeeParties = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const canSeeCompanies = usePermission(PERMISSIONS.CRM_CONTACT_VIEW_SELF);
  const canCreate = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  // By id: the preset name below was read out of a 200-company page, so a
  // company past that got no preset at all.
  const presetCompany = useCompany(canSeeCompanies ? draft.companyId : null);

  const isNew = record === null;
  const editable = canCreate && draft.status === 'DRAFT';
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);

  // Resolved by id, not from a page-one list, so a party chosen past the first
  // page still fills the paper's buyer block and its "Addressed to" name.
  const party = useParty(draft.partyId).data ?? null;
  const presetName = party?.name ?? presetCompany.data?.name ?? null;
  const customerName = draft.customerName.trim() === '' && presetName !== null ? presetName : draft.customerName;
  const effectiveDraft: EstimateDraft = customerName === draft.customerName ? draft : { ...draft, customerName };
  const customerMissing = draft.partyId === null && draft.companyId === null && customerName.trim() === '';

  // Lines as the paper reads them: the server's figures when nothing changed, the preview while typing.
  const serverLines = record !== null && !dirty ? record.lines : null;
  const paperLines: PaperLine[] = draft.lines.map((line, index) => {
    const priced = serverLines?.[index] ?? null;
    const p = previewLine(line);
    return {
      key: line.key,
      stockItemId: line.stockItemId,
      description: line.description,
      hsnCode: line.hsnCode,
      quantity: line.quantity,
      unit: line.unit,
      rate: line.rate,
      discountPct: line.discountPct,
      taxPct: line.taxPct,
      amount: priced?.amount ?? (p === null ? null : p.amount.toFixed(2)),
      taxAmount: priced?.taxAmount ?? (p === null ? null : p.tax.toFixed(2)),
    };
  });
  const totals = (() => {
    if (serverLines !== null && record !== null) return { subtotal: record.subtotal, discountTotal: record.discountTotal, taxTotal: record.taxTotal, grandTotal: record.grandTotal, preview: false };
    return previewTotals(draft.lines);
  })();

  // The buyer's state code: what was typed, else the two digits a GSTIN starts with.
  const buyerStateCode = draft.placeOfSupply.trim() !== '' ? draft.placeOfSupply.trim() : (party?.gstin ?? '').slice(0, 2).replace(/\D/gu, '');
  const model: PaperModel = {
    type: 'ESTIMATE',
    number: record?.number ?? null,
    statusLabel: SALES_DOCUMENT_STATUS_LABELS[draft.status],
    date: draft.date,
    validUntil: draft.validUntil,
    buyer: { name: customerName, address: party?.address ?? '', gstin: party?.gstin ?? '', stateName: '', stateCode: buyerStateCode },
    shipTo: Object.values(draft.shipTo).some((v) => (v ?? '').trim() !== '') ? draft.shipTo : null,
    details: draft.details,
    reference: null,
    lines: paperLines,
    totals,
    notes: draft.notes,
    terms: draft.terms,
  };

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setDraft((current) => ({ ...current, lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)) }));
  }
  function chooseItem(key: string, item: StockItem | null) {
    updateLine(key, {
      stockItemId: item?.id ?? null,
      description: item?.name ?? '',
      unit: item?.unit ?? '',
      // 15 REQ-AN-13: the rate is left blank on purpose. The server resolves it
      // from the price lists at the document's date, and falls back to this very
      // Tally rate when no list names the item -- so prefilling it here only
      // hid the list. The picker's hint still shows what Tally holds.
      rate: '',
      taxPct: item?.gstRate === null || item?.gstRate === undefined ? '0' : String(Number(item.gstRate)),
    });
  }
  const editing: PaperEditing | undefined = editable
    ? {
        customer: (
          <div className="flex flex-col gap-1">
            <div className="grid gap-1 sm:grid-cols-2">
              <PartyPicker
                // Sundry Debtors: a sales document is raised on a customer. Unfiltered this
                // offered every supplier too.
                parentGroup={PARTY_LEDGER_GROUPS.CUSTOMER}
                id="estimate-party"
                label="Tally party"
                placeholder="Tally party"
                icon={<BooksIcon className="text-muted-foreground" />}
                enabled={canSeeParties}
                disabled={!canSeeParties}
                clearable
                clearLabel="No party"
                partyId={draft.partyId}
                onValueChange={(next) => {
                  setDraft((current) => ({ ...current, partyId: next?.id ?? null, companyId: next === null ? current.companyId : null, customerName: next?.name ?? current.customerName }));
                }}
              />
              <CompanyPicker
                id="estimate-company"
                label="CRM company"
                placeholder="or a CRM company"
                icon={<BuildingsIcon className="text-muted-foreground" />}
                enabled={canSeeCompanies}
                disabled={!canSeeCompanies || draft.partyId !== null}
                clearable
                clearLabel="No company"
                companyId={draft.companyId}
                onValueChange={(next) => {
                  setDraft((current) => ({ ...current, companyId: next?.id ?? null, customerName: next?.name ?? current.customerName }));
                }}
              />
            </div>
            <PaperField label="Addressed to" value={customerName} placeholder="Addressed to" className="font-bold" onChange={(value) => { setDraft((current) => ({ ...current, customerName: value })); }} />
          </div>
        ),
        date: (
          <DateField label="Estimate date" value={fromDateParam(draft.date)} onValueChange={(next) => { setDraft((current) => ({ ...current, date: toDateParam(next) })); }} yearsBack={1} yearsForward={1} className="paper-field h-auto min-h-0 px-0 py-0 shadow-none" />
        ),
        validUntil: (
          <DateField label="Valid until" value={draft.validUntil ? fromDateParam(draft.validUntil) : addDays(new Date(), 30)} onValueChange={(next) => { setDraft((current) => ({ ...current, validUntil: toDateParam(next) })); }} yearsBack={0} yearsForward={2} className="paper-field h-auto min-h-0 px-0 py-0 shadow-none" />
        ),
        setDate: (iso) => {
          setDraft((current) => ({ ...current, date: iso }));
        },
        setValidUntil: (iso) => {
          setDraft((current) => ({ ...current, validUntil: iso }));
        },
        itemPicker: (line) => {
          const draftLine = draft.lines.find((l) => l.key === line.key);
          return canSeeParties ? (
            <ItemPicker
              id={`estimate-line-item-${line.key}`}
              label="Stock item"
              placeholder="Stock item, or type below"
              searchPlaceholder="Search stock items"
              emptyMessage="No item matches. Leave it and type a description."
              clearable
              clearLabel="No stock item"
              value={draftLine?.stockItemId ? { id: draftLine.stockItemId, label: draftLine.description } : null}
              onValueChange={(next) => {
                chooseItem(line.key, next);
              }}
            />
          ) : null;
        },
        itemHistory: (line) => <ItemHistoryAffordance stockItemId={line.stockItemId} partyId={draft.partyId} companyId={draft.companyId} />,
        rateNote: (line) => (
          <ResolvedRateHint
            partyId={draft.partyId}
            stockItemId={line.stockItemId}
            quantity={line.quantity}
            date={draft.date}
            rate={line.rate}
            reason={draft.lines.find((l) => l.key === line.key)?.rateOverrideReason ?? ''}
            editable={editable}
            lineNo={model.lines.findIndex((l) => l.key === line.key) + 1}
            onUseRate={(next) => { updateLine(line.key, { rate: next }); }}
            onReasonChange={(next) => { updateLine(line.key, { rateOverrideReason: next }); }}
          />
        ),
        updateLine: (key, patch) => {
          updateLine(key, patch);
        },
        addLine: () => {
          setDraft((current) => ({ ...current, lines: [...current.lines, newLine()] }));
        },
        removeLine: (key) => {
          setDraft((current) => ({ ...current, lines: current.lines.length === 1 ? [newLine()] : current.lines.filter((line) => line.key !== key) }));
        },
        setNotes: (value) => {
          setDraft((current) => ({ ...current, notes: value }));
        },
        setTerms: (value) => {
          setDraft((current) => ({ ...current, terms: value }));
        },
        updateDetails: (patch) => {
          setDraft((current) => ({ ...current, details: { ...current.details, ...patch } }));
        },
        updateShipTo: (patch) => {
          setDraft((current) => ({ ...current, shipTo: patch === null ? {} : { ...current.shipTo, ...patch } }));
        },
        setPlaceOfSupply: (value) => {
          setDraft((current) => ({ ...current, placeOfSupply: value.replace(/\D/gu, '').slice(0, 2) }));
        },
      }
    : undefined;

  function submit() {
    if (customerMissing || save.isPending || !editable) return;
    save.mutate(effectiveDraft, {
      onSuccess: (saved) => {
        toast.add({ type: 'success', title: isNew ? `${saved.number} raised` : `${saved.number} saved`, description: `${saved.customerName} · ${formatMoney(saved.grandTotal)}` });
        backup.clear();
        if (isNew) void navigate(`/sales/estimates/${saved.id}`, { replace: true });
        else adopt(estimateToDraft(saved));
      },
    });
  }
  function move(status: EstimateStatus) {
    if (record === null) return;
    setStatus.mutate({ id: record.id, status }, { onSuccess: (saved) => { toast.add({ type: 'success', title: `${saved.number} ${SALES_DOCUMENT_STATUS_LABELS[saved.status].toLowerCase()}` }); adopt(estimateToDraft(saved)); } });
  }

  const failure = save.error ?? setStatus.error ?? remove.error ?? convert.error;
  const copy = actionErrorCopy(failure, save.error ? 'Saving the estimate' : convert.error ? 'Converting the estimate' : 'Changing the estimate');
  const transitions = record === null || !isEstimateStatus(record.status) ? [] : ESTIMATE_TRANSITIONS[record.status];
  const busy = save.isPending || setStatus.isPending || remove.isPending || convert.isPending;

  return (
    <ShortcutLayer id={`screen:estimate-editor-${record?.id ?? 'new'}`}>
      <SaveShortcut onSave={submit} />
      <DocumentEditor
        docType="ESTIMATE"
        backTo="/sales/estimates"
        backLabel="Estimates"
        title={isNew ? 'New estimate' : `Estimate ${record.number}`}
        badges={<StatusBadge state={draft.status} label={SALES_DOCUMENT_STATUS_LABELS[draft.status]} />}
        dirty={dirty}
        failure={failure ? copy : null}
        hint={customerMissing && editable ? 'Choose a Tally party or a CRM company, or type who it is addressed to.' : null}
        model={model}
        editing={editing}
        printPath={record === null ? null : `/print/estimates/${record.id}`}
        excel={record === null ? null : { path: `/sales/estimates/${record.id}/export.xlsx`, filename: `Estimate-${record.number}.xlsx` }}
        settings={settings}
        actions={
          <>
            {record !== null && transitions.length > 0 && !dirty ? (
              <Select value={record.status} onValueChange={(value: string | null) => { if (value !== null && isEstimateStatus(value) && value !== record.status) move(value); }}>
                <SelectTrigger className="w-40" aria-label="Status" disabled={busy}>
                  <SelectValue>{(value: string) => (isEstimateStatus(value) ? SALES_DOCUMENT_STATUS_LABELS[value] : value)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={record.status}>{SALES_DOCUMENT_STATUS_LABELS[record.status]}</SelectItem>
                  {transitions.map((next) => (
                    <SelectItem key={next} value={next}>
                      {SALES_DOCUMENT_STATUS_LABELS[next]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {record !== null && record.status === 'ACCEPTED' && canCreate ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { convert.mutate({ estimateId: record.id }, { onSuccess: (order) => { toast.add({ type: 'success', title: `${order.number} raised from ${record.number}` }); void navigate(`/sales/orders/${order.id}`); } }); }}>
                <ArrowRightIcon data-icon="inline-start" />
                Sales order
              </Button>
            ) : null}
            {record !== null && record.status === 'DRAFT' && canCreate ? (
              confirmDelete ? (
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => { remove.mutate(record.id, { onSuccess: () => { toast.add({ type: 'success', title: `${record.number} deleted` }); void navigate('/sales/estimates'); } }); }}>
                  <TrashIcon data-icon="inline-start" />
                  Delete for sure
                </Button>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setConfirmDelete(true); }}>
                  <TrashIcon data-icon="inline-start" />
                  Delete
                </Button>
              )
            ) : null}
            {editable ? (
              <Button size="sm" aria-label="Save estimate" disabled={busy || customerMissing || !dirty} onClick={submit}>
                {save.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
                {save.isPending ? 'Saving' : 'Save'}
                <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
              </Button>
            ) : null}
          </>
        }
      />
    </ShortcutLayer>
  );
}

function SaveShortcut({ onSave }: { onSave: () => void }) {
  useShortcut({ id: 'estimate-editor.save', keys: 'ctrl+a', label: 'Accept / Save', scope: 'screen', allowInInput: true, run: onSave });
  return null;
}
