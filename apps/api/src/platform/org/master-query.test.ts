import { describe, expect, it } from 'vitest';

import { fuzzyWorthy } from './master-query.js';

/**
 * Which words are forgiven a typo.
 *
 * Tested here rather than through a search endpoint, honestly: the length
 * floor has nothing observable to change end to end, because no
 * three-character term reaches the 0.35 threshold against any real name
 * anyway. An earlier endpoint test claimed to cover it and passed whether or
 * not the rule existed.
 *
 * The alphabetic rule is the one that carries real weight, and the shift
 * suite proved it: without it a search for one shift code returned two.
 */
describe('fuzzyWorthy', () => {
  it('forgives a word of four letters or more', () => {
    expect(fuzzyWorthy('acem')).toBe(true);
    expect(fuzzyWorthy('zenth')).toBe(true);
    expect(fuzzyWorthy('Bharrat')).toBe(true);
  });

  it('leaves anything shorter strict', () => {
    for (const word of ['', 'a', 'ac', 'ash']) expect(fuzzyWorthy(word)).toBe(false);
  });

  it('never forgives an identifier', () => {
    // A code is copied, not remembered. SR-NGT-4821 and SR-DAY-4821 differ by
    // three characters out of eleven and are different shifts.
    for (const word of ['SR-NGT-4821', '27AAAPL1234C1ZV', 'mccb100a', 'cat-6', '100a']) {
      expect(fuzzyWorthy(word), word).toBe(false);
    }
  });

  it('is unmoved by casing, since the search lowercases anyway', () => {
    expect(fuzzyWorthy('ACEM')).toBe(true);
    expect(fuzzyWorthy('AcEm')).toBe(true);
  });
});
