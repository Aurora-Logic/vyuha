import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StockBadge } from './stock-badge';

describe('StockBadge', () => {
  it('colours the shelf: green with stock, red at nil, amber when Tally holds it negative', () => {
    render(
      <>
        <StockBadge quantity="18" unit="Nos" />
        <StockBadge quantity="0" unit="Nos" />
        <StockBadge quantity="-2.5" unit="Mtr" />
      </>,
    );
    expect(screen.getByText('18 Nos').className).toContain('text-success');
    expect(screen.getByText('0 Nos').className).toContain('text-destructive');
    expect(screen.getByText('-2.5 Mtr').className).toContain('text-warning');
  });

  it('groups the way the register does and keeps the unit on the number', () => {
    render(<StockBadge quantity="1234567.5" unit="Kg" />);
    expect(screen.getByText('12,34,567.5 Kg')).toBeTruthy();
  });

  it('draws nothing when Tally sent no figure', () => {
    const { container } = render(
      <>
        <StockBadge quantity={null} unit="Nos" />
        <StockBadge quantity="" unit="Nos" />
        <StockBadge quantity="abc" unit="Nos" />
      </>,
    );
    expect(container.textContent).toBe('');
  });
});
