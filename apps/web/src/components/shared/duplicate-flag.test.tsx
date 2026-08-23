import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DuplicateBadge } from './duplicate-badge';
import { duplicateWarning } from './duplicate-flag';

describe('duplicate flag', () => {
  it('says who else and on what, in one sentence', () => {
    expect(duplicateWarning({ others: ['Asha Traders Private Limited'], matchedFields: ['gstin', 'name'] })).toBe('Likely the same as Asha Traders Private Limited (same gstin, name). Merge in Tally.');
    expect(duplicateWarning({ others: [], matchedFields: [] })).toBe('Likely the same as another record. Merge in Tally.');
  });

  it('is announced, not only coloured (REQ-AO-08)', () => {
    render(<DuplicateBadge flag={{ others: ['Asha Traders Pvt Ltd'], matchedFields: ['gstin'] }} />);
    const badge = screen.getByRole('button', { name: /Possible duplicate: Likely the same as Asha Traders Pvt Ltd \(same gstin\)/u });
    expect(badge.className).toContain('text-destructive');
  });
});
