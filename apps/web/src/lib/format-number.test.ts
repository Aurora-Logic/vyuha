import { DEFAULT_LOCALE } from '@vyuha/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DATE_FORMAT,
  currencySymbol,
  formatAmount,
  formatCount,
  formatDate,
  formatMoney,
  formatMoneyShort,
  setWorkspaceDateFormat,
  setWorkspaceLocale,
} from './format';

// Every figure in the product is written by these two, from the workspace's
// setting; a change in Settings changes what a table cell says.
describe('workspace number format', () => {
  afterEach(() => {
    setWorkspaceLocale(DEFAULT_LOCALE);
  });

  it('groups the Indian way by default, two decimals always', () => {
    expect(formatAmount('1234567.5')).toBe('12,34,567.50');
    expect(formatAmount('999')).toBe('999.00');
    expect(formatAmount('-1234.567')).toBe('−1,234.57');
    expect(formatCount(12345678)).toBe('1,23,45,678');
    expect(currencySymbol()).toBe('₹');
  });

  it('rounds the third decimal rather than chopping it', () => {
    // The projection keeps three decimals on purpose (D-01), so quantities,
    // rates and anything derived from them arrive with one. Slicing the third
    // off showed every such figure a paisa short, and a column of them drifted
    // further the longer it got. This line asserted the old behaviour.
    expect(formatAmount('1234.567')).toBe('1,234.57');
    expect(formatAmount('1234.564')).toBe('1,234.56');
    expect(formatAmount('1234.565')).toBe('1,234.57');
    // The carry has to reach the rupees, and the grouping after it.
    expect(formatAmount('99.999')).toBe('100.00');
    expect(formatAmount('99999.999')).toBe('1,00,000.00');
    expect(formatAmount('-0.999')).toBe('−1.00');
    // And a figure longer than a float can hold exactly still rounds exactly.
    expect(formatAmount('9007199254740993.567')).toBe('9,00,71,99,25,47,40,993.57');
    expect(formatAmount('0')).toBe('0.00');
    expect(formatAmount('0.004')).toBe('0.00');
  });

  it('groups the international way and changes the symbol when the workspace says so', () => {
    setWorkspaceLocale({ numberFormat: 'international', currencySymbol: 'INR' });
    expect(formatAmount('1234567.5')).toBe('1,234,567.50');
    expect(formatCount(12345678)).toBe('12,345,678');
    expect(currencySymbol()).toBe('INR');
  });
});

describe('money', () => {
  afterEach(() => {
    setWorkspaceLocale(DEFAULT_LOCALE);
  });

  it('puts the workspace symbol in front, grouped the Indian way', () => {
    expect(formatMoney('1234567.5')).toBe('₹12,34,567.50');
    expect(formatMoney('999')).toBe('₹999.00');
    expect(formatMoney(1500)).toBe('₹1,500.00');
  });

  it('writes the minus outside the symbol, the way a ledger does', () => {
    expect(formatMoney('-1234.56')).toBe('−₹1,234.56');
  });

  it('has an empty value rather than a bare symbol', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
    expect(formatMoney(Number.NaN)).toBe('—');
  });

  it('shortens for a chart label, still with the symbol', () => {
    expect(formatMoneyShort(933103)).toBe('₹9.3L');
    expect(formatMoneyShort(12_500_000)).toBe('₹1.3Cr');
    expect(formatMoneyShort(4200)).toBe('₹4.2k');
    expect(formatMoneyShort(850)).toBe('₹850');
    expect(formatMoneyShort(-250000)).toBe('−₹2.5L');
    expect(formatMoneyShort(0)).toBe('₹0');
  });

  it('follows the workspace setting rather than hardcoding the rupee', () => {
    setWorkspaceLocale({ numberFormat: 'international', currencySymbol: 'Rs' });
    expect(formatMoney('1234567.5')).toBe('Rs1,234,567.50');
    expect(formatMoneyShort(4200)).toBe('Rs4.2k');
  });
});

// Every date on screen is written by `formatDate`, from the workspace's
// setting; a change in Settings changes what a table cell says, the same
// contract the number formatters keep above.
describe('workspace date format', () => {
  afterEach(() => {
    setWorkspaceDateFormat(DATE_FORMAT);
  });

  it('writes the organisation default until told otherwise', () => {
    expect(formatDate('2026-08-01')).toBe('01-08-2026');
  });

  it('follows the workspace setting rather than hardcoding the pattern', () => {
    setWorkspaceDateFormat('dd MMM yyyy');
    expect(formatDate('2026-08-01')).toBe('01 Aug 2026');
  });

  it('keeps the em dash for the unset and the unparseable', () => {
    setWorkspaceDateFormat('dd MMM yyyy');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
  });
});
