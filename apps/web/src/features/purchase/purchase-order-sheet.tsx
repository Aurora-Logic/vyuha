import { useState } from 'react';
import { BooksIcon, CheckIcon, CopyIcon, HourglassMediumIcon, PackageIcon, PaperPlaneTiltIcon, ProhibitIcon, SealCheckIcon, UploadSimpleIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { ReasonDialog } from '@/components/shared/reason-dialog';
import { SectionHeading } from '@/components/shared/section-heading';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { DateField } from '@/features/attendance/pickers';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { PartyPicker } from '@/features/masters/party-picker';
import { DocumentLinesEditor } from '@/features/sales/document-lines-editor';
import { SyncStateBadge } from '@/features/sales/sales-order-sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { EMPTY_VALUE, formatDate, formatMoney, formatRelativeAge } from '@/lib/format';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, PO_FULFILMENT_LABELS, PURCHASE_ORDER_STATUS_LABELS } from '@vyuha/shared';

import { AllocateDialog } from './allocation-form';
import { GrnDialog } from './grn-dialog';
import { ItemPurchasingSheet } from './item-purchasing-sheet';
import { OptionalDateField } from './optional-date-field';
import { draftFingerprint, formatQty, lineBalance, type Grn, type PurchaseNotification, type PurchaseOrder, type PurchaseOrderDraft } from './types';
import { useMarkPurchaseNotification, usePurchaseOrderAction, useSavePurchaseOrder, useShortClosePurchaseOrder } from './use-purchase';

/**
 * One purchase order (REQ-X-13) and its two states side by side: the
 * document's (draft, awaiting approval, confirmed) and Tally's (REQ-X-17).
 * A draft is edited and confirmed; over the threshold it waits for a holder
 * of the approve key (REQ-X-16); confirmed, it receives goods one GRN at a
 * time (REQ-X-20) until short-closed (REQ-X-23). Each line shows what it
 * took up from the queue (REQ-X-10), so the customer waiting behind it is
 * never more than a glance away.
 */

interface PurchaseOrderSheetProps {
  draft: PurchaseOrderDraft | null;
  record?: PurchaseOrder | null;
  onOpenChange: (open: boolean) => void;
}

export function PurchaseOrderSheet({ draft, record, onOpenChange }: PurchaseOrderSheetProps) {
  const isMobile = useIsMobile();
  return (
    <Sheet open={draft !== null} onOpenChange={onOpenChange}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-3xl max-md:max-h-[92vh]">
        {draft ? (
          <PurchaseOrderSheetBody
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

function PurchaseOrderSheetBody({ initial, record, onClose }: { initial: PurchaseOrderDraft; record: PurchaseOrder | null; onClose: () => void }) {
  const [draft, setDraft] = useState<PurchaseOrderDraft>(initial);
  const [receiving, setReceiving] = useState(false);
  const [allocating, setAllocating] = useState<Grn | null>(null);
  const [shortClosing, setShortClosing] = useState(false);
  const [item, setItem] = useState<{ id: string; name: string } | null>(null);
  const save = useSavePurchaseOrder();
  const act = usePurchaseOrderAction();
  const shortClose = useShortClosePurchaseOrder();
  const canCreate = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_CREATE);
  const canApprove = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_APPROVE);
  const canSeeMasters = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const isNew = initial.id === undefined;
  const isDraft = draft.status === 'DRAFT';
  const editable = isDraft && canCreate;
  const partyMissing = draft.partyId === null;
  const dirty = draftFingerprint(draft) !== draftFingerprint(initial);
  const busy = save.isPending || act.isPending || shortClose.isPending;
  const confirmed = record !== null && record.status === 'CONFIRMED';
  const owed = record === null ? 0 : record.lines.reduce((sum, line) => sum + lineBalance(line), 0);
  const receivable = confirmed && record.shortClosedAt === null && owed > 0;
  const linked = record?.lines.some((line) => line.requirements.length > 0) ?? false;
  const itemLines = draft.lines.filter((line): line is typeof line & { stockItemId: string } => line.stockItemId !== null);

  function submit() {
    if (partyMissing || busy || !editable) return;
    save.mutate(draft, {
      onSuccess: (saved) => {
        toast.add({ type: 'success', title: isNew ? `${saved.number} drafted` : `${saved.number} saved`, description: `${saved.vendorName} · ${formatMoney(saved.grandTotal)}` });
        onClose();
      },
    });
  }

  function run(action: 'confirm' | 'approve' | 'push' | 'cancel') {
    if (initial.id === undefined) return;
    act.mutate(
      { id: initial.id, action },
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
          onClose();
        },
      },
    );
  }

  const failure = save.error ?? act.error;
  const copy = actionErrorCopy(failure, save.error ? 'Saving the order' : 'Changing the order');

  return (
    <ShortcutLayer id={`modal:purchase-order-${initial.id ?? 'new'}`}>
      <SaveShortcut onSave={submit} />

      <SheetHeader className="shrink-0 border-b">
        <SheetTitle className="flex flex-wrap items-center gap-2">
          {isNew ? 'New purchase order' : `Purchase order ${initial.number ?? ''}`}
          {isNew ? null : <StatusBadge state={draft.status} label={PURCHASE_ORDER_STATUS_LABELS[draft.status]} />}
          {record !== null && record.status === 'CONFIRMED' ? <StatusBadge state={record.fulfilment} label={PO_FULFILMENT_LABELS[record.fulfilment]} /> : null}
          {record === null ? null : <SyncStateBadge record={record} />}
        </SheetTitle>
        <SheetDescription>
          {isNew
            ? 'Pushes to Tally as a Purchase Order voucher once confirmed. The vendor must be a Tally party.'
            : record?.status === 'PENDING_APPROVAL'
              ? `Above the approval threshold at ${formatMoney(record.grandTotal)}. Nothing goes to the vendor or to Tally until a holder of purchase.document.approve releases it.`
              : record?.syncState === 'PUSHED'
                ? `In Tally as voucher #${record.remoteVoucherNumber ?? '?'}. Receive against it below.`
                : record?.syncState === 'QUEUED'
                  ? 'Queued: the agent will push it on its next poll and report back.'
                  : isDraft
                    ? 'A draft: set the rates, then confirm to queue it for Tally.'
                    : `${PURCHASE_ORDER_STATUS_LABELS[draft.status]}.`}
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

          {record?.syncState === 'FAILED' && record.lastError ? (
            <Alert variant="destructive">
              <XCircleIcon />
              <AlertTitle>Tally rejected it</AlertTitle>
              <AlertDescription>
                <p className="font-mono text-xs">{record.lastError}</p>
                <p className="mt-1">Tally&rsquo;s own words. Fix the cause there or here, then push again.</p>
              </AlertDescription>
            </Alert>
          ) : null}

          {record?.status === 'PENDING_APPROVAL' ? (
            <Alert>
              <HourglassMediumIcon />
              <AlertTitle>Waiting for approval</AlertTitle>
              <AlertDescription>
                Decide it here or in the{' '}
                <Link to="/approvals" className="underline underline-offset-4">
                  Approvals inbox
                </Link>
                . The request is routed to every holder of purchase.document.approve; the author cannot approve their own.
              </AlertDescription>
            </Alert>
          ) : null}

          {record?.shortClosedAt ? (
            <Alert>
              <ProhibitIcon />
              <AlertTitle>Short-closed {formatRelativeAge(record.shortClosedAt)}</AlertTitle>
              <AlertDescription>{record.shortCloseReason ?? 'The vendor will not supply the balance.'} What was not received went back to the queue.</AlertDescription>
            </Alert>
          ) : null}

          {isDraft && record?.approvalRequired && !canApprove ? (
            <FieldDescription>
              At {formatMoney(record.grandTotal)} this order is above the approval threshold: confirming sends it to the Approvals inbox rather than to Tally.
            </FieldDescription>
          ) : null}

          {record?.salesOrderId ? (
            <FieldDescription>
              Raised for{' '}
              <Link to={`/sales/orders/${record.salesOrderId}`} className="underline-offset-4 hover:underline">
                its sales order
              </Link>
              .
            </FieldDescription>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="po-vendor">Vendor</FieldLabel>
              {editable ? (
                <PartyPicker
                  id="po-vendor"
                  label="Vendor"
                  placeholder="Choose the party"
                  icon={<BooksIcon className="text-muted-foreground" />}
                  enabled={canSeeMasters && editable}
                  disabled={!canSeeMasters}
                  partyId={draft.partyId}
                  onValueChange={(next) => {
                    setDraft((current) => ({ ...current, partyId: next?.id ?? null, vendorName: next?.name ?? current.vendorName }));
                  }}
                />
              ) : (
                <p id="po-vendor" className="text-sm font-medium">
                  {draft.vendorName || EMPTY_VALUE}
                </p>
              )}
            </Field>
            <Field>
              <FieldLabel>Date</FieldLabel>
              {editable ? (
                <DateField
                  label="Order date"
                  value={fromDateParam(draft.date)}
                  onValueChange={(next) => {
                    setDraft((current) => ({ ...current, date: toDateParam(next) }));
                  }}
                  yearsBack={1}
                  yearsForward={1}
                />
              ) : (
                <p className="text-sm tabular-nums">{formatDate(draft.date)}</p>
              )}
            </Field>
            <Field>
              <FieldLabel>Expected</FieldLabel>
              {editable ? (
                <OptionalDateField
                  label="Expected date"
                  emptyLabel="No date yet — set one"
                  value={draft.expectedDate}
                  onValueChange={(next) => {
                    setDraft((current) => ({ ...current, expectedDate: next }));
                  }}
                />
              ) : (
                <p className="text-sm tabular-nums">{formatDate(draft.expectedDate)}</p>
              )}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="po-vendor-email">Vendor email</FieldLabel>
              <Input
                id="po-vendor-email"
                type="email"
                inputMode="email"
                autoComplete="off"
                disabled={!editable}
                value={draft.vendorEmail}
                onChange={(e) => {
                  setDraft((c) => ({ ...c, vendorEmail: e.target.value }));
                }}
              />
              <FieldDescription>Where the vendor&rsquo;s copy goes; sent by hand and marked here until the channel lands.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="po-vendor-whatsapp">Vendor WhatsApp</FieldLabel>
              <Input
                id="po-vendor-whatsapp"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                className="tabular-nums"
                placeholder="+91 98765 43210"
                disabled={!editable}
                value={draft.vendorWhatsapp}
                onChange={(e) => {
                  setDraft((c) => ({ ...c, vendorWhatsapp: e.target.value }));
                }}
              />
            </Field>
          </div>

          {confirmed && record !== null ? (
            <ReceiptLines order={record} />
          ) : (
            <DocumentLinesEditor
              lines={draft.lines}
              onLinesChange={(next) => {
                setDraft((current) => ({ ...current, lines: next }));
              }}
              editable={editable}
              canPickItems={canSeeMasters}
              partyId={draft.partyId}
              companyId={null}
              saved={record === null ? null : { subtotal: record.subtotal, discountTotal: '0.00', taxTotal: record.taxTotal, grandTotal: record.grandTotal }}
              dirty={dirty}
            />
          )}

          {!confirmed && linked && record !== null ? <TakenUp order={record} /> : null}

          {confirmed && record.notifications.length > 0 ? <VendorCopy order={record} canMark={canCreate} /> : null}

          {itemLines.length > 0 ? (
            <div className="flex flex-col gap-2">
              <SectionHeading title="Item facts" note="What is on hand, on order, and what this vendor charged before." />
              <div className="flex flex-wrap gap-2">
                {[...new Map(itemLines.map((line) => [line.stockItemId, line])).values()].map((line) => (
                  <Button
                    key={line.stockItemId}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setItem({ id: line.stockItemId, name: line.description || 'Stock item' });
                    }}
                  >
                    <PackageIcon data-icon="inline-start" />
                    {line.description || 'Stock item'}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          <Field>
            <FieldLabel htmlFor="po-notes">Notes</FieldLabel>
            <Textarea
              id="po-notes"
              rows={3}
              disabled={!editable}
              value={draft.notes}
              onChange={(e) => {
                setDraft((c) => ({ ...c, notes: e.target.value }));
              }}
            />
            <FieldDescription>Carried into the voucher narration, with the idempotency key.</FieldDescription>
          </Field>
        </FieldGroup>
      </Form>

      <SheetFooter className="shrink-0 flex-row flex-wrap justify-end gap-2 border-t">
        {!isNew && (isDraft || draft.status === 'PENDING_APPROVAL') && canCreate ? (
          <Button
            variant="outline"
            className="mr-auto"
            disabled={busy}
            onClick={() => {
              run('cancel');
            }}
          >
            <XCircleIcon data-icon="inline-start" />
            Cancel order
          </Button>
        ) : null}
        {confirmed && record.shortClosedAt === null && owed > 0 && canApprove ? (
          <Button
            variant="outline"
            className="mr-auto"
            disabled={busy}
            onClick={() => {
              setShortClosing(true);
            }}
          >
            <ProhibitIcon data-icon="inline-start" />
            Short close
          </Button>
        ) : null}
        {!isNew && isDraft && !dirty && canCreate ? (
          <Button
            variant="outline"
            disabled={busy || draft.lines.every((line) => line.stockItemId === null && line.description.trim() === '')}
            onClick={() => {
              run('confirm');
            }}
          >
            <CheckIcon data-icon="inline-start" />
            {record?.approvalRequired && !canApprove ? 'Confirm and send for approval' : 'Confirm and push'}
          </Button>
        ) : null}
        {!isNew && draft.status === 'PENDING_APPROVAL' && canApprove ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              run('approve');
            }}
          >
            <SealCheckIcon data-icon="inline-start" />
            Approve and push
          </Button>
        ) : null}
        {confirmed && (record.syncState === 'NOT_PUSHED' || record.syncState === 'FAILED') && canCreate ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              run('push');
            }}
          >
            <UploadSimpleIcon data-icon="inline-start" />
            {record.syncState === 'FAILED' ? 'Push again' : 'Push to Tally'}
          </Button>
        ) : null}
        {receivable && canCreate ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setReceiving(true);
            }}
          >
            <PackageIcon data-icon="inline-start" />
            Receive
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          {editable ? 'Cancel' : 'Close'}
        </Button>
        {editable ? (
          <Button disabled={busy || partyMissing} onClick={submit}>
            {busy ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
            {save.isPending ? 'Saving' : 'Save'}
            <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
          </Button>
        ) : null}
      </SheetFooter>

      <GrnDialog
        order={receiving ? record : null}
        onOpenChange={(open) => {
          if (!open) setReceiving(false);
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
        open={shortClosing}
        onOpenChange={(next) => {
          if (!next) {
            setShortClosing(false);
            shortClose.reset();
          }
        }}
        title={`Short-close ${initial.number ?? 'this order'}?`}
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
          if (initial.id === undefined) return;
          shortClose.mutate(
            { id: initial.id, reason },
            {
              onSuccess: (saved) => {
                toast.add({ type: 'success', title: `${saved.number} short-closed`, description: 'The balance is back in the queue for another vendor.' });
                setShortClosing(false);
                onClose();
              },
            },
          );
        }}
      />

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

/**
 * REQ-X-18: the vendor's copy, one per channel, composed by the server and
 * sent by hand until email and WhatsApp land (REQ-AA-26's `manual`
 * fallback). Copy takes the text; Mark sent records that it went.
 */
export function VendorCopy({ order, canMark }: { order: PurchaseOrder; canMark: boolean }) {
  const mark = useMarkPurchaseNotification();
  const copy = actionErrorCopy(mark.error, 'Marking the copy sent');

  async function copyText(notification: PurchaseNotification) {
    try {
      await navigator.clipboard.writeText(notification.composedText);
      toast.add({ type: 'success', title: 'Copied', description: `The ${notification.channel === 'email' ? 'email' : 'WhatsApp'} text is on the clipboard.` });
    } catch {
      // Not swallowed: the text is on screen to select by hand.
      toast.add({ type: 'error', title: 'Could not copy', description: 'The clipboard is not available here; select the text and copy it by hand.' });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <SectionHeading title="Vendor copy" note="Composed by the server for each channel on record. Send it by hand, then mark it sent." />
      {mark.isError ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription>{copy.description}</AlertDescription>
        </Alert>
      ) : null}
      <ul className="flex flex-col divide-y border">
        {order.notifications.map((notification) => (
          <li key={notification.id} className="flex flex-col gap-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{notification.channel === 'email' ? 'Email' : 'WhatsApp'}</span>
              <span className="text-muted-foreground text-xs">{notification.recipient ?? 'No address on the order'}</span>
              <Badge variant={notification.status === 'sent' ? 'default' : notification.status === 'failed' ? 'destructive' : 'outline'} className="ml-auto">
                {notification.status === 'sent' ? `Sent${notification.sentAt ? ` ${formatRelativeAge(notification.sentAt)}` : ''}` : notification.status === 'failed' ? 'Failed' : 'Pending'}
              </Badge>
            </div>
            <Textarea aria-label={`${notification.channel === 'email' ? 'Email' : 'WhatsApp'} text`} readOnly rows={4} className="font-mono text-xs" value={notification.composedText} />
            {notification.error ? <FieldDescription className="text-destructive">{notification.error}</FieldDescription> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void copyText(notification);
                }}
              >
                <CopyIcon data-icon="inline-start" />
                Copy
              </Button>
              {canMark && notification.status !== 'sent' ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={mark.isPending}
                  onClick={() => {
                    mark.mutate(
                      { id: order.id, notificationId: notification.id, status: 'sent' },
                      {
                        onSuccess: () => {
                          toast.add({ type: 'success', title: 'Marked sent', description: `The ${notification.channel === 'email' ? 'email' : 'WhatsApp'} copy of ${order.number} is recorded as sent.` });
                        },
                      },
                    );
                  }}
                >
                  {mark.isPending ? <Spinner data-icon="inline-start" /> : <PaperPlaneTiltIcon data-icon="inline-start" />}
                  Mark sent
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** REQ-X-19/X-20: what a confirmed order has received, per line, and who each line was bought for. */
export function ReceiptLines({ order }: { order: PurchaseOrder }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading title="Lines" note="Ordered, received, rejected and still owed. Rejected goods stay off stock and keep the line open." />
      <ol className="flex flex-col divide-y border">
        {order.lines.map((line) => {
          const balance = lineBalance(line);
          return (
            <li key={line.id} className="flex flex-col gap-1.5 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-sm font-medium">
                  {String(line.lineNo)}. {line.description}
                </span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatQty(line.quantity)} {line.unit ?? ''} @ {formatMoney(line.rate)} = {formatMoney(line.amount)}
                </span>
              </div>
              <dl className="grid grid-cols-4 gap-2 text-xs tabular-nums">
                <div>
                  <dt className="text-muted-foreground">Ordered</dt>
                  <dd className="font-medium">{formatQty(line.quantity)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Received</dt>
                  <dd className="font-medium">{formatQty(line.receivedQty)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Rejected</dt>
                  <dd className="font-medium">{formatQty(line.rejectedQty)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Balance</dt>
                  <dd className={balance > 0 ? 'font-semibold' : 'font-medium'}>{formatQty(String(balance))}</dd>
                </div>
              </dl>
              {line.requirements.length > 0 ? (
                <p className="text-muted-foreground text-xs">
                  For{' '}
                  {line.requirements
                    .map((r) => `${r.salesOrderNumber ?? 'stock'}${r.customerName ? ` (${r.customerName})` : ''} · ${formatQty(r.quantity)}`)
                    .join('; ')}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <dl className="ml-auto grid w-full max-w-xs grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
        <dt className="text-muted-foreground">Subtotal</dt>
        <dd className="text-right">{formatMoney(order.subtotal)}</dd>
        <dt className="text-muted-foreground">Tax (for information)</dt>
        <dd className="text-right">{formatMoney(order.taxTotal)}</dd>
        <dt className="font-medium">Total</dt>
        <dd className="text-right font-medium">{formatMoney(order.grandTotal)}</dd>
      </dl>
    </div>
  );
}

/** REQ-X-10: which requirements a not-yet-confirmed order will take up. */
export function TakenUp({ order }: { order: PurchaseOrder }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading title="Takes up" note="The queue lines this order was raised for. They move to ordered when it is confirmed." />
      <ul className="divide-y border text-sm">
        {order.lines.flatMap((line) =>
          line.requirements.map((r) => (
            <li key={`${line.id}-${r.requirementId}`} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-1.5">
              <span className="min-w-0 truncate">
                {line.description}
                <span className="text-muted-foreground ml-2 text-xs">
                  {r.salesOrderNumber ?? 'Stock'}
                  {r.customerName ? ` · ${r.customerName}` : ''}
                </span>
              </span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatQty(r.quantity)}</span>
            </li>
          )),
        )}
      </ul>
    </div>
  );
}

function SaveShortcut({ onSave }: { onSave: () => void }) {
  useShortcut({ id: 'purchase-order-sheet.save', keys: 'ctrl+a', label: 'Accept / Save', scope: 'modal', allowInInput: true, run: onSave });
  return null;
}
