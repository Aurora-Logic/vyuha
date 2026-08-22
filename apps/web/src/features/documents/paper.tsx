import type { KeyboardEvent, ReactNode } from 'react';
import { PlusIcon, XIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { trimZeros as trimQty } from '@/features/sales/types';
import { formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  PRINTED_DOCUMENT_TITLES,
  SECOND_DATE_LABELS,
  VENDOR_FACING_TYPES,
  gstStateName,
  type DocumentDesign,
  type DocumentDetails,
  type DocumentProfile,
  type DocumentTemplateId,
  type PrintedDocumentType,
  type ShipTo,
} from '@vyuha/shared';

import { hsnSummary } from './paper-hsn';
import { DETAIL_LABELS, DETAIL_ORDER, E_INVOICE_KEYS, useEnterMoves } from './paper-support';
import { moneyToIndianWords } from './words';

/**
 * The printed page, and the editor: one A4 sheet rendered from a design and
 * a profile, worn by every document type. In `edit` mode the fields on the
 * paper are the inputs — what is typed where it will print — and the lines
 * are a table whose cells are boxes; in `print` mode the same paper prints.
 *
 * Two layouts. `tally` is the GST tax invoice everyone in the office already
 * reads: boxed seller, consignee and buyer, the details grid, HSN/SAC on
 * every line, CGST+SGST or IGST rows, the quantity total, the amount in
 * words, the HSN summary, the declaration, the signatory. The other four
 * templates share a letterhead layout that differs in weight and rule —
 * and carries every one of those fields, so a document that moves between
 * templates loses nothing. The face is the design's font; figures are
 * always monospaced so columns of money line up (index.css).
 *
 * Nothing here is styled inline: the accent is a palette class the sheet
 * reads through `--paper-accent`, and every template is a set of classes.
 */

export interface PaperLine {
  readonly key: string;
  readonly stockItemId: string | null;
  readonly description: string;
  readonly hsnCode: string;
  readonly quantity: string;
  readonly unit: string;
  readonly rate: string;
  readonly discountPct: string;
  readonly taxPct: string;
  /** Null while a line is being typed and the server has not priced it. */
  readonly amount: string | null;
  readonly taxAmount: string | null;
}

export interface PaperTotals {
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
  /** True while the figures are the client's preview, not the server's. */
  readonly preview: boolean;
}

export interface PaperParty {
  readonly name: string;
  readonly address: string;
  readonly gstin: string;
  readonly stateName: string;
  readonly stateCode: string;
}

/** The sheet's heading: its own when it has one, the type's otherwise. */
function paperTitle(model: Pick<PaperModel, 'type' | 'title'>): string {
  return model.title ?? PRINTED_DOCUMENT_TITLES[model.type];
}

export interface PaperModel {
  readonly type: PrintedDocumentType;
  readonly number: string | null;
  readonly statusLabel: string | null;
  readonly date: string;
  /** An estimate's validity; a purchase order's expected date. */
  readonly validUntil: string | null;
  /** Buyer (Bill to). */
  readonly buyer: PaperParty;
  /** Consignee (Ship to); null means "same as buyer". */
  readonly shipTo: ShipTo | null;
  readonly details: DocumentDetails;
  readonly reference: string | null;
  readonly lines: readonly PaperLine[];
  readonly totals: PaperTotals;
  readonly notes: string;
  readonly terms: string;
  /** What the sheet is called when not the type's own title: a Tally voucher prints as "Receipt Voucher" on the invoice paper. */
  readonly title?: string | null;
  /** "Original for Recipient" and the like, on an invoice's copies. */
  readonly copyLabel?: string | null;
  /** D-47: what the packing slip knows that other papers do not — set only by the pack record. */
  readonly slip?: PaperSlipFacts;
}

export interface PaperSlipFacts {
  readonly boxCount: number;
  readonly packedAt: string;
  readonly packedByName: string | null;
  /** The consignee's phone from the parties master, for the loader and the transporter. */
  readonly phone: string | null;
}

/** What the page hands the paper when it is the editor. Absent = print. */
export interface PaperEditing {
  readonly customer: ReactNode;
  readonly date: ReactNode;
  readonly validUntil?: ReactNode;
  /**
   * ISO-date setters for the phone form, which draws its own date controls
   * rather than reusing the paper-styled slots above (those are drawn to sit
   * on the sheet and look wrong in a form). Absent when the page cannot
   * change the date, in which case the form falls back to the slot.
   */
  readonly setDate?: (iso: string) => void;
  readonly setValidUntil?: (iso: string) => void;
  readonly itemPicker: (line: PaperLine) => ReactNode;
  /** The i beside a line: what this customer was charged for the item before (REQ-W-02). */
  readonly itemHistory?: (line: PaperLine) => ReactNode;
  /** 15 REQ-AN-17: under the line, what the price lists resolved and why -- and the reason box when the rate goes below it. */
  readonly rateNote?: (line: PaperLine) => ReactNode;
  readonly updateLine: (key: string, patch: Partial<Pick<PaperLine, 'description' | 'hsnCode' | 'quantity' | 'unit' | 'rate' | 'discountPct' | 'taxPct'>>) => void;
  readonly addLine: () => void;
  readonly removeLine: (key: string) => void;
  readonly setNotes: (value: string) => void;
  readonly setTerms: (value: string) => void;
  readonly updateDetails: (patch: Partial<DocumentDetails>) => void;
  readonly updateShipTo: (patch: Partial<ShipTo> | null) => void;
  readonly setPlaceOfSupply: (value: string) => void;
}

interface DocumentPaperProps {
  design: DocumentDesign;
  profile: DocumentProfile;
  logoUrl: string | null;
  footerLogoUrls?: readonly string[];
  orgName: string;
  model: PaperModel;
  editing?: PaperEditing;
  className?: string;
}

/** The one look-alike input: a box on screen, plain text on paper. */
export function PaperField({ value, onChange, placeholder, className, label, align = 'left', onKeyDown, dataCell, numeric = false }: { value: string; onChange: (value: string) => void; placeholder?: string; className?: string; label: string; align?: 'left' | 'right'; onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void; dataCell?: string; numeric?: boolean }) {
  return (
    <Input
      aria-label={label}
      value={value}
      placeholder={placeholder}
      data-cell={dataCell}
      inputMode={numeric ? 'decimal' : undefined}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      onKeyDown={onKeyDown}
      className={cn('paper-field w-full', align === 'right' && 'text-right tabular-nums', className)}
    />
  );
}

function PaperArea({ value, onChange, placeholder, label, rows = 3, className }: { value: string; onChange: (value: string) => void; placeholder?: string; label: string; rows?: number; className?: string }) {
  return <Textarea aria-label={label} rows={rows} value={value} placeholder={placeholder} onChange={(event) => { onChange(event.target.value); }} className={cn('paper-field w-full resize-none', className)} />;
}

// --------------------------------------------------------------- tax facts

interface TaxSplit {
  /** 'intra' → CGST + SGST; 'inter' → IGST; 'unknown' → one GST line. */
  readonly kind: 'intra' | 'inter' | 'unknown';
}

function splitOf(profile: DocumentProfile, buyerStateCode: string): TaxSplit {
  const seller = profile.stateCode.trim();
  const buyer = buyerStateCode.trim();
  if (seller === '' || buyer === '') return { kind: 'unknown' };
  return { kind: seller === buyer ? 'intra' : 'inter' };
}

function half(value: string): string {
  return (Math.round((Number(value) / 2) * 100) / 100).toFixed(2);
}


/**
 * The quantity total Tally prints under the column: only when every counted
 * line is in the same unit (3 NOS + 1 box is not 4 of anything). A blank
 * line (no description, nothing priced) is a row waiting to be typed.
 */
function quantityTotal(lines: readonly PaperLine[]): { totalQty: number; unit: string } {
  const counted = lines.filter((l) => l.description.trim() !== '' || l.amount !== null);
  const units = new Set(counted.map((l) => l.unit.trim()));
  if (units.size > 1) return { totalQty: 0, unit: '' };
  return { totalQty: counted.reduce((sum, l) => sum + Number(l.quantity || 0), 0), unit: counted[0]?.unit ?? '' };
}

// --------------------------------------------------------------- the paper

export function DocumentPaper(props: DocumentPaperProps) {
  const { design, model, editing, className } = props;
  return (
    <article
      className={cn('a4-paper shadow-sm ring-1 ring-black/5', className)}
      data-accent={design.accent}
      data-font={design.fontFamily}
      data-scale={design.fontScale}
      data-mode={editing !== undefined ? 'edit' : 'print'}
      data-template={design.templateId}
      aria-label={`${paperTitle(model)} ${model.number ?? 'draft'}`}
    >
      {design.templateId === 'tally' ? <TallyLayout {...props} /> : <LetterheadLayout {...props} />}
    </article>
  );
}

// ---------------------------------------------------------- Tally (GST) layout

const BOX = 'border border-neutral-800';

function TallyLayout({ design, profile, logoUrl, footerLogoUrls = [], orgName, model, editing }: DocumentPaperProps) {
  const editable = editing !== undefined;
  const enter = useEnterMoves(editing, model.lines);
  const businessName = profile.legalName.trim() === '' ? orgName : profile.legalName;
  const addressLines = profile.addressLines.split('\n').filter((l) => l.trim() !== '');
  const split = splitOf(profile, model.buyer.stateCode);
  const shipTo = model.shipTo;
  const showShipTo = design.showShipTo && (editable || (shipTo !== null && (shipTo.name ?? '').trim() !== ''));
  // A blank line (no description, nothing priced) is a row waiting to be typed, not a quantity.
  const { totalQty, unit } = quantityTotal(model.lines);
  const summary = design.showHsn ? hsnSummary(model.lines) : [];
  // The summary's own rows, not the document's gross subtotal: a line's
  // `amount` is net of its discount while `totals.subtotal` is gross, so
  // printing the latter made the Total disagree with the column above it on
  // any document carrying a discount.
  const taxableTotal = summary.reduce((sum, row) => sum + row.taxable, 0);
  const details = model.details;
  const detailBox = (label: string, key: keyof DocumentDetails, placeholder = '') => (
    <div className={cn('flex flex-col gap-0.5 px-2 py-1', BOX, '-mt-px -ml-px')}>
      <span className="text-[0.85em] text-neutral-600">{label}</span>
      {editable ? (
        <PaperField label={label} value={details[key] ?? ''} placeholder={placeholder} onChange={(value) => { editing.updateDetails({ [key]: value }); }} className="min-h-[1.4em] text-[0.95em]" />
      ) : (
        <span className="min-h-[1.4em] text-[0.95em] font-medium">{details[key] ?? ''}</span>
      )}
    </div>
  );
  // A paper that carries goods, not money, prints quantities only: no rate, discount, amount, tax rows, words or bank.
  const money = design.showAmounts;
  const showDiscount = money && design.showDiscount;
  const showTax = money && design.showTax;
  const showWords = money && design.showAmountInWords;
  const showBank = money && design.showBank;
  const vendorFacing = VENDOR_FACING_TYPES.includes(model.type);
  const secondDate = SECOND_DATE_LABELS[model.type];
  const colCount = 3 + (money ? 2 : 0) + (design.showHsn ? 1 : 0) + (design.showUnit ? 1 : 0) + (showDiscount ? 1 : 0);

  return (
    <div className="flex min-h-[297mm] flex-col p-[10mm]">
      {/* Title row: the document's name centred, e-Invoice facts to the right when they exist. */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2 pb-2">
        <div className="flex items-start gap-3">
          {logoUrl !== null && design.logoPlacement === 'left' ? <img src={logoUrl} alt="" className="max-h-14 max-w-[40mm] object-contain" /> : null}
        </div>
        <div className="text-center">
          <div className="text-[1.5em] font-bold">{paperTitle(model)}</div>
          {model.copyLabel ? <div className="text-[0.85em] font-medium">({model.copyLabel})</div> : null}
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          {logoUrl !== null && design.logoPlacement === 'right' ? <img src={logoUrl} alt="" className="max-h-14 max-w-[40mm] object-contain" /> : null}
          {design.showEInvoice && (editable || (details.irn ?? '') !== '') ? (
            <div className="grid grid-cols-[auto_auto_1fr] gap-x-2 text-left text-[0.85em]">
              <span className="font-medium">e-Invoice</span>
              <span />
              <span />
              <span>IRN</span>
              <span>:</span>
              {editable ? <PaperField label="IRN" value={details.irn ?? ''} onChange={(v) => { editing.updateDetails({ irn: v }); }} className="min-h-[1.2em] font-medium" /> : <span className="font-medium break-all">{details.irn}</span>}
              <span>Ack No.</span>
              <span>:</span>
              {editable ? <PaperField label="Acknowledgement number" value={details.ackNo ?? ''} onChange={(v) => { editing.updateDetails({ ackNo: v }); }} className="min-h-[1.2em] font-medium" /> : <span className="font-medium">{details.ackNo}</span>}
              <span>Ack Date</span>
              <span>:</span>
              {editable ? <PaperField label="Acknowledgement date" value={details.ackDate ?? ''} onChange={(v) => { editing.updateDetails({ ackDate: v }); }} className="min-h-[1.2em] font-medium" /> : <span className="font-medium">{details.ackDate}</span>}
            </div>
          ) : null}
        </div>
      </div>

      {/* The header block: seller / consignee / buyer down the left, the details grid down the right. */}
      <div className={cn('grid grid-cols-[1.15fr_1fr]', BOX)}>
        <div className="flex flex-col">
          <div className="border-b border-neutral-800 px-2 py-1">
            <div className="text-[1.05em] font-bold">{businessName}</div>
            {addressLines.map((line) => (
              <div key={line} className="text-[0.95em]">{line}</div>
            ))}
            {profile.gstin ? <div className="text-[0.95em]">GSTIN/UIN: {profile.gstin}</div> : null}
            {profile.stateName || profile.stateCode ? <div className="text-[0.95em]">State Name : {profile.stateName}{profile.stateCode ? `, Code : ${profile.stateCode}` : ''}</div> : null}
            {[profile.phone, profile.email].filter((p) => p.trim() !== '').length > 0 ? <div className="text-[0.9em]">{[profile.phone, profile.email].filter((p) => p.trim() !== '').join(' · ')}</div> : null}
          </div>
          {showShipTo ? (
            <div className="border-b border-neutral-800 px-2 py-1">
              <div className="text-[0.85em] text-neutral-600">Consignee (Ship to)</div>
              {editable ? (
                <div className="flex flex-col">
                  <PaperField label="Consignee name" value={shipTo?.name ?? ''} placeholder="Same as buyer when blank" onChange={(v) => { editing.updateShipTo({ name: v }); }} className="font-bold" />
                  <PaperArea label="Consignee address" rows={2} value={shipTo?.address ?? ''} placeholder="Address" onChange={(v) => { editing.updateShipTo({ address: v }); }} className="text-[0.95em]" />
                  <div className="grid grid-cols-[auto_1fr] gap-x-2 text-[0.95em]">
                    <span>GSTIN/UIN</span>
                    <PaperField label="Consignee GSTIN" value={shipTo?.gstin ?? ''} onChange={(v) => { editing.updateShipTo({ gstin: v.toUpperCase() }); }} className="min-h-[1.2em]" />
                    <span>State Name</span>
                    <div className="grid grid-cols-[1fr_auto_4rem] gap-x-1">
                      <PaperField label="Consignee state" value={shipTo?.stateName ?? ''} onChange={(v) => { editing.updateShipTo({ stateName: v }); }} className="min-h-[1.2em]" />
                      <span>Code :</span>
                      <PaperField label="Consignee state code" value={shipTo?.stateCode ?? ''} onChange={(v) => { editing.updateShipTo({ stateCode: v }); }} className="min-h-[1.2em]" />
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="font-bold">{shipTo?.name}</div>
                  <div className="whitespace-pre-line text-[0.95em]">{shipTo?.address}</div>
                  {shipTo?.gstin ? <div className="text-[0.95em]">GSTIN/UIN : {shipTo.gstin}</div> : null}
                  {shipTo?.stateName || shipTo?.stateCode ? <div className="text-[0.95em]">State Name : {shipTo.stateName || gstStateName(shipTo.stateCode ?? '')}{shipTo.stateCode ? `, Code : ${shipTo.stateCode}` : ''}</div> : null}
                </>
              )}
            </div>
          ) : null}
          <div className="flex-1 px-2 py-1">
            <div className="text-[0.85em] text-neutral-600">{vendorFacing ? 'Vendor' : 'Buyer (Bill to)'}</div>
            {editable ? editing.customer : <div className="font-bold">{model.buyer.name || '—'}</div>}
            {model.buyer.address ? <div className="whitespace-pre-line text-[0.95em]">{model.buyer.address}</div> : null}
            {model.buyer.gstin ? <div className="text-[0.95em]">GSTIN/UIN : {model.buyer.gstin}</div> : null}
            <div className="flex items-baseline gap-2 text-[0.95em]">
              <span>State Name :</span>
              {editable && !vendorFacing ? (
                <span className="flex items-baseline gap-1">
                  <span>{model.buyer.stateName || gstStateName(model.buyer.stateCode) || '—'}</span>
                  <span>, Code :</span>
                  <PaperField label="Place of supply (state code)" value={model.buyer.stateCode} placeholder="29" onChange={(v) => { editing.setPlaceOfSupply(v); }} className="w-10 min-h-[1.2em]" />
                </span>
              ) : (
                <span>{model.buyer.stateName || gstStateName(model.buyer.stateCode)}{model.buyer.stateCode ? `, Code : ${model.buyer.stateCode}` : ''}</span>
              )}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 border-l border-neutral-800 content-start">
          <div className={cn('flex flex-col gap-0.5 px-2 py-1', BOX, '-mt-px -ml-px')}>
            <span className="text-[0.85em] text-neutral-600">{paperTitle(model)} No.</span>
            <span className="min-h-[1.4em] text-[0.95em] font-bold">{model.number ?? 'Draft'}</span>
          </div>
          <div className={cn('flex flex-col gap-0.5 px-2 py-1', BOX, '-mt-px -ml-px')}>
            <span className="text-[0.85em] text-neutral-600">Dated</span>
            <span className="min-h-[1.4em] text-[0.95em] font-bold">{editable ? editing.date : formatDate(model.date)}</span>
          </div>
          {secondDate !== undefined ? (
            <div className={cn('col-span-2 flex flex-col gap-0.5 px-2 py-1', BOX, '-mt-px -ml-px')}>
              <span className="text-[0.85em] text-neutral-600">{secondDate}</span>
              <span className="min-h-[1.4em] text-[0.95em] font-medium">{editable && editing.validUntil !== undefined ? editing.validUntil : model.validUntil ? formatDate(model.validUntil) : '—'}</span>
            </div>
          ) : null}
          {design.showDetailsGrid ? (
            <>
              {detailBox('Delivery Note', 'deliveryNote')}
              {detailBox('Mode/Terms of Payment', 'paymentTerms')}
              {detailBox('Reference No. & Date.', 'referenceNo')}
              {detailBox('Other References', 'otherReferences')}
              {detailBox("Buyer's Order No.", 'buyersOrderNo')}
              {detailBox('Dated', 'buyersOrderDate')}
              {detailBox('Dispatch Doc No.', 'dispatchDocNo')}
              {detailBox('Delivery Note Date', 'deliveryNoteDate')}
              {detailBox('Dispatched through', 'dispatchedThrough')}
              {detailBox('Destination', 'destination')}
              <div className={cn('col-span-2 flex flex-col gap-0.5 px-2 py-1', BOX, '-mt-px -ml-px')}>
                <span className="text-[0.85em] text-neutral-600">Terms of Delivery</span>
                {editable ? <PaperArea label="Terms of Delivery" rows={2} value={details.termsOfDelivery ?? ''} onChange={(v) => { editing.updateDetails({ termsOfDelivery: v }); }} className="text-[0.95em]" /> : <span className="min-h-[1.4em] whitespace-pre-line text-[0.95em]">{details.termsOfDelivery ?? ''}</span>}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* The lines. Tax rows sit under the items like Tally prints them; the total row carries the quantity. */}
      <Table className="-mt-px text-[1em]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={cn(BOX, 'w-8 py-1 text-center text-[0.9em]')}>Sl No.</TableHead>
            <TableHead className={cn(BOX, 'py-1 text-center text-[0.9em]')}>Description of Goods</TableHead>
            {design.showHsn ? <TableHead className={cn(BOX, 'w-[11%] py-1 text-center text-[0.9em]')}>HSN/SAC</TableHead> : null}
            <TableHead className={cn(BOX, 'w-[11%] py-1 text-center text-[0.9em]')}>Quantity</TableHead>
            {money ? <TableHead className={cn(BOX, 'w-[11%] py-1 text-center text-[0.9em]')}>Rate</TableHead> : null}
            {design.showUnit ? <TableHead className={cn(BOX, 'w-[8%] py-1 text-center text-[0.9em]')}>per</TableHead> : null}
            {showDiscount ? <TableHead className={cn(BOX, 'w-[8%] py-1 text-center text-[0.9em]')}>Disc. %</TableHead> : null}
            {money ? <TableHead className={cn(BOX, 'w-[15%] py-1 text-center text-[0.9em]')}>Amount</TableHead> : null}
            {editable ? <TableHead className="print-hidden w-14 border-0" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {model.lines.map((line, index) => (
            <TableRow key={line.key} className="hover:bg-transparent">
              <TableCell className={cn(BOX, 'py-1 text-center align-top tabular-nums')}>{index + 1}</TableCell>
              <TableCell className={cn(BOX, 'py-1 align-top whitespace-normal')}>
                {editable ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-start gap-1">
                      <div className="min-w-0 flex-1">{editing.itemPicker(line)}</div>
                      {editing.itemHistory?.(line)}
                    </div>
                    <PaperField dataCell={`description-${String(index)}`} label={`Line ${String(index + 1)} description`} value={line.description} placeholder="Description of goods" onChange={(v) => { editing.updateLine(line.key, { description: v }); }} onKeyDown={enter(index, 'description')} className="font-bold" />
                    {editing.rateNote?.(line)}
                  </div>
                ) : (
                  <span className="font-bold">{line.description}</span>
                )}
              </TableCell>
              {design.showHsn ? (
                <TableCell className={cn(BOX, 'py-1 align-top tabular-nums')}>
                  {editable ? <PaperField dataCell={`hsn-${String(index)}`} label={`Line ${String(index + 1)} HSN or SAC`} value={line.hsnCode} placeholder="HSN" onChange={(v) => { editing.updateLine(line.key, { hsnCode: v }); }} onKeyDown={enter(index, 'hsn')} /> : line.hsnCode}
                </TableCell>
              ) : null}
              <TableCell className={cn(BOX, 'py-1 text-right align-top font-bold tabular-nums')}>
                {editable ? <PaperField dataCell={`qty-${String(index)}`} align="right" label={`Line ${String(index + 1)} quantity`} value={line.quantity} onChange={(v) => { editing.updateLine(line.key, { quantity: v }); }} onKeyDown={enter(index, 'qty')} className="font-bold" numeric /> : `${trimQty(line.quantity)}${design.showUnit ? '' : line.unit ? ` ${line.unit}` : ''}`}
              </TableCell>
              {money ? (
                <TableCell className={cn(BOX, 'py-1 text-right align-top tabular-nums')}>
                  {editable ? <PaperField dataCell={`rate-${String(index)}`} align="right" label={`Line ${String(index + 1)} rate`} value={line.rate} placeholder="0.00" onChange={(v) => { editing.updateLine(line.key, { rate: v }); }} onKeyDown={enter(index, 'rate')} numeric /> : formatMoney(line.rate)}
                </TableCell>
              ) : null}
              {design.showUnit ? (
                <TableCell className={cn(BOX, 'py-1 align-top')}>
                  {editable ? <PaperField dataCell={`unit-${String(index)}`} label={`Line ${String(index + 1)} unit`} value={line.unit} placeholder="No" onChange={(v) => { editing.updateLine(line.key, { unit: v }); }} onKeyDown={enter(index, 'unit')} /> : line.unit}
                </TableCell>
              ) : null}
              {showDiscount ? (
                <TableCell className={cn(BOX, 'py-1 text-right align-top tabular-nums')}>
                  {editable ? <PaperField dataCell={`disc-${String(index)}`} align="right" label={`Line ${String(index + 1)} discount percent`} value={line.discountPct} onChange={(v) => { editing.updateLine(line.key, { discountPct: v }); }} onKeyDown={enter(index, 'disc')} numeric /> : Number(line.discountPct) > 0 ? trimQty(line.discountPct) : ''}
                </TableCell>
              ) : null}
              {money ? <TableCell className={cn(BOX, 'py-1 text-right align-top font-bold tabular-nums')}>{formatMoney(line.amount)}</TableCell> : null}
              {editable ? (
                <TableCell className="print-hidden border-0 py-1 align-top">
                  <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove line ${String(index + 1)}`} onClick={() => { editing.removeLine(line.key); }}>
                    <XIcon />
                  </Button>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
          {editable ? (
            <TableRow className="print-hidden hover:bg-transparent">
              <TableCell colSpan={colCount + 1} className="border-x border-neutral-800 py-1">
                <Button type="button" variant="ghost" size="sm" onClick={editing.addLine}>
                  <PlusIcon data-icon="inline-start" />
                  Add line
                  <span className="text-muted-foreground ml-2 text-xs">or press Enter on the last line</span>
                </Button>
              </TableCell>
            </TableRow>
          ) : null}
          {showTax && Number(model.totals.taxTotal) > 0 ? (
            split.kind === 'intra' ? (
              <>
                <TaxRow label="CGST" value={half(model.totals.taxTotal)} colCount={colCount} editable={editable} />
                <TaxRow label="SGST" value={half(model.totals.taxTotal)} colCount={colCount} editable={editable} />
              </>
            ) : (
              <TaxRow label={split.kind === 'inter' ? 'IGST' : 'GST'} value={model.totals.taxTotal} colCount={colCount} editable={editable} />
            )
          ) : null}
          {/*
              No "Less: Discount" row here. Every line's Amount is already net
              of its own discount (the server writes `amount` as
              qty x rate x (1 - disc/100)), and each line shows its Disc. %
              beside it, so deducting the total a second time made the column
              stop adding up: the reader summed the amounts, subtracted the
              discount again, and landed short of the Total the server had
              computed correctly. The discount is visible per line, which is
              where it applies.
          */}
          <TableRow className="hover:bg-transparent">
            <TableCell className={cn(BOX, 'py-1')} />
            <TableCell className={cn(BOX, 'py-1 text-right font-medium')}>Total</TableCell>
            {design.showHsn ? <TableCell className={cn(BOX, 'py-1')} /> : null}
            <TableCell className={cn(BOX, 'py-1 text-right font-bold tabular-nums')}>{totalQty > 0 ? `${trimQty(totalQty.toFixed(3))}${unit ? ` ${unit}` : ''}` : ''}</TableCell>
            {money ? <TableCell className={cn(BOX, 'py-1')} /> : null}
            {design.showUnit ? <TableCell className={cn(BOX, 'py-1')} /> : null}
            {showDiscount ? <TableCell className={cn(BOX, 'py-1')} /> : null}
            {money ? <TableCell className={cn(BOX, 'py-1 text-right text-[1.15em] font-bold tabular-nums')}>{formatMoney(model.totals.grandTotal)}</TableCell> : null}
            {editable ? <TableCell className="print-hidden border-0" /> : null}
          </TableRow>
        </TableBody>
      </Table>

      {/* Amount in words, E. & O.E, then the HSN summary. */}
      <div className={cn(BOX, '-mt-px flex items-start justify-between gap-4 px-2 py-1')}>
        <div>
          {showWords ? (
            <>
              <div className="text-[0.85em] text-neutral-600">Amount Chargeable (in words)</div>
              <div className="text-[1.05em] font-bold">{moneyToIndianWords(model.totals.grandTotal)}</div>
            </>
          ) : null}
        </div>
        <span className="text-[0.85em] italic">E. &amp; O.E</span>
      </div>
      {money && design.showHsn && summary.length > 0 && Number(model.totals.taxTotal) > 0 ? (
        <Table className="-mt-px text-[0.95em]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead rowSpan={2} className={cn(BOX, 'py-1 text-center')}>HSN/SAC</TableHead>
              <TableHead rowSpan={2} className={cn(BOX, 'py-1 text-center')}>Taxable Value</TableHead>
              {split.kind === 'intra' ? (
                <>
                  <TableHead colSpan={2} className={cn(BOX, 'py-1 text-center')}>Central Tax</TableHead>
                  <TableHead colSpan={2} className={cn(BOX, 'py-1 text-center')}>State Tax</TableHead>
                </>
              ) : (
                <TableHead colSpan={2} className={cn(BOX, 'py-1 text-center')}>{split.kind === 'inter' ? 'Integrated Tax' : 'GST'}</TableHead>
              )}
              <TableHead rowSpan={2} className={cn(BOX, 'py-1 text-center')}>Total Tax Amount</TableHead>
            </TableRow>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(BOX, 'py-1 text-center')}>Rate</TableHead>
              <TableHead className={cn(BOX, 'py-1 text-center')}>Amount</TableHead>
              {split.kind === 'intra' ? (
                <>
                  <TableHead className={cn(BOX, 'py-1 text-center')}>Rate</TableHead>
                  <TableHead className={cn(BOX, 'py-1 text-center')}>Amount</TableHead>
                </>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.map((row) => (
              <TableRow key={`${row.hsn}-${String(row.ratePct)}`} className="hover:bg-transparent">
                <TableCell className={cn(BOX, 'py-0.5')}>{row.hsn}</TableCell>
                <TableCell className={cn(BOX, 'py-0.5 text-right tabular-nums')}>{formatMoney(row.taxable.toFixed(2))}</TableCell>
                {split.kind === 'intra' ? (
                  <>
                    <TableCell className={cn(BOX, 'py-0.5 text-right tabular-nums')}>{trimQty((row.ratePct / 2).toFixed(2))}%</TableCell>
                    <TableCell className={cn(BOX, 'py-0.5 text-right tabular-nums')}>{formatMoney(half(row.tax.toFixed(2)))}</TableCell>
                    <TableCell className={cn(BOX, 'py-0.5 text-right tabular-nums')}>{trimQty((row.ratePct / 2).toFixed(2))}%</TableCell>
                    <TableCell className={cn(BOX, 'py-0.5 text-right tabular-nums')}>{formatMoney(half(row.tax.toFixed(2)))}</TableCell>
                  </>
                ) : (
                  <>
                    <TableCell className={cn(BOX, 'py-0.5 text-right tabular-nums')}>{trimQty(row.ratePct.toFixed(2))}%</TableCell>
                    <TableCell className={cn(BOX, 'py-0.5 text-right tabular-nums')}>{formatMoney(row.tax.toFixed(2))}</TableCell>
                  </>
                )}
                <TableCell className={cn(BOX, 'py-0.5 text-right tabular-nums')}>{formatMoney(row.tax.toFixed(2))}</TableCell>
              </TableRow>
            ))}
            <TableRow className="hover:bg-transparent">
              <TableCell className={cn(BOX, 'py-0.5 text-right font-bold')}>Total</TableCell>
              <TableCell className={cn(BOX, 'py-0.5 text-right font-bold tabular-nums')}>{formatMoney(taxableTotal.toFixed(2))}</TableCell>
              {split.kind === 'intra' ? (
                <>
                  <TableCell className={cn(BOX, 'py-0.5')} />
                  <TableCell className={cn(BOX, 'py-0.5 text-right font-bold tabular-nums')}>{formatMoney(half(model.totals.taxTotal))}</TableCell>
                  <TableCell className={cn(BOX, 'py-0.5')} />
                  <TableCell className={cn(BOX, 'py-0.5 text-right font-bold tabular-nums')}>{formatMoney(half(model.totals.taxTotal))}</TableCell>
                </>
              ) : (
                <>
                  <TableCell className={cn(BOX, 'py-0.5')} />
                  <TableCell className={cn(BOX, 'py-0.5 text-right font-bold tabular-nums')}>{formatMoney(model.totals.taxTotal)}</TableCell>
                </>
              )}
              <TableCell className={cn(BOX, 'py-0.5 text-right font-bold tabular-nums')}>{formatMoney(model.totals.taxTotal)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      ) : null}
      {money && design.showHsn && showWords && Number(model.totals.taxTotal) > 0 ? (
        <div className={cn(BOX, '-mt-px px-2 py-1')}>
          <span className="text-[0.85em] text-neutral-600">Tax Amount (in words) : </span>
          <span className="font-bold">{moneyToIndianWords(model.totals.taxTotal)}</span>
        </div>
      ) : null}

      {/* Notes and terms only when they say something; the declaration and the signatory close the box. */}
      {(editable || model.notes.trim() !== '' || (design.showTerms && model.terms.trim() !== '')) ? (
        <div className={cn(BOX, '-mt-px grid gap-2 px-2 py-1 sm:grid-cols-2')}>
          <div>
            <div className="text-[0.85em] text-neutral-600">Notes</div>
            {editable ? <PaperArea label="Notes" rows={2} value={model.notes} placeholder={vendorFacing ? 'Anything the vendor should read' : 'Anything the customer should read'} onChange={editing.setNotes} className="text-[0.95em]" /> : <p className="whitespace-pre-line text-[0.95em]">{model.notes}</p>}
          </div>
          {design.showTerms ? (
            <div>
              <div className="text-[0.85em] text-neutral-600">Terms</div>
              {editable ? <PaperArea label="Terms" rows={2} value={model.terms} placeholder={design.defaultTerms || 'Payment terms, delivery, validity'} onChange={editing.setTerms} className="text-[0.95em]" /> : <p className="whitespace-pre-line text-[0.95em]">{model.terms}</p>}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={cn(BOX, '-mt-px grid grid-cols-[1.15fr_1fr]')}>
        <div className="flex flex-col gap-1 px-2 py-1">
          {showBank && profile.bankAccount.trim() !== '' ? (
            <div className="text-[0.9em]">
              <div className="text-[0.9em] text-neutral-600">Company's Bank Details</div>
              <div className="grid grid-cols-[auto_1fr] gap-x-2">
                <span>Bank Name</span><span>: {profile.bankName}</span>
                <span>A/c No.</span><span className="tabular-nums">: {profile.bankAccount}</span>
                <span>Branch &amp; IFS Code</span><span>: {[profile.bankBranch, profile.bankIfsc].filter((p) => p.trim() !== '').join(' & ')}</span>
              </div>
            </div>
          ) : null}
          {design.showDeclaration ? (
            <div className="text-[0.85em]">
              <div className="text-neutral-600">Declaration</div>
              <div>{profile.declaration}</div>
            </div>
          ) : null}
        </div>
        {design.showSignature ? (
          <div className="flex min-h-[22mm] flex-col justify-between border-l border-neutral-800 px-2 py-1 text-right">
            <div className="text-[0.95em] font-bold">for {businessName}</div>
            <div className="text-[0.9em]">{profile.signatoryName.trim() === '' ? 'Authorised Signatory' : profile.signatoryName}</div>
          </div>
        ) : (
          <div className="border-l border-neutral-800" />
        )}
      </div>
      <PaperFoot design={design} profile={profile} footerLogoUrls={footerLogoUrls} />
    </div>
  );
}

function TaxRow({ label, value, colCount, editable, muted = false }: { label: string; value: string; colCount: number; editable: boolean; muted?: boolean }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className="border-x border-neutral-800 py-0.5" />
      <TableCell colSpan={colCount - 2} className={cn('border-x border-neutral-800 py-0.5 text-right italic', muted ? 'text-neutral-600' : 'font-bold')}>{label}</TableCell>
      <TableCell className={cn('border-x border-neutral-800 py-0.5 text-right tabular-nums', muted ? 'text-neutral-600' : 'font-bold')}>{formatMoney(value)}</TableCell>
      {editable ? <TableCell className="print-hidden border-0" /> : null}
    </TableRow>
  );
}

/**
 * The foot of the page, on the bottom margin: the footer line, then the
 * caption ("Authorised channel partners of"), then the partner logos in a
 * row — the last thing on the sheet, touching the margin, on every template.
 */
function PaperFoot({ design, profile, footerLogoUrls, className }: { design: DocumentDesign; profile: DocumentProfile; footerLogoUrls: readonly string[]; className?: string }) {
  const caption = profile.footerCaption.trim();
  if (design.footerNote.trim() === '' && footerLogoUrls.length === 0 && caption === '') return null;
  return (
    <div className={cn('mt-auto flex flex-col items-center gap-1.5 pt-3', className)}>
      {design.footerNote.trim() !== '' ? <div className="text-center text-[0.85em]">{design.footerNote}</div> : null}
      {caption !== '' ? <div className="text-center text-[0.8em] tracking-wide text-neutral-600 uppercase">{caption}</div> : null}
      {footerLogoUrls.length > 0 ? (
        <div className="flex w-full flex-wrap items-center justify-center gap-x-6 gap-y-2">
          {footerLogoUrls.map((url) => (
            <img key={url} src={url} alt="" className="max-h-10 max-w-[32mm] object-contain" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------- letterhead layouts

interface TemplateStyle {
  sheet: string;
  /** A wrapper inside the margins; the bordered template draws its frame here. */
  frame: string;
  header: string;
  title: string;
  business: string;
  metaBox: string;
  metaLabel: string;
  tableHeadCell: string;
  row: string;
  cell: string;
  /** The ruled line under the totals area: the summary tables and the HSN table wear it. */
  summaryHead: string;
  summaryCell: string;
  totalsBox: string;
  grandTotal: string;
  footer: string;
  section: string;
  /** The band templates pad their body; the margin templates pad the sheet. */
  body: string;
}

const TEMPLATES: Record<Exclude<DocumentTemplateId, 'tally'>, TemplateStyle> = {
  modern: {
    sheet: 'p-0',
    frame: '',
    header: 'flex items-start justify-between gap-6 bg-[var(--paper-accent)] px-[12mm] py-6 text-white',
    title: 'text-[2em] font-semibold leading-none tracking-tight',
    business: 'text-right text-white/90',
    metaBox: 'grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5',
    metaLabel: 'text-[0.85em] text-neutral-500',
    tableHeadCell: 'bg-[var(--paper-accent-soft)] text-[0.85em] font-semibold text-[var(--paper-accent)] first:rounded-l last:rounded-r',
    row: 'border-b border-neutral-100',
    cell: 'align-top py-2',
    summaryHead: 'bg-[var(--paper-accent-soft)] text-[0.85em] font-semibold text-[var(--paper-accent)]',
    summaryCell: 'border-b border-neutral-100 py-1',
    totalsBox: 'ml-auto w-[38%] min-w-[220px] rounded bg-[var(--paper-accent-soft)] p-3',
    grandTotal: 'mt-1 border-t border-[var(--paper-accent)]/30 pt-1 text-[1.2em] font-semibold text-[var(--paper-accent)]',
    footer: 'text-[0.85em] text-neutral-500',
    section: 'text-[0.85em] font-semibold text-[var(--paper-accent)]',
    body: 'px-[12mm] pb-[10mm] pt-6',
  },
  minimal: {
    sheet: 'p-[14mm]',
    frame: '',
    header: 'flex items-start justify-between gap-6 pb-6',
    title: 'text-[1.1em] uppercase tracking-[0.3em] text-neutral-500',
    business: 'text-right',
    metaBox: 'grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5',
    metaLabel: 'text-[0.85em] text-neutral-400',
    tableHeadCell: 'border-b border-neutral-300 pb-2 text-[0.8em] font-medium uppercase tracking-wider text-neutral-500',
    row: 'border-b border-neutral-100',
    cell: 'align-top py-2.5',
    summaryHead: 'border-b border-neutral-300 text-[0.8em] font-medium uppercase tracking-wider text-neutral-500',
    summaryCell: 'border-b border-neutral-100 py-1',
    totalsBox: 'ml-auto w-[38%] min-w-[220px] pt-2',
    grandTotal: 'border-t border-neutral-900 pt-1.5 text-[1.15em] font-medium',
    footer: 'pt-4 text-[0.8em] text-neutral-400',
    section: 'text-[0.8em] uppercase tracking-wider text-neutral-400',
    body: 'pt-6',
  },
  bordered: {
    sheet: 'p-[8mm]',
    frame: 'border border-neutral-800 p-[6mm]',
    header: 'flex items-start justify-between gap-6 border-b border-neutral-800 pb-4',
    title: 'text-[1.6em] font-semibold tracking-tight',
    business: 'text-right',
    metaBox: 'grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border border-neutral-800 px-3 py-2',
    metaLabel: 'text-[0.85em] text-neutral-500',
    tableHeadCell: 'border-y border-neutral-800 text-[0.85em] font-semibold',
    row: 'border-b border-neutral-300',
    cell: 'align-top py-1.5',
    summaryHead: 'border-y border-neutral-800 text-[0.85em] font-semibold',
    summaryCell: 'border-b border-neutral-300 py-1',
    totalsBox: 'ml-auto w-[38%] min-w-[220px] border border-neutral-800 px-3 py-2',
    grandTotal: 'border-t border-neutral-800 pt-1 text-[1.15em] font-semibold',
    footer: 'border-t border-neutral-800 pt-3 text-[0.85em]',
    section: 'text-[0.85em] font-semibold',
    body: 'pt-5',
  },
  ledger: {
    sheet: 'p-[12mm]',
    frame: '',
    header: 'flex items-start justify-between gap-6 border-b-4 border-double border-neutral-800 pb-3',
    title: 'text-[1.7em] font-semibold uppercase tracking-wide',
    business: 'text-right',
    metaBox: 'grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5',
    metaLabel: 'text-[0.85em] text-neutral-600',
    tableHeadCell: 'border-y-2 border-neutral-800 text-[0.85em] font-semibold uppercase tracking-wide',
    row: 'border-b border-neutral-400 [&>td]:border-l [&>td]:border-neutral-400 [&>td:first-child]:border-l-0',
    cell: 'align-top py-1.5',
    summaryHead: 'border-y-2 border-neutral-800 text-[0.85em] font-semibold uppercase tracking-wide',
    summaryCell: 'border-b border-neutral-400 py-1',
    totalsBox: 'ml-auto w-[38%] min-w-[220px]',
    grandTotal: 'mt-1 border-y-4 border-double border-neutral-800 py-1 text-[1.15em] font-semibold',
    footer: 'border-t border-neutral-800 pt-3 text-[0.85em]',
    section: 'text-[0.85em] uppercase tracking-wide text-neutral-600',
    body: 'pt-5',
  },
};

function LetterheadLayout({ design, profile, logoUrl, footerLogoUrls = [], orgName, model, editing }: DocumentPaperProps) {
  const t = TEMPLATES[design.templateId === 'tally' ? 'bordered' : design.templateId];
  const editable = editing !== undefined;
  const enter = useEnterMoves(editing, model.lines);
  const businessName = profile.legalName.trim() === '' ? orgName : profile.legalName;
  const addressLines = profile.addressLines.split('\n').filter((line) => line.trim() !== '');
  const split = splitOf(profile, model.buyer.stateCode);
  const money = design.showAmounts;
  const showDiscount = money && design.showDiscount;
  const showTax = money && design.showTax;
  const showWords = money && design.showAmountInWords;
  const showBank = money && design.showBank;
  const vendorFacing = VENDOR_FACING_TYPES.includes(model.type);
  const secondDate = SECOND_DATE_LABELS[model.type];
  // #, description, qty, then what the design shows; the remove column rides outside this count.
  const columns = 3 + (money ? 2 : 0) + (design.showHsn ? 1 : 0) + (design.showUnit ? 1 : 0) + (showDiscount ? 1 : 0) + (showTax ? 1 : 0);
  const details = model.details;
  const filledDetails = (Object.entries(details) as [keyof DocumentDetails, string | undefined][]).filter(([, v]) => (v ?? '').trim() !== '');
  const shipTo = model.shipTo;
  const showShipTo = design.showShipTo && (editable || (shipTo?.name ?? '').trim() !== '');
  const showEInvoice = design.showEInvoice && (editable || (details.irn ?? '') !== '');
  const { totalQty, unit } = quantityTotal(model.lines);
  const summary = design.showHsn ? hsnSummary(model.lines) : [];
  // The summary's own rows, not the document's gross subtotal: a line's
  // `amount` is net of its discount while `totals.subtotal` is gross, so
  // printing the latter made the Total disagree with the column above it on
  // any document carrying a discount.
  const taxableTotal = summary.reduce((sum, row) => sum + row.taxable, 0);
  const taxed = money && Number(model.totals.taxTotal) > 0;

  const logo = logoUrl !== null && design.logoPlacement !== 'none' ? <img src={logoUrl} alt="" className="max-h-16 max-w-[48mm] object-contain" /> : null;
  const business = (
    <div className={cn('flex flex-col gap-0.5', t.business)}>
      <div className="text-[1.15em] font-semibold">{businessName}</div>
      {addressLines.map((line) => (
        <div key={line} className="text-[0.9em]">{line}</div>
      ))}
      <div className="text-[0.85em]">
        {[profile.gstin ? `GSTIN ${profile.gstin}` : null, profile.pan ? `PAN ${profile.pan}` : null, profile.stateName || profile.stateCode ? `${profile.stateName || gstStateName(profile.stateCode)}${profile.stateCode ? ` (${profile.stateCode})` : ''}` : null].filter(Boolean).join(' · ')}
      </div>
      <div className="text-[0.85em]">{[profile.phone, profile.email, profile.website].filter((p) => p.trim() !== '').join(' · ')}</div>
    </div>
  );

  return (
    <div className={cn('flex min-h-[297mm] flex-col', t.sheet)}>
      <div className={cn('flex flex-1 flex-col', t.frame)}>
        <header className={t.header}>
          <div className="flex flex-col gap-3">
            <div className={cn('flex items-start gap-4', design.logoPlacement === 'right' && 'flex-row-reverse text-right')}>{logo}</div>
            <div className={t.title}>{paperTitle(model)}</div>
            {model.copyLabel ? <div className="text-[0.85em] font-medium uppercase tracking-wide opacity-80">{model.copyLabel}</div> : null}
          </div>
          {business}
        </header>

        <div className={cn('flex flex-1 flex-col gap-5', t.body)}>
          <div className="grid gap-6 sm:grid-cols-[1fr_auto]">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <div className={t.section}>{vendorFacing ? 'Vendor' : 'Bill to'}</div>
                {editable ? editing.customer : <div className="text-[1.05em] font-semibold">{model.buyer.name || '—'}</div>}
                {model.buyer.address ? <div className="whitespace-pre-line text-[0.9em] text-neutral-600">{model.buyer.address}</div> : null}
                <div className="text-[0.9em] text-neutral-600">
                  {[model.buyer.gstin ? `GSTIN ${model.buyer.gstin}` : null, model.buyer.stateName || model.buyer.stateCode ? `${model.buyer.stateName || gstStateName(model.buyer.stateCode)}${model.buyer.stateCode ? ` (${model.buyer.stateCode})` : ''}` : null].filter(Boolean).join(' · ')}
                  {editable && !vendorFacing ? (
                    <span className="ml-2 inline-flex items-baseline gap-1">
                      Place of supply
                      <PaperField label="Place of supply (state code)" value={model.buyer.stateCode} placeholder="29" onChange={(v) => { editing.setPlaceOfSupply(v); }} className="w-10 min-h-[1.2em]" />
                    </span>
                  ) : null}
                </div>
              </div>
              {showShipTo ? (
                <div className="flex flex-col gap-1">
                  <div className={t.section}>Ship to</div>
                  {editable ? (
                    <div className="flex flex-col">
                      <PaperField label="Consignee name" value={shipTo?.name ?? ''} placeholder="Same as buyer when blank" onChange={(v) => { editing.updateShipTo({ name: v }); }} className="font-medium" />
                      <PaperArea label="Consignee address" rows={2} value={shipTo?.address ?? ''} placeholder="Address" onChange={(v) => { editing.updateShipTo({ address: v }); }} className="text-[0.9em]" />
                      <div className="grid grid-cols-[auto_1fr_auto_3rem] items-baseline gap-x-2 text-[0.9em] text-neutral-600">
                        <span>GSTIN</span>
                        <PaperField label="Consignee GSTIN" value={shipTo?.gstin ?? ''} onChange={(v) => { editing.updateShipTo({ gstin: v.toUpperCase() }); }} className="min-h-[1.2em]" />
                        <span>State code</span>
                        <PaperField label="Consignee state code" value={shipTo?.stateCode ?? ''} onChange={(v) => { editing.updateShipTo({ stateCode: v }); }} className="min-h-[1.2em]" />
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="font-medium">{shipTo?.name}</div>
                      <div className="whitespace-pre-line text-[0.9em] text-neutral-600">{shipTo?.address}</div>
                      <div className="text-[0.9em] text-neutral-600">
                        {[shipTo?.gstin ? `GSTIN ${shipTo.gstin}` : null, shipTo?.stateName || shipTo?.stateCode ? `${shipTo.stateName || gstStateName(shipTo.stateCode ?? '')}${shipTo.stateCode ? ` (${shipTo.stateCode})` : ''}` : null].filter(Boolean).join(' · ')}
                      </div>
                    </>
                  )}
                </div>
              ) : null}
              {showEInvoice ? (
                <div className="flex flex-col gap-1">
                  <div className={t.section}>e-Invoice</div>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.9em]">
                    <span className="text-neutral-600">IRN</span>
                    {editable ? <PaperField label="IRN" value={details.irn ?? ''} onChange={(v) => { editing.updateDetails({ irn: v }); }} className="min-h-[1.2em]" /> : <span className="break-all">{details.irn}</span>}
                    <span className="text-neutral-600">Ack no.</span>
                    {editable ? <PaperField label="Acknowledgement number" value={details.ackNo ?? ''} onChange={(v) => { editing.updateDetails({ ackNo: v }); }} className="min-h-[1.2em]" /> : <span>{details.ackNo}</span>}
                    <span className="text-neutral-600">Ack date</span>
                    {editable ? <PaperField label="Acknowledgement date" value={details.ackDate ?? ''} onChange={(v) => { editing.updateDetails({ ackDate: v }); }} className="min-h-[1.2em]" /> : <span>{details.ackDate}</span>}
                  </div>
                </div>
              ) : null}
            </div>
            <div className={cn(t.metaBox, 'min-w-[62mm] self-start text-[0.95em]')}>
              <span className={t.metaLabel}>Number</span>
              <span className="font-medium tabular-nums">{model.number ?? 'Draft'}</span>
              <span className={t.metaLabel}>Date</span>
              <span className="tabular-nums">{editable ? editing.date : formatDate(model.date)}</span>
              {secondDate !== undefined ? (
                <>
                  <span className={t.metaLabel}>{secondDate}</span>
                  <span className="tabular-nums">{editable && editing.validUntil !== undefined ? editing.validUntil : model.validUntil ? formatDate(model.validUntil) : '—'}</span>
                </>
              ) : null}
              {model.reference ? (
                <>
                  <span className={t.metaLabel}>Reference</span>
                  <span>{model.reference}</span>
                </>
              ) : null}
              {design.showDetailsGrid
                ? (editable ? DETAIL_ORDER : filledDetails.map(([k]) => k).filter((k) => !E_INVOICE_KEYS.has(k))).map((key) => (
                    <DetailPair key={key} label={DETAIL_LABELS[key]} value={details[key] ?? ''} editable={editable} labelClass={t.metaLabel} onChange={(v) => { editing?.updateDetails({ [key]: v }); }} />
                  ))
                : null}
            </div>
          </div>

          <Table className="text-[1em]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={cn(t.tableHeadCell, 'w-8')}>#</TableHead>
                <TableHead className={t.tableHeadCell}>Description</TableHead>
                {design.showHsn ? <TableHead className={cn(t.tableHeadCell, 'w-[10%]')}>HSN/SAC</TableHead> : null}
                <TableHead className={cn(t.tableHeadCell, 'w-[12%] text-right')}>Qty</TableHead>
                {design.showUnit ? <TableHead className={cn(t.tableHeadCell, 'w-[8%]')}>Unit</TableHead> : null}
                {money ? <TableHead className={cn(t.tableHeadCell, 'w-[13%] text-right')}>Rate</TableHead> : null}
                {showDiscount ? <TableHead className={cn(t.tableHeadCell, 'w-[8%] text-right')}>Disc %</TableHead> : null}
                {showTax ? <TableHead className={cn(t.tableHeadCell, 'w-[8%] text-right')}>Tax %</TableHead> : null}
                {money ? <TableHead className={cn(t.tableHeadCell, 'w-[15%] text-right')}>Amount</TableHead> : null}
                {editable ? <TableHead className={cn(t.tableHeadCell, 'w-8 print-hidden')}> </TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {model.lines.map((line, index) => (
                <TableRow key={line.key} className={cn(t.row, 'hover:bg-transparent')}>
                  <TableCell className={cn(t.cell, 'text-neutral-500 tabular-nums')}>{index + 1}</TableCell>
                  <TableCell className={cn(t.cell, 'whitespace-normal')}>
                    {editable ? (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-start gap-1">
                          <div className="min-w-0 flex-1">{editing.itemPicker(line)}</div>
                          {editing.itemHistory?.(line)}
                        </div>
                        <PaperField dataCell={`description-${String(index)}`} label={`Line ${String(index + 1)} description`} value={line.description} placeholder="Description" onChange={(value) => { editing.updateLine(line.key, { description: value }); }} onKeyDown={enter(index, 'description')} />
                    {editing.rateNote?.(line)}
                      </div>
                    ) : (
                      line.description
                    )}
                  </TableCell>
                  {design.showHsn ? (
                    <TableCell className={cn(t.cell, 'tabular-nums')}>
                      {editable ? <PaperField dataCell={`hsn-${String(index)}`} label={`Line ${String(index + 1)} HSN or SAC`} value={line.hsnCode} placeholder="HSN" onChange={(v) => { editing.updateLine(line.key, { hsnCode: v }); }} onKeyDown={enter(index, 'hsn')} /> : line.hsnCode}
                    </TableCell>
                  ) : null}
                  <TableCell className={cn(t.cell, 'text-right tabular-nums')}>
                    {editable ? <PaperField dataCell={`qty-${String(index)}`} align="right" label={`Line ${String(index + 1)} quantity`} value={line.quantity} onChange={(value) => { editing.updateLine(line.key, { quantity: value }); }} onKeyDown={enter(index, 'qty')} numeric /> : trimQty(line.quantity)}
                  </TableCell>
                  {design.showUnit ? (
                    <TableCell className={t.cell}>{editable ? <PaperField dataCell={`unit-${String(index)}`} label={`Line ${String(index + 1)} unit`} value={line.unit} placeholder="Unit" onChange={(value) => { editing.updateLine(line.key, { unit: value }); }} onKeyDown={enter(index, 'unit')} /> : line.unit}</TableCell>
                  ) : null}
                  {money ? (
                    <TableCell className={cn(t.cell, 'text-right tabular-nums')}>
                      {editable ? <PaperField dataCell={`rate-${String(index)}`} align="right" label={`Line ${String(index + 1)} rate`} value={line.rate} placeholder="0.00" onChange={(value) => { editing.updateLine(line.key, { rate: value }); }} onKeyDown={enter(index, 'rate')} numeric /> : formatMoney(line.rate)}
                    </TableCell>
                  ) : null}
                  {showDiscount ? (
                    <TableCell className={cn(t.cell, 'text-right tabular-nums')}>
                      {editable ? <PaperField dataCell={`disc-${String(index)}`} align="right" label={`Line ${String(index + 1)} discount percent`} value={line.discountPct} onChange={(value) => { editing.updateLine(line.key, { discountPct: value }); }} onKeyDown={enter(index, 'disc')} numeric /> : trimQty(line.discountPct)}
                    </TableCell>
                  ) : null}
                  {showTax ? (
                    <TableCell className={cn(t.cell, 'text-right tabular-nums')}>
                      {editable ? <PaperField dataCell={`tax-${String(index)}`} align="right" label={`Line ${String(index + 1)} tax percent`} value={line.taxPct} onChange={(value) => { editing.updateLine(line.key, { taxPct: value }); }} onKeyDown={enter(index, 'tax')} numeric /> : trimQty(line.taxPct)}
                    </TableCell>
                  ) : null}
                  {money ? <TableCell className={cn(t.cell, 'text-right font-medium tabular-nums')}>{formatMoney(line.amount)}</TableCell> : null}
                  {editable ? (
                    <TableCell className={cn(t.cell, 'print-hidden')}>
                      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove line ${String(index + 1)}`} onClick={() => { editing.removeLine(line.key); }}>
                        <XIcon />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
              {editable ? (
                <TableRow className="print-hidden hover:bg-transparent">
                  <TableCell colSpan={columns + 1} className="py-1">
                    <Button type="button" variant="ghost" size="sm" onClick={editing.addLine} className="text-[var(--paper-accent)]">
                      <PlusIcon data-icon="inline-start" />
                      Add line
                      <span className="text-muted-foreground ml-2 text-xs">or press Enter on the last line</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ) : null}
              {totalQty > 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell className={cn(t.cell, 'py-1')} />
                  <TableCell className={cn(t.cell, 'py-1 text-right text-[0.9em] text-neutral-600')}>Total quantity</TableCell>
                  {design.showHsn ? <TableCell className={cn(t.cell, 'py-1')} /> : null}
                  <TableCell className={cn(t.cell, 'py-1 text-right font-medium tabular-nums')}>{`${trimQty(totalQty.toFixed(3))}${unit ? ` ${unit}` : ''}`}</TableCell>
                  {columns - 3 - (design.showHsn ? 1 : 0) + (editable ? 1 : 0) > 0 ? <TableCell colSpan={columns - 3 - (design.showHsn ? 1 : 0) + (editable ? 1 : 0)} className={cn(t.cell, 'py-1')} /> : null}
                </TableRow>
              ) : null}
            </TableBody>
          </Table>

          <div className="grid gap-6 sm:grid-cols-[1fr_auto]">
            <div className="flex flex-col gap-4">
              {showWords ? (
                <div className="flex flex-col gap-0.5">
                  <div className={t.section}>Amount in words</div>
                  <div className="text-[0.95em] font-medium">{moneyToIndianWords(model.totals.grandTotal)}</div>
                  {design.showHsn && taxed ? <div className="text-[0.85em] text-neutral-600">Tax amount in words: {moneyToIndianWords(model.totals.taxTotal)}</div> : null}
                </div>
              ) : null}
              {editable || model.notes.trim() !== '' ? (
                <div className="flex flex-col gap-1">
                  <div className={t.section}>Notes</div>
                  {editable ? <PaperArea label="Notes" value={model.notes} placeholder={vendorFacing ? 'Anything the vendor should read' : 'Anything the customer should read'} onChange={editing.setNotes} /> : <p className="whitespace-pre-line text-[0.95em]">{model.notes}</p>}
                </div>
              ) : null}
              {design.showTerms && (editable || model.terms.trim() !== '') ? (
                <div className="flex flex-col gap-1">
                  <div className={t.section}>Terms</div>
                  {editable ? <PaperArea label="Terms" value={model.terms} placeholder={design.defaultTerms || 'Payment terms, delivery, validity'} onChange={editing.setTerms} /> : <p className="whitespace-pre-line text-[0.9em] text-neutral-700">{model.terms}</p>}
                </div>
              ) : null}
            </div>
            {money ? (
            <div className={cn(t.totalsBox, 'flex flex-col gap-1 text-[0.95em]')}>
              <Row label="Subtotal" value={model.totals.subtotal} />
              {showDiscount && Number(model.totals.discountTotal) > 0 ? <Row label="Discount" value={model.totals.discountTotal} /> : null}
              {showTax ? (
                split.kind === 'intra' ? (
                  <>
                    <Row label="CGST" value={half(model.totals.taxTotal)} />
                    <Row label="SGST" value={half(model.totals.taxTotal)} />
                  </>
                ) : (
                  <Row label={split.kind === 'inter' ? 'IGST' : 'Tax'} value={model.totals.taxTotal} />
                )
              ) : null}
              <div className={cn('flex items-baseline justify-between gap-4', t.grandTotal)}>
                <span>Total</span>
                <span className="tabular-nums">{formatMoney(model.totals.grandTotal)}</span>
              </div>
              <div className="text-right text-[0.8em] text-neutral-500 italic">E. &amp; O.E</div>
              {model.totals.preview && editable ? <div className="print-hidden text-[0.8em] text-neutral-500">Preview — the server prices it on save.</div> : null}
            </div>
            ) : null}
          </div>

          {design.showHsn && summary.length > 0 && taxed ? (
            <Table className="text-[0.9em]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={t.summaryHead}>HSN/SAC</TableHead>
                  <TableHead className={cn(t.summaryHead, 'text-right')}>Taxable value</TableHead>
                  {split.kind === 'intra' ? (
                    <>
                      <TableHead className={cn(t.summaryHead, 'text-right')}>CGST rate</TableHead>
                      <TableHead className={cn(t.summaryHead, 'text-right')}>CGST</TableHead>
                      <TableHead className={cn(t.summaryHead, 'text-right')}>SGST rate</TableHead>
                      <TableHead className={cn(t.summaryHead, 'text-right')}>SGST</TableHead>
                    </>
                  ) : (
                    <>
                      <TableHead className={cn(t.summaryHead, 'text-right')}>{split.kind === 'inter' ? 'IGST rate' : 'Rate'}</TableHead>
                      <TableHead className={cn(t.summaryHead, 'text-right')}>{split.kind === 'inter' ? 'IGST' : 'Tax'}</TableHead>
                    </>
                  )}
                  <TableHead className={cn(t.summaryHead, 'text-right')}>Total tax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.map((row) => (
                  <TableRow key={`${row.hsn}-${String(row.ratePct)}`} className="hover:bg-transparent">
                    <TableCell className={t.summaryCell}>{row.hsn}</TableCell>
                    <TableCell className={cn(t.summaryCell, 'text-right tabular-nums')}>{formatMoney(row.taxable.toFixed(2))}</TableCell>
                    {split.kind === 'intra' ? (
                      <>
                        <TableCell className={cn(t.summaryCell, 'text-right tabular-nums')}>{trimQty((row.ratePct / 2).toFixed(2))}%</TableCell>
                        <TableCell className={cn(t.summaryCell, 'text-right tabular-nums')}>{formatMoney(half(row.tax.toFixed(2)))}</TableCell>
                        <TableCell className={cn(t.summaryCell, 'text-right tabular-nums')}>{trimQty((row.ratePct / 2).toFixed(2))}%</TableCell>
                        <TableCell className={cn(t.summaryCell, 'text-right tabular-nums')}>{formatMoney(half(row.tax.toFixed(2)))}</TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell className={cn(t.summaryCell, 'text-right tabular-nums')}>{trimQty(row.ratePct.toFixed(2))}%</TableCell>
                        <TableCell className={cn(t.summaryCell, 'text-right tabular-nums')}>{formatMoney(row.tax.toFixed(2))}</TableCell>
                      </>
                    )}
                    <TableCell className={cn(t.summaryCell, 'text-right tabular-nums')}>{formatMoney(row.tax.toFixed(2))}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="hover:bg-transparent">
                  <TableCell className={cn(t.summaryCell, 'font-medium')}>Total</TableCell>
                  <TableCell className={cn(t.summaryCell, 'text-right font-medium tabular-nums')}>{formatMoney(taxableTotal.toFixed(2))}</TableCell>
                  {split.kind === 'intra' ? (
                    <>
                      <TableCell className={t.summaryCell} />
                      <TableCell className={cn(t.summaryCell, 'text-right font-medium tabular-nums')}>{formatMoney(half(model.totals.taxTotal))}</TableCell>
                      <TableCell className={t.summaryCell} />
                      <TableCell className={cn(t.summaryCell, 'text-right font-medium tabular-nums')}>{formatMoney(half(model.totals.taxTotal))}</TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className={t.summaryCell} />
                      <TableCell className={cn(t.summaryCell, 'text-right font-medium tabular-nums')}>{formatMoney(model.totals.taxTotal)}</TableCell>
                    </>
                  )}
                  <TableCell className={cn(t.summaryCell, 'text-right font-medium tabular-nums')}>{formatMoney(model.totals.taxTotal)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          ) : null}

          <footer className={cn('mt-auto flex flex-col gap-3', t.footer)}>
            <div className="grid gap-6 sm:grid-cols-[1fr_auto]">
              <div className="flex flex-col gap-3">
                {showBank && profile.bankAccount.trim() !== '' ? (
                  <div className="flex flex-col gap-0.5">
                    <div className={t.section}>Bank</div>
                    <div className="text-[1.05em] text-neutral-800">{[profile.bankName, profile.bankBranch].filter((p) => p.trim() !== '').join(', ')}</div>
                    <div className="text-[1.05em] text-neutral-800 tabular-nums">A/c {profile.bankAccount}{profile.bankIfsc ? ` · IFSC ${profile.bankIfsc}` : ''}</div>
                  </div>
                ) : null}
                {design.showDeclaration && profile.declaration.trim() !== '' ? (
                  <div className="flex flex-col gap-0.5">
                    <div className={t.section}>Declaration</div>
                    <div className="text-neutral-600">{profile.declaration}</div>
                  </div>
                ) : null}
              </div>
              {design.showSignature ? (
                <div className="flex items-end justify-end">
                  <div className="flex flex-col items-end gap-8 text-right text-neutral-800">
                    <div>For {businessName}</div>
                    <div className="border-t border-neutral-400 pt-1">{profile.signatoryName.trim() === '' ? 'Authorised signatory' : profile.signatoryName}</div>
                  </div>
                </div>
              ) : null}
            </div>
            <PaperFoot design={design} profile={profile} footerLogoUrls={footerLogoUrls} />
          </footer>
        </div>
      </div>
    </div>
  );
}

function DetailPair({ label, value, editable, labelClass, onChange }: { label: string; value: string; editable: boolean; labelClass: string; onChange: (value: string) => void }) {
  return (
    <>
      <span className={labelClass}>{label}</span>
      {editable ? <PaperField label={label} value={value} onChange={onChange} className="min-h-[1.3em]" /> : <span>{value}</span>}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-neutral-600">{label}</span>
      <span className="tabular-nums">{formatMoney(value)}</span>
    </div>
  );
}
