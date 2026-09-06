import { describe, expect, it } from 'vitest';

import { emptyCompanyDraft } from './types';
import { companyDraftErrors, companyInputOf } from './company-validation';

describe('company form validation', () => {
  it('reports the shared contract errors beside every typed field', () => {
    const errors = companyDraftErrors({
      ...emptyCompanyDraft(),
      name: '   ',
      phone: '12',
      email: 'not-an-email',
      website: 'not a website',
      city: 'x'.repeat(81),
      notes: 'x'.repeat(4001),
    });

    expect(Object.keys(errors).sort()).toEqual([
      'city',
      'email',
      'name',
      'notes',
      'phone',
      'website',
    ]);
    expect(Object.values(errors).every((message) => typeof message === 'string')).toBe(true);
  });

  it('accepts blank optional fields and sends them as null', () => {
    const draft = { ...emptyCompanyDraft(), name: '  Asha Traders  ' };

    expect(companyDraftErrors(draft)).toEqual({});
    expect(companyInputOf(draft)).toEqual({
      name: 'Asha Traders',
      phone: null,
      email: null,
      website: null,
      city: null,
      ownerId: null,
      notes: null,
    });
  });
});
