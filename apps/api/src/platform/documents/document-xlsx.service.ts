import { Injectable } from '@nestjs/common';
import { PRINTED_DOCUMENT_TITLES, type DocumentProfile, type PrintedDocumentType, type PartyStatementView } from '@vyuha/shared';
import ExcelJS from 'exceljs';

/**
 * One printed document as a workbook: an identity block, the addressee, the
 * lines, the totals — the same shape every module's Excel button produces,
 * so an accountant opening an estimate and a purchase order finds the same
 * cells in the same places.
 */
export interface DocumentSheetInput {
  readonly type: PrintedDocumentType;
  readonly number: string;
  readonly date: string;
  readonly status: string;
  readonly partyName: string;
  readonly partyDetail: string | null;
  readonly reference: string | null;
  readonly lines: readonly { description: string; quantity: string; unit: string | null; rate: string; discountPct: string; taxPct: string; amount: string; taxAmount: string }[];
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
  readonly notes: string | null;
  readonly terms: string | null;
  /** False on a paper that carries goods, not money: quantities only, no rates, amounts or totals. */
  readonly showAmounts?: boolean;
}

@Injectable()
export class DocumentXlsxService {
  /** Report 48: the party's ledger as a workbook, on the same letterhead as every other paper. */
  async buildStatement(profile: DocumentProfile, orgName: string, statement: PartyStatementView): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = orgName;
    const sheet = workbook.addWorksheet('Statement');
    sheet.columns = [{ width: 12 }, { width: 14 }, { width: 14 }, { width: 44 }, { width: 16 }, { width: 16 }, { width: 18 }];
    const title = sheet.addRow([PRINTED_DOCUMENT_TITLES.STATEMENT]);
    title.font = { bold: true, size: 16 };
    sheet.addRow([profile.legalName || orgName]).font = { bold: true };
    for (const line of profile.addressLines.split('\n').filter((l) => l.trim() !== '')) sheet.addRow([line]);
    if (profile.gstin) sheet.addRow([`GSTIN ${profile.gstin}`]);
    sheet.addRow([]);
    sheet.addRow(['Party', statement.party.name]).font = { bold: true };
    if (statement.party.address) sheet.addRow(['', statement.party.address]);
    if (statement.party.gstin) sheet.addRow(['GSTIN', statement.party.gstin]);
    sheet.addRow(['Period', `${statement.from} to ${statement.to}`]);
    sheet.addRow([]);
    const header = sheet.addRow(['Date', 'Voucher', 'Number', 'Particulars', 'Debit', 'Credit', 'Balance']);
    header.font = { bold: true };
    const opening = sheet.addRow([statement.from, '', '', 'Opening balance', '', '', `${statement.opening.amount} ${statement.opening.side}`]);
    opening.font = { italic: true };
    for (const entry of statement.entries) {
      const row = sheet.addRow([
        entry.date,
        entry.voucherType,
        entry.voucherNumber,
        // The marker rides beside the narration rather than under it, so a row with both still says why its money columns are blank.
        entry.side === null ? [entry.narration, 'Side not known -- not counted'].filter((part) => part !== '').join(' -- ') : entry.narration,
        entry.side === 'Dr' ? Number(entry.amount) : '',
        entry.side === 'Cr' ? Number(entry.amount) : '',
        `${entry.balance} ${entry.balanceSide}`,
      ]);
      for (const col of [5, 6]) row.getCell(col).numFmt = '#,##0.00';
    }
    const totals = sheet.addRow(['', '', '', 'Total', Number(statement.totals.debit), Number(statement.totals.credit), '']);
    totals.font = { bold: true };
    for (const col of [5, 6]) totals.getCell(col).numFmt = '#,##0.00';
    const closing = sheet.addRow([statement.to, '', '', 'Closing balance', '', '', `${statement.closing.amount} ${statement.closing.side}`]);
    closing.font = { bold: true };
    if (statement.unplaced > 0) {
      sheet.addRow([]);
      sheet.addRow(['Note', `${String(statement.unplaced)} voucher(s) carried no side and are shown without moving the balance.`]);
    }
    if (statement.tallyClosing !== null) {
      sheet.addRow(['Note', `Tally's closing balance at the last pull: ${statement.tallyClosing}.`]);
    }
    if (statement.earliestVoucherDate !== null) {
      sheet.addRow(['Note', `Built from vouchers held since ${statement.earliestVoucherDate}.`]);
    }
    const written = await workbook.xlsx.writeBuffer();
    return Buffer.from(written);
  }

  async build(profile: DocumentProfile, orgName: string, doc: DocumentSheetInput): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = orgName;
    workbook.created = new Date();
    // Excel refuses a sheet name with \ / ? * [ ] : — a packing slip is numbered SO-0016/AF71.
    const sheet = workbook.addWorksheet(doc.number.replace(/[\\/?*[\]:]/gu, '-').slice(0, 31));
    sheet.columns = [{ width: 6 }, { width: 44 }, { width: 12 }, { width: 8 }, { width: 14 }, { width: 10 }, { width: 8 }, { width: 16 }, { width: 14 }];

    const title = sheet.addRow([PRINTED_DOCUMENT_TITLES[doc.type]]);
    title.font = { bold: true, size: 16 };
    sheet.addRow([profile.legalName || orgName]).font = { bold: true };
    for (const line of profile.addressLines.split('\n').filter((l) => l.trim() !== '')) sheet.addRow([line]);
    if (profile.gstin) sheet.addRow([`GSTIN ${profile.gstin}`]);
    sheet.addRow([]);
    sheet.addRow(['Number', doc.number, '', 'Date', doc.date, '', 'Status', doc.status]);
    sheet.addRow(['To', doc.partyName, '', doc.partyDetail ?? '']);
    if (doc.reference) sheet.addRow(['Reference', doc.reference]);
    sheet.addRow([]);

    const money = doc.showAmounts ?? true;
    const header = sheet.addRow(money ? ['#', 'Description', 'Quantity', 'Unit', 'Rate', 'Disc %', 'Tax %', 'Amount', 'Tax'] : ['#', 'Description', 'Quantity', 'Unit']);
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.border = { bottom: { style: 'thin' } };
    });
    doc.lines.forEach((line, index) => {
      const row = money
        ? sheet.addRow([index + 1, line.description, Number(line.quantity), line.unit ?? '', Number(line.rate), Number(line.discountPct), Number(line.taxPct), Number(line.amount), Number(line.taxAmount)])
        : sheet.addRow([index + 1, line.description, Number(line.quantity), line.unit ?? '']);
      for (const col of money ? [3, 5, 6, 7, 8, 9] : [3]) row.getCell(col).numFmt = '#,##0.00';
    });
    sheet.addRow([]);
    if (money) {
      const totals: [string, string][] = [
        ['Subtotal', doc.subtotal],
        ['Discount', doc.discountTotal],
        ['Tax', doc.taxTotal],
        ['Total', doc.grandTotal],
      ];
      for (const [label, value] of totals) {
        const row = sheet.addRow(['', '', '', '', '', '', label, Number(value)]);
        row.getCell(8).numFmt = '#,##0.00';
        if (label === 'Total') row.font = { bold: true };
      }
    } else {
      const total = doc.lines.reduce((sum, line) => sum + Number(line.quantity), 0);
      const row = sheet.addRow(['', 'Total quantity', total]);
      row.getCell(3).numFmt = '#,##0.00';
      row.font = { bold: true };
    }
    if (doc.notes) {
      sheet.addRow([]);
      sheet.addRow(['Notes', doc.notes]);
    }
    if (doc.terms) sheet.addRow(['Terms', doc.terms]);
    const written = await workbook.xlsx.writeBuffer();
    return Buffer.from(written);
  }
}
