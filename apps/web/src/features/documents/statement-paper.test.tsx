import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DEFAULT_DOCUMENT_DESIGN, DEFAULT_DOCUMENT_PROFILE, DEFAULT_DOCUMENT_SETTINGS } from '@vyuha/shared';
import type { PartyStatement } from '@/features/masters/use-parties';
import { formatDate, formatMoney } from '@/lib/format';

import { DocumentPaper } from './paper';
import { paperModelOf, statementAsPaper } from './paper-record';

// Report 48: the statement of account on both papers. What is proven is that
// the ledger stands where the goods lines would, each voucher's amount lands
// on the side the API placed it, an unplaced voucher is printed on no side,
// and the reconciliation notes reach the sheet.

const party: PartyStatement['party'] = {
  id: 'p1',
  connectionId: 'c1',
  name: 'Asha Traders',
  alias: null,
  parentGroup: 'Sundry Debtors',
  gstin: '27AAAPL9999C1ZV',
  address: 'MIDC\nPune',
  creditLimit: null,
  creditDays: null,
  openingBalance: '-10000',
  closingBalance: '-15440',
  absentInTally: false,
  lastPulledAt: '2026-09-01T00:00:00.000Z',
  manager: null,
  duplicate: null,
};

const statement: PartyStatement = {
  party,
  from: '2026-08-01',
  to: '2026-08-31',
  opening: { amount: '11000.00', side: 'Dr' },
  closing: { amount: '15440.00', side: 'Dr' },
  entries: [
    { voucherId: 'v1', date: '2026-08-10', voucherType: 'Sales', voucherNumber: 'INV-A1', narration: '', side: 'Dr', sideSource: 'line', amount: '9440.00', balance: '20440.00', balanceSide: 'Dr' },
    { voucherId: 'v2', date: '2026-08-20', voucherType: 'Receipt', voucherNumber: 'RCP-7', narration: 'NEFT received', side: 'Cr', sideSource: 'type', amount: '5000.00', balance: '15440.00', balanceSide: 'Dr' },
    { voucherId: 'v3', date: '2026-08-28', voucherType: 'Journal', voucherNumber: 'JV-3', narration: '', side: null, sideSource: 'none', amount: '100.00', balance: '15440.00', balanceSide: 'Dr' },
  ],
  totals: { debit: '9440.00', credit: '5000.00' },
  unplaced: 1,
  tallyClosing: '-15440.00',
  earliestVoucherDate: '2026-07-05',
  generatedAt: '2026-09-09T00:00:00.000Z',
};

function rowCells(text: string): string[] {
  const row = screen.getByText(text).closest('tr');
  if (row === null) throw new Error(`${text} is not in a table row`);
  return within(row).getAllByRole('cell').map((cell) => cell.textContent ?? '');
}

describe.each(['tally', 'ledger'] as const)('the statement on the %s paper', (templateId) => {
  const design = { ...DEFAULT_DOCUMENT_SETTINGS.designs.STATEMENT, templateId };

  it('prints the account as a ledger where the goods lines would be', () => {
    const model = paperModelOf('STATEMENT', statementAsPaper(statement), null);
    render(<DocumentPaper design={design} profile={DEFAULT_DOCUMENT_PROFILE} logoUrl={null} orgName="Acme" model={model} />);

    expect(screen.queryByText(/Description/u)).toBeNull();
    expect(screen.getByText('Account of')).toBeTruthy();
    expect(screen.getByText('Asha Traders')).toBeTruthy();
    expect(screen.getByText('Period')).toBeTruthy();
    expect(screen.getByText(`${formatDate('2026-08-01')} to ${formatDate('2026-08-31')}`)).toBeTruthy();

    expect(rowCells('Opening Balance').at(-1)).toBe(`${formatMoney('11000.00')} Dr`);
    // Date, particulars, type, number, debit, credit, balance.
    expect(rowCells('INV-A1')).toEqual([formatDate('2026-08-10'), 'Sales', 'Sales', 'INV-A1', formatMoney('9440.00'), '', `${formatMoney('20440.00')} Dr`]);
    expect(rowCells('RCP-7')).toEqual([formatDate('2026-08-20'), 'NEFT received', 'Receipt', 'RCP-7', '', formatMoney('5000.00'), `${formatMoney('15440.00')} Dr`]);
    // The unplaced journal spans both money columns and moves nothing.
    expect(rowCells('JV-3')).toEqual([formatDate('2026-08-28'), 'Journal', 'Journal', 'JV-3', `${formatMoney('100.00')} (side unknown)`, `${formatMoney('15440.00')} Dr`]);
    expect(rowCells('Total').slice(-3, -1)).toEqual([formatMoney('9440.00'), formatMoney('5000.00')]);
    expect(rowCells('Closing Balance').at(-1)).toBe(`${formatMoney('15440.00')} Dr`);

    expect(screen.getByText(/1 entry is shown without a side/u)).toBeTruthy();
    expect(screen.getByText(`Balance in Tally as last pulled: ${formatMoney('15440.00')} Dr.`)).toBeTruthy();
    expect(screen.getByText(new RegExp(`earliest dated ${formatDate('2026-07-05')}`, 'u'))).toBeTruthy();
  });

  it('says so when the period holds no vouchers, carrying the balance across', () => {
    const empty: PartyStatement = { ...statement, entries: [], totals: { debit: '0.00', credit: '0.00' }, opening: statement.closing, unplaced: 0 };
    render(<DocumentPaper design={design} profile={DEFAULT_DOCUMENT_PROFILE} logoUrl={null} orgName="Acme" model={paperModelOf('STATEMENT', statementAsPaper(empty), null)} />);
    expect(screen.getByText('No vouchers in this period.')).toBeTruthy();
    expect(rowCells('Opening Balance').at(-1)).toBe(`${formatMoney('15440.00')} Dr`);
    expect(screen.queryByText(/without a side/u)).toBeNull();
  });
});

it('a goods paper is untouched: no ledger, the lines table as before', () => {
  const model = paperModelOf('INVOICE', { ...statementAsPaper(statement), ledger: undefined, lines: [{ id: 'l1', stockItemId: null, description: 'Cat6 Cable Box', hsnCode: '8544', quantity: '2', unit: 'Nos', rate: '100', discountPct: '0', taxPct: '18', amount: '200', taxAmount: '36' }] }, null);
  render(<DocumentPaper design={DEFAULT_DOCUMENT_DESIGN} profile={DEFAULT_DOCUMENT_PROFILE} logoUrl={null} orgName="Acme" model={model} />);
  expect(screen.getByText('Description of Goods')).toBeTruthy();
  expect(screen.queryByText('Opening Balance')).toBeNull();
});
