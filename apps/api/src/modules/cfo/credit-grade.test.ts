import { describe, expect, it } from 'vitest';

import { creditGrade } from './credit-grade.js';

const clean = { avgDaysLate: 0, brokenPromiseRate: 0, overdueShare: 0, utilisationPct: 0, gapRatio: 1, disputes: 0 };

describe('creditGrade (D18)', () => {
  it('a customer who pays on time with nothing overdue is an A', () => {
    const r = creditGrade(clean);
    expect(r.grade).toBe('A');
    expect(r.risk).toBe(0);
  });

  it('ninety days late with everything overdue is an E, and the breakdown says why', () => {
    const r = creditGrade({ ...clean, avgDaysLate: 90, overdueShare: 1, utilisationPct: 150 });
    expect(r.grade).toBe('E');
    expect(r.breakdown.paymentHistory).toBe(40);
    expect(r.breakdown.ageing).toBe(25);
    expect(r.breakdown.utilisation).toBe(15);
  });

  it('a broken promise counts as the lateness it hides', () => {
    const late = creditGrade({ ...clean, avgDaysLate: 45 });
    const broken = creditGrade({ ...clean, brokenPromiseRate: 0.5 });
    expect(broken.breakdown.paymentHistory).toBe(late.breakdown.paymentHistory);
  });

  it('bands are fixed at 20-point steps', () => {
    expect(creditGrade({ ...clean, avgDaysLate: 44 }).grade).toBe('A');
    expect(creditGrade({ ...clean, avgDaysLate: 46 }).grade).toBe('B');
    expect(creditGrade({ ...clean, avgDaysLate: 90, overdueShare: 0.6 }).grade).toBe('C');
    expect(creditGrade({ ...clean, avgDaysLate: 90, overdueShare: 1 }).grade).toBe('D');
  });

  it('utilisation only starts to hurt past 80% of the limit; three disputes saturate', () => {
    expect(creditGrade({ ...clean, utilisationPct: 80 }).breakdown.utilisation).toBe(0);
    expect(creditGrade({ ...clean, utilisationPct: 115 }).breakdown.utilisation).toBe(7.5);
    expect(creditGrade({ ...clean, disputes: 5 }).breakdown.disputes).toBe(10);
  });
});
