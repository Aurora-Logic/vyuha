import { useState } from 'react';
import { CheckCircleIcon, CircleIcon, HandGrabbingIcon, PackageIcon, WarningCircleIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { stepOf, type PickPackStep } from './fulfilment-progress';
import { ResponsiveDialog, ResponsiveDialogActions } from '@/components/shared/responsive-dialog';
import { lineBalances, trimZeros, type Estimate, type PackRecord, type PickRecord, type SalesLine } from './types';
import { usePackOrder, usePickOrder } from './use-fulfilment';

/**
 * The owner's flow (22 Aug 2026): an order comes, it is picked, it is packed,
 * the slip prints. One sheet does the two warehouse steps, and opens at the
 * one that is next: Pick while something is still on the shelf, Pack once
 * something picked waits for a box. The picker never meets the rule that a
 * line packs only what it has picked (D-48) as an error, because the sheet
 * does not offer to pack what is not picked.
 *
 * Each step is the same shape (REQ-AA-06…AA-10): every line with a balance,
 * its figures, a box for the quantity that starts full, a tick that says
 * "this line is done", a comment per line and per session, and the button
 * pinned in the footer under the thumb. A short pick or pack is a number
 * typed down; the balance stays on the order and in the queue (REQ-AA-07).
 */

const QUANTITY = /^\d{1,12}(\.\d{1,3})?$/u;

interface PickPackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null while the order is still loading (the pick queue opens by id). */
  order: Estimate | null;
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => void;
  onPacked?: (record: PackRecord) => void;
}

export function PickPackDialog({ open, onOpenChange, order, loading = false, loadError, onRetry, onPacked }: PickPackDialogProps) {
  const close = () => {
    onOpenChange(false);
  };
  return order === null ? (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Pick" description="The pick list for this order." className="sm:max-w-lg">
      {loading ? (
        <div role="status" aria-busy="true" aria-label="Loading the order" className="flex flex-col gap-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : null}
      {loadError !== undefined && loadError !== null ? <QueryErrorAlert error={loadError} subject="that sales order" onRetry={onRetry ?? close} /> : null}
      <ResponsiveDialogActions>
        <Button variant="outline" onClick={close}>
          <ACTION_ICONS.close data-icon="inline-start" />
          Close
        </Button>
      </ResponsiveDialogActions>
    </ResponsiveDialog>
  ) : (
    <Flow key={order.id} open={open} onOpenChange={onOpenChange} order={order} onClose={close} onPacked={onPacked} />
  );
}

function Flow({ open, onOpenChange, order, onClose, onPacked }: { open: boolean; onOpenChange: (open: boolean) => void; order: Estimate; onClose: () => void; onPacked?: (record: PackRecord) => void }) {
  // The person may step back to pick the rest while a box waits; the order's own figures decide otherwise.
  const [chosen, setChosen] = useState<PickPackStep | null>(null);
  const step = chosen ?? stepOf(order);
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${step === 'pick' ? 'Pick' : 'Pack'} ${order.number}`}
      description={
        step === 'pick'
          ? `${order.customerName}. Tick what came off the shelf; what is not picked stays in the queue.`
          : `${order.customerName}. Type what went in the box; the balance stays on the order and returns to the queue.`
      }
      className="sm:max-w-lg"
    >
      {step === 'pick' ? (
        <PickForm
          order={order}
          onClose={onClose}
          onPicked={() => {
            setChosen('pack');
          }}
        />
      ) : (
        <PackForm
          order={order}
          onClose={onClose}
          onPacked={onPacked}
          onPickRest={() => {
            setChosen('pick');
          }}
        />
      )}
    </ResponsiveDialog>
  );
}

interface LineEntry {
  quantity: string;
  comment: string;
}

function useEntries(lines: readonly SalesLine[], balanceOf: (line: SalesLine) => number) {
  const [entries, setEntries] = useState<Record<string, LineEntry>>(() =>
    Object.fromEntries(lines.map((line) => [line.id, { quantity: trimZeros(balanceOf(line).toFixed(3)), comment: '' }])),
  );
  const named = lines.filter((line) => Number(entries[line.id]?.quantity ?? '0') > 0);
  // D-44: a line is done when what is typed is its whole balance.
  const isDone = (line: SalesLine) => Math.abs(Number(entries[line.id]?.quantity ?? '0') - balanceOf(line)) < 1e-9 && balanceOf(line) > 0;
  function toggleDone(line: SalesLine) {
    const entry = entries[line.id] ?? { quantity: '', comment: '' };
    const next = isDone(line) ? '' : trimZeros(balanceOf(line).toFixed(3));
    setEntries((current) => ({ ...current, [line.id]: { ...entry, quantity: next } }));
  }
  function update(line: SalesLine, patch: Partial<LineEntry>) {
    setEntries((current) => ({ ...current, [line.id]: { ...(current[line.id] ?? { quantity: '', comment: '' }), ...patch } }));
  }
  return { entries, named, isDone, toggleDone, update };
}

/** The API's own sentence, so the field teaches the same rule the server enforces. */
function problemFor(line: SalesLine, quantity: string, balance: number, verb: 'pick' | 'pack'): string | null {
  const trimmed = quantity.trim();
  if (trimmed === '' || Number(trimmed) === 0) return null;
  if (!QUANTITY.test(trimmed)) return 'A quantity with up to three decimals.';
  if (Number(trimmed) > balance + 1e-9) {
    return verb === 'pick'
      ? `Line ${String(line.lineNo)} (${line.description}) has ${balance.toFixed(3)} left to pick, not ${trimmed}.`
      : `Line ${String(line.lineNo)} (${line.description}) has ${balance.toFixed(3)} picked and not yet packed, not ${trimmed}.`;
  }
  return null;
}

function linesToRequest(named: readonly SalesLine[], entries: Record<string, LineEntry>) {
  return named.map((line) => {
    const entry = entries[line.id];
    const lineComment = entry?.comment.trim() ?? '';
    return { lineId: line.id, quantity: (entry?.quantity ?? '0').trim(), comment: lineComment === '' ? null : lineComment };
  });
}

function NotAllowed({ canAct, order, verb }: { canAct: boolean; order: Estimate; verb: string }) {
  return (
    <Alert>
      <PackageIcon />
      <AlertTitle>{!canAct ? `You can see the queue, not ${verb} it` : order.shortClosedAt === null ? `Only a confirmed order is ${verb}ed` : `${order.number} was short-closed`}</AlertTitle>
      <AlertDescription>
        {!canAct
          ? `${verb === 'pick' ? 'Picking' : 'Packing'} needs sales.document.create — the Sales role carries it; a warehouse role needs it too.`
          : order.shortClosedAt === null
            ? `Confirm it first, then ${verb}.`
            : (order.shortCloseReason ?? 'Its balance was written off.')}
      </AlertDescription>
    </Alert>
  );
}

function LineRows({
  lines,
  order,
  entries,
  problems,
  isDone,
  toggleDone,
  update,
  enabled,
  verb,
  figures,
  onEnter,
}: {
  lines: readonly SalesLine[];
  order: Estimate;
  entries: Record<string, LineEntry>;
  problems: (string | null)[];
  isDone: (line: SalesLine) => boolean;
  toggleDone: (line: SalesLine) => void;
  update: (line: SalesLine, patch: Partial<LineEntry>) => void;
  enabled: boolean;
  verb: 'pick' | 'pack';
  figures: (line: SalesLine) => string;
  onEnter: () => void;
}) {
  if (lines.length === 0) {
    return <p className="text-muted-foreground text-sm">{verb === 'pick' ? `Everything on ${order.number} is picked.` : `Everything picked on ${order.number} is packed.`}</p>;
  }
  return (
    <ol className="flex flex-col divide-y border">
      {lines.map((line, index) => {
        const problem = problems[index] ?? null;
        const entry = entries[line.id] ?? { quantity: '', comment: '' };
        return (
          <li key={line.id} className="flex flex-col gap-2 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="min-w-0 text-sm font-medium">
                  <span className="text-muted-foreground mr-2 text-xs tabular-nums">{String(line.lineNo)}.</span>
                  {line.description}
                </span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {figures(line)}
                  {line.unit ? ` ${line.unit}` : ''}
                </span>
              </div>
              {/* D-44: one tap says "this line is done" — the whole balance; a partial is typed below. */}
              <Button
                type="button"
                variant={isDone(line) ? 'default' : 'outline'}
                size="sm"
                className="shrink-0"
                aria-pressed={isDone(line)}
                aria-label={`Line ${String(line.lineNo)} ${verb === 'pick' ? 'picked' : 'fulfilled'}`}
                disabled={!enabled}
                onClick={() => {
                  toggleDone(line);
                }}
              >
                {isDone(line) ? <CheckCircleIcon data-icon="inline-start" weight="fill" /> : <CircleIcon data-icon="inline-start" />}
                {verb === 'pick' ? 'Picked' : 'Fulfilled'}
              </Button>
            </div>
            <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-2">
              <Input
                aria-label={`Line ${String(line.lineNo)} ${verb === 'pick' ? 'picked' : 'packed'} quantity`}
                aria-invalid={problem !== null || undefined}
                inputMode="decimal"
                className="tabular-nums"
                placeholder="Qty"
                disabled={!enabled}
                value={entry.quantity}
                onChange={(event) => {
                  update(line, { quantity: event.target.value });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onEnter();
                  }
                }}
              />
              <Input
                aria-label={`Line ${String(line.lineNo)} comment`}
                placeholder="Comment: short supply, damage, substitution"
                disabled={!enabled}
                value={entry.comment}
                onChange={(event) => {
                  update(line, { comment: event.target.value });
                }}
              />
            </div>
            {problem === null ? null : <FieldError>{problem}</FieldError>}
          </li>
        );
      })}
    </ol>
  );
}

function PickForm({ order, onClose, onPicked }: { order: Estimate; onClose: () => void; onPicked: (record: PickRecord) => void }) {
  const lines = order.lines.filter((line) => lineBalances(line).toPick > 0);
  const balanceOf = (line: SalesLine) => lineBalances(line).toPick;
  const { entries, named, isDone, toggleDone, update } = useEntries(lines, balanceOf);
  const [comment, setComment] = useState('');
  const pick = usePickOrder();

  const problems = lines.map((line) => problemFor(line, entries[line.id]?.quantity ?? '', balanceOf(line), 'pick'));
  const doneCount = lines.filter(isDone).length;
  // Picking writes to the order, so it needs the create key like every other move of quantity (P8-5).
  const canPick = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const pickable = canPick && order.status === 'CONFIRMED' && order.shortClosedAt === null;
  const canSubmit = pickable && named.length > 0 && problems.every((p) => p === null) && !pick.isPending;

  function submit() {
    if (!canSubmit) return;
    pick.mutate(
      { documentId: order.id, input: { comment: comment.trim() === '' ? null : comment.trim(), lines: linesToRequest(named, entries) } },
      {
        onSuccess: (record) => {
          toast.add({
            type: 'success',
            title: `${order.number} picked`,
            description: `${String(record.lines.length)} line${record.lines.length === 1 ? '' : 's'} off the shelf. Now pack it.`,
          });
          onPicked(record);
        },
      },
    );
  }

  const copy = actionErrorCopy(pick.error, 'Picking');

  return (
    <ShortcutLayer id={`modal:pick-${order.id}`}>
      <SaveShortcut id="pick-dialog.save" label="Accept / Pick" onSave={submit} />
      <FieldGroup>
        {pick.error ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>{copy.title}</AlertTitle>
            <AlertDescription>{copy.description}</AlertDescription>
          </Alert>
        ) : null}
        {pickable ? null : <NotAllowed canAct={canPick} order={order} verb="pick" />}
        <LineRows
          lines={lines}
          order={order}
          entries={entries}
          problems={problems}
          isDone={isDone}
          toggleDone={toggleDone}
          update={update}
          enabled={pickable}
          verb="pick"
          figures={(line) => `Ordered ${trimZeros(line.quantity)} · Picked ${trimZeros(line.pickedQty)} · On the shelf ${trimZeros(balanceOf(line).toFixed(3))}`}
          onEnter={submit}
        />
        {pickable && lines.length > 0 ? (
          <Field>
            <FieldLabel htmlFor="pick-comment">Comment on this pick</FieldLabel>
            <Textarea
              id="pick-comment"
              rows={2}
              placeholder="Anything the office needs to know"
              value={comment}
              onChange={(event) => {
                setComment(event.target.value);
              }}
            />
            <FieldDescription>Visible to sales, on the order.</FieldDescription>
          </Field>
        ) : null}
      </FieldGroup>

      <ResponsiveDialogActions>
        <Button variant="outline" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          {pickable && lines.length > 0 ? 'Cancel' : 'Close'}
        </Button>
        {pickable && lines.length > 0 ? (
          <Button disabled={!canSubmit} onClick={submit}>
            {pick.isPending ? <Spinner data-icon="inline-start" /> : <HandGrabbingIcon data-icon="inline-start" />}
            {pick.isPending
              ? 'Picking'
              : named.length === 0
                ? 'Pick'
                : doneCount === lines.length
                  ? `Pick all ${String(lines.length)}`
                  : `Pick ${String(named.length)} line${named.length === 1 ? '' : 's'}`}
            <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
          </Button>
        ) : null}
      </ResponsiveDialogActions>
    </ShortcutLayer>
  );
}

function PackForm({ order, onClose, onPacked, onPickRest }: { order: Estimate; onClose: () => void; onPacked?: (record: PackRecord) => void; onPickRest: () => void }) {
  const lines = order.lines.filter((line) => lineBalances(line).toPack > 0);
  const stillOnShelf = order.lines.filter((line) => lineBalances(line).toPick > 0).length;
  const balanceOf = (line: SalesLine) => lineBalances(line).toPack;
  const { entries, named, isDone, toggleDone, update } = useEntries(lines, balanceOf);
  const [boxCount, setBoxCount] = useState('1');
  const [comment, setComment] = useState('');
  const pack = usePackOrder();

  const problems = lines.map((line) => problemFor(line, entries[line.id]?.quantity ?? '', balanceOf(line), 'pack'));
  const fulfilledCount = lines.filter(isDone).length;
  const boxes = Number(boxCount);
  const boxesValid = Number.isInteger(boxes) && boxes >= 1 && boxes <= 999;
  // Packing writes to the order, so it needs the create key like every other move of quantity (P8-5).
  const canPack = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const packable = canPack && order.status === 'CONFIRMED' && order.shortClosedAt === null;
  const canSubmit = packable && named.length > 0 && problems.every((p) => p === null) && boxesValid && !pack.isPending;

  function submit() {
    if (!canSubmit) return;
    pack.mutate(
      {
        documentId: order.id,
        input: { boxCount: boxes, comment: comment.trim() === '' ? null : comment.trim(), lines: linesToRequest(named, entries) },
      },
      {
        onSuccess: (record) => {
          // D-47: the slip is what the packer needs next, so it is one tap
          // from here - the print route opens with one sheet per box.
          toast.add({
            type: 'success',
            title: `${order.number} packed`,
            description: `${String(record.lines.length)} line${record.lines.length === 1 ? '' : 's'} in ${String(record.boxCount)} box${record.boxCount === 1 ? '' : 'es'}. Print the slip${record.boxCount === 1 ? '' : 's'} and put one in each box.`,
            actionProps: {
              children: 'Print slips',
              onClick: () => {
                window.open(`/print/packs/${record.id}`, '_blank', 'noopener');
              },
            },
          });
          onPacked?.(record);
          onClose();
        },
      },
    );
  }

  const copy = actionErrorCopy(pack.error, 'Packing');

  return (
    <ShortcutLayer id={`modal:pack-${order.id}`}>
      <SaveShortcut id="pack-dialog.save" label="Accept / Pack" onSave={submit} />
      <FieldGroup>
        {pack.error ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>{copy.title}</AlertTitle>
            <AlertDescription>{copy.description}</AlertDescription>
          </Alert>
        ) : null}
        {packable ? null : <NotAllowed canAct={canPack} order={order} verb="pack" />}
        <LineRows
          lines={lines}
          order={order}
          entries={entries}
          problems={problems}
          isDone={isDone}
          toggleDone={toggleDone}
          update={update}
          enabled={packable}
          verb="pack"
          figures={(line) => `Ordered ${trimZeros(line.quantity)} · Picked ${trimZeros(line.pickedQty)} · Packed ${trimZeros(line.packedQty)} · Balance ${trimZeros(balanceOf(line).toFixed(3))}`}
          onEnter={submit}
        />
        {stillOnShelf > 0 ? (
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm">
            <span>
              {String(stillOnShelf)} line{stillOnShelf === 1 ? ' is' : 's are'} still on the shelf.
            </span>
            {packable ? (
              <Button variant="link" size="sm" className="h-auto px-0" onClick={onPickRest}>
                <HandGrabbingIcon data-icon="inline-start" />
                Pick {lines.length === 0 ? 'them' : 'the rest'}
              </Button>
            ) : null}
          </p>
        ) : null}

        {packable && lines.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)]">
            <Field>
              <FieldLabel htmlFor="pack-boxes">Boxes</FieldLabel>
              <Input
                id="pack-boxes"
                inputMode="numeric"
                className="tabular-nums"
                aria-invalid={!boxesValid || undefined}
                value={boxCount}
                onChange={(event) => {
                  setBoxCount(event.target.value);
                }}
              />
              {boxesValid ? null : <FieldError>A whole number from 1 to 999.</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="pack-comment">Comment on this pack</FieldLabel>
              <Textarea
                id="pack-comment"
                rows={2}
                placeholder="Anything the office needs to know"
                value={comment}
                onChange={(event) => {
                  setComment(event.target.value);
                }}
              />
              <FieldDescription>Visible to sales, on the order.</FieldDescription>
            </Field>
          </div>
        ) : null}
      </FieldGroup>

      <ResponsiveDialogActions>
        <Button variant="outline" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          {packable && lines.length > 0 ? 'Cancel' : 'Close'}
        </Button>
        {packable && lines.length > 0 ? (
          <Button disabled={!canSubmit} onClick={submit}>
            {pack.isPending ? <Spinner data-icon="inline-start" /> : <PackageIcon data-icon="inline-start" />}
            {pack.isPending
              ? 'Packing'
              : named.length === 0
                ? 'Pack'
                : fulfilledCount === lines.length
                  ? `Pack all ${String(lines.length)}`
                  : `Pack ${String(named.length)} line${named.length === 1 ? '' : 's'}${fulfilledCount > 0 ? ` (${String(fulfilledCount)} fulfilled)` : ''}`}
            <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
          </Button>
        ) : null}
      </ResponsiveDialogActions>
    </ShortcutLayer>
  );
}

function SaveShortcut({ id, label, onSave }: { id: string; label: string; onSave: () => void }) {
  useShortcut({ id, keys: 'ctrl+a', label, scope: 'modal', allowInInput: true, run: onSave });
  return null;
}
