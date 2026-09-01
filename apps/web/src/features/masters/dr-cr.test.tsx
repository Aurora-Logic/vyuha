import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DrCr, VoucherTypeLabel } from './dr-cr';

/**
 * Colour is the point, but never the whole of it: a fact carried only by hue
 * is a fact withheld from anyone who cannot separate the hues, and from the
 * printed copy.
 */

describe('DrCr', () => {
  it('keeps the letters a Tally user reads, and names them for a screen reader', () => {
    render(<DrCr isDeemedPositive={true} />);
    expect(screen.getByText('Dr')).toBeTruthy();
    expect(screen.getByLabelText('Debit')).toBeTruthy();
  });

  it('tells the two sides apart by hue as well as by text', () => {
    const { unmount } = render(<DrCr isDeemedPositive={true} />);
    const debit = screen.getByText('Dr').className;
    unmount();
    render(<DrCr isDeemedPositive={false} />);
    const credit = screen.getByText('Cr').className;
    expect(debit).not.toBe(credit);
  });

  it('is neither red nor green, because neither side is good news', () => {
    // Which side is the welcome one depends on whose ledger it is. Painting
    // them with the status colours would assert something untrue about money.
    const { unmount } = render(<DrCr isDeemedPositive={true} />);
    const debit = screen.getByText('Dr').className;
    unmount();
    render(<DrCr isDeemedPositive={false} />);
    const credit = screen.getByText('Cr').className;
    for (const classes of [debit, credit]) {
      expect(classes).not.toMatch(/destructive|success|warning/);
    }
  });

  it('shows nothing for a line the pull could not attribute', () => {
    const { container } = render(<DrCr isDeemedPositive={null} />);
    expect(container.textContent).toBe('');
  });
});

describe('VoucherTypeLabel', () => {
  it('tints the two the owner asked for, whatever the casing', () => {
    const { unmount } = render(<VoucherTypeLabel type="Credit Note" />);
    expect(screen.getByText('Credit Note').className).not.toBe('');
    unmount();
    render(<VoucherTypeLabel type="debit note" />);
    expect(screen.getByText('debit note').className).not.toBe('');
  });

  it('leaves every other type plain, so the column is not a rainbow', () => {
    render(<VoucherTypeLabel type="Sales" />);
    expect(screen.getByText('Sales').className).toBe('');
  });

  it('gives a credit note and a debit note different hues', () => {
    const { unmount } = render(<VoucherTypeLabel type="Credit Note" />);
    const credit = screen.getByText('Credit Note').className;
    unmount();
    render(<VoucherTypeLabel type="Debit Note" />);
    expect(screen.getByText('Debit Note').className).not.toBe(credit);
  });
});
