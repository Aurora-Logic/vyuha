import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DEFAULT_DOCUMENT_DESIGN, DEFAULT_DOCUMENT_PROFILE, type DocumentProfile } from '@vyuha/shared';

import { PackingSlipPaper } from './packing-slip-paper';
import type { PaperModel } from './paper';

// The slip a loader reads at arm's length. What is proven here is the two
// things the owner asked for: the organisation's logo and details ride the
// header, and a pack of N boxes prints one sheet each, numbered "box i of N".

const profile: DocumentProfile = { ...DEFAULT_DOCUMENT_PROFILE, legalName: 'Acme Traders', addressLines: 'Andheri East\nMumbai', gstin: '27AAAPL9999C1ZV', phone: '9820011223' };
const LOGO = 'https://logos.example/acme.png';

function slipModel(boxCount: number, type: PaperModel['type'] = 'PACKING_SLIP'): PaperModel {
  return {
    type,
    number: 'PACK-1',
    statusLabel: `${String(boxCount)} boxes`,
    date: '2026-08-21',
    validUntil: null,
    buyer: { name: 'Live Drive Traders', address: 'MIDC\nPune', gstin: '', stateName: '', stateCode: '27' },
    shipTo: null,
    details: { buyersOrderNo: 'SO-9' },
    reference: 'Against SO-9',
    lines: [{ key: 'a', stockItemId: null, description: 'Cat6 Cable Box', hsnCode: '8544', quantity: '2', unit: 'Nos', rate: '0', discountPct: '0', taxPct: '0', amount: '0', taxAmount: '0' }],
    totals: { subtotal: '0.00', discountTotal: '0.00', taxTotal: '0.00', grandTotal: '0.00', preview: false },
    notes: '',
    terms: '',
    slip: { boxCount, packedAt: '2026-08-21T10:00:00.000Z', packedByName: 'Asha', phone: '9820011223' },
  };
}

describe('PackingSlipPaper', () => {
  it('prints the organisation logo and its details in the header', () => {
    const { container } = render(<PackingSlipPaper design={DEFAULT_DOCUMENT_DESIGN} profile={profile} orgName="Acme" logoUrl={LOGO} model={slipModel(3)} box={1} />);
    // The only <img> is the logo; the barcodes are inline <svg>.
    expect(container.querySelector('img')?.getAttribute('src')).toBe(LOGO);
    expect(screen.getByText('Acme Traders')).toBeTruthy();
    expect(screen.getByText(/GSTIN 27AAAPL9999C1ZV/u)).toBeTruthy();
  });

  it('hides the logo when the design places it nowhere, keeping the details', () => {
    const { container } = render(<PackingSlipPaper design={{ ...DEFAULT_DOCUMENT_DESIGN, logoPlacement: 'none' }} profile={profile} orgName="Acme" logoUrl={LOGO} model={slipModel(3)} box={1} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Acme Traders')).toBeTruthy();
  });

  it('has no logo when the organisation has uploaded none', () => {
    const { container } = render(<PackingSlipPaper design={DEFAULT_DOCUMENT_DESIGN} profile={profile} orgName="Acme" logoUrl={null} model={slipModel(3)} box={1} />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('numbers each sheet "box i of N", the way the print route prints one per box', () => {
    for (const box of [1, 2, 3]) {
      const { container, unmount } = render(<PackingSlipPaper design={DEFAULT_DOCUMENT_DESIGN} profile={profile} orgName="Acme" logoUrl={LOGO} model={slipModel(3)} box={box} />);
      expect(container.querySelector(`[aria-label="Packing slip PACK-1, box ${String(box)} of 3"]`)).toBeTruthy();
      expect(screen.getByText('of 3')).toBeTruthy();
      unmount();
    }
  });

  it('draws the delivery note twin with the same logo and no box block', () => {
    const { container } = render(<PackingSlipPaper design={DEFAULT_DOCUMENT_DESIGN} profile={profile} orgName="Acme" logoUrl={LOGO} model={slipModel(1, 'DELIVERY_NOTE')} box={1} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(LOGO);
    expect(screen.getByText('Dispatched')).toBeTruthy();
    expect(screen.queryByText(/of 1$/u)).toBeNull();
  });
});
