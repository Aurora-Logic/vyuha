import { useState } from 'react';
import { ArrowsClockwiseIcon, BooksIcon, CheckIcon, LockKeyOpenIcon, PackageIcon, PencilSimpleIcon, ProhibitIcon, ReceiptIcon, TruckIcon, UploadSimpleIcon, WarningCircleIcon, XCircleIcon, HandGrabbingIcon } from '@phosphor-icons/react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ReasonDialog } from '@/components/shared/reason-dialog';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { ResolvedRateHint } from '@/features/pricing/resolved-rate-hint';
import { BrokenPromiseNote } from '@/features/collections/broken-promise-note';
import { DateField } from '@/features/attendance/pickers';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { DocumentEditor } from '@/features/documents/document-editor';
import { PaperField, type PaperEditing, type PaperLine, type PaperModel } from '@/features/documents/paper';
import { useDesignDraft } from '@/features/documents/use-design-draft';
import { useDraftBackup } from '@/features/documents/use-draft-backup';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { ItemPicker } from '@/features/masters/item-picker';
import { PartyPicker } from '@/features/masters/party-picker';
import { useParty } from '@/features/masters/use-parties';
import { type StockItem } from '@/features/masters/use-stock-items';
import { formatMoney } from '@/lib/format';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PARTY_LEDGER_GROUPS, PERMISSIONS, SALES_DOCUMENT_STATUS_LABELS } from '@vyuha/shared';

import { DispatchDialog } from './dispatch-dialog';
import { FulfilmentBadge } from './fulfilment-badge';
import { InvoiceDialog } from './invoice-dialog';
import { ItemHistoryAffordance } from './item-history-popover';
import { PickPackDialog } from './pick-pack-dialog';
import { creditBlockOf } from './credit-block';
import { FulfilmentSections, SyncStateBadge } from './sales-order-sheet';
import { emptyEstimateDraft, estimateToDraft, lineBalances, newLine, previewLine, type Estimate, type EstimateDraft, type LineDraft } from './types';
import { useDispatches } from './use-dispatches';
import { usePackRecords, useShortCloseOrder } from './use-fulfilment';
import { useAlterSalesOrder, useSalesOrder, useSalesOrderAction, useSaveSalesOrder } from './use-estimates';

/**
 * The sales order, as the page it prints on (REQ-W-03): the same paper as
 * the estimate, with the order's own verbs on the bar — Confirm and push,
 * Push again, Alter and re-push (REQ-W-07), Approve discount (REQ-W-08),
 * the credit release (REQ-W-09) — and, once confirmed, the fulfilment
 * verbs (Pack, Raise invoice, Dispatch, Short close) with the quantities,
 * what it waits on, its invoices, dispatches and pack records below the
 * paper (REQ-AA-29, AA-31, X-26). The dialogs are the ones the pick queue
 * and the board already use.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function SalesOrderEditorPage() {
  const params = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const isNew = params.id === undefined || params.id === 'new';
  const canViewSelf = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_SELF);
  const canViewAll = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_ALL);
  const canView = canViewSelf || canViewAll;
  const canCreate = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const record = useSalesOrder(canView && !isNew ? (params.id ?? null) : null);
  const settings = useDesignDraft();

  if (!canView || (isNew && !canCreate)) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WarningCircleIcon />
          </EmptyMedia>
          <EmptyTitle>{isNew ? 'You cannot raise sales orders' : 'You cannot view sales orders'}</EmptyTitle>
          <EmptyDescription>{isNew ? 'This needs sales.document.create — the Sales role carries it.' : 'This needs sales.document.view.self or sales.document.view.all.'}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (!isNew && record.isError) {
    return (
      <QueryErrorAlert
        error={record.error}
        subject="that sales order"
        onRetry={() => {
          void record.refetch();
        }}
      />
    );
  }
  if ((!isNew && record.data === undefined) || settings === null) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading the sales order" className="flex flex-col gap-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="mx-auto h-[420px] w-full max-w-[210mm]" />
      </div>
    );
  }
  const initial: EstimateDraft = isNew
    ? emptyEstimateDraft(toDateParam(new Date()), {
        ...(searchParams.get('deal') ? { dealId: searchParams.get('deal') } : {}),
        ...(searchParams.get('party') ? { partyId: searchParams.get('party') } : {}),
        terms: settings.draft.designs.SALES_ORDER.defaultTerms,
      })
    : estimateToDraft(record.data as Estimate);
  return <SalesOrderEditor key={isNew ? 'new' : (record.data as Estimate).id} initial={initial} record={isNew ? null : (record.data as Estimate)} settings={settings} />;
}

function SalesOrderEditor({ initial, record, settings }: { initial: EstimateDraft; record: Estimate | null; settings: NonNullable<ReturnType<typeof useDesignDraft>> }) {
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
  const backup = useDraftBackup('sales-order', draft, record === null);

  const [backupOffered, setBackupOffered] = useState(false);
  if (!backupOffered && backup.restored !== null && record === null && JSON.stringify(backup.restored) !== JSON.stringify(draft)) {
    setBackupOffered(true);
    setDraft(backup.restored);
  }

  const [altering, setAltering] = useState(false);
  const [dialog, setDialog] = useState<'pack' | 'invoice' | 'dispatch' | 'short-close' | 'credit-override' | null>(null);
  const save = useSaveSalesOrder();
  const alter = useAlterSalesOrder();
  const act = useSalesOrderAction();
  const shortClose = useShortCloseOrder();
  const canAlter = usePermission(PERMISSIONS.SALES_DOCUMENT_ALTER);
  const canApproveDiscount = usePermission(PERMISSIONS.SALES_DISCOUNT_APPROVE);
  const canCreate = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const canOverrideCredit = usePermission(PERMISSIONS.SALES_CREDIT_OVERRIDE);
  const canSeeMasters = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const isNew = record === null;
  const isDraft = draft.status === 'DRAFT';
  const editable = canCreate && (isDraft || altering);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const busy = save.isPending || alter.isPending || act.isPending;
  const partyMissing = draft.partyId === null;
  const emailProblem = draft.customerEmail.trim() !== '' && !EMAIL.test(draft.customerEmail.trim());
  const whatsappProblem = draft.customerWhatsapp.trim() !== '' && (draft.customerWhatsapp.trim().length < 6 || draft.customerWhatsapp.trim().length > 24);
  const contactInvalid = emailProblem || whatsappProblem;

  const confirmed = record !== null && record.status === 'CONFIRMED';
  const fulfilling = confirmed && record.shortClosedAt === null;
  const balances = record === null ? [] : record.lines.map(lineBalances);
  const canPack = canCreate && fulfilling && balances.some((b) => b.toPack > 0);
  // D-48: the owner's flow is pick, then pack; one button, named for the step that is next.
  const canPick = canCreate && fulfilling && balances.some((b) => b.toPick > 0);
  const canInvoice = canCreate && confirmed && record.partyId !== null && balances.some((b) => b.toInvoice > 0);
  const canDispatch = canCreate && fulfilling && balances.some((b) => b.toDispatch > 0);
  const canShortClose = canAlter && fulfilling && record.fulfilment !== 'closed';
  const packs = usePackRecords(confirmed ? record.id : null);
  const dispatches = useDispatches({ page: 1, pageSize: 50, ...(confirmed ? { documentId: record.id } : {}) }, { enabled: confirmed });

  // Resolved by id, not from a page-one list: the picker can now choose a party
  // past the first page, and the paper's buyer block (address, GSTIN, place of
  // supply) must resolve for it too.
  const party = useParty(draft.partyId).data ?? null;
  const customerName = draft.customerName.trim() === '' ? (party?.name ?? '') : draft.customerName;

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
    let gross = 0;
    let net = 0;
    let tax = 0;
    for (const line of draft.lines) {
      const p = previewLine(line);
      if (p === null) continue;
      gross += Number(line.quantity) * Number(line.rate);
      net += p.amount;
      tax += p.tax;
    }
    return { subtotal: net.toFixed(2), discountTotal: Math.max(0, gross - net).toFixed(2), taxTotal: tax.toFixed(2), grandTotal: (net + tax).toFixed(2), preview: true };
  })();
  const buyerStateCode = draft.placeOfSupply.trim() !== '' ? draft.placeOfSupply.trim() : (party?.gstin ?? '').slice(0, 2).replace(/\D/gu, '');
  const model: PaperModel = {
    type: 'SALES_ORDER',
    number: record?.number ?? null,
    statusLabel: SALES_DOCUMENT_STATUS_LABELS[draft.status],
    date: draft.date,
    validUntil: null,
    buyer: { name: customerName, address: party?.address ?? '', gstin: party?.gstin ?? '', stateName: '', stateCode: buyerStateCode },
    shipTo: Object.values(draft.shipTo).some((v) => (v ?? '').trim() !== '') ? draft.shipTo : null,
    details: draft.details,
    reference: record?.sourceDocumentId ? 'From an estimate' : null,
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
            <PartyPicker
              // Sundry Debtors: a sales document is raised on a customer. Unfiltered this
              // offered every supplier too.
              parentGroup={PARTY_LEDGER_GROUPS.CUSTOMER}
              id="order-party"
              label="Tally party"
              placeholder="Choose the party"
              icon={<BooksIcon className="text-muted-foreground" />}
              enabled={canSeeMasters}
              disabled={!canSeeMasters}
              partyId={draft.partyId}
              onValueChange={(next) => {
                setDraft((current) => ({ ...current, partyId: next?.id ?? null, customerName: next?.name ?? current.customerName }));
              }}
            />
            <PaperField label="Addressed to" value={customerName} placeholder="Addressed to" className="font-bold" onChange={(value) => { setDraft((current) => ({ ...current, customerName: value })); }} />
            <div className="grid grid-cols-2 gap-2 text-[0.9em]">
              <PaperField label="Customer email" value={draft.customerEmail} placeholder="Email for notifications" onChange={(value) => { setDraft((current) => ({ ...current, customerEmail: value })); }} />
              <PaperField label="Customer WhatsApp" value={draft.customerWhatsapp} placeholder="WhatsApp number" onChange={(value) => { setDraft((current) => ({ ...current, customerWhatsapp: value })); }} />
            </div>
          </div>
        ),
        date: <DateField label="Order date" value={fromDateParam(draft.date)} onValueChange={(next) => { if (isDraft) setDraft((current) => ({ ...current, date: toDateParam(next) })); }} yearsBack={1} yearsForward={1} className="paper-field h-auto min-h-0 px-0 py-0 shadow-none" />,
        setDate: (iso) => {
          if (isDraft) setDraft((current) => ({ ...current, date: iso }));
        },
        itemPicker: (line) => {
          const draftLine = draft.lines.find((l) => l.key === line.key);
          return canSeeMasters ? (
            <ItemPicker
              id={`order-line-item-${line.key}`}
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
    if (partyMissing || busy || !editable || contactInvalid) return;
    const effective = { ...draft, customerName };
    if (altering) {
      alter.mutate(effective, {
        onSuccess: (saved) => {
          toast.add({ type: 'success', title: `${saved.number} altered`, description: 'Re-queued for Tally against the same voucher.' });
          setAltering(false);
          adopt(estimateToDraft(saved));
        },
      });
      return;
    }
    save.mutate(effective, {
      onSuccess: (saved) => {
        toast.add({ type: 'success', title: isNew ? `${saved.number} raised` : `${saved.number} saved`, description: `${saved.customerName} · ${formatMoney(saved.grandTotal)}` });
        backup.clear();
        if (isNew) void navigate(`/sales/orders/${saved.id}`, { replace: true });
        else adopt(estimateToDraft(saved));
      },
    });
  }
  function run(action: 'confirm' | 'approve' | 'push' | 'cancel', creditOverrideReason?: string) {
    if (record === null) return;
    act.mutate(
      { id: record.id, action, ...(creditOverrideReason === undefined ? {} : { body: { creditOverrideReason } }) },
      {
        onSuccess: (saved) => {
          toast.add({
            type: 'success',
            title:
              action === 'cancel'
                ? `${saved.number} cancelled`
                : saved.status === 'PENDING_APPROVAL'
                  ? `${saved.number} sent for approval`
                  : saved.syncState === 'QUEUED'
                    ? `${saved.number} queued for Tally`
                    : `${saved.number} confirmed`,
            description:
              saved.status === 'PENDING_APPROVAL'
                ? 'The discount is past the threshold; a Sales manager decides it in the Approvals inbox.'
                : action !== 'cancel' && saved.syncState === 'NOT_PUSHED'
                  ? 'No agent connection can carry it yet; push it when one is issued.'
                  : undefined,
          });
          setDialog(null);
          // The paper follows the record: a confirmed order is no longer a draft on screen.
          adopt(estimateToDraft(saved));
        },
        onError: () => {
          if (creditOverrideReason !== undefined) setDialog(null);
        },
      },
    );
  }

  const creditBlock = creditBlockOf(act.error);
  const failure = save.error ?? alter.error ?? (creditBlock === null ? act.error : null);
  const copy = actionErrorCopy(failure, save.error ? 'Saving the order' : alter.error ? 'Altering the order' : 'Changing the order');

  return (
    <ShortcutLayer id={`screen:sales-order-editor-${record?.id ?? 'new'}`}>
      <SaveShortcut onSave={submit} />
      <DocumentEditor
        docType="SALES_ORDER"
        backTo="/sales/orders"
        backLabel="Sales orders"
        title={isNew ? 'New sales order' : `Sales order ${record.number}`}
        badges={
          <>
            <StatusBadge state={draft.status} label={SALES_DOCUMENT_STATUS_LABELS[draft.status]} />
            {record === null ? null : <SyncStateBadge record={record} />}
            {record?.fulfilment && confirmed ? <FulfilmentBadge state={record.fulfilment} /> : null}
          </>
        }
        dirty={dirty}
        failure={failure ? copy : null}
        hint={partyMissing && editable ? 'Choose the Tally party the order is for.' : contactInvalid ? 'The customer email or WhatsApp number is not valid.' : null}
        model={model}
        editing={editing}
        printPath={record === null ? null : `/print/orders/${record.id}`}
        excel={record === null ? null : { path: `/sales/orders/${record.id}/export.xlsx`, filename: `Sales-Order-${record.number}.xlsx` }}
        settings={settings}
        extras={
          record !== null ? (
            <div className="flex flex-col gap-4">
              {/* 15 REQ-AJ-10 / D-54: the promise flag sits with the limit and never blocks. */}
              <BrokenPromiseNote partyId={record.partyId} />
              {creditBlock !== null ? (
                <Alert variant="destructive">
                  <WarningCircleIcon />
                  <AlertTitle>{creditBlock.position.partyName} is over its credit limit</AlertTitle>
                  <AlertDescription>
                    <p>
                      Exposure {formatMoney(creditBlock.position.exposure)} + open orders {formatMoney(creditBlock.position.openOrders)} + this order {formatMoney(creditBlock.orderTotal)} &gt; limit {formatMoney(creditBlock.position.creditLimit)}.
                    </p>
                    <p className="mt-1">{canOverrideCredit ? 'You hold sales.credit.override: release it with a reason, which is audited.' : `Releasing it needs ${creditBlock.requiredPermission}; ask a holder to confirm it with a reason.`}</p>
                  </AlertDescription>
                  {canOverrideCredit ? (
                    <AlertAction>
                      <Button size="sm" variant="outline" onClick={() => { setDialog('credit-override'); }}>
                        <LockKeyOpenIcon data-icon="inline-start" />
                        Release with reason
                      </Button>
                    </AlertAction>
                  ) : null}
                </Alert>
              ) : null}
              {record.syncState === 'FAILED' && record.lastError ? (
                <Alert variant="destructive">
                  <XCircleIcon />
                  <AlertTitle>Tally rejected it</AlertTitle>
                  <AlertDescription>
                    <p className="font-mono text-xs">{record.lastError}</p>
                    <p className="mt-1">Tally&rsquo;s own words. Fix the cause there or here, then push again.</p>
                  </AlertDescription>
                </Alert>
              ) : null}
              {confirmed ? <FulfilmentSections
                record={record}
                packs={packs}
                dispatches={dispatches}
                verbs={canCreate ? { onPack: () => { setDialog('pack'); }, onInvoice: () => { setDialog('invoice'); }, onDispatch: () => { setDialog('dispatch'); } } : null}
              /> : null}
            </div>
          ) : undefined
        }
        actions={
          <>
            {!isNew && (isDraft || draft.status === 'PENDING_APPROVAL') ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { run('cancel'); }}>
                <XCircleIcon data-icon="inline-start" />
                Cancel order
              </Button>
            ) : null}
            {!isNew && draft.status === 'PENDING_APPROVAL' && canApproveDiscount ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { run('approve'); }}>
                <CheckIcon data-icon="inline-start" />
                Approve discount
              </Button>
            ) : null}
            {!isNew && draft.status === 'PENDING_APPROVAL' && !canApproveDiscount ? (
              <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/approvals" />}>
                Open approvals
              </Button>
            ) : null}
            {!isNew && isDraft && !dirty ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { run('confirm'); }}>
                <CheckIcon data-icon="inline-start" />
                Confirm and push
              </Button>
            ) : null}
            {!isNew && draft.status === 'CONFIRMED' && (record?.syncState === 'NOT_PUSHED' || record?.syncState === 'FAILED') ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { run('push'); }}>
                <UploadSimpleIcon data-icon="inline-start" />
                {record.syncState === 'FAILED' ? 'Push again' : 'Push to Tally'}
              </Button>
            ) : null}
            {!isNew && record?.syncState === 'PUSHED' && canAlter && !altering ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { setAltering(true); }}>
                <PencilSimpleIcon data-icon="inline-start" />
                Alter
              </Button>
            ) : null}
            {canShortClose && !altering ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { setDialog('short-close'); }}>
                <ProhibitIcon data-icon="inline-start" />
                Short close
              </Button>
            ) : null}
            {(canPack || canPick) && !altering ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { setDialog('pack'); }}>
                {canPack ? <PackageIcon data-icon="inline-start" /> : <HandGrabbingIcon data-icon="inline-start" />}
                {canPack ? 'Pack' : 'Pick'}
              </Button>
            ) : null}
            {canInvoice && !altering ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { setDialog('invoice'); }}>
                <ReceiptIcon data-icon="inline-start" />
                Raise invoice
              </Button>
            ) : null}
            {canDispatch && !altering ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { setDialog('dispatch'); }}>
                <TruckIcon data-icon="inline-start" />
                Dispatch
              </Button>
            ) : null}
            {editable ? (
              <Button size="sm" aria-label={altering ? 'Alter and re-push' : 'Save sales order'} disabled={busy || partyMissing || contactInvalid || !dirty} onClick={submit}>
                {busy ? <Spinner data-icon="inline-start" /> : altering ? <ArrowsClockwiseIcon data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
                {altering ? 'Alter and re-push' : save.isPending ? 'Saving' : 'Save'}
                <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
              </Button>
            ) : null}
          </>
        }
      />

      <ReasonDialog
        open={dialog === 'credit-override'}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        title={`Release ${record?.number ?? 'this order'} past the credit limit?`}
        description="The order confirms and queues for Tally although the party is over its limit. The position and your reason are recorded."
        consequences={creditBlock === null ? [] : [`${creditBlock.position.partyName}: exposure ${formatMoney(creditBlock.position.exposure)}, open orders ${formatMoney(creditBlock.position.openOrders)}, limit ${formatMoney(creditBlock.position.creditLimit)}.`, `This order adds ${formatMoney(creditBlock.orderTotal)}.`]}
        prompt="Why is this order being released?"
        hint="Kept in the audit log against your name."
        confirmLabel="Release and confirm"
        pendingLabel="Confirming"
        confirmIcon={<LockKeyOpenIcon data-icon="inline-start" />}
        pending={act.isPending}
        error={null}
        onConfirm={(reason) => {
          run('confirm', reason);
        }}
      />
      {record === null ? null : (
        <>
          <PickPackDialog open={dialog === 'pack'} onOpenChange={(next) => { if (!next) setDialog(null); }} order={record} onPacked={() => { setDialog(null); }} />
          <InvoiceDialog open={dialog === 'invoice'} onOpenChange={(next) => { if (!next) setDialog(null); }} order={record} />
          <DispatchDialog open={dialog === 'dispatch'} onOpenChange={(next) => { if (!next) setDialog(null); }} order={record} />
          <ReasonDialog
            open={dialog === 'short-close'}
            onOpenChange={(next) => {
              if (!next) {
                setDialog(null);
                shortClose.reset();
              }
            }}
            title={`Short-close ${record.number}?`}
            description="The balance that has not left is written off. It comes off the pick queue and its shortage requirements close."
            consequences={['What is packed, invoiced or dispatched stays as it is.', 'The order no longer returns to the pick queue.', 'Recorded against your name in the audit log; it cannot be undone from here.']}
            prompt="Why is the balance being written off?"
            hint="The customer cancelled the rest, the item is discontinued — the reason is kept on the order."
            confirmLabel="Short close"
            pendingLabel="Closing"
            confirmIcon={<ProhibitIcon data-icon="inline-start" />}
            destructive
            pending={shortClose.isPending}
            error={shortClose.error}
            onConfirm={(reason) => {
              shortClose.mutate(
                { documentId: record.id, reason },
                {
                  onSuccess: (saved) => {
                    toast.add({ type: 'success', title: `${saved.number} short-closed`, description: 'The balance is written off; the order is closed.' });
                    setDialog(null);
                  },
                },
              );
            }}
          />
        </>
      )}
    </ShortcutLayer>
  );
}

function SaveShortcut({ onSave }: { onSave: () => void }) {
  useShortcut({ id: 'sales-order-editor.save', keys: 'ctrl+a', label: 'Accept / Save', scope: 'screen', allowInInput: true, run: onSave });
  return null;
}
