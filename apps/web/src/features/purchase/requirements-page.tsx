import { useState } from 'react';
import { BooksIcon, ClipboardTextIcon, LockKeyIcon, PackageIcon, PlusIcon, ShoppingCartIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { ReasonDialog } from '@/components/shared/reason-dialog';
import { type PickerOption } from '@/components/shared/record-picker';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { RowActions, type RowAction } from '@/components/shared/row-actions';
import { SearchField } from '@/components/shared/search-field';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { CheckboxRow } from '@/features/leave/control-row';
import { ItemPicker } from '@/features/masters/item-picker';
import { PartyPicker } from '@/features/masters/party-picker';
import { EMPTY_VALUE, formatDate } from '@/lib/format';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, REQUIREMENT_STATES, type RequirementState } from '@vyuha/shared';

import { ItemPurchasingSheet } from './item-purchasing-sheet';
import { OptionalDateField } from './optional-date-field';
import { formatQty, type Requirement } from './types';
import { useCloseRequirement, useCreatePurchaseOrderFromRequirements, useCreateRequirement, useRequirements } from './use-purchase';

/**
 * The procurement queue (REQ-X-12): the purchase team's home. Every
 * requirement — raised by a shortage at picking (REQ-X-08), by the nightly
 * reorder check (REQ-X-09) or by hand — with who is waiting behind it, so
 * three customers short of the same item read as one call to the vendor
 * (REQ-X-10). Selected rows become one draft PO (REQ-X-13); a requirement
 * nobody will buy for is closed with a reason (REQ-X-11).
 */

const ALL = '__all__';

const STATE_LABELS: Record<RequirementState, string> = { open: 'Open', ordered: 'Ordered', received: 'Received', closed: 'Closed' };
const SOURCE_LABELS: Record<Requirement['source'], string> = { shortage: 'Shortage', reorder: 'Reorder', manual: 'Manual' };

function isState(value: string | null): value is RequirementState {
  return REQUIREMENT_STATES.some((s) => s === value);
}

function StateBadge({ state }: { state: RequirementState }) {
  return <StatusBadge state={state} label={STATE_LABELS[state]} />;
}

function WaitingOn({ row }: { row: Requirement }) {
  if (row.salesOrderId === null) return <span className="text-muted-foreground">{row.source === 'reorder' ? 'Stock' : EMPTY_VALUE}</span>;
  return (
    <span className="flex min-w-0 flex-col">
      <Link
        to={`/sales/orders/${row.salesOrderId}`}
        className="font-medium underline-offset-4 hover:underline"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {row.salesOrderNumber ?? 'Sales order'}
      </Link>
      {row.customerName ? <span className="text-muted-foreground truncate text-xs">{row.customerName}</span> : null}
    </span>
  );
}

export function RequirementsPage() {
  const canView = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_VIEW);
  const canCreate = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_CREATE);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const stateParam = searchParams.get('state');
  // Open by default: the queue is the work still to do. `all` widens it.
  const state: RequirementState | 'all' = stateParam === 'all' ? 'all' : isState(stateParam) ? stateParam : 'open';
  const salesOrderId = searchParams.get('salesOrderId') ?? '';
  const stockItemId = searchParams.get('stockItemId') ?? '';

  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [raising, setRaising] = useState(false);
  const [closing, setClosing] = useState<Requirement | null>(null);
  const [item, setItem] = useState<{ id: string; name: string } | null>(null);

  const query = useRequirements(
    { ...(state === 'all' ? {} : { state }), ...(salesOrderId ? { salesOrderId } : {}), ...(stockItemId ? { stockItemId } : {}) },
    { enabled: canView },
  );
  const close = useCloseRequirement();

  const needle = q.trim().toLowerCase();
  const rows = (query.data ?? []).filter(
    (row) => needle === '' || [row.stockItemName, row.customerName ?? '', row.salesOrderNumber ?? ''].some((text) => text.toLowerCase().includes(needle)),
  );
  const openRows = rows.filter((row) => row.state === 'open');
  const selectedRows = openRows.filter((row) => selected.has(row.id));
  const allSelected = openRows.length > 0 && selectedRows.length === openRows.length;

  function toggleRow(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(openRows.map((row) => row.id)) : new Set());
  }
  function setParam(key: string, value: string | null) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  }

  useShortcut({
    id: 'purchase.requirements.create',
    keys: 'alt+c',
    label: 'New requirement',
    scope: 'screen',
    when: () => canCreate,
    run: () => {
      setCreating(true);
    },
  });

  if (!canView) {
    return (
      <>
        <PageHeader description="The procurement queue: what needs buying, and who is waiting behind it." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view the procurement queue</EmptyTitle>
            <EmptyDescription>This needs purchase.document.view — the Purchase role carries it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const columns: RecordColumn<Requirement>[] = [
    ...(canCreate
      ? [
          {
            key: 'select',
            header: 'Select',
            cell: (row: Requirement) =>
              row.state === 'open' ? (
                <CheckboxRow
                  id={`requirement-${row.id}`}
                  label={<span className="sr-only">Select {row.stockItemName}</span>}
                  checked={selected.has(row.id)}
                  onCheckedChange={(checked) => {
                    toggleRow(row.id, checked);
                  }}
                />
              ) : null,
            className: 'w-10',
          },
        ]
      : []),
    { key: 'item', header: 'Item', cell: (row) => <span className="font-medium">{row.stockItemName}</span> },
    {
      key: 'quantity',
      header: 'Needed · ordered · received',
      cell: (row) => (
        <span className="tabular-nums">
          {formatQty(row.quantity)} <span className="text-muted-foreground">· {formatQty(row.orderedQty)} · {formatQty(row.receivedQty)}</span>
        </span>
      ),
      numeric: true,
    },
    { key: 'source', header: 'Source', cell: (row) => <Badge variant="outline">{SOURCE_LABELS[row.source]}</Badge> },
    { key: 'waiting', header: 'Waiting on it', cell: (row) => <WaitingOn row={row} /> },
    { key: 'neededBy', header: 'Needed by', cell: (row) => formatDate(row.neededBy), className: 'tabular-nums' },
    { key: 'state', header: 'State', cell: (row) => <StateBadge state={row.state} /> },
    { key: 'raised', header: 'Raised', cell: (row) => formatDate(row.createdAt.slice(0, 10)), secondary: true, className: 'tabular-nums' },
    { key: 'actions', header: '', cell: (row) => <RowActions label={`Actions for ${row.stockItemName}`} actions={actionsFor(row)} />, className: 'w-10' },
  ];

  function actionsFor(row: Requirement): RowAction[] {
    return [
      {
        key: 'item',
        label: 'Item purchasing',
        icon: PackageIcon,
        onSelect: () => {
          setItem({ id: row.stockItemId, name: row.stockItemName });
        },
      },
      ...(row.state === 'open'
        ? [
            {
              key: 'close',
              label: 'Close without a PO',
              icon: XCircleIcon,
              destructive: true,
              onSelect: () => {
                setClosing(row);
              },
              ...(canCreate ? {} : { unavailableReason: 'Closing a requirement needs purchase.document.create.' }),
            },
          ]
        : []),
    ];
  }

  const filtered = needle !== '' || state !== 'open' || Boolean(salesOrderId || stockItemId);

  return (
    <>
      <PageHeader
        description="What needs buying, sorted by when it is needed, with the customer waiting behind each line. Select open lines to raise one PO for them."
        action={
          canCreate ? (
            <Button
              size="sm"
              onClick={() => {
                setCreating(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              New requirement
              <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
            </Button>
          ) : null
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField id="requirement-search" label="Search requirements" value={q} onValueChange={setQ} placeholder="Item, customer or order" />
          <Select
            value={state === 'all' ? ALL : state}
            onValueChange={(value: string | null) => {
              setParam('state', value === null || value === 'open' ? null : value === ALL ? 'all' : value);
            }}
          >
            <SelectTrigger className="w-40" aria-label="State">
              <SelectValue>{(value: string) => (value === ALL ? 'Any state' : STATE_LABELS[value as RequirementState])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {REQUIREMENT_STATES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATE_LABELS[s]}
                </SelectItem>
              ))}
              <SelectItem value={ALL}>Any state</SelectItem>
            </SelectContent>
          </Select>
          {salesOrderId || stockItemId ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setParam('salesOrderId', null);
                setParam('stockItemId', null);
              }}
            >
              <ACTION_ICONS.clearFilters data-icon="inline-start" />
              {salesOrderId ? 'One sales order' : 'One item'} — clear
            </Button>
          ) : null}
        </div>

        {canCreate && openRows.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border px-3 py-2">
            <CheckboxRow id="requirements-select-all" label={`Select all ${String(openRows.length)} open`} checked={allSelected} onCheckedChange={toggleAll} />
            {selectedRows.length > 0 ? (
              <>
                <span className="text-muted-foreground text-xs tabular-nums">{selectedRows.length} selected</span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setRaising(true);
                    }}
                  >
                    <ShoppingCartIcon data-icon="inline-start" />
                    Raise PO for selected
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSelected(new Set());
                    }}
                  >
                    Clear
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {query.isPending ? <ListSkeleton rows={4} label="Loading requirements" /> : null}
        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="requirements"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ClipboardTextIcon />
              </EmptyMedia>
              <EmptyTitle>{filtered ? 'No requirement matches that' : 'Nothing waiting to be bought'}</EmptyTitle>
              <EmptyDescription>
                {filtered ? 'Try another state or clear the search.' : 'A shortage at picking or the nightly reorder check raises the next one; or raise one by hand.'}
              </EmptyDescription>
            </EmptyHeader>
            {!filtered && canCreate ? (
              <EmptyContent>
                <Button
                  size="sm"
                  onClick={() => {
                    setCreating(true);
                  }}
                >
                  <PlusIcon data-icon="inline-start" />
                  New requirement
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <RecordTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            mobilePrimary={(row) => `${row.stockItemName} · ${formatQty(row.quantity)}`}
            mobileStatus={(row) => (
              <>
                <StateBadge state={row.state} />
                {canCreate && row.state === 'open' ? (
                  <CheckboxRow
                    id={`requirement-m-${row.id}`}
                    label={<span className="sr-only">Select {row.stockItemName}</span>}
                    checked={selected.has(row.id)}
                    onCheckedChange={(checked) => {
                      toggleRow(row.id, checked);
                    }}
                  />
                ) : null}
                <RowActions label={`Actions for ${row.stockItemName}`} actions={actionsFor(row)} />
              </>
            )}
            mobileSupporting={(row) =>
              [SOURCE_LABELS[row.source], row.salesOrderNumber ? `${row.salesOrderNumber}${row.customerName ? ` · ${row.customerName}` : ''}` : null, row.neededBy ? `by ${formatDate(row.neededBy)}` : null]
                .filter((p): p is string => p !== null)
                .join(' · ')
            }
          />
        ) : null}
      </div>

      <NewRequirementDialog open={creating} onOpenChange={setCreating} />

      <RaisePurchaseOrderDialog
        open={raising}
        onOpenChange={setRaising}
        requirements={selectedRows}
        onRaised={(id) => {
          setSelected(new Set());
          void navigate(`/purchase/orders/${id}`);
        }}
      />

      <ReasonDialog
        open={closing !== null}
        onOpenChange={(next) => {
          if (!next) {
            setClosing(null);
            close.reset();
          }
        }}
        title={`Close the requirement for ${closing?.stockItemName ?? 'this item'}?`}
        description="It leaves the queue without a purchase order. The sales order it carried, if any, stays as it is."
        consequences={['Nothing is bought for it, and no PO is raised.', 'The reason is recorded and audited.']}
        prompt="Why is nothing being bought?"
        hint="Customer cancelled, substitute offered, item discontinued — the next reader should not have to guess."
        confirmLabel="Close requirement"
        pendingLabel="Closing"
        confirmIcon={<XCircleIcon data-icon="inline-start" />}
        destructive
        pending={close.isPending}
        error={close.error}
        onConfirm={(reason) => {
          if (closing === null) return;
          close.mutate(
            { id: closing.id, reason },
            {
              onSuccess: () => {
                toast.add({ type: 'success', title: 'Requirement closed', description: `${closing.stockItemName} leaves the queue.` });
                setClosing(null);
              },
            },
          );
        }}
      />

      <ItemPurchasingSheet
        stockItemId={item?.id ?? null}
        stockItemName={item?.name ?? null}
        onOpenChange={(open) => {
          if (!open) setItem(null);
        }}
      />
    </>
  );
}

// ------------------------------------------------------- new requirement

function NewRequirementDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <NewRequirementBody
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const QTY = /^\d{1,12}(\.\d{1,3})?$/u;

function NewRequirementBody({ onClose }: { onClose: () => void }) {
  const canSeeMasters = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const create = useCreateRequirement();
  const [stockItem, setStockItem] = useState<PickerOption | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [neededBy, setNeededBy] = useState<string | null>(null);

  const valid = stockItem !== null && QTY.test(quantity.trim());
  const copy = actionErrorCopy(create.error, 'Raising the requirement');

  function submit() {
    if (!valid || create.isPending || stockItem === null) return;
    create.mutate(
      { stockItemId: stockItem.id, quantity: quantity.trim(), neededBy },
      {
        onSuccess: (saved) => {
          toast.add({ type: 'success', title: 'Requirement raised', description: `${saved.stockItemName} · ${formatQty(saved.quantity)}${saved.neededBy ? ` by ${formatDate(saved.neededBy)}` : ''}` });
          onClose();
        },
      },
    );
  }

  return (
    <ShortcutLayer id="modal:requirement-new">
      <SaveShortcut id="requirement-new.save" onSave={submit} />
      <DialogHeader>
        <DialogTitle>New requirement</DialogTitle>
        <DialogDescription>A need no shortage or reorder check raised. It joins the queue as a manual requirement.</DialogDescription>
      </DialogHeader>
      <Form onSubmit={submit}>
        <FieldGroup>
          {create.isError ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>{copy.title}</AlertTitle>
              <AlertDescription>{copy.description}</AlertDescription>
            </Alert>
          ) : null}
          <Field>
            <FieldLabel htmlFor="requirement-item">Stock item</FieldLabel>
            <ItemPicker
              id="requirement-item"
              label="Stock item"
              placeholder="Choose the item"
              searchPlaceholder="Search stock items"
              emptyMessage="No item matches. It must exist in Tally first."
              icon={<PackageIcon className="text-muted-foreground" />}
              enabled={canSeeMasters}
              disabled={!canSeeMasters}
              value={stockItem}
              onValueChange={(next) => { setStockItem(next ? { id: next.id, label: next.name } : null); }}
            />
            {!canSeeMasters ? <FieldDescription>Choosing an item needs masters.tally.view.</FieldDescription> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="requirement-quantity">Quantity</FieldLabel>
            <Input
              id="requirement-quantity"
              inputMode="decimal"
              className="tabular-nums"
              value={quantity}
              onChange={(event) => {
                setQuantity(event.target.value);
              }}
            />
            <FieldDescription>Up to three decimals{stockItem?.hint ? `, in ${stockItem.hint}` : ''}.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Needed by</FieldLabel>
            <OptionalDateField label="Needed by" emptyLabel="No date — set one" value={neededBy} onValueChange={setNeededBy} />
          </Field>
        </FieldGroup>
      </Form>
      <DialogFooter className="flex-row justify-end gap-2">
        <Button variant="outline" className="flex-1 sm:flex-none" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          Cancel
        </Button>
        <Button className="flex-1 sm:flex-none" disabled={!valid || create.isPending} onClick={submit}>
          {create.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
          {create.isPending ? 'Raising' : 'Raise'}
          <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
        </Button>
      </DialogFooter>
    </ShortcutLayer>
  );
}

// -------------------------------------------------- PO from requirements

function RaisePurchaseOrderDialog({
  open,
  onOpenChange,
  requirements,
  onRaised,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requirements: readonly Requirement[];
  onRaised: (purchaseOrderId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <RaisePurchaseOrderBody
            requirements={requirements}
            onRaised={onRaised}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RaisePurchaseOrderBody({ requirements, onRaised, onClose }: { requirements: readonly Requirement[]; onRaised: (id: string) => void; onClose: () => void }) {
  const canSeeMasters = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const create = useCreatePurchaseOrderFromRequirements();
  const [vendor, setVendor] = useState<PickerOption | null>(null);
  const [expectedDate, setExpectedDate] = useState<string | null>(null);

  const items = new Set(requirements.map((r) => r.stockItemId)).size;
  const copy = actionErrorCopy(create.error, 'Raising the purchase order');

  function submit() {
    if (vendor === null || create.isPending || requirements.length === 0) return;
    create.mutate(
      { partyId: vendor.id, requirementIds: requirements.map((r) => r.id), expectedDate },
      {
        onSuccess: (saved) => {
          toast.add({ type: 'success', title: `${saved.number} drafted`, description: `${saved.vendorName} · ${String(saved.lines.length)} line${saved.lines.length === 1 ? '' : 's'}. Set the rates, then confirm.` });
          onClose();
          onRaised(saved.id);
        },
      },
    );
  }

  return (
    <ShortcutLayer id="modal:requirements-raise-po">
      <SaveShortcut id="requirements-raise-po.save" onSave={submit} />
      <DialogHeader>
        <DialogTitle>Raise a purchase order</DialogTitle>
        <DialogDescription>
          {String(requirements.length)} requirement{requirements.length === 1 ? '' : 's'} across {String(items)} item{items === 1 ? '' : 's'} become one draft PO, one line per item, quantities summed. Rates are set on
          the draft.
        </DialogDescription>
      </DialogHeader>
      <Form onSubmit={submit}>
        <FieldGroup>
          {create.isError ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>{copy.title}</AlertTitle>
              <AlertDescription>{copy.description}</AlertDescription>
            </Alert>
          ) : null}
          <ul className="max-h-40 divide-y overflow-y-auto border text-sm">
            {requirements.map((r) => (
              <li key={r.id} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                <span className="min-w-0 truncate">
                  {r.stockItemName}
                  {r.customerName ? <span className="text-muted-foreground ml-2 text-xs">{r.customerName}</span> : null}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatQty(r.quantity)}</span>
              </li>
            ))}
          </ul>
          <Field>
            <FieldLabel htmlFor="raise-po-vendor">Vendor</FieldLabel>
            <PartyPicker
              id="raise-po-vendor"
              label="Vendor"
              placeholder="Choose the party"
              icon={<BooksIcon className="text-muted-foreground" />}
              enabled={canSeeMasters}
              disabled={!canSeeMasters}
              partyId={vendor?.id ?? null}
              onValueChange={(next) => { setVendor(next ? { id: next.id, label: next.name } : null); }}
            />
            {!canSeeMasters ? <FieldDescription>Choosing a vendor needs masters.tally.view.</FieldDescription> : null}
          </Field>
          <Field>
            <FieldLabel>Expected</FieldLabel>
            <OptionalDateField label="Expected date" emptyLabel="No date yet — set one" value={expectedDate} onValueChange={setExpectedDate} />
          </Field>
        </FieldGroup>
      </Form>
      <DialogFooter className="flex-row justify-end gap-2">
        <Button variant="outline" className="flex-1 sm:flex-none" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          Cancel
        </Button>
        <Button className="flex-1 sm:flex-none" disabled={vendor === null || create.isPending} onClick={submit}>
          {create.isPending ? <Spinner data-icon="inline-start" /> : <ShoppingCartIcon data-icon="inline-start" />}
          {create.isPending ? 'Drafting' : 'Draft the PO'}
          <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
        </Button>
      </DialogFooter>
    </ShortcutLayer>
  );
}

function SaveShortcut({ id, onSave }: { id: string; onSave: () => void }) {
  useShortcut({ id, keys: 'ctrl+a', label: 'Accept / Save', scope: 'modal', allowInInput: true, run: onSave });
  return null;
}
