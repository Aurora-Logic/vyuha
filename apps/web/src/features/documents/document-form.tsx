import { useState } from 'react';
import { CaretDownIcon, PlusIcon, XIcon } from '@phosphor-icons/react';

import { SectionHeading } from '@/components/shared/section-heading';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { DateField } from '@/features/attendance/pickers';
import { trimZeros as trimQty } from '@/features/sales/types';
import { formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PRINTED_DOCUMENT_TITLES, SECOND_DATE_LABELS, VENDOR_FACING_TYPES, gstStateName, type DocumentDesign, type DocumentDetails } from '@vyuha/shared';

import type { PaperEditing, PaperLine, PaperModel } from './paper';
import { DETAIL_LABELS, DETAIL_ORDER, E_INVOICE_KEYS } from './paper-support';

/**
 * The document on a phone. The paper is the editor on a desk (REQ-W-01),
 * but an A4 grid zoomed to 360px is eight-point type and inputs a few
 * pixels tall, so below the tablet breakpoint the same model and the same
 * editing hooks are drawn as a stacked form: the party, the dates, one
 * block per line, the totals, the small boxes folded away, the notes. The
 * page that owns the document does not know which surface drew it; Preview
 * flips to the paper. Without `editing` it reads the document back the
 * same way, which is how an invoice — never edited, only issued — is read
 * on a phone.
 */
interface DocumentFormProps {
  model: PaperModel;
  design: DocumentDesign;
  editing?: PaperEditing;
}

function hasText(value: string | null | undefined): value is string {
  return (value ?? '').trim() !== '';
}

export function DocumentForm({ model, design, editing }: DocumentFormProps) {
  const editable = editing !== undefined;
  const vendorFacing = VENDOR_FACING_TYPES.includes(model.type);
  const title = PRINTED_DOCUMENT_TITLES[model.type];
  const secondDate = SECOND_DATE_LABELS[model.type];
  const money = design.showAmounts;
  const showDiscount = money && design.showDiscount;
  const showTax = money && design.showTax;
  const shipTo = model.shipTo;
  const details = model.details;
  const detailKeys = DETAIL_ORDER.filter((key) => editable || hasText(details[key]));
  const eInvoiceKeys = [...E_INVOICE_KEYS].filter((key) => editable || hasText(details[key]));
  const showDetails = (design.showDetailsGrid && detailKeys.length > 0) || (design.showEInvoice && eInvoiceKeys.length > 0);
  const showShipTo = design.showShipTo && (editable || (shipTo !== null && hasText(shipTo.name)));
  // The consignee is the buyer until someone says otherwise; the fields stay
  // folded behind the switch so a phone form is not five empty boxes long.
  const [sameAsBuyer, setSameAsBuyer] = useState(!(shipTo !== null && (hasText(shipTo.name) || hasText(shipTo.address))));
  const stateLine = [model.buyer.stateName || gstStateName(model.buyer.stateCode), model.buyer.stateCode ? `Code ${model.buyer.stateCode}` : ''].filter((p) => p !== '').join(', ');

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5" data-slot="document-form">
      <section className="flex flex-col gap-3">
        <SectionHeading title={vendorFacing ? 'Vendor' : 'Buyer (Bill to)'} />
        {editable ? (
          <FieldGroup className="gap-3">
            {editing.customer}
            {!vendorFacing ? (
              <Field>
                <FieldLabel htmlFor="document-form-place-of-supply">Place of supply (state code)</FieldLabel>
                <Input id="document-form-place-of-supply" inputMode="numeric" placeholder="29" value={model.buyer.stateCode} onChange={(event) => { editing.setPlaceOfSupply(event.target.value); }} className="w-24" />
                {stateLine !== '' ? <p className="text-muted-foreground text-xs">{stateLine}</p> : null}
              </Field>
            ) : null}
          </FieldGroup>
        ) : (
          <div className="flex flex-col gap-0.5 text-sm">
            <span className="font-semibold">{model.buyer.name || '—'}</span>
            {hasText(model.buyer.address) ? <span className="text-muted-foreground whitespace-pre-line text-xs">{model.buyer.address}</span> : null}
            {hasText(model.buyer.gstin) ? <span className="text-muted-foreground text-xs">GSTIN/UIN {model.buyer.gstin}</span> : null}
            {stateLine !== '' ? <span className="text-muted-foreground text-xs">{stateLine}</span> : null}
          </div>
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <SectionHeading title={`${title} details`} />
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>{title} No.</FieldLabel>
            <span className="text-sm font-semibold tabular-nums">{model.number ?? 'Draft'}</span>
          </Field>
          <Field>
            <FieldLabel>Dated</FieldLabel>
            {editable && editing.setDate !== undefined ? (
              <DateField label="Dated" value={fromDateParam(model.date)} onValueChange={(next) => { editing.setDate?.(toDateParam(next)); }} yearsBack={1} yearsForward={1} className="w-full justify-start" />
            ) : editable ? (
              <div className="flex min-h-8 items-center">{editing.date}</div>
            ) : (
              <span className="text-sm tabular-nums">{formatDate(model.date)}</span>
            )}
          </Field>
          {secondDate !== undefined ? (
            <Field className="col-span-2">
              <FieldLabel>{secondDate}</FieldLabel>
              {editable && editing.setValidUntil !== undefined ? (
                <DateField label={secondDate} value={model.validUntil ? fromDateParam(model.validUntil) : new Date()} onValueChange={(next) => { editing.setValidUntil?.(toDateParam(next)); }} yearsBack={0} yearsForward={2} className="w-full justify-start" />
              ) : editable && editing.validUntil !== undefined ? (
                <div className="flex min-h-8 items-center">{editing.validUntil}</div>
              ) : (
                <span className="text-sm tabular-nums">{model.validUntil ? formatDate(model.validUntil) : '—'}</span>
              )}
            </Field>
          ) : null}
        </div>
      </section>

      {showShipTo ? (
        <>
          <Separator />
          <section className="flex flex-col gap-3">
            <SectionHeading title="Consignee (Ship to)" />
            {editable ? (
              <Field orientation="horizontal" className="justify-between">
                <FieldLabel htmlFor="document-form-ship-toggle">Same as buyer (Bill to)</FieldLabel>
                <Switch
                  id="document-form-ship-toggle"
                  checked={sameAsBuyer}
                  onCheckedChange={(checked) => {
                    setSameAsBuyer(checked);
                    if (checked) editing.updateShipTo(null);
                  }}
                />
              </Field>
            ) : null}
            {editable && !sameAsBuyer ? (
              <FieldGroup className="gap-3">
                <Field>
                  <FieldLabel htmlFor="document-form-ship-name">Name</FieldLabel>
                  <Input id="document-form-ship-name" value={shipTo?.name ?? ''} onChange={(event) => { editing.updateShipTo({ name: event.target.value }); }} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="document-form-ship-address">Address</FieldLabel>
                  <Textarea id="document-form-ship-address" rows={2} value={shipTo?.address ?? ''} onChange={(event) => { editing.updateShipTo({ address: event.target.value }); }} />
                </Field>
                <div className="grid grid-cols-[1fr_5rem] gap-3">
                  <Field>
                    <FieldLabel htmlFor="document-form-ship-gstin">GSTIN/UIN</FieldLabel>
                    <Input id="document-form-ship-gstin" value={shipTo?.gstin ?? ''} onChange={(event) => { editing.updateShipTo({ gstin: event.target.value.toUpperCase() }); }} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="document-form-ship-state-code">Code</FieldLabel>
                    <Input id="document-form-ship-state-code" inputMode="numeric" value={shipTo?.stateCode ?? ''} onChange={(event) => { editing.updateShipTo({ stateCode: event.target.value }); }} />
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="document-form-ship-state">State</FieldLabel>
                  <Input id="document-form-ship-state" value={shipTo?.stateName ?? ''} onChange={(event) => { editing.updateShipTo({ stateName: event.target.value }); }} />
                </Field>
              </FieldGroup>
            ) : null}
            {!editable ? (
              <div className="flex flex-col gap-0.5 text-sm">
                <span className="font-semibold">{shipTo?.name}</span>
                {hasText(shipTo?.address) ? <span className="text-muted-foreground whitespace-pre-line text-xs">{shipTo?.address}</span> : null}
                {hasText(shipTo?.gstin) ? <span className="text-muted-foreground text-xs">GSTIN/UIN {shipTo?.gstin}</span> : null}
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      <Separator />

      <section className="flex flex-col gap-3">
        <SectionHeading title="Lines" note={`${String(model.lines.length)} ${model.lines.length === 1 ? 'line' : 'lines'}`} />
        <ol className={cn('flex flex-col', editable ? 'gap-3' : 'divide-border divide-y border-y')}>
          {model.lines.map((line, index) => (
            <li key={line.key} className={cn('flex flex-col gap-3', editable ? 'bg-muted/40 p-3' : 'py-3')}>
              {editable ? editableLine(line, index, editing, design) : readLine(line, index, design)}
            </li>
          ))}
        </ol>
        {editable ? (
          <Button type="button" variant="outline" onClick={editing.addLine}>
            <PlusIcon data-icon="inline-start" />
            Add line
          </Button>
        ) : null}
      </section>

      {money ? (
        <>
          <Separator />
          <section className="flex flex-col gap-2" aria-label="Totals">
            <TotalRow label="Subtotal" value={formatMoney(model.totals.subtotal)} />
            {showDiscount && Number(model.totals.discountTotal) > 0 ? <TotalRow label="Less: Discount" value={`-${formatMoney(model.totals.discountTotal)}`} muted /> : null}
            {showTax && Number(model.totals.taxTotal) > 0 ? <TotalRow label="Tax" value={formatMoney(model.totals.taxTotal)} /> : null}
            <TotalRow label="Total" value={formatMoney(model.totals.grandTotal)} strong />
            {model.totals.preview ? <p className="text-muted-foreground text-xs">Figures are a preview until the document is saved.</p> : null}
          </section>
        </>
      ) : null}

      {showDetails ? (
        <>
          <Separator />
          <Collapsible defaultOpen={!editable}>
            <CollapsibleTrigger
              render={<Button type="button" variant="ghost" className="group/details w-full justify-between px-0 hover:bg-transparent" />}
            >
              <span className="text-sm font-semibold">More details</span>
              <CaretDownIcon className="transition-transform group-aria-expanded/details:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <FieldGroup className="gap-3">
                {design.showDetailsGrid
                  ? detailKeys.map((key) => detailField(key, details, editing))
                  : null}
                {design.showEInvoice && eInvoiceKeys.length > 0 ? (
                  <>
                    <SectionHeading title="e-Invoice" className="mt-2" />
                    {eInvoiceKeys.map((key) => detailField(key, details, editing))}
                  </>
                ) : null}
              </FieldGroup>
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : null}

      {editable || hasText(model.notes) || hasText(model.terms) ? (
        <>
          <Separator />
          <section className="flex flex-col gap-3">
            <SectionHeading title="Notes and terms" />
            <FieldGroup className="gap-3">
              {editable || hasText(model.notes) ? (
                <Field>
                  <FieldLabel htmlFor="document-form-notes">Notes</FieldLabel>
                  {editable ? <Textarea id="document-form-notes" rows={2} placeholder={vendorFacing ? 'Anything the vendor should read' : 'Anything the customer should read'} value={model.notes} onChange={(event) => { editing.setNotes(event.target.value); }} /> : <p className="text-sm whitespace-pre-line">{model.notes}</p>}
                </Field>
              ) : null}
              {editable || hasText(model.terms) ? (
                <Field>
                  <FieldLabel htmlFor="document-form-terms">Terms</FieldLabel>
                  {editable ? <Textarea id="document-form-terms" rows={2} placeholder={design.defaultTerms || 'Payment terms, delivery, validity'} value={model.terms} onChange={(event) => { editing.setTerms(event.target.value); }} /> : <p className="text-sm whitespace-pre-line">{model.terms}</p>}
                </Field>
              ) : null}
            </FieldGroup>
          </section>
        </>
      ) : null}
    </div>
  );
}

function TotalRow({ label, value, strong = false, muted = false }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 text-sm', strong && 'text-base font-semibold', muted && 'text-muted-foreground')}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function editableLine(line: PaperLine, index: number, editing: PaperEditing, design: DocumentDesign) {
  const n = String(index + 1);
  const id = (cell: string) => `document-form-line-${line.key}-${cell}`;
  const money = design.showAmounts;
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Badge variant="secondary" className="tabular-nums">Line {n}</Badge>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${n}`} onClick={() => { editing.removeLine(line.key); }}>
          <XIcon />
        </Button>
      </div>
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">{editing.itemPicker(line)}</div>
        {editing.itemHistory?.(line)}
      </div>
      <Field>
        <FieldLabel htmlFor={id('description')}>Description</FieldLabel>
        <Input id={id('description')} placeholder="Description of goods" value={line.description} onChange={(event) => { editing.updateLine(line.key, { description: event.target.value }); }} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor={id('qty')}>Quantity</FieldLabel>
          <Input id={id('qty')} inputMode="decimal" className="text-right tabular-nums" value={line.quantity} onChange={(event) => { editing.updateLine(line.key, { quantity: event.target.value }); }} />
        </Field>
        {design.showUnit ? (
          <Field>
            <FieldLabel htmlFor={id('unit')}>Unit</FieldLabel>
            <Input id={id('unit')} placeholder="No" value={line.unit} onChange={(event) => { editing.updateLine(line.key, { unit: event.target.value }); }} />
          </Field>
        ) : null}
        {money ? (
          <Field>
            <FieldLabel htmlFor={id('rate')}>Rate</FieldLabel>
            <Input id={id('rate')} inputMode="decimal" placeholder="0.00" className="text-right tabular-nums" value={line.rate} onChange={(event) => { editing.updateLine(line.key, { rate: event.target.value }); }} />
          </Field>
        ) : null}
        {money && design.showDiscount ? (
          <Field>
            <FieldLabel htmlFor={id('disc')}>Discount %</FieldLabel>
            <Input id={id('disc')} inputMode="decimal" className="text-right tabular-nums" value={line.discountPct} onChange={(event) => { editing.updateLine(line.key, { discountPct: event.target.value }); }} />
          </Field>
        ) : null}
        {design.showHsn ? (
          <Field>
            <FieldLabel htmlFor={id('hsn')}>HSN/SAC</FieldLabel>
            <Input id={id('hsn')} placeholder="HSN" value={line.hsnCode} onChange={(event) => { editing.updateLine(line.key, { hsnCode: event.target.value }); }} />
          </Field>
        ) : null}
      </div>
      {money ? (
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">Amount</span>
          <span className="font-semibold tabular-nums">{formatMoney(line.amount)}</span>
        </div>
      ) : null}
    </>
  );
}

function readLine(line: PaperLine, index: number, design: DocumentDesign) {
  const money = design.showAmounts;
  const quantity = `${trimQty(line.quantity)}${design.showUnit && line.unit ? ` ${line.unit}` : ''}`;
  const facts = [design.showHsn && line.hsnCode ? `HSN ${line.hsnCode}` : null, money ? `${quantity} × ${formatMoney(line.rate)}` : quantity, money && design.showDiscount && Number(line.discountPct) > 0 ? `${trimQty(line.discountPct)}% off` : null].filter((f): f is string => f !== null);
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-semibold">
          <span className="text-muted-foreground mr-1.5 tabular-nums">{String(index + 1)}.</span>
          {line.description || '—'}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">{facts.join(' · ')}</span>
      </div>
      {money ? <span className="shrink-0 font-semibold tabular-nums">{formatMoney(line.amount)}</span> : null}
    </div>
  );
}

function detailField(key: keyof DocumentDetails, details: DocumentDetails, editing: PaperEditing | undefined) {
  const id = `document-form-detail-${key}`;
  const value = details[key] ?? '';
  if (editing === undefined) {
    return (
      <div key={key} className="flex flex-col gap-0.5 text-sm">
        <span className="text-muted-foreground text-xs">{DETAIL_LABELS[key]}</span>
        <span className="whitespace-pre-line">{value}</span>
      </div>
    );
  }
  return (
    <Field key={key}>
      <FieldLabel htmlFor={id}>{DETAIL_LABELS[key]}</FieldLabel>
      {key === 'termsOfDelivery' ? (
        <Textarea id={id} rows={2} value={value} onChange={(event) => { editing.updateDetails({ [key]: event.target.value }); }} />
      ) : (
        <Input id={id} value={value} onChange={(event) => { editing.updateDetails({ [key]: event.target.value }); }} />
      )}
    </Field>
  );
}
