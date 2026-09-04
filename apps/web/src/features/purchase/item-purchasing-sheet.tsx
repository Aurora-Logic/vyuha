import { useState } from 'react';
import { BooksIcon, PlusIcon, TrashIcon, WarningCircleIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { SectionHeading } from '@/components/shared/section-heading';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { CheckboxRow } from '@/features/leave/control-row';
import { PartyPicker } from '@/features/masters/party-picker';
import { useIsMobile } from '@/hooks/use-mobile';
import { EMPTY_VALUE, formatDate, formatMoney, formatRelativeAge } from '@/lib/format';
import { ShortcutLayer } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PARTY_LEDGER_GROUPS, PERMISSIONS } from '@vyuha/shared';

import { formatQty, type ItemVendor } from './types';
import { useItemAvailability, useItemVendors, usePurchaseHistory, usePutItemSettings, usePutItemVendors } from './use-purchase';

/**
 * Everything purchase needs to know about one item, in one place: what is
 * on hand and on order (REQ-AC-04, REQ-X-24), the reorder level and minimum
 * order quantity Vyuha holds for it (D-28), who supplies it and how long
 * they take (REQ-X-15, D-27, D-33), and what vendors charged before
 * (REQ-X-14). Opened from a requirement row or a PO line, never a page of
 * its own — the item is Tally's; these are the facts Vyuha adds to it.
 */

interface ItemPurchasingSheetProps {
  /** Null closes the sheet. */
  stockItemId: string | null;
  stockItemName: string | null;
  /** The vendor in hand, when opened from a PO: the history opens filtered to them. */
  partyId?: string | null;
  onOpenChange: (open: boolean) => void;
}

export function ItemPurchasingSheet({ stockItemId, stockItemName, partyId = null, onOpenChange }: ItemPurchasingSheetProps) {
  const isMobile = useIsMobile();
  return (
    <Sheet open={stockItemId !== null} onOpenChange={onOpenChange}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-2xl max-md:max-h-[92vh]">
        {stockItemId !== null ? <ItemPurchasingBody key={stockItemId} stockItemId={stockItemId} stockItemName={stockItemName} partyId={partyId} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function ItemPurchasingBody({ stockItemId, stockItemName, partyId }: { stockItemId: string; stockItemName: string | null; partyId: string | null }) {
  const canEdit = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_CREATE);
  return (
    // Its own layer, so a ctrl+a typed here cannot save the PO sheet underneath.
    <ShortcutLayer id={`modal:item-purchasing-${stockItemId}`}>
      <SheetHeader className="shrink-0 border-b">
        <SheetTitle>{stockItemName ?? 'Stock item'}</SheetTitle>
        <SheetDescription>What is on hand and on order, the reorder settings, the vendors, and what they charged before.</SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <AvailabilitySection stockItemId={stockItemId} />
        <Separator />
        <SettingsSection stockItemId={stockItemId} canEdit={canEdit} />
        <Separator />
        <VendorsSection stockItemId={stockItemId} canEdit={canEdit} />
        <Separator />
        <HistorySection stockItemId={stockItemId} partyId={partyId} />
      </div>
    </ShortcutLayer>
  );
}

// ---------------------------------------------------------- availability

function AvailabilitySection({ stockItemId }: { stockItemId: string }) {
  const availability = useItemAvailability(stockItemId);
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading title="Availability" note="Available is Tally's closing balance less what open sales orders have committed. Vyuha never writes a stock figure." />
      {availability.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading availability" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} aria-hidden className="h-10" />
          ))}
        </div>
      ) : null}
      {availability.isError ? (
        <QueryErrorAlert
          error={availability.error}
          subject="availability"
          onRetry={() => {
            void availability.refetch();
          }}
        />
      ) : null}
      {availability.isSuccess ? (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <Fact label="Closing (Tally)" value={formatQty(availability.data.closingQty)} />
            <Fact label="Committed" value={formatQty(availability.data.committedQty)} />
            <Fact label="Available" value={formatQty(availability.data.availableQty)} emphasis />
            <Fact label="On order" value={formatQty(availability.data.openPoQty)} />
          </dl>
          <p className="text-muted-foreground text-xs">
            {availability.data.asOf === null ? 'No stock pull has landed for this item yet; the closing figure is unknown.' : `Tally figures as of the pull ${formatRelativeAge(availability.data.asOf)}.`}
          </p>
        </>
      ) : null}
    </section>
  );
}

function Fact({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={emphasis ? 'font-semibold tabular-nums' : 'font-medium tabular-nums'}>{value}</dd>
    </div>
  );
}

// -------------------------------------------------------------- settings

interface SettingsDraft {
  reorderLevel: string;
  minimumOrderQty: string;
}

const QTY = /^\d{1,12}(\.\d{1,3})?$/u;

function SettingsSection({ stockItemId, canEdit }: { stockItemId: string; canEdit: boolean }) {
  const availability = useItemAvailability(stockItemId);
  const put = usePutItemSettings();
  const [edited, setEdited] = useState<SettingsDraft | null>(null);
  const server: SettingsDraft = {
    reorderLevel: availability.data?.reorderLevel === null || availability.data?.reorderLevel === undefined ? '' : formatQty(availability.data.reorderLevel),
    minimumOrderQty: availability.data?.minimumOrderQty === null || availability.data?.minimumOrderQty === undefined ? '' : formatQty(availability.data.minimumOrderQty),
  };
  const draft = edited ?? server;
  const dirty = edited !== null && (edited.reorderLevel !== server.reorderLevel || edited.minimumOrderQty !== server.minimumOrderQty);
  const invalid = [draft.reorderLevel, draft.minimumOrderQty].some((v) => v.trim() !== '' && !QTY.test(v.trim()));

  function submit() {
    if (!dirty || invalid || put.isPending) return;
    put.mutate(
      {
        stockItemId,
        input: {
          reorderLevel: draft.reorderLevel.trim() === '' ? null : draft.reorderLevel.trim(),
          minimumOrderQty: draft.minimumOrderQty.trim() === '' ? null : draft.minimumOrderQty.trim(),
        },
      },
      {
        onSuccess: () => {
          setEdited(null);
          toast.add({ type: 'success', title: 'Purchasing settings saved', description: 'The nightly reorder check reads the new level.' });
        },
      },
    );
  }

  const copy = actionErrorCopy(put.error, 'Saving the settings');

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title="Purchasing settings"
        note="Held by Vyuha until Tally holds them (D-28). The nightly job raises a requirement when available falls to the reorder level."
        action={
          canEdit ? (
            <Button size="sm" variant="outline" disabled={!dirty || invalid || put.isPending} onClick={submit}>
              {put.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
              {put.isPending ? 'Saving' : 'Save settings'}
            </Button>
          ) : null
        }
      />
      {put.isError ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription>{copy.description}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="item-reorder-level">Reorder level</FieldLabel>
          <Input
            id="item-reorder-level"
            inputMode="decimal"
            className="tabular-nums"
            placeholder="None"
            disabled={!canEdit || availability.isPending}
            value={draft.reorderLevel}
            onChange={(event) => {
              setEdited({ ...draft, reorderLevel: event.target.value });
            }}
          />
          <FieldDescription>Up to three decimals. Empty means the item is never reordered automatically.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="item-moq">Minimum order quantity</FieldLabel>
          <Input
            id="item-moq"
            inputMode="decimal"
            className="tabular-nums"
            placeholder="None"
            disabled={!canEdit || availability.isPending}
            value={draft.minimumOrderQty}
            onChange={(event) => {
              setEdited({ ...draft, minimumOrderQty: event.target.value });
            }}
          />
          <FieldDescription>What the vendor will accept as one order.</FieldDescription>
        </Field>
      </div>
      {!canEdit ? <FieldDescription>Editing needs purchase.document.create.</FieldDescription> : null}
    </section>
  );
}

// --------------------------------------------------------------- vendors

interface VendorRow {
  key: string;
  partyId: string | null;
  partyName: string;
  isPreferred: boolean;
  leadTimeDays: string;
}

let vendorCounter = 0;
function vendorRow(overrides: Partial<VendorRow> = {}): VendorRow {
  vendorCounter += 1;
  return { key: `vendor-${String(vendorCounter)}`, partyId: null, partyName: '', isPreferred: false, leadTimeDays: '', ...overrides };
}

function rowsOf(vendors: readonly ItemVendor[]): VendorRow[] {
  return vendors.map((v) => vendorRow({ partyId: v.partyId, partyName: v.partyName, isPreferred: v.isPreferred, leadTimeDays: v.leadTimeDays === null ? '' : String(v.leadTimeDays) }));
}

function VendorsSection({ stockItemId, canEdit }: { stockItemId: string; canEdit: boolean }) {
  const vendors = useItemVendors(stockItemId);
  const put = usePutItemVendors();
  const canSeeMasters = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const [edited, setEdited] = useState<VendorRow[] | null>(null);
  const rows = edited ?? rowsOf(vendors.data ?? []);
  const dirty = edited !== null;

  const preferredCount = rows.filter((r) => r.isPreferred).length;
  const missingParty = rows.some((r) => r.partyId === null);
  const badLead = rows.some((r) => r.leadTimeDays.trim() !== '' && !/^\d{1,3}$/u.test(r.leadTimeDays.trim()));
  const duplicate = new Set(rows.map((r) => r.partyId)).size !== rows.length;
  const invalid = preferredCount > 1 || missingParty || badLead || duplicate;

  function update(key: string, patch: Partial<VendorRow>) {
    setEdited(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function submit() {
    if (!dirty || invalid || put.isPending) return;
    put.mutate(
      {
        stockItemId,
        input: {
          vendors: rows
            .filter((r): r is VendorRow & { partyId: string } => r.partyId !== null)
            .map((r) => ({ partyId: r.partyId, isPreferred: r.isPreferred, leadTimeDays: r.leadTimeDays.trim() === '' ? null : Number(r.leadTimeDays.trim()) })),
        },
      },
      {
        onSuccess: (saved) => {
          setEdited(null);
          toast.add({ type: 'success', title: 'Vendors saved', description: saved.length === 0 ? 'No vendor is recorded for this item.' : `${String(saved.length)} vendor${saved.length === 1 ? '' : 's'} on record.` });
        },
      },
    );
  }

  const copy = actionErrorCopy(put.error, 'Saving the vendors');

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title="Vendors"
        note="Who supplies this item, which one is preferred, and their lead time in days. One preferred at most."
        action={
          canEdit ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={vendors.isPending}
                onClick={() => {
                  setEdited([...rows, vendorRow()]);
                }}
              >
                <PlusIcon data-icon="inline-start" />
                Add vendor
              </Button>
              <Button size="sm" variant="outline" disabled={!dirty || invalid || put.isPending} onClick={submit}>
                {put.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
                {put.isPending ? 'Saving' : 'Save vendors'}
              </Button>
            </>
          ) : null
        }
      />
      {vendors.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading vendors" className="flex flex-col gap-2">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : null}
      {vendors.isError ? (
        <QueryErrorAlert
          error={vendors.error}
          subject="vendors"
          onRetry={() => {
            void vendors.refetch();
          }}
        />
      ) : null}
      {put.isError ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription>{copy.description}</AlertDescription>
        </Alert>
      ) : null}
      {vendors.isSuccess && rows.length === 0 ? <p className="text-muted-foreground text-sm">No vendor recorded yet.{canEdit ? ' Add one so the next PO knows who to ask.' : ''}</p> : null}
      {rows.length > 0 ? (
        <ol className="flex flex-col divide-y border">
          {rows.map((row, index) => (
            <li key={row.key} className="grid gap-2 p-3 md:grid-cols-[minmax(0,2fr)_auto_minmax(0,1fr)_auto] md:items-center">
              {canEdit && canSeeMasters ? (
                <PartyPicker
                  // A vendor is a party under Sundry Creditors (13 §1). Left
                  // unfiltered this offered every customer too, so "Choose the
                  // party" listed the people you sell to.
                  parentGroup={PARTY_LEDGER_GROUPS.SUPPLIER}
                  id={`vendor-${row.key}`}
                  label={`Vendor ${String(index + 1)}`}
                  placeholder="Choose the party"
                  icon={<BooksIcon className="text-muted-foreground" />}
                  enabled={canSeeMasters && canEdit}
                  partyId={row.partyId}
                  partyName={row.partyName}
                  onValueChange={(next) => {
                    update(row.key, { partyId: next?.id ?? null, partyName: next?.name ?? '' });
                  }}
                />
              ) : (
                <span className="text-sm font-medium">{row.partyName || EMPTY_VALUE}</span>
              )}
              <CheckboxRow
                id={`vendor-preferred-${row.key}`}
                label="Preferred"
                checked={row.isPreferred}
                disabled={!canEdit}
                onCheckedChange={(checked) => {
                  // At most one preferred (D-27): choosing one un-prefers the rest.
                  setEdited(rows.map((r) => ({ ...r, isPreferred: r.key === row.key ? checked : checked ? false : r.isPreferred })));
                }}
              />
              <Input
                aria-label={`Vendor ${String(index + 1)} lead time in days`}
                inputMode="numeric"
                className="tabular-nums"
                placeholder="Lead time, days"
                disabled={!canEdit}
                value={row.leadTimeDays}
                onChange={(event) => {
                  update(row.key, { leadTimeDays: event.target.value });
                }}
              />
              {canEdit ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove vendor ${String(index + 1)}`}
                  className="justify-self-end"
                  onClick={() => {
                    setEdited(rows.filter((r) => r.key !== row.key));
                  }}
                >
                  <TrashIcon />
                </Button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {dirty && invalid ? (
        <FieldDescription>
          {preferredCount > 1
            ? 'Only one vendor can be preferred.'
            : missingParty
              ? 'Every row needs a party.'
              : duplicate
                ? 'The same party is listed twice.'
                : 'Lead time is a whole number of days, up to 365.'}
        </FieldDescription>
      ) : null}
    </section>
  );
}

// --------------------------------------------------------------- history

function HistorySection({ stockItemId, partyId }: { stockItemId: string; partyId: string | null }) {
  const [scope, setScope] = useState<'vendor' | 'all'>(partyId === null ? 'all' : 'vendor');
  const history = usePurchaseHistory({ stockItemId, partyId: scope === 'vendor' ? partyId : null, enabled: true });
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title="Purchase history"
        note="Purchase vouchers pulled from Tally and earlier purchase orders here, newest first."
        action={
          partyId === null ? null : (
            <ToggleGroup
              variant="outline"
              size="sm"
              aria-label="History scope"
              value={[scope]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === 'vendor' || next === 'all') setScope(next);
              }}
            >
              <ToggleGroupItem value="vendor">
                This vendor
              </ToggleGroupItem>
              <ToggleGroupItem value="all">
                All vendors
              </ToggleGroupItem>
            </ToggleGroup>
          )
        }
      />
      {history.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading purchase history" className="flex flex-col gap-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
      ) : null}
      {history.isError ? (
        <QueryErrorAlert
          error={history.error}
          subject="purchase history"
          onRetry={() => {
            void history.refetch();
          }}
        />
      ) : null}
      {history.isSuccess && history.data.length === 0 ? <p className="text-muted-foreground text-sm">{scope === 'vendor' ? 'Nothing bought from this vendor yet.' : 'Nothing bought yet, in Tally or here.'}</p> : null}
      {history.isSuccess && history.data.length > 0 ? (
        <ul className="divide-y border text-sm">
          {history.data.map((entry, index) => (
            <li key={`${entry.reference}-${String(index)}`} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2">
              <span className="min-w-0">
                <span className="font-medium">{entry.reference}</span>
                <span className="text-muted-foreground ml-2 text-xs">
                  {formatDate(entry.date)} · {entry.vendorName}
                </span>
                {entry.source === 'purchase_order' ? (
                  <Badge variant="outline" className="ml-2">
                    PO
                  </Badge>
                ) : null}
              </span>
              <span className="text-muted-foreground text-xs tabular-nums">
                {[entry.quantity === null ? null : formatQty(entry.quantity), entry.rate === null ? null : `@ ${formatMoney(entry.rate)}`, entry.amount === null ? null : `= ${formatMoney(entry.amount)}`]
                  .filter((p): p is string => p !== null)
                  .join(' ')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
