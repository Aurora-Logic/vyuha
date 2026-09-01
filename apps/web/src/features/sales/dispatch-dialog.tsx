import { useEffect, useRef, useState } from 'react';
import { TruckIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { useNavigate } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { DateField } from '@/features/attendance/pickers';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { DISPATCH_MODES, DISPATCH_MODE_LABELS, type CreateDispatchInput, type DispatchMode } from '@vyuha/shared';

import { PhotoPicker } from '@/components/shared/photo-picker';
import { type PreparedPhoto } from '@/components/shared/prepare-photo';
import { ResponsiveDialog, ResponsiveDialogActions } from '@/components/shared/responsive-dialog';
import { lineBalances, trimZeros, type Estimate, type SalesLine } from './types';
import { useCreateDispatch } from './use-dispatches';

/**
 * REQ-AA-16…AA-21: one dispatch against an order — its own lines within the
 * invoiced balance (REQ-AA-14: nothing leaves ahead of the paperwork), the
 * mode, and what the mode demands: vehicle and driver for our own vehicle,
 * LR and transporter and both photographs for outstation. Each missing
 * field is named with the sentence the schema uses, before the request.
 *
 * Photographs come from the camera or the gallery (REQ-AA-21) through the
 * one sanctioned hidden file input, and travel as `box` and `lr` parts
 * beside the JSON. The result opens on the dispatch, where the composed
 * notification waits to be sent by hand (REQ-AA-26).
 */

const QUANTITY = /^\d{1,12}(\.\d{1,3})?$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MAX_BOX_PHOTOS = 6;
const MAX_LR_PHOTOS = 3;

interface DispatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: Estimate | null;
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => void;
}

export function DispatchDialog({ open, onOpenChange, order, loading = false, loadError, onRetry }: DispatchDialogProps) {
  const close = () => {
    onOpenChange(false);
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={order === null ? 'Dispatch' : `Dispatch ${order.number}`}
      description={order === null ? 'What leaves, how it travels, and the proof.' : `${order.customerName}. Only what an invoice covers can leave; the balance stays on the order.`}
      className="sm:max-w-2xl"
    >
      {loading ? (
        <div role="status" aria-busy="true" aria-label="Loading the order" className="flex flex-col gap-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : null}
      {loadError !== undefined && loadError !== null ? <QueryErrorAlert error={loadError} subject="that sales order" onRetry={onRetry ?? close} /> : null}
      {order === null ? (
        <ResponsiveDialogActions>
          <Button variant="outline" onClick={close}>
            <ACTION_ICONS.close data-icon="inline-start" />
            Close
          </Button>
        </ResponsiveDialogActions>
      ) : (
        <DispatchForm key={order.id} order={order} onClose={close} />
      )}
    </ResponsiveDialog>
  );
}

function DispatchForm({ order, onClose }: { order: Estimate; onClose: () => void }) {
  const navigate = useNavigate();
  const lines = order.lines.filter((line) => lineBalances(line).toDispatch > 0);
  const [mode, setMode] = useState<DispatchMode>('local_auto');
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((line) => [line.id, trimZeros(lineBalances(line).toDispatch.toFixed(3))])),
  );
  const [lrNumber, setLrNumber] = useState('');
  const [transporterName, setTransporterName] = useState('');
  const [transporterContact, setTransporterContact] = useState('');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [driverName, setDriverName] = useState('');
  const [expected, setExpected] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [email, setEmail] = useState(order.customerEmail ?? '');
  const [whatsapp, setWhatsapp] = useState(order.customerWhatsapp ?? '');
  const [box, setBox] = useState<PreparedPhoto[]>([]);
  const [lr, setLr] = useState<PreparedPhoto[]>([]);
  const create = useCreateDispatch();

  // Object URLs are revoked when the form goes, whatever it held by then.
  const held = useRef<PreparedPhoto[]>([]);
  useEffect(() => {
    held.current = [...box, ...lr];
  });
  useEffect(
    () => () => {
      for (const photo of held.current) URL.revokeObjectURL(photo.previewUrl);
    },
    [],
  );

  const problems = lines.map((line) => problemFor(line, quantities[line.id] ?? ''));
  const named = lines.filter((line) => Number(quantities[line.id] ?? '0') > 0);
  const dispatchable = order.status === 'CONFIRMED' && order.shortClosedAt === null;
  const modeLabel = DISPATCH_MODE_LABELS[mode];
  const need = (value: string, label: string): string | null => (value.trim() === '' ? `${label} is required for ${modeLabel}` : null);
  const missing = {
    vehicleNumber: mode === 'local_own_vehicle' ? need(vehicleNumber, 'Vehicle number') : null,
    driverName: mode === 'local_own_vehicle' ? need(driverName, 'Driver name') : null,
    lrNumber: mode === 'outstation' ? need(lrNumber, 'LR number') : null,
    transporterName: mode === 'outstation' ? need(transporterName, 'Transporter name') : null,
    transporterContact: mode === 'outstation' ? need(transporterContact, 'Transporter contact') : null,
    box: mode === 'outstation' && box.length === 0 ? 'A photograph of the packed boxes is required for outstation.' : null,
    lr: mode === 'outstation' && lr.length === 0 ? 'A photograph of the LR is required for outstation.' : null,
    email: email.trim() !== '' && !EMAIL.test(email.trim()) ? 'Not an email address.' : null,
    whatsapp: whatsapp.trim() !== '' && (whatsapp.trim().length < 6 || whatsapp.trim().length > 24) ? 'A WhatsApp number is 6 to 24 characters.' : null,
  };
  const complete = Object.values(missing).every((m) => m === null);
  const canSubmit = dispatchable && named.length > 0 && problems.every((p) => p === null) && complete && !create.isPending;

  function submit() {
    if (!canSubmit) return;
    const text = (value: string): string | null => (value.trim() === '' ? null : value.trim());
    const input: CreateDispatchInput = {
      mode,
      lines: named.map((line) => ({ lineId: line.id, quantity: (quantities[line.id] ?? '0').trim() })),
      lrNumber: mode === 'outstation' ? text(lrNumber) : null,
      transporterName: mode === 'outstation' ? text(transporterName) : null,
      transporterContact: mode === 'outstation' ? text(transporterContact) : null,
      vehicleNumber: mode === 'local_auto' ? null : text(vehicleNumber),
      driverName: mode === 'local_own_vehicle' ? text(driverName) : null,
      expectedDeliveryDate: mode === 'outstation' ? expected : null,
      notes: text(notes),
      // REQ-AA-28: only an override travels; blank falls back to the order, then the party.
      customerEmail: text(email),
      customerWhatsapp: text(whatsapp),
    };
    create.mutate(
      { documentId: order.id, input, box: box.map((p) => p.file), lr: lr.map((p) => p.file) },
      {
        onSuccess: (dispatch) => {
          toast.add({
            type: 'success',
            title: `${dispatch.number} dispatched`,
            description: dispatch.syncState === 'QUEUED' ? 'Delivery Note queued for Tally. Send the customer their notification.' : 'No agent connection can carry the Delivery Note yet; push it when one is issued.',
          });
          onClose();
          void navigate(`/sales/dispatches/${dispatch.id}`);
        },
      },
    );
  }

  const copy = actionErrorCopy(create.error, 'Dispatching');
  function forget(photo: PreparedPhoto | undefined) {
    if (photo !== undefined) URL.revokeObjectURL(photo.previewUrl);
  }

  return (
    <ShortcutLayer id={`modal:dispatch-${order.id}`}>
      <DispatchShortcut onSave={submit} />
      <FieldGroup>
        {create.error ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>{copy.title}</AlertTitle>
            <AlertDescription>{copy.description}</AlertDescription>
          </Alert>
        ) : null}

        {dispatchable ? null : (
          <Alert>
            <TruckIcon />
            <AlertTitle>{order.shortClosedAt === null ? 'Only a confirmed order dispatches' : `${order.number} was short-closed`}</AlertTitle>
            <AlertDescription>{order.shortClosedAt === null ? 'Confirm it first.' : (order.shortCloseReason ?? 'Its balance was written off.')}</AlertDescription>
          </Alert>
        )}

        {lines.length === 0 ? (
          <Alert>
            <TruckIcon />
            <AlertTitle>Nothing on {order.number} is invoiced and waiting to leave</AlertTitle>
            <AlertDescription>Goods do not leave ahead of the paperwork. Raise or link an invoice first.</AlertDescription>
          </Alert>
        ) : (
          <>
            <ol className="flex flex-col divide-y border">
              {lines.map((line, index) => {
                const balance = lineBalances(line);
                const problem = problems[index] ?? null;
                return (
                  <li key={line.id} className="flex flex-col gap-2 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="min-w-0 text-sm font-medium">
                        <span className="text-muted-foreground mr-2 text-xs tabular-nums">{String(line.lineNo)}.</span>
                        {line.description}
                      </span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        Invoiced {trimZeros(line.invoicedQty)} · Dispatched {trimZeros(line.dispatchedQty)} · Can leave {trimZeros(balance.toDispatch.toFixed(3))}
                        {line.unit ? ` ${line.unit}` : ''}
                      </span>
                    </div>
                    <Input
                      aria-label={`Line ${String(line.lineNo)} dispatched quantity`}
                      aria-invalid={problem !== null || undefined}
                      inputMode="decimal"
                      className="max-w-[7rem] tabular-nums"
                      placeholder="Qty"
                      disabled={!dispatchable}
                      value={quantities[line.id] ?? ''}
                      onChange={(event) => {
                        setQuantities((current) => ({ ...current, [line.id]: event.target.value }));
                      }}
                    />
                    {problem === null ? null : <FieldError>{problem}</FieldError>}
                  </li>
                );
              })}
            </ol>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="dispatch-mode">Mode</FieldLabel>
                <Select
                  value={mode}
                  onValueChange={(value: string | null) => {
                    const next = DISPATCH_MODES.find((m) => m === value);
                    if (next) setMode(next);
                  }}
                >
                  <SelectTrigger id="dispatch-mode" className="w-full" aria-label="Mode" disabled={!dispatchable}>
                    <SelectValue>{(value: string) => DISPATCH_MODE_LABELS[value as DispatchMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {DISPATCH_MODES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {DISPATCH_MODE_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {mode === 'local_auto' ? 'Nothing more is needed.' : mode === 'local_own_vehicle' ? 'Vehicle and driver are recorded.' : mode === 'customer_collects' ? 'Nothing more is needed; the customer is told it is ready to collect.' : 'LR, transporter, and both photographs.'}
                </FieldDescription>
              </Field>
              {mode === 'outstation' ? (
                <Field>
                  <FieldLabel>Expected delivery</FieldLabel>
                  <div className="flex flex-wrap items-center gap-2">
                    <DateField
                      label="Expected delivery date"
                      value={fromDateParam(expected ?? toDateParam(new Date()))}
                      onValueChange={(next) => {
                        setExpected(toDateParam(next));
                      }}
                      hint={expected === null ? <span className="text-muted-foreground text-xs">(not set)</span> : undefined}
                      yearsBack={0}
                      yearsForward={1}
                    />
                    {expected === null ? null : (
                      <Button variant="ghost" size="sm" onClick={() => { setExpected(null); }}>
                        <XIcon data-icon="inline-start" />
                        Clear
                      </Button>
                    )}
                  </div>
                  <FieldDescription>Optional; told to the customer when set.</FieldDescription>
                </Field>
              ) : null}
            </div>

            {mode === 'local_own_vehicle' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField id="dispatch-vehicle" label="Vehicle number" value={vehicleNumber} onChange={setVehicleNumber} error={missing.vehicleNumber} disabled={!dispatchable} />
                <TextField id="dispatch-driver" label="Driver name" value={driverName} onChange={setDriverName} error={missing.driverName} disabled={!dispatchable} />
              </div>
            ) : null}

            {mode === 'outstation' ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField id="dispatch-lr" label="LR number" value={lrNumber} onChange={setLrNumber} error={missing.lrNumber} disabled={!dispatchable} />
                  <TextField id="dispatch-vehicle" label="Vehicle number (optional)" value={vehicleNumber} onChange={setVehicleNumber} error={null} disabled={!dispatchable} />
                  <TextField id="dispatch-transporter" label="Transporter name" value={transporterName} onChange={setTransporterName} error={missing.transporterName} disabled={!dispatchable} />
                  <TextField id="dispatch-transporter-contact" label="Transporter contact" value={transporterContact} onChange={setTransporterContact} error={missing.transporterContact} inputMode="tel" disabled={!dispatchable} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <PhotoPicker
                    label="Box photographs"
                    hint={`Up to ${String(MAX_BOX_PHOTOS)}. Camera or gallery.`}
                    photos={box}
                    max={MAX_BOX_PHOTOS}
                    error={missing.box}
                    disabled={!dispatchable}
                    onAdd={(photo) => {
                      setBox((current) => (current.length >= MAX_BOX_PHOTOS ? current : [...current, photo]));
                    }}
                    onRemove={(index) => {
                      forget(box[index]);
                      setBox(box.filter((_, i) => i !== index));
                    }}
                  />
                  <PhotoPicker
                    label="LR photographs"
                    hint={`Up to ${String(MAX_LR_PHOTOS)}. A scan or a WhatsApp image is fine.`}
                    photos={lr}
                    max={MAX_LR_PHOTOS}
                    error={missing.lr}
                    disabled={!dispatchable}
                    onAdd={(photo) => {
                      setLr((current) => (current.length >= MAX_LR_PHOTOS ? current : [...current, photo]));
                    }}
                    onRemove={(index) => {
                      forget(lr[index]);
                      setLr(lr.filter((_, i) => i !== index));
                    }}
                  />
                </div>
              </>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField id="dispatch-email" label="Customer email" value={email} onChange={setEmail} error={missing.email} inputMode="email" placeholder="From the party master when blank" disabled={!dispatchable} />
              <TextField id="dispatch-whatsapp" label="Customer WhatsApp" value={whatsapp} onChange={setWhatsapp} error={missing.whatsapp} inputMode="tel" placeholder="From the party master when blank" disabled={!dispatchable} />
            </div>
            <FieldDescription>Overrides for this dispatch’s notification only. The message is composed now and sent by hand from the dispatch.</FieldDescription>

            <Field>
              <FieldLabel htmlFor="dispatch-notes">Notes</FieldLabel>
              <Textarea
                id="dispatch-notes"
                rows={2}
                disabled={!dispatchable}
                value={notes}
                onChange={(event) => {
                  setNotes(event.target.value);
                }}
              />
              <FieldDescription>Included in the customer’s message.</FieldDescription>
            </Field>
          </>
        )}
      </FieldGroup>

      <ResponsiveDialogActions>
        <Button variant="outline" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          {dispatchable && lines.length > 0 ? 'Cancel' : 'Close'}
        </Button>
        {dispatchable && lines.length > 0 ? (
          <Button disabled={!canSubmit} onClick={submit}>
            {create.isPending ? <Spinner data-icon="inline-start" /> : <TruckIcon data-icon="inline-start" />}
            {create.isPending ? 'Dispatching' : 'Dispatch'}
            <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
          </Button>
        ) : null}
      </ResponsiveDialogActions>
    </ShortcutLayer>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  error,
  disabled,
  inputMode,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  disabled: boolean;
  inputMode?: 'tel' | 'email';
  placeholder?: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        aria-invalid={error !== null || undefined}
        inputMode={inputMode}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {error === null ? null : <FieldError>{error}</FieldError>}
    </Field>
  );
}

/** The API's own sentence (REQ-AA-14), so the field teaches the same rule the server enforces. */
function problemFor(line: SalesLine, quantity: string): string | null {
  const trimmed = quantity.trim();
  if (trimmed === '' || Number(trimmed) === 0) return null;
  if (!QUANTITY.test(trimmed)) return 'A quantity with up to three decimals.';
  const balance = lineBalances(line).toDispatch;
  if (Number(trimmed) > balance + 1e-9) {
    return `Line ${String(line.lineNo)} (${line.description}) has ${balance.toFixed(3)} invoiced and not yet dispatched; ${trimmed} cannot leave until an invoice covers it.`;
  }
  return null;
}

function DispatchShortcut({ onSave }: { onSave: () => void }) {
  useShortcut({ id: 'dispatch-dialog.save', keys: 'ctrl+a', label: 'Accept / Dispatch', scope: 'modal', allowInInput: true, run: onSave });
  return null;
}
