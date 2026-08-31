import { describe, expect, it } from 'vitest';

import { normaliseName, parseClassImport } from './tier-import.js';

const CODES = ['A+', 'A', 'B', 'C', 'D'];

describe('parseClassImport', () => {
  it('reads tab-separated rows the way Excel pastes them', () => {
    const rows = parseClassImport('Asha Traders\tA+\tKey account\nDeva Supply\tB', CODES);
    expect(rows).toEqual([
      { line: 1, raw: 'Asha Traders\tA+\tKey account', party: 'Asha Traders', tierCode: 'A+', reason: 'Key account' },
      { line: 2, raw: 'Deva Supply\tB', party: 'Deva Supply', tierCode: 'B', reason: '' },
    ]);
  });

  it('finds the class column even when the name itself contains commas', () => {
    const rows = parseClassImport('Sharma, Sons & Co, a+, First classification', CODES);
    expect(rows[0]?.party).toBe('Sharma, Sons & Co');
    expect(rows[0]?.tierCode).toBe('A+');
    expect(rows[0]?.reason).toBe('First classification');
  });

  it('keeps a line with no recognisable class so the preview can point at it', () => {
    const rows = parseClassImport('Asha Traders, Z9', CODES);
    expect(rows[0]?.tierCode).toBeNull();
  });

  it('drops a header row silently but only in first position', () => {
    const rows = parseClassImport('Customer\tClass\tReason\nAsha Traders\tA\t', CODES);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.party).toBe('Asha Traders');
  });

  it('ignores blank lines and normalises names for matching', () => {
    expect(parseClassImport('\n\n', CODES)).toEqual([]);
    expect(normaliseName('  Asha   Traders ')).toBe('asha traders');
  });
});
