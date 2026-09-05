import { useEffect, useMemo, useRef } from 'react';

/**
 * A dropped connection or an accidental swipe-back must not lose a document
 * being typed (the brief's draft autosave). The unsaved draft of a *new*
 * document is mirrored into sessionStorage a moment after each change;
 * saving or leaving through the app clears it, and reopening the creation
 * screen in the same tab offers the copy back exactly once. Session rather
 * than local storage on purpose: this is crash insurance, not a drafts
 * feature — the server's draft is the real one the moment Save works.
 */
/**
 * "Reopening in the same tab" means after a page load, not after walking to
 * the screen again. Every stored blob is stamped with an id made once per
 * JavaScript context, and a blob stamped with this one is discarded rather
 * than offered: it can only have been written by this same load, which is an
 * in-app navigation and not a crash.
 *
 * Without it, opening a new document for one customer, going back, and
 * opening one for another silently replaced the second with the first -- the
 * presets the screen had just been given were overwritten by an abandoned
 * draft the person had already walked away from. It also makes the sentence
 * above ("leaving through the app clears it") true, which it was not.
 */
const LOAD_ID = Math.random().toString(36).slice(2);

interface StoredDraft<T> {
  readonly loadId: string;
  readonly draft: T;
}

export function useDraftBackup<T>(
  key: string,
  draft: T,
  enabled: boolean,
  ownerUserId: string | null,
): { restored: T | null; clear: () => void } {
  // One tab can sign out and into another account without reloading. The user
  // id is therefore part of the key, not merely metadata inside a document-
  // scoped blob that the next account could accidentally restore (M-01).
  const storageKey =
    ownerUserId === null ? null : `vyuha.draft-backup.${ownerUserId}.${key}`;
  const restored = useMemo<T | null>(() => {
    if (!enabled || storageKey === null) return null;
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw === null) return null;
      const stored = JSON.parse(raw) as StoredDraft<T>;
      if (stored.loadId === LOAD_ID) {
        // Written by this same load: an in-app navigation, not a crash.
        window.sessionStorage.removeItem(storageKey);
        return null;
      }
      return stored.draft;
    } catch {
      return null;
    }
  }, [enabled, storageKey]);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || storageKey === null) return undefined;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify({ loadId: LOAD_ID, draft } satisfies StoredDraft<T>));
      } catch {
        // Quota or privacy mode: the backup silently does not exist.
      }
    }, 400);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [draft, enabled, storageKey]);

  return {
    restored,
    clear: () => {
      if (storageKey === null) return;
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        // Nothing to clear where nothing could be stored.
      }
    },
  };
}
