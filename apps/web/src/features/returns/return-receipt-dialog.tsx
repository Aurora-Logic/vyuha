import { useMemo, useState } from 'react';
import { ArrowUUpLeftIcon, BooksIcon, TrashIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { PhotoPicker } from '@/components/shared/photo-picker';
import { type PreparedPhoto } from '@/components/shared/prepare-photo';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { duplicateWarning } from '@/components/shared/duplicate-flag';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useParties } from '@/features/masters/use-parties';
import { ResponsiveDialog, ResponsiveDialogActions } from '@/features/sales/responsive-dialog';
import { useSalesOrder, useSalesOrders } from '@/features/sales/use-estimates';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, RETURN_CONDITIONS, RETURN_CONDITION_LABELS, RETURN_DISPOSITIONS, RETURN_DISPOSITION_LABELS, type ReturnCondition, type ReturnDisposition, type ReturnLineInput } from '@vyuha/shared';

import { useCreateReturn, useReturnReasons } from './use-returns';

/**
 * REQ-AK-01…AK-04: the return desk. The person filling this in is holding
 * the goods, so the form asks only what they can see — how many, why, what
 * state they arrived in, and where they go next — and takes the photograph
 * in the same breath, because a damage claim without one is an argument.
 *
 * Picking the order the goods came from fills the lines in, and the
 * quantity is then held to what that line actually sent. Without an order
 * the lines are typed, because the goods are in the room whether or not
 * Vyuha ever saw the invoice.
 */

const QUANTITY = /^\d{1,12}(\.\d{1,3})?$/u;

interface DraftLine {
  readonly key: string;
  lineId: string | null;
  stockItemId: string | null;
  description: string;
  unit: string | null;
  /** What the source line dispatched, when there is one; the ceiling for this row. */
  sent: number | null;
  quantity: string;
  reason: string;
  reasonNote: string;
  condition: ReturnCondition;
  disposition: ReturnDisposition;
}

function blankLine(key: string, reason: string): DraftLine {
  return { key, lineId: null, stockItemId: null, description: '', unit: null, sent: null, quantity: '', reason, reasonNote: '', condition: 'sealed', disposition: 'restock' };
}

export function ReturnReceiptDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const canScrap = usePermission(PERMISSIONS.RETURNS_DISPOSITION);
  const reasons = useReturnReasons({ enabled: open });
  const create = useCreateReturn();
  const [partyId, setPartyId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  /**
   * The order's lines are read, never copied into state: what the person
   * types is held per line and laid over them at render. Copying them in an
   * effect would mean a second source of truth, stale the moment the order
   * refetches.
   */
  const [edits, setEdits] = useState<Record<string, Partial<DraftLine>>>({});
  const [typed, setTyped] = useState<DraftLine[]>([]);
  const [removed, setRemoved] = useState<readonly string[]>([]);
  const [photos, setPhotos] = useState<PreparedPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const parties = useParties({ page: 1, pageSize: 200 });
  const orders = useSalesOrders({ page: 1, ...(partyId === null ? {} : { partyId }) }, { enabled: open && partyId !== null });
  const order = useSalesOrder(orderId);
  const firstReason = reasons.data?.reasons[0] ?? '';

  const lines: DraftLine[] = useMemo(() => {
    const fromOrder = (order.data === undefined || orderId === null ? [] : order.data.lines)
      .filter((line) => Number(line.dispatchedQty) > 0 && !removed.includes(line.id))
      .map((line): DraftLine => ({
        key: line.id,
        lineId: line.id,
        stockItemId: line.stockItemId,
        description: line.description,
        unit: line.unit,
        sent: Number(line.dispatchedQty),
        quantity: '',
        reason: firstReason,
        reasonNote: '',
        condition: 'sealed',
        disposition: 'restock',
        ...edits[line.id],
      }));
    return [...fromOrder, ...typed.filter((line) => !removed.includes(line.key)).map((line) => ({ ...line, ...edits[line.key] }))];
  }, [order.data, orderId, firstReason, edits, typed, removed]);

  function reset(): void {
    setPartyId(null);
    setCustomerName('');
    setOrderId(null);
    setNotes('');
    setEdits({});
    setTyped([]);
    setRemoved([]);
    for (const photo of photos) URL.revokeObjectURL(photo.previewUrl);
    setPhotos([]);
    setError(null);
  }

  const partyOptions: PickerOption[] = (parties.data?.data ?? []).map((p) => ({
    id: p.id,
    label: p.name,
    ...(p.gstin === null ? {} : { hint: p.gstin }),
    ...(p.duplicate ? { warning: duplicateWarning(p.duplicate) } : {}),
  }));
  const orderOptions: PickerOption[] = (orders.data?.data ?? []).map((o) => ({ id: o.id, label: o.number, hint: o.date }));
  const pick = (options: readonly PickerOption[], id: string | null) => options.find((o) => o.id === id) ?? null;

  const filled = useMemo(() => lines.filter((line) => line.quantity.trim() !== '' && Number(line.quantity) > 0), [lines]);

  function problemFor(line: DraftLine): string | null {
    const value = line.quantity.trim();
    if (value === '') return null;
    if (!QUANTITY.test(value)) return 'A quantity with up to three decimals.';
    if (line.sent !== null && Number(value) > line.sent + 1e-9) return `That line sent ${line.sent.toFixed(3)}; more than that cannot come back.`;
    if (line.description.trim() === '') return 'A description is needed for a typed line.';
    return null;
  }

  function update(key: string, patch: Partial<DraftLine>): void {
    setEdits((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }

  async function save(): Promise<void> {
    setError(null);
    if (customerName.trim() === '') {
      setError('Say who sent the goods back.');
      return;
    }
    if (filled.length === 0) {
      setError('A return needs at least one line with a quantity.');
      return;
    }
    const problem = filled.map((line) => problemFor(line)).find((p) => p !== null);
    if (problem != null) {
      setError(problem);
      return;
    }
    const payload: ReturnLineInput[] = filled.map((line) => ({
      lineId: line.lineId,
      stockItemId: line.stockItemId,
      description: line.description.trim(),
      unit: line.unit,
      quantity: line.quantity.trim(),
      reason: line.reason,
      reasonNote: line.reasonNote.trim() === '' ? null : line.reasonNote.trim(),
      condition: line.condition,
      disposition: line.disposition,
    }));
    try {
      const received = await create.mutateAsync({
        input: {
          partyId,
          customerName: customerName.trim(),
          sourceDocumentId: orderId,
          notes: notes.trim() === '' ? null : notes.trim(),
          lines: payload,
        },
        goods: photos.map((photo) => photo.file),
        packaging: [],
        document: [],
      });
      toast.add({ type: 'success', title: `${received.number} received`, description: 'It waits for Tally’s credit note.' });
      reset();
      onOpenChange(false);
    } catch (cause) {
      const copy = actionErrorCopy(cause, 'Receiving');
      setError(copy.description);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Receive a return"
      description="What came back, why, in what state, and where it goes. Vyuha raises no credit note — the receipt waits for Tally’s."
      className="sm:max-w-3xl"
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <RecordPicker
            id="return-party"
            label="Customer"
            showLabel
            placeholder="Choose a customer"
            searchPlaceholder="Search parties"
            emptyMessage="No party matches."
            icon={<BooksIcon className="text-muted-foreground" />}
            options={partyOptions}
            loading={parties.isPending}
            value={pick(partyOptions, partyId)}
            onValueChange={(next) => {
              setPartyId(next?.id ?? null);
              setCustomerName(next?.label ?? '');
              setOrderId(null);
              setEdits({});
              setTyped([]);
              setRemoved([]);
            }}
          />
          <RecordPicker
            id="return-order"
            label="Against the order"
            showLabel
            placeholder={partyId === null ? 'Choose a customer first' : 'Optional — fills the lines in'}
            searchPlaceholder="Search orders"
            emptyMessage="No dispatched order for this customer."
            options={orderOptions}
            loading={orders.isPending}
            disabled={partyId === null}
            clearable
            clearLabel="No order"
            value={pick(orderOptions, orderId)}
            onValueChange={(next) => {
              setOrderId(next?.id ?? null);
              setEdits({});
              setRemoved([]);
            }}
          />
        </div>

        {partyId === null ? (
          <Field>
            <FieldLabel htmlFor="return-customer">Customer name</FieldLabel>
            <Input
              id="return-customer"
              value={customerName}
              onChange={(event) => {
                setCustomerName(event.target.value);
              }}
            />
            <FieldDescription>Goods came back from someone who is not yet a Tally party. A replacement order needs one; the receipt does not.</FieldDescription>
          </Field>
        ) : null}

        <Separator />

        <div className="flex flex-col gap-4">
          {lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">Pick an order to fill the lines in, or add one by hand.</p>
          ) : null}
          {lines.map((line, index) => {
            const problem = problemFor(line);
            return (
              <div key={line.key} className="flex flex-col gap-3">
                {index === 0 ? null : <Separator />}
                <div className="flex items-start justify-between gap-2">
                  {line.lineId === null ? (
                    <Field className="flex-1">
                      <FieldLabel htmlFor={`desc-${line.key}`}>Item</FieldLabel>
                      <Input
                        id={`desc-${line.key}`}
                        value={line.description}
                        onChange={(event) => {
                          update(line.key, { description: event.target.value });
                        }}
                      />
                    </Field>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{line.description}</span>
                      <span className="text-muted-foreground text-xs tabular-nums">{line.sent?.toFixed(3) ?? ''} sent{line.unit ? ` ${line.unit}` : ''}</span>
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove line ${String(index + 1)}`}
                    onClick={() => {
                      setRemoved((current) => [...current, line.key]);
                    }}
                  >
                    <TrashIcon />
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-4">
                  <Field data-invalid={problem === null ? undefined : true}>
                    <FieldLabel htmlFor={`qty-${line.key}`}>Quantity</FieldLabel>
                    <Input
                      id={`qty-${line.key}`}
                      inputMode="decimal"
                      className="tabular-nums"
                      value={line.quantity}
                      onChange={(event) => {
                        update(line.key, { quantity: event.target.value });
                      }}
                    />
                    {problem === null ? null : <FieldError>{problem}</FieldError>}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`reason-${line.key}`}>Reason</FieldLabel>
                    <Select
                      value={line.reason}
                      onValueChange={(next) => {
                        update(line.key, { reason: next ?? line.reason });
                      }}
                    >
                      <SelectTrigger id={`reason-${line.key}`}>
                        <SelectValue placeholder="Why it came back" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {(reasons.data?.reasons ?? []).map((reason) => (
                            <SelectItem key={reason} value={reason}>
                              {reason}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`condition-${line.key}`}>Condition</FieldLabel>
                    <Select
                      value={line.condition}
                      onValueChange={(next) => {
                        update(line.key, { condition: next as ReturnCondition });
                      }}
                    >
                      <SelectTrigger id={`condition-${line.key}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {RETURN_CONDITIONS.map((condition) => (
                            <SelectItem key={condition} value={condition}>
                              {RETURN_CONDITION_LABELS[condition]}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`disposition-${line.key}`}>Then</FieldLabel>
                    <Select
                      value={line.disposition}
                      onValueChange={(next) => {
                        update(line.key, { disposition: next as ReturnDisposition });
                      }}
                    >
                      <SelectTrigger id={`disposition-${line.key}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {RETURN_DISPOSITIONS.map((disposition) => (
                            <SelectItem key={disposition} value={disposition} disabled={disposition === 'scrap' && !canScrap}>
                              {RETURN_DISPOSITION_LABELS[disposition]}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {canScrap ? null : <FieldDescription>Scrapping needs returns.disposition.</FieldDescription>}
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor={`note-${line.key}`}>What you can see</FieldLabel>
                  <Input
                    id={`note-${line.key}`}
                    placeholder="Crushed corner, cable exposed"
                    value={line.reasonNote}
                    onChange={(event) => {
                      update(line.key, { reasonNote: event.target.value });
                    }}
                  />
                </Field>
              </div>
            );
          })}
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setTyped((current) => [...current, blankLine(`typed-${String(current.length)}-${String(Date.now())}`, firstReason)]);
              }}
            >
              <ArrowUUpLeftIcon data-icon="inline-start" />
              Add a line
            </Button>
          </div>
        </div>

        <Separator />

        <PhotoPicker
          label="Photographs"
          hint="The goods as they arrived. A damage claim without one is an argument."
          photos={photos}
          max={6}
          error={null}
          disabled={create.isPending}
          onAdd={(photo) => {
            setPhotos((current) => [...current, photo]);
          }}
          onRemove={(index) => {
            setPhotos((current) => {
              const going = current[index];
              if (going !== undefined) URL.revokeObjectURL(going.previewUrl);
              return current.filter((_, i) => i !== index);
            });
          }}
        />

        <Field>
          <FieldLabel htmlFor="return-notes">Notes</FieldLabel>
          <Textarea
            id="return-notes"
            rows={2}
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
        </Field>

        {error === null ? null : <p className="text-destructive text-sm">{error}</p>}
      </div>

      <ResponsiveDialogActions>
        <Button
          variant="outline"
          onClick={() => {
            reset();
            onOpenChange(false);
          }}
        >
          <ACTION_ICONS.cancel data-icon="inline-start" />
          Cancel
        </Button>
        <Button
          disabled={create.isPending}
          onClick={() => {
            void save();
          }}
        >
          {create.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
          Receive
        </Button>
      </ResponsiveDialogActions>
    </ResponsiveDialog>
  );
}
