import { describe, expect, it } from 'vitest';

import { ExprError, evaluate, measuresOf, parseExpression, unitOf } from './pivot-expression.js';

describe('pivot expressions (S1.2)', () => {
  it('parses the brief’s own examples and reads their units', () => {
    const marginPct = parseExpression('(net - landed) / net');
    expect(unitOf(marginPct)).toBe('ratio');
    expect(measuresOf(marginPct).sort()).toEqual(['landed', 'net']);
    const aov = parseExpression('net / vouchers');
    expect(unitOf(aov)).toBe('money');
  });

  it('guards the division the brief warns about: a zero denominator is null, never Infinity', () => {
    const tree = parseExpression('net / qty');
    expect(evaluate(tree, { net: 100, qty: 0 })).toBeNull();
    expect(evaluate(tree, { net: 100, qty: 4 })).toBe(25);
    expect(evaluate(tree, { net: null, qty: 4 })).toBeNull();
  });

  it('refuses raw SQL, unknown names, and unit nonsense', () => {
    expect(() => parseExpression('select * from users')).toThrow(ExprError);
    expect(() => parseExpression('pocket_margin')).toThrow(/not a registered measure/u);
    expect(() => parseExpression('net + qty')).toThrow(/no unit/u);
    expect(() => parseExpression('net * margin')).toThrow(/no unit/u);
    expect(() => parseExpression('(net - landed')).toThrow(/ends unexpectedly/u);
    expect(() => parseExpression('')).toThrow(/empty/u);
  });

  it('a number scales without changing the unit', () => {
    const tree = parseExpression('net * 1.18');
    expect(unitOf(tree)).toBe('money');
    expect(evaluate(tree, { net: 100 })).toBeCloseTo(118, 6);
  });
});
