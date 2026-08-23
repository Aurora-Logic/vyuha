import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { isNumericColumn, renderCell } from './format';

/**
 * The money column type. Before it, a report's amount columns were `text` and
 * rendered raw -- a value at cost came through as `1587620.00`, which reads as
 * a typo, not a figure. These pin the fix and its boundary: money groups, a
 * quantity does not become money.
 */
describe('report money columns', () => {
  it('groups a money value Indian-style rather than showing it raw', () => {
    const { container } = render(<>{renderCell('1587620.00', 'money')}</>);
    expect(container.textContent).toContain('15,87,620.00');
    expect(container.textContent).not.toContain('1587620.00');
  });

  it('right-aligns money like other figures', () => {
    expect(isNumericColumn('money')).toBe(true);
  });

  it('does not turn a quantity into money — 5 units stays 5, never ₹5.00', () => {
    const { container } = render(<>{renderCell('5', 'number')}</>);
    expect(container.textContent).toBe('5');
    expect(container.textContent).not.toContain('₹');
  });
});
