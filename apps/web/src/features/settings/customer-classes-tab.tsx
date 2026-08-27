import { useState } from 'react';
import { PlusIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { ClassBadge } from '@/components/shared/customer-badges';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { deleteTier, saveTier, useTiers, type TierRowData } from '@/features/insights/use-cfo';
import { useIsMobile } from '@/hooks/use-mobile';
import { EMPTY_VALUE, formatCount, formatMoney } from '@/lib/format';

/**
 * The customer class master (CFO brief P3): one row per class, configurable
 * and never hardcoded. A class can be renamed and its terms changed; it
 * cannot be deleted while customers wear it -- the server refuses, and
 * this screen says why.
 */

type Draft = Omit<TierRowData, 'assigned'>;

const TOKENS = ['fresh-1', 'fresh-2', 'fresh-3', 'fresh-4', 'fresh-5'];

const COLUMNS: RecordColumn<TierRowData>[] = [
  { key: 'code', header: 'Class', cell: (row) => (
    <span className="flex items-center gap-2">
      <ClassBadge code={row.code} label={row.label} token={row.colourToken} />
      <span className="font-medium">{row.label}</span>
    </span>
  ) },
  { key: 'creditDays', header: 'Credit days', cell: (row) => (row.creditDays === null ? EMPTY_VALUE : formatCount(row.creditDays)), numeric: true },
  { key: 'creditLimit', header: 'Default limit', cell: (row) => (row.creditLimit === null ? EMPTY_VALUE : formatMoney(row.creditLimit)), numeric: true, secondary: true },
  { key: 'maxDiscountPct', header: 'Discount ceiling', cell: (row) => (row.maxDiscountPct === null ? EMPTY_VALUE : `${row.maxDiscountPct}%`), numeric: true, secondary: true },
  { key: 'contactEveryDays', header: 'Contact every', cell: (row) => (row.contactEveryDays === null ? EMPTY_VALUE : `${formatCount(row.contactEveryDays)} days`), numeric: true, secondary: true },
  { key: 'assigned', header: 'Customers', cell: (row) => formatCount(row.assigned), numeric: true },
];

function blank(sortOrder: number): Draft {
  return { code: '', label: '', description: '', colourToken: 'fresh-3', creditDays: null, creditLimit: null, maxDiscountPct: null, contactEveryDays: null, servicePriority: '', reviewEvery: 'Quarterly', sortOrder };
}

export function CustomerClassesTab({ canEdit }: { canEdit: boolean }) {
  const tiers = useTiers();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<{ row: Draft; isNew: boolean; assigned: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const numeric = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const patch = (next: Partial<Draft>) => { setDraft((d) => (d === null ? d : { ...d, row: { ...d.row, ...next } })); };

  async function save() {
    if (draft === null) return;
    setSaving(true);
    try {
      await saveTier(draft.row);
      await queryClient.invalidateQueries({ queryKey: ['cfo', 'tiers'] });
      toast.add({ type: 'success', title: `Class ${draft.row.code} saved` });
      setDraft(null);
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not save the class', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (draft === null) return;
    setSaving(true);
    try {
      await deleteTier(draft.row.code);
      await queryClient.invalidateQueries({ queryKey: ['cfo', 'tiers'] });
      toast.add({ type: 'success', title: `Class ${draft.row.code} removed` });
      setDraft(null);
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not remove the class', description: error instanceof Error ? error.message : 'Reassign its customers first.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeading
        title="Customer classes"
        description="How important a customer is to us, A+ to D, set by a person with a reason. Each class carries its default terms, discount ceiling and contact rhythm."
        action={
          canEdit ? (
            <Button size="sm" onClick={() => { setDraft({ row: blank((tiers.data?.length ?? 0) + 1), isNew: true, assigned: 0 }); }}>
              <PlusIcon data-icon="inline-start" />
              Add class
            </Button>
          ) : undefined
        }
      />
      {tiers.isPending ? <Skeleton className="h-40" /> : null}
      {tiers.error ? <QueryErrorAlert error={tiers.error} subject="customer classes" onRetry={() => void tiers.refetch()} /> : null}
      {tiers.data ? (
        <RecordTable
          columns={COLUMNS}
          rows={[...tiers.data]}
          rowKey={(row) => row.code}
          mobilePrimary={(row) => `${row.code} · ${row.label}`}
          mobileSupporting={(row) => `${row.creditDays === null ? 'no credit days' : `${formatCount(row.creditDays)} credit days`} · ${formatCount(row.assigned)} customers`}
          onRowActivate={canEdit ? (row) => { const { assigned, ...rest } = row; setDraft({ row: rest, isNew: false, assigned }); } : undefined}
        />
      ) : null}

      <Sheet open={draft !== null} onOpenChange={(open) => { if (!open) setDraft(null); }}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-md">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{draft?.isNew ? 'New class' : `Class ${draft?.row.code ?? ''}`}</SheetTitle>
            <SheetDescription>{draft && !draft.isNew ? `${formatCount(draft.assigned)} customers wear this class.` : 'Codes are short marks like A+ or B.'}</SheetDescription>
          </SheetHeader>
          {draft ? (
            <div className="flex max-h-[75vh] flex-col gap-3 overflow-y-auto px-4 py-4 sm:max-h-none">
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="tier-code">Code</FieldLabel>
                  <Input id="tier-code" maxLength={4} value={draft.row.code} disabled={!draft.isNew} onChange={(e) => { patch({ code: e.target.value.toUpperCase() }); }} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tier-sort">Order</FieldLabel>
                  <Input id="tier-sort" inputMode="numeric" value={String(draft.row.sortOrder)} onChange={(e) => { patch({ sortOrder: numeric(e.target.value) ?? 1 }); }} />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="tier-label">Label</FieldLabel>
                <Input id="tier-label" maxLength={60} value={draft.row.label} onChange={(e) => { patch({ label: e.target.value }); }} />
              </Field>
              <Field>
                <FieldLabel htmlFor="tier-description">Description</FieldLabel>
                <Textarea id="tier-description" rows={2} maxLength={200} value={draft.row.description} onChange={(e) => { patch({ description: e.target.value }); }} />
              </Field>
              <Field>
                <FieldLabel>Colour</FieldLabel>
                <Select value={draft.row.colourToken} onValueChange={(v) => { if (v !== null) patch({ colourToken: String(v) }); }}>
                  <SelectTrigger aria-label="Colour">
                    <SelectValue>{(v: string) => <span className="flex items-center gap-2"><ClassBadge code={draft.row.code || 'A'} token={v} /> {v}</span>}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {TOKENS.map((t) => (
                      <SelectItem key={t} value={t}><span className="flex items-center gap-2"><ClassBadge code={draft.row.code || 'A'} token={t} /> {t}</span></SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="tier-days">Credit days</FieldLabel>
                  <Input id="tier-days" inputMode="numeric" value={draft.row.creditDays ?? ''} onChange={(e) => { patch({ creditDays: numeric(e.target.value) }); }} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tier-limit">Default limit</FieldLabel>
                  <Input id="tier-limit" inputMode="decimal" value={draft.row.creditLimit ?? ''} onChange={(e) => { patch({ creditLimit: e.target.value.trim() === '' ? null : e.target.value.trim() }); }} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tier-discount">Discount ceiling %</FieldLabel>
                  <Input id="tier-discount" inputMode="decimal" value={draft.row.maxDiscountPct ?? ''} onChange={(e) => { patch({ maxDiscountPct: e.target.value.trim() === '' ? null : e.target.value.trim() }); }} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tier-contact">Contact every (days)</FieldLabel>
                  <Input id="tier-contact" inputMode="numeric" value={draft.row.contactEveryDays ?? ''} onChange={(e) => { patch({ contactEveryDays: numeric(e.target.value) }); }} />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="tier-service">Service priority</FieldLabel>
                <Input id="tier-service" maxLength={80} value={draft.row.servicePriority} onChange={(e) => { patch({ servicePriority: e.target.value }); }} />
              </Field>
              <Field>
                <FieldLabel htmlFor="tier-review">Review</FieldLabel>
                <Input id="tier-review" maxLength={40} value={draft.row.reviewEvery} onChange={(e) => { patch({ reviewEvery: e.target.value }); }} />
              </Field>
              <div className="flex items-center justify-between gap-2 pt-2">
                {!draft.isNew ? (
                  <Button variant="outline" disabled={saving || draft.assigned > 0} onClick={() => void remove()}>
                    Remove
                  </Button>
                ) : <span />}
                <Button disabled={saving || draft.row.code.trim() === '' || draft.row.label.trim() === ''} onClick={() => void save()}>
                  {saving ? 'Saving' : 'Save'}
                </Button>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
