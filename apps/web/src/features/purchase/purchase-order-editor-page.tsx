import { useState } from 'react';
import { BooksIcon, CheckIcon, ClockCounterClockwiseIcon, HourglassMediumIcon, PackageIcon, ProhibitIcon, SealCheckIcon, UploadSimpleIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ReasonDialog } from '@/components/shared/reason-dialog';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
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
import { SyncStateBadge } from '@/features/sales/sales-order-sheet';
import { newLine, previewLine, type LineDraft } from '@/features/sales/types';
import { formatMoney, formatRelativeAge } from '@/lib/format';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, PO_FULFILMENT_LABELS, PURCHASE_ORDER_STATUS_LABELS } from '@vyuha/shared';

import { AllocateDialog } from './allocation-form';
import { GrnDialog } from './grn-dialog';
import { ItemPurchasingSheet } from './item-purchasing-sheet';
import { OptionalDateField } from './optional-date-field';
import { ReceiptLines, TakenUp, VendorCopy } from './purchase-order-sheet';
import { draftFingerprint, emptyPurchaseOrderDraft, formatQty, lineBalance, purchaseOrderToDraft, type Grn, type PurchaseOrder, type PurchaseOrderDraft } from './types';
import { usePurchaseOrder, usePurchaseOrderAction, useSavePurchaseOrder, useShortClosePurchaseOrder } from './use-purchase';

/**
 * The purchase order, as the page it prints on (REQ-X-13): the same paper
 * the sales documents wear, with the vendor where the buyer stands and the
 * order's own verbs on the bar — Confirm and push, or send for approval
 * over the threshold (REQ-X-16); Approve and push; Push again; Cancel;
 * Short close (REQ-X-23); Receive (REQ-X-20). Beneath the paper: what has
 * arrived against each line, which requirements the order took up
 * (REQ-X-10), and the vendor's copy to send by hand (REQ-X-18). The i on a
 * line opens the item's buying facts: on hand, on order, what this vendor
 * charged before (REQ-X-14, REQ-X-24).
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function PurchaseOrderEditorPage() {
  const params = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const isNew = params.id === undefined || params.id === 'new';
  const canView = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_VIEW);
  const canCreate = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_CREATE);
  const record = usePurchaseOrder(canView && !isNew ? (params.id ?? null) : null);
  const settings = useDesignDraft();

  if (!canView || (isNew && !canCreate)) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WarningCircleIcon />
          </EmptyMedia>
          <EmptyTitle>{canView ? 'You cannot raise purchase orders' : 'You cannot view purchase orders'}</EmptyTitle>
          <EmptyDescription>{canView ? 'This needs purchase.document.create — the Purchase role carries it.' : 'This needs purchase.document.view — the Purchase role carries it.'}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (record.isError) {
    return (
      <QueryErrorAlert
        error={record.error}
        subject="that purchase order"
        onRetry={() => {
          void record.refetch();
        }}
      />
    );
  }
  if ((!isNew && record.data === undefined) || settings === null) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading the purchase order" className="flex flex-col gap-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="mx-auto h-[420px] w-full max-w-[210mm]" />
      </div>
    );
  }
  const initial: PurchaseOrderDraft = isNew
    ? emptyPurchaseOrderDraft(toDateParam(new Date()), {
        ...(searchParams.get('party') ? { partyId: searchParams.get('party') } : {}),
        ...(searchParams.get('salesOrder') ? { salesOrderId: searchParams.get('salesOrder') } : {}),
        terms: settings.draft.designs.PURCHASE_ORDER.defaultTerms,
      })
    : purchaseOrderToDraft(record.data as PurchaseOrder);
  return <PurchaseOrderEditor key={isNew ? 'new' : (record.data as PurchaseOrder).id} initial={initial} record={isNew ? null : (record.data as PurchaseOrder)} settings={settings} />;
}

function PurchaseOrderEditor({ initial, record, settings }: { initial: PurchaseOrderDraft; record: PurchaseOrder | null; settings: NonNullable<ReturnType<typeof useDesignDraft>> }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<PurchaseOrderDraft>(initial);
  // What the server last confirmed; dirty is measured against this, not the prop the page mounted with.
  const [base, setBase] = useState<PurchaseOrderDraft>(initial);
  const adopt = (next: PurchaseOrderDraft) => {
    setDraft(next);
    setBase(next);
  };
  // Crash insurance for a new document: the unsaved draft mirrors into
  // sessionStorage and comes back if the tab reloads mid-typing.
  const backup = useDraftBackup('purchase-order', draft, record === null);

  const [backupOffered, setBackupOffered] = useState(false);
  if (!backupOffered && backup.restored !== null && record === null && JSON.stringify(backup.restored) !== JSON.stringify(draft)) {
    setBackupOffered(true);
    setDraft(backup.restored);
  }

  const [dialog, setDialog] = useState<'receive' | 'short-close' | null>(null);
  const [allocating, setAllocating] = useState<Grn | null>(null);
  const [item, setItem] = useState<{ id: string; name: string } | null>(null);
  const save = useSavePurchaseOrder();
  const act = usePurchaseOrderAction();
  const shortClose = useShortClosePurchaseOrder();
  const canCreate = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_CREATE);
  const canApprove = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_APPROVE);
  const canSeeMasters = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const isNew = record === null;
  const isDraft = draft.status === 'DRAFT';
  const editable = canCreate && isDraft;
  const dirty = draftFingerprint(draft) !== draftFingerprint(base);
  const busy = save.isPending || act.isPending || shortClose.isPending;
  const partyMissing = draft.partyId === null;
  const emailProblem = draft.vendorEmail.trim() !== '' && !EMAIL.test(draft.vendorEmail.trim());
  const whatsappProblem = draft.vendorWhatsapp.trim() !== '' && (draft.vendorWhatsapp.trim().length < 6 || draft.vendorWhatsapp.trim().length > 24);
  const contactInvalid = emailProblem || whatsappProblem;
  const confirmed = record !== null && record.status === 'CONFIRMED';
  const owed = record === null ? 0 : record.lines.reduce((sum, line) => sum + lineBalance(line), 0);
  const receivable = confirmed && record.shortClosedAt === null && owed > 0;
  const linked = record?.lines.some((line) => line.requirements.length > 0) ?? false;

  // Resolved by id, not from a page-one list: the vendor picker reaches past
  // the first page now, and the paper's vendor block (address, GSTIN) must too.
  const party = useParty(draft.partyId).data ?? null;
  const vendorName = draft.vendorName.trim() === '' ? (party?.name ?? '') : draft.vendorName;

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
  const vendorStateCode = (party?.gstin ?? '').slice(0, 2).replace(/\D/gu, '');
  const model: PaperModel = {
    type: 'PURCHASE_ORDER',
    number: record?.number ?? null,
    statusLabel: PURCHASE_ORDER_STATUS_LABELS[draft.status],
    date: draft.date,
    validUntil: draft.expectedDate,
    buyer: { name: vendorName, address: party?.address ?? '', gstin: party?.gstin ?? '', stateName: '', stateCode: vendorStateCode },
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
  function chooseItem(key: string, chosen: StockItem | null) {
    updateLine(key, {
      stockItemId: chosen?.id ?? null,
      description: chosen?.name ?? '',
      unit: chosen?.unit ?? '',
      rate: chosen?.costPrice === null || chosen?.costPrice === undefined ? '' : chosen.costPrice.replace(/\.?0+$/u, ''),
      taxPct: chosen?.gstRate === null || chosen?.gstRate === undefined ? '0' : String(Number(chosen.gstRate)),
    });
  }
  const editing: PaperEditing | undefined = editable
    ? {
        customer: (
          <div className="flex flex-col gap-1">
            <PartyPicker
              id="po-vendor"
              label="Vendor"
              placeholder="Choose the party"
              icon={<BooksIcon className="text-muted-foreground" />}
              enabled={canSeeMasters}
              disabled={!canSeeMasters}
              partyId={draft.partyId}
              onValueChange={(next) => {
                setDraft((current) => ({ ...current, partyId: next?.id ?? null, vendorName: next?.name ?? current.vendorName }));
              }}
            />
            <div className="grid grid-cols-2 gap-2 text-[0.9em]">
              <PaperField label="Vendor email" value={draft.vendorEmail} placeholder="Email for the vendor's copy" onChange={(value) => { setDraft((current) => ({ ...current, vendorEmail: value })); }} />
              <PaperField label="Vendor WhatsApp" value={draft.vendorWhatsapp} placeholder="WhatsApp number" onChange={(value) => { setDraft((current) => ({ ...current, vendorWhatsapp: value })); }} />
            </div>
          </div>
        ),
        date: <DateField label="Order date" value={fromDateParam(draft.date)} onValueChange={(next) => { setDraft((current) => ({ ...current, date: toDateParam(next) })); }} yearsBack={1} yearsForward={1} className="paper-field h-auto min-h-0 px-0 py-0 shadow-none" />,
        setDate: (iso) => {
          setDraft((current) => ({ ...current, date: iso }));
        },
        validUntil: <OptionalDateField label="Expected date" emptyLabel="No date yet" value={draft.expectedDate} onValueChange={(next) => { setDraft((current) => ({ ...current, expectedDate: next })); }} />,
        itemPicker: (line) => {
          const draftLine = draft.lines.find((l) => l.key === line.key);
          return canSeeMasters ? (
            <ItemPicker
              id={`po-line-item-${line.key}`}
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
        itemHistory: (line) => (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Buying facts for this item"
            title="On hand, on order, and what this vendor charged before"
            disabled={line.stockItemId === null}
            onClick={() => {
              if (line.stockItemId !== null) setItem({ id: line.stockItemId, name: line.description || 'Stock item' });
            }}
          >
            <ClockCounterClockwiseIcon />
          </Button>
        ),
        updateLine: (key, patch) => {
          updateLine(key, patch);
        },
        addLine: () => {
          setDraft((current) => ({ ...current, lines: [...current.lines, newLine()] }));
        },
        removeLine: (key) => {
          setDraft((current) => {
            const { [key]: _dropped, ...rest } = current.lineRequirements;
            return { ...current, lines: current.lines.length === 1 ? [newLine()] : current.lines.filter((line) => line.key !== key), lineRequirements: rest };
          });
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
        setPlaceOfSupply: () => {
          // A purchase order has no place of supply of its own; the vendor's GSTIN names the state.
        },
      }
    : undefined;

  function submit() {
    if (partyMissing || busy || !editable || contactInvalid) return;
    save.mutate(
      { ...draft, vendorName },
      {
        onSuccess: (saved) => {
          toast.add({ type: 'success', title: isNew ? `${saved.number} drafted` : `${saved.number} saved`, description: `${saved.vendorName} · ${formatMoney(saved.grandTotal)}` });
          backup.clear();
        if (isNew) void navigate(`/purchase/orders/${saved.id}`, { replace: true });
          else adopt(purchaseOrderToDraft(saved));
        },
      },
    );
  }
  function run(action: 'confirm' | 'approve' | 'push' | 'cancel') {
    if (record === null) return;
    act.mutate(
      { id: record.id, action },
      {
        onSuccess: (saved) => {
          if (saved.status === 'PENDING_APPROVAL') {
            toast.add({ type: 'success', title: `${saved.number} awaiting approval`, description: `${formatMoney(saved.grandTotal)} is above the approval threshold: a holder of purchase.document.approve decides it in the Approvals inbox.` });
          } else {
            toast.add({
              type: 'success',
              title:
                action === 'cancel'
                  ? `${saved.number} cancelled`
                  : action === 'approve'
                    ? `${saved.number} approved${saved.syncState === 'QUEUED' ? ' and queued for Tally' : ''}`
                    : saved.syncState === 'QUEUED'
                      ? `${saved.number} queued for Tally`
                      : `${saved.number} confirmed`,
              description: action !== 'cancel' && saved.syncState === 'NOT_PUSHED' ? 'No agent connection can carry it yet; push it when one is issued.' : undefined,
            });
          }
          if (action === 'cancel') void navigate('/purchase/orders');
          else adopt(purchaseOrderToDraft(saved));
        },
      },
    );
  }

  const failure = save.error ?? act.error;
  const copy = actionErrorCopy(failure, save.error ? 'Saving the order' : 'Changing the order');

  return (
    <ShortcutLayer id={`screen:purchase-order-editor-${record?.id ?? 'new'}`}>
      <SaveShortcut onSave={submit} />
      <DocumentEditor
        docType="PURCHASE_ORDER"
        backTo="/purchase/orders"
        backLabel="Purchase orders"
        title={isNew ? 'New purchase order' : `Purchase order ${record.number}`}
        badges={
          <>
            <StatusBadge state={draft.status} label={PURCHASE_ORDER_STATUS_LABELS[draft.status]} />
            {confirmed ? <StatusBadge state={record.fulfilment} label={PO_FULFILMENT_LABELS[record.fulfilment]} /> : null}
            {record === null ? null : <SyncStateBadge record={record} />}
          </>
        }
        dirty={dirty}
        failure={failure ? copy : null}
        hint={partyMissing && editable ? 'Choose the Tally party the order goes to.' : contactInvalid ? 'The vendor email or WhatsApp number is not valid.' : editable && isNew ? 'Set the rates, save, then confirm to queue it for Tally as a Purchase Order voucher.' : null}
        model={model}
        editing={editing}
        canPreview={editable}
        printPath={record === null ? null : `/print/purchase-orders/${record.id}`}
        excel={record === null ? null : { path: `/purchase/orders/${record.id}/export.xlsx`, filename: `Purchase-Order-${record.number}.xlsx` }}
        settings={settings}
        extras={
          record !== null ? (
            <div className="flex flex-col gap-4">
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
              {record.status === 'PENDING_APPROVAL' ? (
                <Alert>
                  <HourglassMediumIcon />
                  <AlertTitle>Waiting for approval</AlertTitle>
                  <AlertDescription>
                    Above the threshold at {formatMoney(record.grandTotal)}. Decide it here or in the{' '}
                    <Link to="/approvals" className="underline underline-offset-4">
                      Approvals inbox
                    </Link>
                    ; the author cannot approve their own.
                  </AlertDescription>
                </Alert>
              ) : null}
              {record.shortClosedAt ? (
                <Alert>
                  <ProhibitIcon />
                  <AlertTitle>Short-closed {formatRelativeAge(record.shortClosedAt)}</AlertTitle>
                  <AlertDescription>{record.shortCloseReason ?? 'The vendor will not supply the balance.'} What was not received went back to the queue.</AlertDescription>
                </Alert>
              ) : null}
              {isDraft && record.approvalRequired && !canApprove ? (
                <p className="text-muted-foreground text-sm">At {formatMoney(record.grandTotal)} this order is above the approval threshold: confirming sends it to the Approvals inbox rather than to Tally.</p>
              ) : null}
              {record.salesOrderId ? (
                <p className="text-muted-foreground text-sm">
                  Raised for{' '}
                  <Link to={`/sales/orders/${record.salesOrderId}`} className="underline-offset-4 hover:underline">
                    its sales order
                  </Link>
                  .
                </p>
              ) : null}
              {confirmed ? <ReceiptLines order={record} /> : null}
              {linked ? <TakenUp order={record} /> : null}
              {confirmed && record.notifications.length > 0 ? <VendorCopy order={record} canMark={canCreate} /> : null}
            </div>
          ) : undefined
        }
        actions={
          <>
            {!isNew && (isDraft || draft.status === 'PENDING_APPROVAL') && canCreate ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { run('cancel'); }}>
                <XCircleIcon data-icon="inline-start" />
                Cancel order
              </Button>
            ) : null}
            {!isNew && draft.status === 'PENDING_APPROVAL' && canApprove ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { run('approve'); }}>
                <SealCheckIcon data-icon="inline-start" />
                Approve and push
              </Button>
            ) : null}
            {!isNew && draft.status === 'PENDING_APPROVAL' && !canApprove ? (
              <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/approvals" />}>
                Open approvals
              </Button>
            ) : null}
            {!isNew && isDraft && !dirty && canCreate ? (
              <Button variant="outline" size="sm" disabled={busy || draft.lines.every((line) => line.stockItemId === null && line.description.trim() === '')} onClick={() => { run('confirm'); }}>
                <CheckIcon data-icon="inline-start" />
                {record?.approvalRequired && !canApprove ? 'Confirm and send for approval' : 'Confirm and push'}
              </Button>
            ) : null}
            {confirmed && (record.syncState === 'NOT_PUSHED' || record.syncState === 'FAILED') && canCreate ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { run('push'); }}>
                <UploadSimpleIcon data-icon="inline-start" />
                {record.syncState === 'FAILED' ? 'Push again' : 'Push to Tally'}
              </Button>
            ) : null}
            {confirmed && record.shortClosedAt === null && owed > 0 && canApprove ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { setDialog('short-close'); }}>
                <ProhibitIcon data-icon="inline-start" />
                Short close
              </Button>
            ) : null}
            {receivable && canCreate ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { setDialog('receive'); }}>
                <PackageIcon data-icon="inline-start" />
                Receive
              </Button>
            ) : null}
            {editable ? (
              <Button size="sm" aria-label="Save purchase order" disabled={busy || partyMissing || contactInvalid || !dirty} onClick={submit}>
                {busy ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
                {save.isPending ? 'Saving' : 'Save'}
                <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
              </Button>
            ) : null}
          </>
        }
      />

      {record === null ? null : (
        <>
          <GrnDialog
            order={dialog === 'receive' ? record : null}
            onOpenChange={(open) => {
              if (!open) setDialog(null);
            }}
            onReceived={(grn) => {
              // REQ-X-27: a receipt short of several waiting orders is decided
              // now, by whoever may, rather than left in a queue nobody opens.
              if (grn.pendingAllocations.length > 0) {
                if (canApprove) setAllocating(grn);
                else toast.add({ type: 'info', title: 'Allocation waits', description: `${String(grn.pendingAllocations.length)} line${grn.pendingAllocations.length === 1 ? '' : 's'} of ${grn.number} need a holder of purchase.document.approve to decide who gets what.` });
              }
            }}
          />
          <AllocateDialog grn={allocating} onGrnChange={setAllocating} />
          <ReasonDialog
            open={dialog === 'short-close'}
            onOpenChange={(next) => {
              if (!next) {
                setDialog(null);
                shortClose.reset();
              }
            }}
            title={`Short-close ${record.number}?`}
            description="The vendor will not supply the balance. Nothing more can be received against it."
            consequences={[`${formatQty(String(owed))} still owed goes back to the queue as open requirements.`, 'The reason is recorded and audited.']}
            prompt="Why will the balance not come?"
            confirmLabel="Short close"
            pendingLabel="Closing"
            confirmIcon={<ProhibitIcon data-icon="inline-start" />}
            destructive
            pending={shortClose.isPending}
            error={shortClose.error}
            onConfirm={(reason) => {
              shortClose.mutate(
                { id: record.id, reason },
                {
                  onSuccess: (saved) => {
                    toast.add({ type: 'success', title: `${saved.number} short-closed`, description: 'The balance is back in the queue for another vendor.' });
                    setDialog(null);
                  },
                },
              );
            }}
          />
        </>
      )}
      <ItemPurchasingSheet
        stockItemId={item?.id ?? null}
        stockItemName={item?.name ?? null}
        partyId={draft.partyId}
        onOpenChange={(open) => {
          if (!open) setItem(null);
        }}
      />
    </ShortcutLayer>
  );
}

function SaveShortcut({ onSave }: { onSave: () => void }) {
  useShortcut({ id: 'purchase-order-editor.save', keys: 'ctrl+a', label: 'Accept / Save', scope: 'screen', allowInInput: true, run: onSave });
  return null;
}
