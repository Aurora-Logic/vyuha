import { describe, expect, it } from 'vitest';

import { creditBlockSchema, estimateSchema, lineBalances, orderWaitingOnSchema, salesLineSchema, trimZeros, type SalesLine, previewTotals, newLine, type LineDraft } from './types';

/**
 * The boundary schemas mirror `@vyuha/shared`; these pin the two things a
 * screen would get silently wrong: the balances that decide which footer
 * action is offered (REQ-AA-01), and the optional shapes — an estimate
 * answers without `waitingOn`, and a credit block's details must parse for
 * the release button to appear (REQ-W-09).
 */

const line = (over: Partial<SalesLine>): SalesLine => ({
  id: 'l1',
  lineNo: 1,
  stockItemId: null,
  description: 'Cable',
  quantity: '10.000',
  unit: 'NOS',
  rate: '4150.50',
  discountPct: '0.00',
  taxPct: '18.00',
  amount: '41505.00',
  taxAmount: '7470.90',
  pickedQty: '0.000',
  packedQty: '0.000',
  invoicedQty: '0.000',
  dispatchedQty: '0.000',
  invoicingQty: '0.000',
  hsnCode: null,
  priceListId: null,
  priceListVersion: null,
  resolvedRate: null,
  appliedDiscountPct: null,
  rateOverrideReason: null,
  freeOfCharge: false,
  ...over,
});

describe('lineBalances', () => {
  it('a free replacement waits for no invoice: what is packed may leave', () => {
    // 15 REQ-AK-09 / D-51. The web schema dropped the mark entirely, so this
    // read as undefined, the line was gated on invoicedQty like any other,
    // and a replacement given away could never be dispatched from a screen.
    const free = lineBalances(line({ quantity: '5.000', pickedQty: '5.000', packedQty: '5.000', invoicedQty: '0.000', freeOfCharge: true }));
    expect(free.toDispatch).toBe(5);
    const paid = lineBalances(line({ quantity: '5.000', pickedQty: '5.000', packedQty: '5.000', invoicedQty: '0.000' }));
    expect(paid.toDispatch).toBe(0);
  });

  it('a free line still cannot send more than was packed', () => {
    const b = lineBalances(line({ quantity: '5.000', pickedQty: '5.000', packedQty: '3.000', dispatchedQty: '3.000', freeOfCharge: true }));
    expect(b.toDispatch).toBe(0);
  });

  it('parses a line that predates the mark as not free', () => {
    const parsed = salesLineSchema.parse({ ...line({}), freeOfCharge: undefined });
    expect(parsed.freeOfCharge).toBe(false);
  });

  it('moves quantity from one stage to the next (12 §7: 100 ordered, 60 packed/invoiced/dispatched leaves 40 to pack)', () => {
    const b = lineBalances(line({ quantity: '100.000', pickedQty: '100.000', packedQty: '60.000', invoicedQty: '60.000', dispatchedQty: '60.000' }));
    expect(b).toEqual({ toPick: 0, toPack: 40, toInvoice: 0, invoicing: 0, toDispatch: 0 });
  });

  it('an invoice in flight holds its quantity: packed 60, none accepted yet, 60 in flight leaves nothing to invoice (P8-2)', () => {
    const b = lineBalances(line({ quantity: '100.000', pickedQty: '100.000', packedQty: '60.000', invoicingQty: '60.000' }));
    expect(b).toEqual({ toPick: 0, toPack: 40, toInvoice: 0, invoicing: 60, toDispatch: 0 });
  });

  it('never goes negative when the database has already advanced a later stage', () => {
    const b = lineBalances(line({ quantity: '5.000', pickedQty: '5.000', packedQty: '5.000', invoicedQty: '5.000', dispatchedQty: '5.000' }));
    expect(b).toEqual({ toPick: 0, toPack: 0, toInvoice: 0, invoicing: 0, toDispatch: 0 });
  });

  it('D-48: the shelf owes what is not picked, and a box takes only what is picked', () => {
    const b = lineBalances(line({ quantity: '10.000', pickedQty: '4.000' }));
    expect(b.toPick).toBe(6);
    expect(b.toPack).toBe(4);
  });

  it('parses the line view with its three stage quantities', () => {
    expect(salesLineSchema.safeParse(line({})).success).toBe(true);
    const { packedQty: _packed, ...missing } = line({});
    expect(salesLineSchema.safeParse(missing).success).toBe(false);
  });
});

describe('estimateSchema', () => {
  const header = {
    id: 'd1',
    docType: 'ESTIMATE',
    number: 'EST-0001',
    status: 'DRAFT',
    date: '2026-08-18',
    validUntil: null,
    partyId: null,
    companyId: null,
    dealId: null,
    customerName: 'Someone',
    ownerId: null,
    ownerName: null,
    notes: null,
    terms: null,
    subtotal: '0.00',
    discountTotal: '0.00',
    taxTotal: '0.00',
    grandTotal: '0.00',
    sourceDocumentId: null,
    syncState: 'NOT_PUSHED',
    remoteGuid: null,
    remoteVoucherNumber: null,
    lastPushedAt: null,
    lastError: null,
    fulfilment: null,
    shortClosedAt: null,
    shortCloseReason: null,
    customerEmail: null,
    customerWhatsapp: null,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    lines: [],
    invoices: [],
  };

  it('accepts an estimate that answers without waitingOn and defaults it to empty', () => {
    const parsed = estimateSchema.safeParse(header);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.waitingOn).toEqual([]);
  });

  it('accepts an INVOICE document type (D-38)', () => {
    expect(estimateSchema.safeParse({ ...header, docType: 'INVOICE', number: 'INV-0001' }).success).toBe(true);
  });

  it('parses a waiting-on requirement with its purchase orders (REQ-X-26)', () => {
    const parsed = orderWaitingOnSchema.safeParse({
      requirementId: 'r1',
      lineId: 'l1',
      stockItemName: 'Cable',
      quantity: '4.000',
      orderedQty: '4.000',
      receivedQty: '0.000',
      state: 'ordered',
      neededBy: null,
      purchaseOrders: [{ id: 'po1', number: 'PO-0001', vendorName: 'Behar Supply Co', status: 'CONFIRMED', expectedDate: '2026-08-25', quantity: '4.000' }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('creditBlockSchema', () => {
  it('parses the details a CREDIT_BLOCKED refusal carries (REQ-W-09)', () => {
    const parsed = creditBlockSchema.safeParse({
      position: { partyId: 'p1', partyName: 'Asha Traders', creditLimit: '100000.00', creditDays: 30, exposure: '80000.00', openOrders: '15000.00', headroom: '5000.00' },
      requiredPermission: 'sales.credit.override',
      orderTotal: '41505.00',
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a shape that moved rather than rendering half a position', () => {
    expect(creditBlockSchema.safeParse({ position: { partyName: 'Asha Traders' } }).success).toBe(false);
  });
});

describe('trimZeros', () => {
  it('writes a quantity the way a person would type it', () => {
    expect(trimZeros('10.000')).toBe('10');
    expect(trimZeros('2.500')).toBe('2.5');
    expect(trimZeros('7')).toBe('7');
  });
});

describe('the totals shown while a document is typed (audit 15)', () => {
  const line = (over: Partial<LineDraft>): LineDraft => ({ ...newLine(), quantity: '1', rate: '100', discountPct: '0', taxPct: '0', ...over });

  it('states the subtotal gross, the way both servers store it', () => {
    // The editors defined subtotal as the net, so the same document showed
    // one Subtotal while it was being typed and a larger one the moment it
    // was saved -- with the Discount line beneath it already taken off.
    const totals = previewTotals([line({ quantity: '10', rate: '100', discountPct: '10', taxPct: '18' })]);
    expect(totals.subtotal).toBe('1000.00');
    expect(totals.discountTotal).toBe('100.00');
    expect(totals.taxTotal).toBe('162.00');
    expect(totals.grandTotal).toBe('1062.00');
    // The four figures reconcile, which is the whole point of showing them.
    expect(Number(totals.subtotal) - Number(totals.discountTotal) + Number(totals.taxTotal)).toBeCloseTo(Number(totals.grandTotal), 2);
  });

  it('rounds each line before summing, as the servers do', () => {
    // Three-decimal quantity against a two-decimal rate: summing the raw
    // products drifts a paisa against sum(round(quantity * rate, 2)).
    const totals = previewTotals([
      line({ quantity: '1.005', rate: '10.10' }),
      line({ quantity: '1.005', rate: '10.10' }),
    ]);
    expect(totals.subtotal).toBe('20.30');
  });

  it('ignores a line that is not yet a line', () => {
    expect(previewTotals([line({ quantity: '', rate: '' })]).grandTotal).toBe('0.00');
    expect(previewTotals([]).subtotal).toBe('0.00');
  });
});
