import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Input } from '@/components/ui/input';
import { DEFAULT_DOCUMENT_DESIGN } from '@vyuha/shared';

import { DocumentForm } from './document-form';
import type { PaperEditing, PaperModel } from './paper';

// The phone surface for every printed document. It draws the same model the
// paper draws and calls the same editing hooks, so what is proven here is
// that each section reaches the hook the page wired, and that a document
// nobody can edit reads back without a single input.
const model: PaperModel = {
  type: 'ESTIMATE',
  number: 'EST-0019',
  statusLabel: 'Draft',
  date: '2026-08-21',
  validUntil: '2026-09-20',
  buyer: { name: 'Live Drive Traders', address: 'Andheri East\nMumbai', gstin: '27AAAPL9999C1ZV', stateName: '', stateCode: '27' },
  shipTo: null,
  details: { buyersOrderNo: 'PO-77' },
  reference: null,
  lines: [
    { key: 'a', stockItemId: null, description: 'Cat6 Cable Box', hsnCode: '8544', quantity: '2.000', unit: 'Nos', rate: '1500.00', discountPct: '0', taxPct: '18', amount: '3000.00', taxAmount: '540.00' },
    { key: 'b', stockItemId: null, description: 'RJ45 Connectors', hsnCode: '', quantity: '100', unit: 'Nos', rate: '8', discountPct: '10', taxPct: '18', amount: '720.00', taxAmount: '129.60' },
  ],
  totals: { subtotal: '3720.00', discountTotal: '80.00', taxTotal: '669.60', grandTotal: '4389.60', preview: false },
  notes: 'Deliver before Friday',
  terms: '',
};

function editingStub(): PaperEditing {
  return {
    customer: <Input aria-label="Addressed to" defaultValue="Live Drive Traders" />,
    date: <span>21-08-2026</span>,
    validUntil: <span>20-09-2026</span>,
    itemPicker: (line) => <Input aria-label={`Stock item ${line.key}`} />,
    updateLine: vi.fn(),
    addLine: vi.fn(),
    removeLine: vi.fn(),
    setNotes: vi.fn(),
    setTerms: vi.fn(),
    updateDetails: vi.fn(),
    updateShipTo: vi.fn(),
    setPlaceOfSupply: vi.fn(),
  };
}

describe('DocumentForm', () => {
  it('reads a document back with no inputs: party, lines with their facts, totals, the filled detail, the notes', () => {
    const { container } = render(<DocumentForm model={model} design={DEFAULT_DOCUMENT_DESIGN} />);
    expect(container.querySelectorAll('input, textarea')).toHaveLength(0);
    expect(screen.getByText('Live Drive Traders')).toBeTruthy();
    expect(screen.getByText('Cat6 Cable Box')).toBeTruthy();
    expect(screen.getByText(/2 Nos × ₹1,500\.00/u)).toBeTruthy();
    expect(screen.getByText(/10% off/u)).toBeTruthy();
    expect(screen.getByText('₹4,389.60')).toBeTruthy();
    expect(screen.getByText("Buyer's order")).toBeTruthy();
    expect(screen.getByText('PO-77')).toBeTruthy();
    expect(screen.getByText('Deliver before Friday')).toBeTruthy();
    // Terms are empty, so the read view does not show an empty Terms label.
    expect(screen.queryByText('Terms')).toBeNull();
  });

  it('routes every section to the editing hooks the page wired', () => {
    const editing = editingStub();
    render(<DocumentForm model={model} design={DEFAULT_DOCUMENT_DESIGN} editing={editing} />);

    fireEvent.change(screen.getByLabelText('Place of supply (state code)'), { target: { value: '29' } });
    expect(editing.setPlaceOfSupply).toHaveBeenCalledWith('29');

    fireEvent.change(screen.getByLabelText('Quantity', { selector: '#document-form-line-a-qty' }), { target: { value: '3' } });
    expect(editing.updateLine).toHaveBeenCalledWith('a', { quantity: '3' });

    fireEvent.change(screen.getByLabelText('Rate', { selector: '#document-form-line-b-rate' }), { target: { value: '9' } });
    expect(editing.updateLine).toHaveBeenCalledWith('b', { rate: '9' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove line 2' }));
    expect(editing.removeLine).toHaveBeenCalledWith('b');

    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    expect(editing.addLine).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Call first' } });
    expect(editing.setNotes).toHaveBeenCalledWith('Call first');

    // The small boxes are folded away while editing; opening them reaches updateDetails.
    fireEvent.click(screen.getByRole('button', { name: 'More details' }));
    fireEvent.change(screen.getByLabelText("Buyer's order"), { target: { value: 'PO-78' } });
    expect(editing.updateDetails).toHaveBeenCalledWith({ buyersOrderNo: 'PO-78' });
  });

  it('keeps the consignee folded behind Same as buyer, and clears it when switched back', () => {
    const editing = editingStub();
    render(<DocumentForm model={model} design={DEFAULT_DOCUMENT_DESIGN} editing={editing} />);
    const toggle = screen.getByRole('switch', { name: 'Same as buyer (Bill to)' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByLabelText('GSTIN/UIN')).toBeNull();

    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText('GSTIN/UIN'), { target: { value: '29abc' } });
    expect(editing.updateShipTo).toHaveBeenCalledWith({ gstin: '29ABC' });

    fireEvent.click(toggle);
    expect(editing.updateShipTo).toHaveBeenLastCalledWith(null);
    expect(screen.queryByLabelText('GSTIN/UIN')).toBeNull();
  });

  it('draws its own date controls when the page hands it setters, and the slot otherwise', () => {
    const withSetters: PaperEditing = { ...editingStub(), setDate: vi.fn(), setValidUntil: vi.fn() };
    const { rerender } = render(<DocumentForm model={model} design={DEFAULT_DOCUMENT_DESIGN} editing={withSetters} />);
    expect(screen.getByRole('button', { name: /Dated/u }).textContent).toContain('21-08-2026');
    expect(screen.getByRole('button', { name: /Valid until/u }).textContent).toContain('20-09-2026');
    expect(screen.queryByText('slot-date')).toBeNull();

    const slots: PaperEditing = { ...editingStub(), date: <span>slot-date</span>, validUntil: <span>slot-valid</span> };
    rerender(<DocumentForm model={model} design={DEFAULT_DOCUMENT_DESIGN} editing={slots} />);
    expect(screen.getByText('slot-date')).toBeTruthy();
    expect(screen.getByText('slot-valid')).toBeTruthy();
  });

  it('has no consignee section at all when the design does not print one', () => {
    render(<DocumentForm model={model} design={{ ...DEFAULT_DOCUMENT_DESIGN, showShipTo: false }} editing={editingStub()} />);
    expect(screen.queryByRole('switch', { name: 'Same as buyer (Bill to)' })).toBeNull();
  });
});
