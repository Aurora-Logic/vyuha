import type { PrintedDocumentType } from './documents.js';
import type { VoucherDetailView, VoucherLineView } from './masters.js';

/**
 * A Tally voucher on the organisation's own paper (owner, 22 Aug 2026:
 * "vouchers: view as PDF, print them; the data comes from Tally and the
 * template is ready"). One reading, shared by the screen, the print route
 * and the Excel export, so the three cannot disagree about a line.
 *
 * Tally writes a voucher as ledger entries and, for a goods voucher, the
 * inventory lines beneath them. On paper the goods are the lines; the
 * party's own ledger is the total and is not a line; tax ledgers become
 * the tax total; a discount ledger the discount; any other ledger (freight,
 * rounding) prints as a line of its own. A voucher with no goods -- a
 * receipt, a payment, a journal -- prints its ledgers, each marked Dr or
 * Cr as Tally marks it. Quantities arrive as text ("2 BOX"): the number
 * is the head, the unit the tail.
 */

export interface VoucherPaperLine {
  readonly id: string;
  readonly stockItemId: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string | null;
  readonly rate: string;
  readonly amount: string;
}

export interface VoucherPaper {
  readonly type: PrintedDocumentType;
  readonly title: string;
  readonly lines: readonly VoucherPaperLine[];
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
}

/** What Tally prints each voucher type as; anything else is "<type> Voucher". */
const TITLES: Record<string, string> = {
  Sales: 'Tax Invoice',
  Purchase: 'Purchase Voucher',
  'Credit Note': 'Credit Note',
  'Debit Note': 'Debit Note',
  Receipt: 'Receipt Voucher',
  Payment: 'Payment Voucher',
  Journal: 'Journal Voucher',
  Contra: 'Contra Voucher',
  'Delivery Note': 'Delivery Note',
  'Receipt Note': 'Receipt Note',
};

export function voucherPaperTitle(voucherType: string): string {
  if (TITLES[voucherType]) return TITLES[voucherType];
  if (/sale|tax\s*inv|gst\s*inv/iu.test(voucherType)) return 'Tax Invoice';
  if (/purchase/iu.test(voucherType)) return 'Purchase Voucher';
  return `${voucherType} Voucher`;
}

/** The design a voucher borrows: the vendor-facing paper for what we owe, the invoice paper for everything else. */
export function voucherPaperType(voucherType: string): PrintedDocumentType {
  if (voucherType === 'Purchase' || voucherType === 'Receipt Note' || /purchase/iu.test(voucherType)) return 'PURCHASE_ORDER';
  if (voucherType === 'Delivery Note') return 'DELIVERY_NOTE';
  return 'INVOICE';
}

const TAX_LEDGER = /\b(c?gst|sgst|igst|utgst|cess|vat|tds|tcs|tax)\b/iu;
const DISCOUNT_LEDGER = /discount/iu;
const QUANTITY = /^\s*(-?\d+(?:\.\d+)?)\s*(.*)$/u;

/** "2 BOX" → 2 and BOX; "12" → 12 and no unit; anything else → 0 and the text as the unit. */
export function splitQuantity(text: string | null): { quantity: string; unit: string | null } {
  if (text === null || text.trim() === '') return { quantity: '0', unit: null };
  const match = QUANTITY.exec(text);
  if (match === null) return { quantity: '0', unit: text.trim() };
  const unit = (match[2] ?? '').trim();
  return { quantity: match[1] ?? '0', unit: unit === '' ? null : unit };
}

function money(value: number): string {
  return value.toFixed(2);
}

function isPartyLedger(line: VoucherLineView, voucher: VoucherDetailView): boolean {
  return line.kind === 'ledger' && line.ledgerName !== null && line.ledgerName.trim().toLowerCase() === voucher.partyName.trim().toLowerCase();
}

export function voucherPaper(voucher: VoucherDetailView): VoucherPaper {
  const type = voucherPaperType(voucher.voucherType);
  const title = voucherPaperTitle(voucher.voucherType);
  const grandTotal = Math.abs(Number(voucher.amount));
  const goods = voucher.lines.filter((line) => line.kind === 'inventory');

  if (goods.length === 0) {
    // No goods: the ledgers are the lines, each as Tally marks it.
    const lines = voucher.lines
      .filter((line) => line.kind === 'ledger' && !isPartyLedger(line, voucher))
      .map((line) => {
        const amount = Math.abs(Number(line.amount));
        const side = line.isDeemedPositive === true ? 'Dr' : line.isDeemedPositive === false ? 'Cr' : '';
        return { id: String(line.lineNo), stockItemId: null, description: side === '' ? (line.ledgerName ?? '') : `${line.ledgerName ?? ''} (${side})`, quantity: '1', unit: null, rate: money(amount), amount: money(amount) };
      });
    return { type, title, lines, subtotal: money(grandTotal), discountTotal: '0.00', taxTotal: '0.00', grandTotal: money(grandTotal) };
  }

  let tax = 0;
  let discount = 0;
  const extras: VoucherPaperLine[] = [];
  for (const line of voucher.lines) {
    if (line.kind !== 'ledger' || isPartyLedger(line, voucher)) continue;
    const name = line.ledgerName ?? '';
    const amount = Math.abs(Number(line.amount));
    if (TAX_LEDGER.test(name)) tax += amount;
    else if (DISCOUNT_LEDGER.test(name)) discount += amount;
    else if (amount > 0 && !/\bsales\b|\bpurchase/iu.test(name)) {
      extras.push({ id: String(line.lineNo), stockItemId: null, description: name, quantity: '1', unit: null, rate: money(amount), amount: money(amount) });
    }
  }
  const lines: VoucherPaperLine[] = goods.map((line) => {
    const { quantity, unit } = splitQuantity(line.billedQty ?? line.actualQty);
    const amount = Math.abs(Number(line.amount));
    return {
      id: String(line.lineNo),
      stockItemId: line.stockItemId,
      description: line.stockItemName ?? '',
      quantity,
      unit,
      rate: line.rate === null ? money(Number(quantity) > 0 ? amount / Number(quantity) : amount) : money(Math.abs(Number(line.rate))),
      amount: money(amount),
    };
  });
  const subtotal = lines.reduce((sum, line) => sum + Number(line.amount), 0) + extras.reduce((sum, line) => sum + Number(line.amount), 0);
  return { type, title, lines: [...lines, ...extras], subtotal: money(subtotal), discountTotal: money(discount), taxTotal: money(tax), grandTotal: money(grandTotal) };
}
