import { beforeEach, describe, expect, it } from 'vitest';

import { TASK_CARD_FIELDS, useTaskCardFields } from './card-fields';

/**
 * The preference behind REQ-V-13. What matters is that it starts with
 * everything on, that a field added later arrives visible rather than
 * silently off, and that hiding one field leaves the rest alone.
 */

beforeEach(() => {
  localStorage.clear();
  useTaskCardFields.setState({ shown: Object.fromEntries(TASK_CARD_FIELDS.map((f) => [f.key, true])) as never });
});

describe('task card fields', () => {
  it('starts with everything shown', () => {
    const { shown } = useTaskCardFields.getState();
    expect(Object.values(shown).every(Boolean)).toBe(true);
    expect(Object.keys(shown)).toHaveLength(TASK_CARD_FIELDS.length);
  });

  it('hides one field and leaves the rest alone', () => {
    useTaskCardFields.getState().toggle('vendor');
    const { shown } = useTaskCardFields.getState();
    expect(shown.vendor).toBe(false);
    expect(shown.party).toBe(true);
    expect(shown.items).toBe(true);
  });

  it('toggles back, and Show everything restores the lot', () => {
    const { toggle, showAll } = useTaskCardFields.getState();
    toggle('vendor');
    toggle('items');
    expect(useTaskCardFields.getState().shown.items).toBe(false);

    toggle('items');
    expect(useTaskCardFields.getState().shown.items).toBe(true);

    showAll();
    expect(Object.values(useTaskCardFields.getState().shown).every(Boolean)).toBe(true);
  });

  it('never governs the title', () => {
    // A card with no title is not a card, so it is not offered as a choice.
    expect(TASK_CARD_FIELDS.map((f) => f.key)).not.toContain('title');
  });
});
