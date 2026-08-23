import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RecordPicker } from './record-picker';

describe('RecordPicker', () => {
  it('shows a chosen option\'s warning on the trigger, before anything is saved (REQ-AO-09)', () => {
    const flagged = { id: 'a', label: 'Asha Traders Pvt Ltd', warning: 'Likely the same as Asha Traders Private Limited (same gstin). Merge in Tally.' };
    render(<RecordPicker label="Tally party" placeholder="Tally party" options={[flagged]} value={flagged} onValueChange={() => {}} />);
    expect(screen.getByLabelText(flagged.warning)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tally party' }).textContent).toContain('Asha Traders Pvt Ltd');
  });

  /**
   * Owner, 22 Aug 2026, with screenshots: a picker beside a labelled Input
   * showed no name and sat a label's height out of line, so the row read as
   * broken. `showLabel` is the fix; these pin both halves of it.
   */
  it('renders no visible label by default, so a filter toolbar stays a row of controls', () => {
    render(<RecordPicker label="Filter by party" placeholder="Any party" options={[]} value={null} onValueChange={() => {}} />);
    // Named for a screen reader, but nothing is drawn above it.
    expect(screen.getByRole('button', { name: 'Filter by party' })).toBeTruthy();
    expect(screen.queryByText('Filter by party')).toBeNull();
  });

  it('renders exactly one visible label when asked, tied to the control', () => {
    render(<RecordPicker id="party" label="Customer" showLabel placeholder="Choose a customer" options={[]} value={null} onValueChange={() => {}} />);
    const labels = screen.getAllByText('Customer').filter((node) => node.tagName.toLowerCase() === 'label');
    // Exactly one: a call site that also hand-wraps the picker in its own
    // Field/FieldLabel would otherwise print the name twice, which is the
    // mistake a blanket sweep of this prop would have made.
    expect(labels).toHaveLength(1);
    expect(labels[0]?.getAttribute('for')).toBe('party');
  });
});
