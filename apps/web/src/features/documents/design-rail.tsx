import { useRef } from 'react';
import { CheckIcon, PlusIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { toast } from '@/components/ui/toast';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';

import { SLIP_PAPER_TYPES } from './paper-support';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { HANDLING_MARK_ICONS } from '@/components/shared/entity-icons';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { useFooterLogoUrls, useUploadFooterLogo } from './use-document-settings';
import { cn } from '@/lib/utils';
import {
  DOCUMENT_ACCENTS,
  DOCUMENT_ACCENT_LABELS,
  DOCUMENT_FONTS,
  DOCUMENT_FONT_LABELS,
  DOCUMENT_PAPERS,
  DOCUMENT_TEMPLATE_IDS,
  DOCUMENT_TEMPLATE_LABELS,
  HANDLING_MARKS,
  HANDLING_MARK_LABELS,
  SLIP_TEMPLATE_IDS,
  SLIP_TEMPLATE_LABELS,
  type DocumentAccent,
  type DocumentDesign,
  type DocumentFont,
  type DocumentPaper,
  type DocumentProfile,
  type DocumentSettings,
  type DocumentTemplateId,
  type PrintedDocumentType,
  type SlipTemplateId,
} from '@vyuha/shared';

/**
 * The design rail beside the paper: the five templates, the accent, what
 * the page shows, and what the business calls itself. Every change is live
 * on the paper at once — the rail edits a working copy the page holds — and
 * Save writes it for the organisation. Someone without settings.manage can
 * still try a look on their own screen; only saving is theirs to ask for.
 */

/** The stock, drawn as the stock. A named colour would not tell anyone what
 *  the sheet will look like. */
const PAPER_SWATCH: Record<DocumentPaper, string> = {
  sand: 'bg-[#e8d3be]',
  ivory: 'bg-[#faf6ee]',
  white: 'bg-white',
};
const PAPER_LABELS: Record<DocumentPaper, string> = {
  sand: 'Sand',
  ivory: 'Ivory',
  white: 'White',
};

const ACCENT_SWATCH: Record<DocumentAccent, string> = {
  ink: 'bg-neutral-900',
  blue: 'bg-blue-700',
  teal: 'bg-teal-700',
  green: 'bg-green-700',
  amber: 'bg-amber-700',
  rose: 'bg-rose-700',
  violet: 'bg-violet-700',
  slate: 'bg-slate-700',
};

interface DesignRailProps {
  docType: PrintedDocumentType;
  settings: DocumentSettings;
  onChange: (next: DocumentSettings) => void;
  canSave: boolean;
  dirty: boolean;
  saving: boolean;
  saveError: Error | null;
  onSave: () => void;
  onDiscard: () => void;
}

/**
 * The slip and the delivery note are drawn by `PackingSlipPaper`, which reads
 * only the paper size, the logo placement, the handling marks, the footer note
 * and its own template -- black on white, because it goes on a carton or
 * through a thermal printer. Offering a paper colour or an accent for them is
 * offering a control that does nothing.
 */
export function DesignRail({ docType, settings, onChange, canSave, dirty, saving, saveError, onSave, onDiscard }: DesignRailProps) {
  const onSlipStock = SLIP_PAPER_TYPES.includes(docType);
  const design = settings.designs[docType];
  const profile = settings.profile;
  // The goods papers (slip, delivery note) wear their own layouts and ignore the money templates.
  const isSlip = docType === 'PACKING_SLIP' || docType === 'DELIVERY_NOTE';
  const setDesign = (patch: Partial<DocumentDesign>) => {
    onChange({ ...settings, designs: { ...settings.designs, [docType]: { ...design, ...patch } } });
  };
  const setProfile = (patch: Partial<DocumentProfile>) => {
    onChange({ ...settings, profile: { ...profile, ...patch } });
  };
  const copy = actionErrorCopy(saveError, 'Saving the design');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs defaultValue="design" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-4 mt-3 grid w-auto grid-cols-2">
          <TabsTrigger value="design">Design</TabsTrigger>
          <TabsTrigger value="business">Business</TabsTrigger>
        </TabsList>

        <TabsContent value="design" className="min-h-0 flex-1 overflow-y-auto p-4">
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel>Template</FieldLabel>
              {isSlip ? (
                <ToggleGroup
                  variant="outline"
                  aria-label="Slip template"
                  value={[design.slipTemplate]}
                  onValueChange={(value: string[]) => {
                    const next = value[0];
                    if (next !== undefined && (SLIP_TEMPLATE_IDS as readonly string[]).includes(next)) setDesign({ slipTemplate: next as SlipTemplateId });
                  }}
                  className="grid grid-cols-1 gap-2"
                >
                  {SLIP_TEMPLATE_IDS.map((id) => (
                    <ToggleGroupItem key={id} value={id} aria-label={SLIP_TEMPLATE_LABELS[id].label} className="h-auto justify-start gap-3 px-3 py-2 text-left data-pressed:border-primary">
                      <SlipThumb id={id} />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium">{SLIP_TEMPLATE_LABELS[id].label}</span>
                        <span className="text-muted-foreground line-clamp-2 text-xs font-normal whitespace-normal">{SLIP_TEMPLATE_LABELS[id].note}</span>
                      </span>
                      {design.slipTemplate === id ? <CheckIcon className="ml-auto shrink-0" /> : null}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              ) : (
                <ToggleGroup
                  variant="outline"
                  aria-label="Template"
                  value={[design.templateId]}
                  onValueChange={(value: string[]) => {
                    const next = value[0];
                    if (next !== undefined && (DOCUMENT_TEMPLATE_IDS as readonly string[]).includes(next)) setDesign({ templateId: next as DocumentTemplateId });
                  }}
                  className="grid grid-cols-1 gap-2"
                >
                  {DOCUMENT_TEMPLATE_IDS.map((id) => (
                    <ToggleGroupItem key={id} value={id} aria-label={DOCUMENT_TEMPLATE_LABELS[id].label} className="h-auto justify-start gap-3 px-3 py-2 text-left data-pressed:border-primary">
                      <TemplateThumb id={id} />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium">{DOCUMENT_TEMPLATE_LABELS[id].label}</span>
                        <span className="text-muted-foreground line-clamp-2 text-xs font-normal whitespace-normal">{DOCUMENT_TEMPLATE_LABELS[id].note}</span>
                      </span>
                      {design.templateId === id ? <CheckIcon className="ml-auto shrink-0" /> : null}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </Field>

            {/* The rest folds into sections so the rail is not one long scroll;
                the template is the one choice that stays open above them. */}
            <Accordion openMultiple defaultValue={['look']} className="border-t">
              <AccordionItem value="look">
                <AccordionTrigger>Layout and type</AccordionTrigger>
                <AccordionContent>
                  <FieldGroup className="gap-5">
            {onSlipStock ? null : (
            <Field>
              <FieldLabel>Paper</FieldLabel>
              <ToggleGroup
                variant="outline"
                aria-label="Paper colour"
                value={[design.paper]}
                onValueChange={(value: string[]) => {
                  const next = value[0];
                  if (next !== undefined && (DOCUMENT_PAPERS as readonly string[]).includes(next)) setDesign({ paper: next as DocumentPaper });
                }}
                className="flex-wrap gap-2"
              >
                {DOCUMENT_PAPERS.map((paper) => (
                  <ToggleGroupItem key={paper} value={paper} aria-label={PAPER_LABELS[paper]} className="size-9 p-0 data-pressed:ring-2 data-pressed:ring-ring">
                    <span className={cn('size-5 rounded-full border border-black/10', PAPER_SWATCH[paper])} />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
            )}

            {onSlipStock ? null : (
            <Field>
              <FieldLabel>Accent</FieldLabel>
              <ToggleGroup
                variant="outline"
                aria-label="Accent colour"
                value={[design.accent]}
                onValueChange={(value: string[]) => {
                  const next = value[0];
                  if (next !== undefined && (DOCUMENT_ACCENTS as readonly string[]).includes(next)) setDesign({ accent: next as DocumentAccent });
                }}
                className="flex-wrap gap-2"
              >
                {DOCUMENT_ACCENTS.map((accent) => (
                  <ToggleGroupItem key={accent} value={accent} aria-label={DOCUMENT_ACCENT_LABELS[accent]} className="size-9 p-0 data-pressed:ring-2 data-pressed:ring-ring">
                    <span className={cn('size-5 rounded-full', ACCENT_SWATCH[accent])} />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
            )}

            {onSlipStock ? (
              <Field>
                <FieldLabel>Handling marks</FieldLabel>
                {/* D-47 (owner): the marks the slip prints, switched on here; each wears the glyph the paper prints. */}
                <ToggleGroup
                  variant="outline"
                  aria-label="Handling marks"
                  multiple
                  className="flex-wrap"
                  value={[...design.handlingMarks]}
                  onValueChange={(value: string[]) => {
                    setDesign({ handlingMarks: HANDLING_MARKS.filter((mark) => value.includes(mark)) });
                  }}
                >
                  {HANDLING_MARKS.map((mark) => {
                    const Glyph = HANDLING_MARK_ICONS[mark];
                    return (
                      <ToggleGroupItem key={mark} value={mark} aria-label={HANDLING_MARK_LABELS[mark]} className="gap-1.5 data-pressed:border-primary">
                        <Glyph />
                        {HANDLING_MARK_LABELS[mark]}
                      </ToggleGroupItem>
                    );
                  })}
                </ToggleGroup>
              </Field>
            ) : null}
            {docType === 'PACKING_SLIP' || docType === 'DELIVERY_NOTE' ? (
              <Field>
                <FieldLabel htmlFor="design-paper-size">Paper size</FieldLabel>
                {/* D-47: the slip alone has a size; the other papers are A4. */}
                <Select value={design.paperSize} onValueChange={(value: string | null) => { if (value === 'A4' || value === 'A5') setDesign({ paperSize: value }); }}>
                  <SelectTrigger id="design-paper-size" className="w-full" aria-label="Paper size">
                    <SelectValue>{(value: string) => (value === 'A5' ? 'A5 — sticker, one per carton' : 'A4 — sheet, for pallets')}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A5">A5 — sticker, one per carton</SelectItem>
                    <SelectItem value="A4">A4 — sheet, for pallets</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="design-logo">Logo</FieldLabel>
                <Select value={design.logoPlacement} onValueChange={(value: string | null) => { if (value === 'left' || value === 'right' || value === 'none') setDesign({ logoPlacement: value }); }}>
                  <SelectTrigger id="design-logo" className="w-full" aria-label="Logo placement">
                    <SelectValue>{(value: string) => (value === 'left' ? 'Left' : value === 'right' ? 'Right' : 'Hidden')}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="left">Left</SelectItem>
                    <SelectItem value="right">Right</SelectItem>
                    <SelectItem value="none">Hidden</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Text size</FieldLabel>
                <ToggleGroup
                  variant="outline"
                  aria-label="Text size"
                  value={[design.fontScale]}
                  onValueChange={(value: string[]) => {
                    const next = value[0];
                    if (next === 'sm' || next === 'md' || next === 'lg') setDesign({ fontScale: next });
                  }}
                >
                  <ToggleGroupItem value="sm" aria-label="Small" className="flex-1">S</ToggleGroupItem>
                  <ToggleGroupItem value="md" aria-label="Medium" className="flex-1">M</ToggleGroupItem>
                  <ToggleGroupItem value="lg" aria-label="Large" className="flex-1">L</ToggleGroupItem>
                </ToggleGroup>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="design-font">Typeface</FieldLabel>
              <Select value={design.fontFamily} onValueChange={(value: string | null) => { if (value !== null && (DOCUMENT_FONTS as readonly string[]).includes(value)) setDesign({ fontFamily: value as DocumentFont }); }}>
                <SelectTrigger id="design-font" className="w-full" aria-label="Typeface">
                  <SelectValue>{(value: string) => DOCUMENT_FONT_LABELS[value as DocumentFont].label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {DOCUMENT_FONTS.map((font) => (
                    <SelectItem key={font} value={font}>
                      <span className="flex flex-col">
                        <span>{DOCUMENT_FONT_LABELS[font].label}</span>
                        <span className="text-muted-foreground text-xs">{DOCUMENT_FONT_LABELS[font].note}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>System typefaces, so the page prints the same on every machine. Figures are always monospaced so columns line up.</FieldDescription>
            </Field>
                  </FieldGroup>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="page">
                <AccordionTrigger>What shows on the page</AccordionTrigger>
                <AccordionContent>
            <Field>
              <div className="flex flex-col divide-y border">
                <ToggleRow id="design-amounts" label="Rates, amounts and totals (off: quantities only, as on a delivery note)" checked={design.showAmounts} onChange={(v) => { setDesign({ showAmounts: v }); }} />
                <ToggleRow id="design-hsn" label="HSN/SAC column and tax summary" checked={design.showHsn} onChange={(v) => { setDesign({ showHsn: v }); }} />
                <ToggleRow id="design-unit" label="Unit (per) column" checked={design.showUnit} onChange={(v) => { setDesign({ showUnit: v }); }} />
                <ToggleRow id="design-discount" label="Discount column" checked={design.showDiscount} onChange={(v) => { setDesign({ showDiscount: v }); }} />
                <ToggleRow id="design-tax" label="Tax rows (CGST/SGST or IGST)" checked={design.showTax} onChange={(v) => { setDesign({ showTax: v }); }} />
                <ToggleRow id="design-details" label="Details grid (delivery note, terms of payment, references, dispatch)" checked={design.showDetailsGrid} onChange={(v) => { setDesign({ showDetailsGrid: v }); }} />
                <ToggleRow id="design-shipto" label="Consignee (Ship to)" checked={design.showShipTo} onChange={(v) => { setDesign({ showShipTo: v }); }} />
                <ToggleRow id="design-words" label="Amount in words" checked={design.showAmountInWords} onChange={(v) => { setDesign({ showAmountInWords: v }); }} />
                <ToggleRow id="design-terms" label="Terms block" checked={design.showTerms} onChange={(v) => { setDesign({ showTerms: v }); }} />
                <ToggleRow id="design-bank" label="Bank details" checked={design.showBank} onChange={(v) => { setDesign({ showBank: v }); }} />
                <ToggleRow id="design-declaration" label="Declaration" checked={design.showDeclaration} onChange={(v) => { setDesign({ showDeclaration: v }); }} />
                <ToggleRow id="design-signature" label="Authorised signatory" checked={design.showSignature} onChange={(v) => { setDesign({ showSignature: v }); }} />
                <ToggleRow id="design-einvoice" label="e-Invoice (IRN, Ack No., Ack Date)" checked={design.showEInvoice} onChange={(v) => { setDesign({ showEInvoice: v }); }} />
              </div>
            </Field>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="footer">
                <AccordionTrigger>Footer and terms</AccordionTrigger>
                <AccordionContent>
                  <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="design-footer">Footer line</FieldLabel>
              <Input id="design-footer" value={design.footerNote} placeholder="Thank you for your business" onChange={(e) => { setDesign({ footerNote: e.target.value }); }} />
            </Field>
            <Field>
              <FieldLabel htmlFor="design-terms-default">Default terms</FieldLabel>
              <Textarea id="design-terms-default" rows={3} value={design.defaultTerms} placeholder="Prefills a new document; each may still say its own." onChange={(e) => { setDesign({ defaultTerms: e.target.value }); }} />
            </Field>
                  </FieldGroup>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </FieldGroup>
        </TabsContent>

        <TabsContent value="business" className="min-h-0 flex-1 overflow-y-auto p-4">
          <FieldGroup className="gap-4">
            <FieldDescription>What every printed page says about the business. Shared by estimates, orders, invoices and purchase orders.</FieldDescription>
            <TextRow id="biz-name" label="Legal name" value={profile.legalName} onChange={(v) => { setProfile({ legalName: v }); }} placeholder="As registered" />
            <Field>
              <FieldLabel htmlFor="biz-address">Address</FieldLabel>
              <Textarea id="biz-address" rows={3} value={profile.addressLines} placeholder={'One line per row\nCity, State PIN'} onChange={(e) => { setProfile({ addressLines: e.target.value }); }} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <TextRow id="biz-gstin" label="GSTIN" value={profile.gstin} onChange={(v) => { setProfile({ gstin: v.toUpperCase() }); }} />
              <TextRow id="biz-pan" label="PAN" value={profile.pan} onChange={(v) => { setProfile({ pan: v.toUpperCase() }); }} />
            </div>
            <div className="grid grid-cols-[1fr_5rem] gap-3">
              <TextRow id="biz-state" label="State" value={profile.stateName} onChange={(v) => { setProfile({ stateName: v }); }} placeholder="Karnataka" />
              <TextRow id="biz-state-code" label="Code" value={profile.stateCode} onChange={(v) => { setProfile({ stateCode: v.replace(/\D/gu, '').slice(0, 2) }); }} placeholder="29" />
            </div>
            <FieldDescription>The state code against the buyer's decides CGST + SGST (same state) or IGST.</FieldDescription>
            <div className="grid grid-cols-2 gap-3">
              <TextRow id="biz-phone" label="Phone" value={profile.phone} onChange={(v) => { setProfile({ phone: v }); }} />
              <TextRow id="biz-email" label="Email" value={profile.email} onChange={(v) => { setProfile({ email: v }); }} />
            </div>
            <TextRow id="biz-website" label="Website" value={profile.website} onChange={(v) => { setProfile({ website: v }); }} />
            <FieldDescription>Bank details print when the design's Bank block is on.</FieldDescription>
            <div className="grid grid-cols-2 gap-3">
              <TextRow id="biz-bank" label="Bank" value={profile.bankName} onChange={(v) => { setProfile({ bankName: v }); }} />
              <TextRow id="biz-branch" label="Branch" value={profile.bankBranch} onChange={(v) => { setProfile({ bankBranch: v }); }} />
              <TextRow id="biz-account" label="Account number" value={profile.bankAccount} onChange={(v) => { setProfile({ bankAccount: v }); }} />
              <TextRow id="biz-ifsc" label="IFSC" value={profile.bankIfsc} onChange={(v) => { setProfile({ bankIfsc: v.toUpperCase() }); }} />
            </div>
            <TextRow id="biz-signatory" label="Signatory" value={profile.signatoryName} onChange={(v) => { setProfile({ signatoryName: v }); }} placeholder="Authorised signatory" />
            <Field>
              <FieldLabel htmlFor="biz-declaration">Declaration</FieldLabel>
              <Textarea id="biz-declaration" rows={3} value={profile.declaration} onChange={(e) => { setProfile({ declaration: e.target.value }); }} />
            </Field>
            <TextRow id="biz-footer-caption" label="Foot of the page" value={profile.footerCaption} onChange={(v) => { setProfile({ footerCaption: v }); }} placeholder="Authorised channel partners of" />
            <FooterLogos fileIds={profile.footerLogoFileIds} canEdit={canSave} onChange={(ids) => { setProfile({ footerLogoFileIds: ids }); }} />
          </FieldGroup>
        </TabsContent>
      </Tabs>

      <div className="flex shrink-0 flex-col gap-2 border-t p-3">
        {saveError ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>{copy.title}</AlertTitle>
            <AlertDescription>{copy.description}</AlertDescription>
          </Alert>
        ) : null}
        {!canSave ? <p className="text-muted-foreground text-xs">You can try a look here; saving it for the organisation needs settings.manage.</p> : null}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" disabled={!dirty || saving} onClick={onDiscard}>
            Discard
          </Button>
          <Button size="sm" className="flex-1" disabled={!dirty || saving || !canSave} onClick={onSave}>
            {saving ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
            {saving ? 'Saving' : 'Save design'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <Field orientation="horizontal" className="pointer-coarse:min-h-11 items-center justify-between px-3 py-2">
      <FieldLabel htmlFor={id} className="text-sm font-normal">{label}</FieldLabel>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Field>
  );
}

function TextRow({ id, label, value, onChange, placeholder }: { id: string; label: string; value: string; onChange: (next: string) => void; placeholder?: string }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} value={value} placeholder={placeholder} onChange={(e) => { onChange(e.target.value); }} />
    </Field>
  );
}

/** A schematic of each template, so the rail's choices read at a glance. */
function TemplateThumb({ id }: { id: DocumentTemplateId }) {
  return (
    <span aria-hidden className="flex h-14 w-11 shrink-0 flex-col gap-0.5 border bg-white p-1">
      {id === 'bordered' ? (
        <>
          <span className="flex flex-1 flex-col gap-0.5 border border-neutral-700 p-0.5">
            <span className="flex justify-between"><span className="h-1 w-3 bg-neutral-800" /><span className="h-1 w-2 bg-neutral-300" /></span>
            <span className="h-px w-full bg-neutral-700" />
            <span className="h-px w-full bg-neutral-300" />
            <span className="h-px w-full bg-neutral-300" />
            <span className="mt-auto ml-auto h-2 w-4 border border-neutral-700" />
          </span>
        </>
      ) : null}
      {id === 'formal' ? (
        <>
          <span className="h-1 w-4 bg-neutral-800" />
          <span className="mt-0.5 h-0.5 w-full bg-neutral-800" />
          <span className="mt-1 h-px w-full bg-neutral-200" />
          <span className="h-px w-full bg-neutral-200" />
          <span className="mt-auto ml-auto h-1 w-4 border-t border-neutral-800" />
        </>
      ) : null}
      {id === 'compact' ? (
        <>
          <span className="flex justify-between"><span className="h-1 w-2 bg-neutral-700" /><span className="h-1 w-1.5 bg-neutral-300" /></span>
          <span className="mt-0.5 h-px w-full bg-neutral-400" />
          <span className="mt-0.5 h-px w-full bg-neutral-200" />
          <span className="h-px w-full bg-neutral-200" />
          <span className="h-px w-full bg-neutral-200" />
          <span className="h-px w-full bg-neutral-200" />
          <span className="mt-auto ml-auto h-px w-4 bg-neutral-800" />
        </>
      ) : null}
      {id === 'executive' ? (
        <>
          <span className="flex items-center justify-between border-b-2 border-neutral-800 pb-0.5"><span className="h-1.5 w-4 bg-neutral-800" /><span className="h-1 w-2 bg-neutral-200" /></span>
          <span className="mt-1 h-1.5 w-full bg-neutral-800" />
          <span className="mt-0.5 h-px w-full bg-neutral-200" />
          <span className="h-px w-full bg-neutral-200" />
          <span className="mt-auto ml-auto h-1.5 w-5 bg-neutral-200" />
        </>
      ) : null}
      {id === 'minimal' ? (
        <>
          <span className="h-1 w-3 bg-neutral-400" />
          <span className="mt-2 h-px w-full bg-neutral-300" />
          <span className="mt-1 h-px w-full bg-neutral-200" />
          <span className="h-px w-full bg-neutral-200" />
          <span className="mt-auto ml-auto h-px w-4 bg-neutral-800" />
        </>
      ) : null}
      {id === 'ledger' ? (
        <>
          <span className="h-1 w-4 bg-neutral-800" />
          <span className="mt-0.5 h-0.5 w-full border-y border-neutral-800" />
          <span className="grid flex-1 grid-cols-4 gap-px bg-neutral-400 p-px">
            <span className="bg-white" /><span className="bg-white" /><span className="bg-white" /><span className="bg-white" />
            <span className="bg-white" /><span className="bg-white" /><span className="bg-white" /><span className="bg-white" />
          </span>
          <span className="mt-0.5 ml-auto h-1 w-4 border-y-2 border-double border-neutral-800" />
        </>
      ) : null}
      {id === 'tally' ? (
        <>
          <span className="grid grid-cols-2 gap-px border border-neutral-700 p-px"><span className="h-1 bg-neutral-300" /><span className="h-1 bg-neutral-300" /></span>
          <span className="grid flex-1 grid-cols-3 gap-px border border-neutral-700 p-px">
            <span className="bg-neutral-100" /><span className="bg-neutral-100" /><span className="bg-neutral-100" />
            <span className="bg-white" /><span className="bg-white" /><span className="bg-white" />
          </span>
        </>
      ) : null}
    </span>
  );
}

/** A schematic of each slip layout, the same size as the document thumbs. */
function SlipThumb({ id }: { id: SlipTemplateId }) {
  return (
    <span aria-hidden className="flex h-14 w-11 shrink-0 flex-col gap-0.5 border bg-white p-1">
      {id === 'barcode' ? (
        <>
          <span className="flex justify-between"><span className="h-1 w-3 bg-neutral-600" /><span className="h-1.5 w-2 bg-neutral-800" /></span>
          <span className="mt-0.5 flex items-start justify-between"><span className="h-1 w-3 bg-neutral-300" /><span className="h-3 w-3 border border-neutral-700" /></span>
          <span className="mt-auto h-2 w-full bg-neutral-800" />
        </>
      ) : null}
      {id === 'label' ? (
        <>
          <span className="h-2.5 w-7 bg-neutral-800" />
          <span className="mt-0.5 ml-auto h-3 w-3 border-2 border-neutral-800" />
          <span className="mt-auto h-3 w-full bg-neutral-800" />
        </>
      ) : null}
      {id === 'list' ? (
        <>
          <span className="h-1 w-4 bg-neutral-700" />
          <span className="mt-0.5 h-px w-full bg-neutral-400" />
          <span className="h-px w-full bg-neutral-200" />
          <span className="h-px w-full bg-neutral-200" />
          <span className="h-px w-full bg-neutral-200" />
          <span className="mt-auto h-1 w-full bg-neutral-700" />
        </>
      ) : null}
    </span>
  );
}

/**
 * The channel-partner and brand logos along the foot of every page: uploaded
 * once, kept as file ids in the profile, shown here as thumbnails. The file
 * input is the sanctioned sr-only one (see org-logo-dialog), driven by a
 * shadcn button.
 */
function FooterLogos({ fileIds, canEdit, onChange }: { fileIds: readonly string[]; canEdit: boolean; onChange: (ids: string[]) => void }) {
  const urls = useFooterLogoUrls(fileIds);
  const upload = useUploadFooterLogo();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Field>
      <FieldLabel>Footer logos</FieldLabel>
      <FieldDescription>Brand and channel-partner marks along the foot of every printed page. Up to eight; PNG or JPEG.</FieldDescription>
      <div className="flex flex-wrap items-center gap-2">
        {fileIds.map((fileId, index) => (
          <span key={fileId} className="relative size-16 shrink-0 border bg-white p-1">
            {urls[index] !== undefined ? <img src={urls[index]} alt="" className="size-full object-contain" /> : null}
            {canEdit ? (
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                aria-label={`Remove footer logo ${String(index + 1)}`}
                className="bg-background absolute -top-2 -right-2"
                onClick={() => {
                  onChange(fileIds.filter((id) => id !== fileId));
                }}
              >
                <XIcon />
              </Button>
            ) : null}
          </span>
        ))}
        {canEdit && fileIds.length < 8 ? (
          <Button type="button" variant="outline" size="sm" className="h-16" disabled={upload.isPending} onClick={() => inputRef.current?.click()}>
            {upload.isPending ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
            Add logo
          </Button>
        ) : null}
        {/* eslint-disable-next-line no-restricted-syntax */}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = '';
            if (file === undefined) return;
            upload.mutate(file, {
              onSuccess: (result) => {
                onChange([...fileIds, result.fileId]);
              },
              onError: (error) => {
                toast.add({ type: 'error', title: 'That logo could not be uploaded', description: error.message });
              },
            });
          }}
        />
      </div>
    </Field>
  );
}
