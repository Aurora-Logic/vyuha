import { z } from 'zod';

/**
 * Printed documents (estimate, sales order, invoice, purchase order): the
 * paper is the editor. One org-wide identity (what the paper says about the
 * business) and one design per document type — a template, an accent, and
 * which blocks and columns appear — so the four documents are one renderer
 * worn four ways. Stored as a setting; nothing here is a table.
 */

export const DOCUMENT_TEMPLATE_IDS = ['tally', 'minimal', 'bordered', 'ledger', 'formal', 'compact', 'executive'] as const;
export type DocumentTemplateId = (typeof DOCUMENT_TEMPLATE_IDS)[number];
export const DOCUMENT_TEMPLATE_LABELS: Record<DocumentTemplateId, { label: string; note: string }> = {
  tally: { label: 'Tally', note: 'The GST tax invoice everyone knows: boxed seller, consignee and buyer, the details grid, HSN summary, amount in words.' },
  minimal: { label: 'Minimal', note: 'Type and hairlines only; the logo carries the identity.' },
  bordered: { label: 'Bordered', note: 'The minimal page inside a ruled frame, every block boxed by a hairline.' },
  ledger: { label: 'Ledger', note: 'Ruled rows and columns, a double rule under the total: the account book.' },
  formal: { label: 'Formal', note: 'A ruled masthead over roomy rows, uppercase section labels: the company letter.' },
  compact: { label: 'Compact', note: 'Small type and tight rows on hairlines; fits the longest list on one page.' },
  executive: { label: 'Executive', note: 'A bold masthead, heavy ruled column heads and boxed totals: the corporate look.' },
};
/**
 * Templates that were offered once and are no longer; a saved design that
 * names one wears its nearest successor. Modern (an accent band) and the older
 * bold both fall back to Tally, the invoice everyone in the office reads.
 */
const RETIRED_TEMPLATES: Record<string, DocumentTemplateId> = { classic: 'bordered', bold: 'tally', modern: 'tally' };

/** System font stacks, so every machine and every printer renders the same page without fetching anything. */
export const DOCUMENT_FONTS = ['sans', 'serif', 'humanist', 'mono'] as const;
export type DocumentFont = (typeof DOCUMENT_FONTS)[number];
export const DOCUMENT_FONT_LABELS: Record<DocumentFont, { label: string; note: string }> = {
  sans: { label: 'Sans', note: 'The system sans-serif; clean on screen and on paper.' },
  serif: { label: 'Serif', note: 'Georgia or Times; the letterhead look.' },
  humanist: { label: 'Humanist', note: 'Trebuchet or Verdana; open and friendly.' },
  mono: { label: 'Typewriter', note: 'Monospaced throughout; the dot-matrix voucher.' },
};

export const PRINTED_DOCUMENT_TYPES = ['ESTIMATE', 'SALES_ORDER', 'INVOICE', 'DELIVERY_NOTE', 'PACKING_SLIP', 'PURCHASE_ORDER', 'RECEIPT_NOTE'] as const;
export type PrintedDocumentType = (typeof PRINTED_DOCUMENT_TYPES)[number];
export const PRINTED_DOCUMENT_TITLES: Record<PrintedDocumentType, string> = {
  ESTIMATE: 'Estimate',
  SALES_ORDER: 'Sales Order',
  INVOICE: 'Tax Invoice',
  DELIVERY_NOTE: 'Delivery Note',
  PACKING_SLIP: 'Packing Slip',
  PURCHASE_ORDER: 'Purchase Order',
  RECEIPT_NOTE: 'Goods Receipt Note',
};
/** The papers on which the other party is the vendor rather than the buyer. */
export const VENDOR_FACING_TYPES: readonly PrintedDocumentType[] = ['PURCHASE_ORDER', 'RECEIPT_NOTE'];
/** The papers that carry goods, not money: quantities print, rates and amounts do not unless the design says so. */
export const GOODS_ONLY_TYPES: readonly PrintedDocumentType[] = ['DELIVERY_NOTE', 'PACKING_SLIP', 'RECEIPT_NOTE'];
/** What the second date box on each paper is called, where it has one. */
export const SECOND_DATE_LABELS: Partial<Record<PrintedDocumentType, string>> = {
  ESTIMATE: 'Valid until',
  PURCHASE_ORDER: 'Expected by',
  DELIVERY_NOTE: 'Expected delivery',
};

/** A palette rather than a colour picker: every accent is a class the paper already knows, on screen and in print. */
export const DOCUMENT_ACCENTS = ['ink', 'blue', 'teal', 'green', 'amber', 'rose', 'violet', 'slate'] as const;
export type DocumentAccent = (typeof DOCUMENT_ACCENTS)[number];

/**
 * The stock the document is printed on.
 *
 * `sand` is the owner's colour, #E8D3BE, and the default: a warm sheet reads
 * as a document rather than a screenshot, and it is what the business wants
 * its paper to look like. White stays available -- it is what a laser printer
 * on plain stock actually produces, so anyone printing rather than sending a
 * PDF will want it.
 */
export const DOCUMENT_PAPERS = ['sand', 'ivory', 'white'] as const;
export type DocumentPaper = (typeof DOCUMENT_PAPERS)[number];
export const DOCUMENT_ACCENT_LABELS: Record<DocumentAccent, string> = {
  ink: 'Ink',
  blue: 'Blue',
  teal: 'Teal',
  green: 'Green',
  amber: 'Amber',
  rose: 'Rose',
  violet: 'Violet',
  slate: 'Slate',
};

const shortText = (max: number) => z.string().trim().max(max);

/** What the business says about itself on every printed page. */
export const documentProfileSchema = z.object({
  legalName: shortText(200),
  addressLines: shortText(600),
  gstin: shortText(20),
  pan: shortText(12),
  /** The seller's state, as GST prints it ("Karnataka, Code : 29"); the code decides CGST+SGST against IGST. */
  stateName: shortText(60),
  stateCode: shortText(2),
  /** The declaration under the tax table; Tally's standard wording by default. */
  declaration: shortText(600),
  /** Channel-partner and brand logos along the foot of the page: file ids in the files service (uploaded once, in Settings). */
  footerLogoFileIds: z.array(z.string()).max(8),
  phone: shortText(40),
  email: shortText(254),
  website: shortText(200),
  bankName: shortText(120),
  bankAccount: shortText(40),
  bankIfsc: shortText(20),
  bankBranch: shortText(120),
  signatoryName: shortText(120),
  /** The line above the footer logos — "Authorised channel partners of" — or anything the foot of the page should say. */
  footerCaption: shortText(200).default(''),
});
export type DocumentProfile = z.infer<typeof documentProfileSchema>;

/** The marks a carton can carry (D-47). The icon for each lives in the web's glyph table; the paper prints icon and label. */
export const HANDLING_MARKS = ['fragile', 'this_side_up', 'keep_dry', 'do_not_stack', 'heavy', 'open_with_care'] as const;
export type HandlingMark = (typeof HANDLING_MARKS)[number];
export const HANDLING_MARK_LABELS: Record<HandlingMark, string> = {
  fragile: 'Fragile',
  this_side_up: 'This side up',
  keep_dry: 'Keep dry',
  do_not_stack: 'Do not stack',
  heavy: 'Heavy',
  open_with_care: 'Open with care',
};

/**
 * D-47: the packing slip and delivery note have their own paper (not the money
 * templates), and three layouts of it. Barcode is the balanced carton slip;
 * Shipping label enlarges the ship-to, the box number and the scan code for a
 * warehouse; Packing list is the ruled item sheet that travels inside the box.
 */
export const SLIP_TEMPLATE_IDS = ['barcode', 'label', 'list'] as const;
export type SlipTemplateId = (typeof SLIP_TEMPLATE_IDS)[number];
export const SLIP_TEMPLATE_LABELS: Record<SlipTemplateId, { label: string; note: string }> = {
  barcode: { label: 'Barcode', note: 'The balanced carton slip: ship-to, box number, items and a scan code.' },
  label: { label: 'Shipping label', note: 'Big ship-to and box number over a large scan code — read across a warehouse.' },
  list: { label: 'Packing list', note: 'A ruled item list under a letterhead — the sheet that goes inside the box.' },
};

export const documentDesignSchema = z.object({
  templateId: z.preprocess((value) => (typeof value === 'string' && value in RETIRED_TEMPLATES ? RETIRED_TEMPLATES[value] : value), z.enum(DOCUMENT_TEMPLATE_IDS)),
  accent: z.enum(DOCUMENT_ACCENTS),
  /** Defaulted, so a design saved before this existed still parses. */
  paper: z.enum(DOCUMENT_PAPERS).default('sand'),
  fontFamily: z.enum(DOCUMENT_FONTS).default('sans'),
  fontScale: z.enum(['sm', 'md', 'lg']),
  logoPlacement: z.enum(['left', 'right', 'none']),
  /** Rates, amounts, totals, the amount in words and the tax summary — off on a delivery note, a packing slip, a receipt. */
  showAmounts: z.boolean().default(true),
  showDiscount: z.boolean(),
  showTax: z.boolean(),
  showUnit: z.boolean(),
  showTerms: z.boolean(),
  showBank: z.boolean(),
  showSignature: z.boolean(),
  /** GST's HSN/SAC column and the per-code tax summary under the table. */
  showHsn: z.boolean(),
  /** The Tally header grid (delivery note, terms of payment, references, dispatch). */
  showDetailsGrid: z.boolean(),
  /** Consignee (Ship to) beside the buyer. */
  showShipTo: z.boolean(),
  /** "Amount chargeable (in words)". */
  showAmountInWords: z.boolean(),
  /** The declaration block. */
  showDeclaration: z.boolean(),
  /** IRN, acknowledgement number and date, when an e-Invoice was registered. */
  showEInvoice: z.boolean(),
  /** The line under the totals; "Thank you for your business" and the like. */
  footerNote: shortText(300),
  /** Prefills a new document's terms; the document may still say its own. */
  defaultTerms: shortText(4000),
  /** D-47: the packing slip prints on A5 by default — the sticker that fits a carton face; A4 for pallets. Other papers stay A4. */
  paperSize: z.enum(['A4', 'A5']).default('A4'),
  /** D-47 (owner): the handling marks the slip prints, as icons — switched on per organisation in the Design rail. */
  handlingMarks: z.array(z.enum(HANDLING_MARKS)).default([]),
  /** D-47: which of the three goods-paper layouts the slip and delivery note wear; defaulted so an older design still parses. */
  slipTemplate: z.enum(SLIP_TEMPLATE_IDS).default('barcode'),
});
export type DocumentDesign = z.infer<typeof documentDesignSchema>;
export type PaperSize = DocumentDesign['paperSize'];

export const documentSettingsSchema = z.object({
  profile: documentProfileSchema,
  designs: z.record(z.enum(PRINTED_DOCUMENT_TYPES), documentDesignSchema),
});
export type DocumentSettings = z.infer<typeof documentSettingsSchema>;

export const DEFAULT_DOCUMENT_DESIGN: DocumentDesign = {
  paperSize: 'A4',
  handlingMarks: [],
  slipTemplate: 'barcode',
  templateId: 'tally',
  accent: 'ink',
  paper: 'sand',
  fontFamily: 'sans',
  fontScale: 'md',
  logoPlacement: 'left',
  showAmounts: true,
  showDiscount: true,
  showTax: true,
  showUnit: true,
  showTerms: true,
  showBank: false,
  showSignature: true,
  showHsn: true,
  showDetailsGrid: true,
  showShipTo: true,
  showAmountInWords: true,
  showDeclaration: true,
  showEInvoice: false,
  footerNote: 'This is a Computer Generated Invoice',
  defaultTerms: '',
};

export const DEFAULT_DECLARATION = 'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.';

export const DEFAULT_DOCUMENT_PROFILE: DocumentProfile = {
  legalName: '',
  addressLines: '',
  gstin: '',
  pan: '',
  phone: '',
  email: '',
  website: '',
  bankName: '',
  bankAccount: '',
  bankIfsc: '',
  bankBranch: '',
  signatoryName: '',
  stateName: '',
  stateCode: '',
  declaration: DEFAULT_DECLARATION,
  footerLogoFileIds: [],
  footerCaption: '',
};

/** A paper that carries goods, not money. */
const GOODS_DESIGN: DocumentDesign = { ...DEFAULT_DOCUMENT_DESIGN, showAmounts: false, showDiscount: false, showTax: false, showBank: false, showAmountInWords: false, showDeclaration: false, showEInvoice: false };

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  profile: DEFAULT_DOCUMENT_PROFILE,
  designs: {
    ESTIMATE: { ...DEFAULT_DOCUMENT_DESIGN, showEInvoice: false, footerNote: 'This is a Computer Generated Estimate' },
    SALES_ORDER: { ...DEFAULT_DOCUMENT_DESIGN, footerNote: 'This is a Computer Generated Sales Order' },
    INVOICE: { ...DEFAULT_DOCUMENT_DESIGN, showBank: true },
    DELIVERY_NOTE: { ...GOODS_DESIGN, footerNote: 'This is a Computer Generated Delivery Note' },
    PACKING_SLIP: { ...GOODS_DESIGN, showHsn: false, showDetailsGrid: false, footerNote: 'This is a Computer Generated Packing Slip', paperSize: 'A5', handlingMarks: ['fragile', 'this_side_up'] },
    PURCHASE_ORDER: { ...DEFAULT_DOCUMENT_DESIGN, showDiscount: false, showDeclaration: false, footerNote: 'This is a Computer Generated Purchase Order' },
    RECEIPT_NOTE: { ...GOODS_DESIGN, showShipTo: false, footerNote: 'This is a Computer Generated Goods Receipt Note' },
  },
};

/** GST's three copies of a tax invoice, printed as three pages with the copy named. */
export const INVOICE_COPIES = ['original', 'duplicate', 'triplicate'] as const;
export type InvoiceCopy = (typeof INVOICE_COPIES)[number];
export const INVOICE_COPY_LABELS: Record<InvoiceCopy, string> = {
  original: 'Original for Recipient',
  duplicate: 'Duplicate for Transporter',
  triplicate: 'Triplicate for Supplier',
};

/** GST state codes → names, as printed beside "State Name" on a tax invoice. */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

/** The state a GSTIN belongs to, from its first two digits; empty when unknown. */
export function gstStateName(code: string): string {
  return GST_STATES[code.trim()] ?? '';
}
