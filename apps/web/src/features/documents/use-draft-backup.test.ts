import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useDraftBackup } from './use-draft-backup';

/**
 * The backup is crash insurance: it survives a page load, and nothing else.
 *
 * It used to survive an in-app navigation too, which is where it did harm --
 * opening a new document for one customer, going back, and opening one for
 * another offered the first one's draft and silently replaced the presets the
 * second screen had just been given.
 */
describe('the new-document draft backup (audit 29)', () => {
  const KEY = 'sales-order';
  const storageKey = `vyuha.draft-backup.${KEY}`;

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('offers back a draft written by an earlier load', () => {
    // What a crash leaves behind: a blob stamped with a load that is gone.
    window.sessionStorage.setItem(storageKey, JSON.stringify({ loadId: 'a-previous-load', draft: { customerName: 'Asha Traders' } }));
    const { result } = renderHook(() => useDraftBackup(KEY, { customerName: '' }, true));
    expect(result.current.restored).toEqual({ customerName: 'Asha Traders' });
  });

  it('does not offer back one this load wrote itself', async () => {
    // A real in-app navigation: mount the creation screen, let the backup be
    // written, walk away, and mount it again in the same load. The old hook
    // stored the draft bare and handed it back to whoever mounted next, so
    // the second screen's presets were replaced by the first screen's
    // abandoned draft.
    const first = renderHook(() => useDraftBackup(KEY, { customerName: 'Acme' }, true));
    expect(first.result.current.restored).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(window.sessionStorage.getItem(storageKey), 'the backup was never written, so this proves nothing').not.toBeNull();
    first.unmount();

    const second = renderHook(() => useDraftBackup(KEY, { customerName: '' }, true));
    expect(second.result.current.restored).toBeNull();
    // And cleared, rather than left to be offered again later in this load.
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it('offers nothing when the screen is not a new document', () => {
    window.sessionStorage.setItem(storageKey, JSON.stringify({ loadId: 'a-previous-load', draft: { customerName: 'Asha' } }));
    const { result } = renderHook(() => useDraftBackup(KEY, { customerName: '' }, false));
    expect(result.current.restored).toBeNull();
  });

  it('survives a stored blob it cannot read', () => {
    window.sessionStorage.setItem(storageKey, 'not json');
    const { result } = renderHook(() => useDraftBackup(KEY, { customerName: '' }, true));
    expect(result.current.restored).toBeNull();
  });
});
