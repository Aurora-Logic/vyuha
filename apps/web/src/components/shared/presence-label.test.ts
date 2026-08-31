import { describe, expect, it } from 'vitest';

import { presenceLabel } from './presence-label';

const viewer = (name: string) => ({ userId: name, name });

describe('presenceLabel', () => {
  it('says nothing when nobody is there', () => {
    expect(presenceLabel([])).toBe('');
  });

  it('reads as a sentence for one, two and three people', () => {
    expect(presenceLabel([viewer('Priya Kulkarni')])).toBe('Priya Kulkarni is working on this');
    expect(presenceLabel([viewer('Priya Kulkarni'), viewer('Ravi Kumar')])).toBe(
      'Priya Kulkarni and Ravi Kumar are working on this',
    );
    expect(presenceLabel([viewer('Priya Kulkarni'), viewer('Ravi Kumar'), viewer('Omar Shaikh')])).toBe(
      'Priya Kulkarni, Ravi Kumar and Omar Shaikh are working on this',
    );
  });
});
