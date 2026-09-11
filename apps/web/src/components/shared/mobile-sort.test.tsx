import { describe, expect, it } from 'vitest';

/**
 * RecordTable no longer draws a phone sort control of its own; the chip
 * sits in each screen's toolbar. That is a rule a screen can forget, so the
 * sources are read here: any screen that hands RecordTable a sort setter
 * must also place MobileSortChip, or the register cannot be ordered on a
 * phone at all -- the asymmetry the chip exists to remove.
 */
const screens = import.meta.glob<string>('/src/features/**/*.tsx', { query: '?raw', import: 'default', eager: true });

describe('MobileSortChip placement', () => {
  it('every screen that sorts a RecordTable places the phone chip', () => {
    const missing = Object.entries(screens)
      .filter(([path]) => !path.endsWith('.test.tsx'))
      .filter(([, source]) => source.includes('<RecordTable') && source.includes('onSortChange={') && !source.includes('<MobileSortChip'))
      .map(([path]) => path);
    expect(missing).toEqual([]);
  });

  it('is not an empty rule: at least the registers it was written for are counted', () => {
    const placed = Object.entries(screens).filter(([, source]) => source.includes('<MobileSortChip')).length;
    expect(placed).toBeGreaterThanOrEqual(9);
  });
});
