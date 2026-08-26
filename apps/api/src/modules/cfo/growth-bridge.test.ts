import { describe, expect, it } from 'vitest';

import { growthBridge, type BridgeRow } from './growth-bridge.js';

/**
 * D1 on a hand-worked story where every factor is non-zero, and Q1.6 rule
 * five holds to the paisa: the factors sum to the actual change exactly.
 *
 * Last year: Asha bought 100 MCB at 100 (10,000) and 50 RCCB at 200
 * (10,000); Chetan bought 80 MCB at 100 (8,000). Total 28,000.
 * This year: Asha bought 120 MCB at 110 (13,200) — volume +2,000, price
 * +1,200 — dropped RCCB entirely (mix −10,000) and added a 3,000 freight-
 * style ledger line (mix +3,000); Chetan is gone (lost −8,000); Deva is new
 * at 5,000. Total 21,200. Change −6,800 = 2,000 + 1,200 − 7,000 + 5,000
 * − 8,000, exactly.
 */
describe('growthBridge (D1)', () => {
  const ly: BridgeRow[] = [
    { customerKey: 'asha', itemKey: 'mcb', qty: 100, net: 10_000 },
    { customerKey: 'asha', itemKey: 'rccb', qty: 50, net: 10_000 },
    { customerKey: 'chetan', itemKey: 'mcb', qty: 80, net: 8_000 },
  ];
  const ty: BridgeRow[] = [
    { customerKey: 'asha', itemKey: 'mcb', qty: 120, net: 13_200 },
    { customerKey: 'asha', itemKey: 'freight', qty: 0, net: 3_000 },
    { customerKey: 'deva', itemKey: 'mcb', qty: 40, net: 5_000 },
  ];

  it('splits the change into the five factors, each hand-checked', () => {
    const bridge = growthBridge(ty, ly);
    expect(bridge.lastYear).toBe(28_000);
    expect(bridge.thisYear).toBe(21_200);
    expect(bridge.change).toBe(-6_800);
    expect(bridge.volumeEffect).toBe(2_000);
    expect(bridge.priceEffect).toBe(1_200);
    expect(bridge.mixEffect).toBe(-7_000);
    expect(bridge.newCustomerEffect).toBe(5_000);
    expect(bridge.lostCustomerEffect).toBe(-8_000);
  });

  it('reconciles exactly — the acceptance test the brief names', () => {
    expect(growthBridge(ty, ly).reconciliationError).toBe(0);
  });

  it('an empty prior year is all new; an empty current year is all lost', () => {
    const allNew = growthBridge(ty, []);
    expect(allNew.newCustomerEffect).toBe(21_200);
    expect(allNew.volumeEffect + allNew.priceEffect + allNew.mixEffect + allNew.lostCustomerEffect).toBe(0);

    const allLost = growthBridge([], ly);
    expect(allLost.lostCustomerEffect).toBe(-28_000);
    expect(allLost.reconciliationError).toBe(0);
  });

  it('a ledger-only pair carries no volume or price, only mix', () => {
    const bridge = growthBridge(
      [{ customerKey: 'a', itemKey: 'freight', qty: 0, net: 500 }],
      [{ customerKey: 'a', itemKey: 'freight', qty: 0, net: 300 }],
    );
    expect(bridge.volumeEffect).toBe(0);
    expect(bridge.priceEffect).toBe(0);
    expect(bridge.mixEffect).toBe(200);
    expect(bridge.reconciliationError).toBe(0);
  });
});
