import { useState } from 'react';
import { CalendarBlankIcon, BooksIcon, CheckIcon, CubeIcon, GitBranchIcon, PaperPlaneTiltIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';

import { Link, useNavigate, useParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { DateField } from '@/features/attendance/pickers';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { useParties } from '@/features/masters/use-parties';
import { useStockItems } from '@/features/masters/use-stock-items';
import { EMPTY_VALUE, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, PRICE_BASES, PRICE_BASIS_LABELS, PRICE_LIST_STATE_LABELS, type PriceBasis, type PriceListDetail, type PriceListDiffLine } from '@vyuha/shared';

import { draftOf, draftProblem, emptyDraft, lineProblem, newAssignmentDraft, newLineDraft, toDraftInput, type AssignmentDraft, type LineDraft, type PriceListDraft } from './price-list-draft';
import { useCreatePriceList, useNewPriceListVersion, usePriceList, usePriceListDiff, useSubmitPriceList, useUpdatePriceList } from './use-pricing';

/**
 * One price list: drafted, sent to the inbox, read while in force, and
 * versioned when it must change (REQ-AN-05..08). The boxes are live only on
 * a draft; an active list shows "New version" instead, because the API
 * refuses an edit to it and the screen says so before the API must.
 * Beside the lines, the diff the approver reads (REQ-AN-12): what moved
 * against the version this one replaces, and who is affected.
 */

const DIFF_COLUMNS: RecordColumn<PriceListDiffLine>[] = [
  { key: 'what', header: 'Item or group', cell: (row) => <span className="font-medium">{row.itemName ?? row.itemGroup ?? EMPTY_VALUE}</span> },
  { key: 'slab', header: 'Quantity', cell: (row) => row.slab, secondary: true },
  { key: 'basis', header: 'Basis', cell: (row) => PRICE_BASIS_LABELS[row.basis] },
  { key: 'rate', header: 'Rate', cell: (row) => formatMoney(row.rate), numeric: true },
  { key: 'discount', header: 'Off', cell: (row) => (row.discountPct === null ? EMPTY_VALUE : `${row.discountPct}%`), numeric: true },
];

type Change = { before: PriceListDiffLine; after: PriceListDiffLine };
const CHANGE_COLUMNS: RecordColumn<Change>[] = [
  { key: 'what', header: 'Item or group', cell: (row) => <span className="font-medium">{row.after.itemName ?? row.after.itemGroup ?? EMPTY_VALUE}</span> },
  { key: 'slab', header: 'Quantity', cell: (row) => row.after.slab, secondary: true },
  { key: 'before', header: 'Was', cell: (row) => describe(row.before), numeric: true },
  { key: 'after', header: 'Becomes', cell: (row) => <span className="font-medium">{describe(row.after)}</span>, numeric: true },
];

function describe(line: PriceListDiffLine): string {
  if (line.basis === 'rate') return formatMoney(line.rate);
  if (line.basis === 'discount_pct') return `${line.discountPct ?? '0'}% off`;
  return `${formatMoney(line.rate)} less ${line.discountPct ?? '0'}%`;
}

export function PriceListPage() {
  const params = useParams<{ id?: string }>();
  const id = params.id ?? null;
  const navigate = useNavigate();
  const canManage = usePermission(PERMISSIONS.PRICING_MANAGE);
  const canApprove = usePermission(PERMISSIONS.PRICING_APPROVE);
  const detail = usePriceList(id);

  if (id !== null && detail.isPending) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading the price list" className="flex flex-col gap-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (id !== null && detail.isError) {
    return (
      <QueryErrorAlert
        error={detail.error}
        subject="this price list"
        onRetry={() => {
          void detail.refetch();
        }}
      />
    );
  }
  if (id === null && !canManage) {
    return (
      <Alert>
        <AlertTitle>You can read price lists, not draft them</AlertTitle>
        <AlertDescription>Drafting needs pricing.manage — the Sales manager and Admin roles carry it.</AlertDescription>
      </Alert>
    );
  }
  return <Editor key={id ?? 'new'} detail={id === null ? null : (detail.data ?? null)} canManage={canManage} canApprove={canApprove} onSaved={(saved) => void navigate(`/masters/price-lists/${saved.id}`, { replace: true })} />;
}

function Editor({ detail, canManage, canApprove, onSaved }: { detail: PriceListDetail | null; canManage: boolean; canApprove: boolean; onSaved: (saved: PriceListDetail) => void }) {
  const [draft, setDraft] = useState<PriceListDraft>(() => (detail === null ? emptyDraft(toDateParam(new Date())) : draftOf(detail)));
  const [touched, setTouched] = useState(false);
  const create = useCreatePriceList();
  const update = useUpdatePriceList();
  const submit = useSubmitPriceList();
  const version = useNewPriceListVersion();
  const navigate = useNavigate();
  const editable = canManage && (detail === null || detail.state === 'draft');
  // A picker that offers a page is a picker that hides the rest of the masters.
  const parties = useParties({ page: 1, pageSize: 200 }, { enabled: editable });
  const items = useStockItems({ page: 1, pageSize: 200 }, { enabled: editable });
  const partyOptions: PickerOption[] = (parties.data?.data ?? []).map((p) => ({ id: p.id, label: p.name, hint: p.parentGroup }));
  const itemOptions: PickerOption[] = (items.data?.data ?? []).map((i) => ({ id: i.id, label: i.name, hint: i.parentGroup }));
  const pick = (options: readonly PickerOption[], idValue: string | null, fallback: string | null) => options.find((o) => o.id === idValue) ?? (idValue === null ? null : { id: idValue, label: fallback ?? idValue });
  const problem = draftProblem(draft);
  const busy = create.isPending || update.isPending || submit.isPending || version.isPending;
  const failure = create.error ?? update.error ?? submit.error ?? version.error;
  const copy = failure ? actionErrorCopy(failure, 'Saving') : null;

  function patchLine(key: string, patch: Partial<LineDraft>) {
    setDraft((current) => ({ ...current, lines: current.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  }
  function patchAssignment(key: string, patch: Partial<AssignmentDraft>) {
    setDraft((current) => ({ ...current, assignments: current.assignments.map((a) => (a.key === key ? { ...a, ...patch } : a)) }));
  }

  function save(): void {
    setTouched(true);
    if (problem !== null || !editable) return;
    const input = toDraftInput(draft);
    if (detail === null) {
      create.mutate(input, {
        onSuccess: (saved) => {
          toast.add({ type: 'success', title: `${saved.name} drafted`, description: 'Submit it when the lines are right; it goes to the inbox for approval.' });
          onSaved(saved);
        },
      });
    } else {
      update.mutate(
        { id: detail.id, input },
        {
          onSuccess: () => {
            toast.add({ type: 'success', title: `${draft.name} saved` });
          },
        },
      );
    }
  }

  function send(): void {
    if (detail === null) return;
    submit.mutate(detail.id, {
      onSuccess: (next) => {
        toast.add({ type: 'success', title: next.state === 'active' ? `${next.name} v${String(next.version)} is in force` : `${next.name} sent for approval`, description: next.state === 'active' ? 'You hold pricing.approve, so it activated at once.' : 'Admin decides it in the approvals inbox, with the diff beside it.' });
      },
    });
  }

  function branch(): void {
    if (detail === null) return;
    version.mutate(detail.id, {
      onSuccess: (next) => {
        toast.add({ type: 'success', title: `${next.name} v${String(next.version)} drafted`, description: 'Edit it and submit; v' + String(detail.version) + ' stays in force until then.' });
        void navigate(`/masters/price-lists/${next.id}`);
      },
    });
  }

  const title = detail === null ? 'New price list' : detail.name;

  return (
    <>
      <PageHeader
        eyebrow="Price list"
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate">{title}</span>
            {detail !== null ? (
              <>
                <Badge variant="outline">v{String(detail.version)}</Badge>
                <Badge variant={detail.state === 'active' ? 'default' : detail.state === 'pending_approval' ? 'secondary' : 'outline'}>{PRICE_LIST_STATE_LABELS[detail.state]}</Badge>
              </>
            ) : null}
          </span>
        }
        description={detail === null ? 'A name, the dates it runs, the lines, and who it applies to.' : detail.state === 'active' ? `In force since ${formatDate((detail.approvedAt ?? detail.createdAt).slice(0, 10))}${detail.approvedByName ? ` · approved by ${detail.approvedByName}` : ''}. An active list does not change: draft a new version.` : detail.state === 'pending_approval' ? 'Awaiting the approvals inbox. Nothing here changes until it is decided.' : detail.state === 'superseded' ? `Replaced on ${formatDate((detail.supersededAt ?? detail.createdAt).slice(0, 10))}; kept so documents from its time stay explainable.` : detail.state === 'expired' ? `Ran until ${formatDate((detail.effectiveTo ?? detail.createdAt).slice(0, 10))} and no longer applies. Draft a new version to carry its prices forward.` : 'A draft: edit freely, then submit.'}
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/masters/price-lists" />}>
              <ACTION_ICONS.back data-icon="inline-start" />
              All lists
            </Button>
            {editable ? (
              <Button size="sm" disabled={busy} onClick={save}>
                {create.isPending || update.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
                Save draft
              </Button>
            ) : null}
            {editable && detail !== null ? (
              <Button size="sm" variant="outline" disabled={busy || problem !== null} onClick={send}>
                {submit.isPending ? <Spinner data-icon="inline-start" /> : canApprove ? <CheckIcon data-icon="inline-start" /> : <PaperPlaneTiltIcon data-icon="inline-start" />}
                {canApprove ? 'Activate' : 'Submit for approval'}
              </Button>
            ) : null}
            {/* An expired list is versioned too: carrying last season's prices
                forward is what the lineage is for, and the API allows it --
                without this the button was simply missing. */}
            {canManage && (detail?.state === 'active' || detail?.state === 'expired') ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={branch}>
                {version.isPending ? <Spinner data-icon="inline-start" /> : <GitBranchIcon data-icon="inline-start" />}
                New version
              </Button>
            ) : null}
          </div>
        }
      />

      {copy ? (
        <Alert variant="destructive">
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription>{copy.description}</AlertDescription>
        </Alert>
      ) : null}
      {touched && problem !== null && editable ? (
        <Alert>
          <AlertTitle>Not ready to save</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="price-list-name">Name</FieldLabel>
          <Input id="price-list-name" disabled={!editable} value={draft.name} onChange={(event) => { setDraft((c) => ({ ...c, name: event.target.value })); }} placeholder="Asha Traders terms" />
        </Field>
        <DateField label="Effective from" showLabel value={fromDateParam(draft.effectiveFrom)} onValueChange={(next) => { setDraft((c) => ({ ...c, effectiveFrom: toDateParam(next) })); }} yearsBack={3} yearsForward={2} className={editable ? undefined : 'pointer-events-none opacity-60'} />
        <div className="flex flex-col gap-1">
          {draft.effectiveTo === '' ? (
            <Field>
              <FieldLabel htmlFor="price-list-open-ended">Effective to</FieldLabel>
              {/* The sentence was the button's label and ran off the end of a
                  quarter-width cell. The control says what it is; the sentence
                  explains it underneath, where there is room for it. */}
              <Button id="price-list-open-ended" type="button" variant="outline" disabled={!editable} className="w-full justify-start font-normal" onClick={() => { setDraft((c) => ({ ...c, effectiveTo: c.effectiveFrom })); }}>
                <CalendarBlankIcon data-icon="inline-start" />
                <span className="truncate">Open-ended</span>
              </Button>
              <FieldDescription>Runs until a new version replaces it.</FieldDescription>
            </Field>
          ) : (
            <DateField label="Effective to" showLabel value={fromDateParam(draft.effectiveTo)} onValueChange={(next) => { setDraft((c) => ({ ...c, effectiveTo: toDateParam(next) })); }} yearsBack={3} yearsForward={5} className={editable ? undefined : 'pointer-events-none opacity-60'} />
          )}
          {editable && draft.effectiveTo !== '' ? (
            <Button type="button" variant="link" size="sm" className="h-auto self-start px-0 text-xs" onClick={() => { setDraft((c) => ({ ...c, effectiveTo: '' })); }}>
              No end date
            </Button>
          ) : null}
        </div>
        <Field className="sm:col-span-2 lg:col-span-4">
          <FieldLabel htmlFor="price-list-notes">Notes</FieldLabel>
          <Textarea id="price-list-notes" rows={2} disabled={!editable} value={draft.notes} onChange={(event) => { setDraft((c) => ({ ...c, notes: event.target.value })); }} placeholder="Why these terms; for the approver and for whoever reads this in a year." />
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading title="Lines" note="An item line beats a group line; within either, the narrowest quantity slab. Slabs on one item must not overlap." action={editable ? <Button type="button" variant="outline" size="sm" onClick={() => { setDraft((c) => ({ ...c, lines: [...c.lines, newLineDraft()] })); }}><PlusIcon data-icon="inline-start" />Add line</Button> : undefined} />
        <ol className="flex flex-col divide-y border">
          {draft.lines.map((line, index) => {
            const issue = touched ? lineProblem(line) : null;
            return (
              <li key={line.key} className="flex flex-col gap-2 p-3">
                <div className="grid gap-2 lg:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_minmax(0,10rem)]">
                  <Select value={line.target} onValueChange={(next) => { if (next) patchLine(line.key, { target: next }); }} disabled={!editable}>
                    <SelectTrigger aria-label={`Line ${String(index + 1)} prices`}>
                      <SelectValue>{(current: string) => (current === 'item' ? 'An item' : 'An item group')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="item">An item</SelectItem>
                        <SelectItem value="group">An item group</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {line.target === 'item' ? (
                    <RecordPicker id={`line-item-${line.key}`} label={`Line ${String(index + 1)} item`} placeholder="Stock item" searchPlaceholder="Search stock items" emptyMessage="No item matches." icon={<CubeIcon className="text-muted-foreground" />} options={itemOptions} loading={items.isPending} disabled={!editable} value={pick(itemOptions, line.stockItemId, line.itemName)} onValueChange={(next) => { patchLine(line.key, { stockItemId: next?.id ?? null, itemName: next?.label ?? null }); }} />
                  ) : (
                    <Input aria-label={`Line ${String(index + 1)} item group`} placeholder="Item group, as Tally names it (e.g. Cables)" disabled={!editable} value={line.itemGroup} onChange={(event) => { patchLine(line.key, { itemGroup: event.target.value }); }} />
                  )}
                  <Select value={line.basis} onValueChange={(next) => { if (next) patchLine(line.key, { basis: next }); }} disabled={!editable}>
                    <SelectTrigger aria-label={`Line ${String(index + 1)} basis`}>
                      <SelectValue>{(current: PriceBasis) => PRICE_BASIS_LABELS[current]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {PRICE_BASES.map((b) => (
                          <SelectItem key={b} value={b}>
                            {PRICE_BASIS_LABELS[b]}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
                  <Input aria-label={`Line ${String(index + 1)} rate`} inputMode="decimal" className="tabular-nums" placeholder="Rate" disabled={!editable || line.basis === 'discount_pct'} value={line.rate} onChange={(event) => { patchLine(line.key, { rate: event.target.value }); }} />
                  <Input aria-label={`Line ${String(index + 1)} percent off`} inputMode="decimal" className="tabular-nums" placeholder="% off" disabled={!editable || line.basis === 'rate'} value={line.discountPct} onChange={(event) => { patchLine(line.key, { discountPct: event.target.value }); }} />
                  <Input aria-label={`Line ${String(index + 1)} from quantity`} inputMode="decimal" className="tabular-nums" placeholder="From qty" disabled={!editable} value={line.minQty} onChange={(event) => { patchLine(line.key, { minQty: event.target.value }); }} />
                  <Input aria-label={`Line ${String(index + 1)} up to quantity`} inputMode="decimal" className="tabular-nums" placeholder="Up to qty" disabled={!editable} value={line.maxQty} onChange={(event) => { patchLine(line.key, { maxQty: event.target.value }); }} />
                  {editable ? (
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${String(index + 1)}`} className="justify-self-end" onClick={() => { setDraft((c) => ({ ...c, lines: c.lines.length === 1 ? [newLineDraft()] : c.lines.filter((l) => l.key !== line.key) })); }}>
                      <TrashIcon />
                    </Button>
                  ) : null}
                </div>
                {issue !== null ? <FieldError>{issue}</FieldError> : null}
              </li>
            );
          })}
        </ol>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading title="Applies to" note="A party, a party group, or everyone without a list of their own. One party, one list at a time." action={editable ? <Button type="button" variant="outline" size="sm" onClick={() => { setDraft((c) => ({ ...c, assignments: [...c.assignments, newAssignmentDraft()] })); }}><PlusIcon data-icon="inline-start" />Add</Button> : undefined} />
        {draft.assignments.length === 0 ? (
          <FieldDescription>Assigned to nobody yet: the list resolves nothing until it is.</FieldDescription>
        ) : (
          <ol className="flex flex-col divide-y border">
            {draft.assignments.map((a, index) => (
              <li key={a.key} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]">
                <Select value={a.kind} onValueChange={(next) => { if (next) patchAssignment(a.key, { kind: next }); }} disabled={!editable}>
                  <SelectTrigger aria-label={`Assignment ${String(index + 1)} kind`}>
                    <SelectValue>{(current: string) => (current === 'party' ? 'A party' : current === 'group' ? 'A party group' : 'The default')}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="party">A party</SelectItem>
                      <SelectItem value="group">A party group</SelectItem>
                      <SelectItem value="default">The default</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {a.kind === 'party' ? (
                  <RecordPicker id={`assign-party-${a.key}`} label={`Assignment ${String(index + 1)} party`} placeholder="Tally party" searchPlaceholder="Search parties" emptyMessage="No party matches." icon={<BooksIcon className="text-muted-foreground" />} options={partyOptions} loading={parties.isPending} disabled={!editable} value={pick(partyOptions, a.partyId, a.partyName)} onValueChange={(next) => { patchAssignment(a.key, { partyId: next?.id ?? null, partyName: next?.label ?? null }); }} />
                ) : a.kind === 'group' ? (
                  <Input aria-label={`Assignment ${String(index + 1)} party group`} placeholder="Party group, as Tally names it (e.g. Sundry Debtors)" disabled={!editable} value={a.partyGroup} onChange={(event) => { patchAssignment(a.key, { partyGroup: event.target.value }); }} />
                ) : (
                  <p className="text-muted-foreground self-center text-sm">Every party without a list of its own.</p>
                )}
                {editable ? (
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove assignment ${String(index + 1)}`} className="justify-self-end" onClick={() => { setDraft((c) => ({ ...c, assignments: c.assignments.filter((x) => x.key !== a.key) })); }}>
                    <ACTION_ICONS.close />
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {detail !== null && detail.supersedesId !== null ? <Diff id={detail.id} /> : null}
    </>
  );
}

/** REQ-AN-12: what the approver reads before deciding. */
function Diff({ id }: { id: string }) {
  const diff = usePriceListDiff(id);
  if (diff.isPending) return <Skeleton className="h-24 w-full" />;
  if (diff.isError) {
    return (
      <QueryErrorAlert
        error={diff.error}
        subject="the comparison"
        onRetry={() => {
          void diff.refetch();
        }}
      />
    );
  }
  const d = diff.data;
  return (
    <section className="flex flex-col gap-6">
      <SectionHeading title={d.against === null ? 'What this version holds' : `What changed against v${String(d.against.version)}`} note={`${String(d.changed.length)} changed · ${String(d.added.length)} added · ${String(d.removed.length)} removed · ${String(d.unchanged)} unchanged.`} action={d.against === null ? undefined : <Button variant="outline" size="sm" nativeButton={false} render={<Link to={`/masters/price-lists/${d.against.id}`} />}>Open v{String(d.against.version)}</Button>} />
      {d.changed.length > 0 ? <RecordTable columns={CHANGE_COLUMNS} rows={[...d.changed]} rowKey={(row) => row.after.key} mobilePrimary={(row) => row.after.itemName ?? row.after.itemGroup ?? ''} mobileSupporting={(row) => `${describe(row.before)} → ${describe(row.after)}`} /> : null}
      {d.added.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Added</p>
          <RecordTable columns={DIFF_COLUMNS} rows={[...d.added]} rowKey={(row) => row.key} mobilePrimary={(row) => row.itemName ?? row.itemGroup ?? ''} mobileSupporting={(row) => describe(row)} />
        </div>
      ) : null}
      {d.removed.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Removed</p>
          <RecordTable columns={DIFF_COLUMNS} rows={[...d.removed]} rowKey={(row) => row.key} mobilePrimary={(row) => row.itemName ?? row.itemGroup ?? ''} mobileSupporting={(row) => describe(row)} />
        </div>
      ) : null}
      <p className="text-muted-foreground text-sm">
        Affects: {d.partiesAffected.length === 0 ? 'nobody yet' : d.partiesAffected.map((p) => p.name).join(' · ')}.
      </p>
    </section>
  );
}
