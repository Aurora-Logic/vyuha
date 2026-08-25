import { describe, expect, it } from 'vitest';

import { reportPageEnvelopeSchema } from './types';

/**
 * The envelope parse is the one gate every report row passes through, and
 * Zod strips keys the schema does not declare. `meta.totals` -- the
 * server's whole-report sums -- was silently stripped here for months, so
 * every headline figure fell back to the 200-row page sum while a fixture
 * that bypassed the parse kept the KPI test green. This test goes through
 * the parse, so a key the dashboard depends on cannot vanish quietly again.
 */
describe('the report page envelope', () => {
  it('carries the server’s whole-report totals through the parse', () => {
    const parsed = reportPageEnvelopeSchema.parse({
      data: [{ partyId: 'p1' }],
      meta: { page: 1, pageSize: 200, total: 4200, totals: { outstanding: '1234567.89' } },
    });
    expect(parsed.meta.totals).toEqual({ outstanding: '1234567.89' });
    expect(parsed.meta.total).toBe(4200);
  });

  it('parses without totals, which only the money reports send', () => {
    const parsed = reportPageEnvelopeSchema.parse({
      data: [],
      meta: { page: 1, pageSize: 200, total: 0 },
    });
    expect(parsed.meta.totals).toBeUndefined();
  });
});
