import { describe, expect, it } from 'vitest';

import { istDateOf, localDateIn } from './local-date.js';

describe('the IST day boundary', () => {
  it('an instant late in the UTC evening already belongs to the next IST day', () => {
    // 18:29:59Z is 23:59:59 IST; one second later is IST midnight.
    expect(istDateOf('2026-08-20T18:29:59.000Z')).toBe('2026-08-20');
    expect(istDateOf('2026-08-20T18:30:00.000Z')).toBe('2026-08-21');
  });

  it('a UTC morning instant and its IST date agree', () => {
    expect(istDateOf('2026-08-20T06:00:00.000Z')).toBe('2026-08-20');
  });

  it('the nightly hour itself: 02:50 IST belongs to the day it wakes on', () => {
    // 21:20Z on the 20th is 02:50 IST on the 21st.
    expect(istDateOf('2026-08-20T21:20:00.000Z')).toBe('2026-08-21');
  });

  it('a bare date reads as its own IST date, so a pinned test payload round-trips', () => {
    expect(istDateOf('2026-08-20')).toBe('2026-08-20');
  });
});

describe('localDateIn', () => {
  it('handles a zone west of UTC the same way', () => {
    expect(localDateIn(new Date('2026-08-20T03:00:00.000Z'), 'America/New_York')).toBe('2026-08-19');
  });
});
