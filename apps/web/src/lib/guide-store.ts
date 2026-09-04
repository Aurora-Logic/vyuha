import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * What this browser remembers about the guided tour.
 *
 * localStorage rather than a server row, for the same reason the bottom-bar
 * preference lives there: it belongs to this person on this device and losing
 * it costs one repeated offer. See docs/OPEN-QUESTIONS G-3, which records this
 * as the default in use rather than an answered question — the store is the
 * only seam, so moving it to `/me` later is one file.
 *
 * `null` and `false` are different states throughout. "Never offered" is not
 * "offered and declined", and only the second one silences the invitation.
 */
interface GuideState {
  /** ISO timestamp of the run that reached the closing card. */
  completedAt: string | null;
  /** ISO timestamp of a "Not now". Silences the unprompted invitation. */
  dismissedAt: string | null;
  /**
   * Asked for on the sign-in screen, consumed on the next authenticated load.
   * The tour cannot run before there is a session to filter it by, so the
   * request has to survive the sign-in round trip somewhere.
   */
  armed: boolean;
  /**
   * Which step to open at, when the request came from an Updates row rather
   * than from the sign-in screen. `null` means start at the beginning.
   */
  armedFromStepId: string | null;
  /**
   * How much the armed run should cover: this screen, or the whole product.
   * `null` while nothing is armed.
   */
  armedScope: 'page' | 'all' | null;
  /** Newest changelog release this person has opened. Drives the unread dot. */
  seenVersion: string | null;
  /**
   * Step *id*, never an index. A step inserted in the middle later must not
   * silently move somebody two steps backwards on resume.
   */
  lastStepId: string | null;
  /** ISO timestamp of the abandoned run, so a stale resume can be discarded. */
  lastStepAt: string | null;
  /** Bumped when the registry changes shape enough to invalidate a resume. */
  registryVersion: number | null;

  arm: (options?: { fromStepId?: string; scope?: 'page' | 'all' }) => void;
  consumeArmed: () => void;
  markUpdatesSeen: (version: string) => void;
  dismiss: () => void;
  complete: (registryVersion: number) => void;
  recordStep: (stepId: string, registryVersion: number) => void;
  clearResume: () => void;
  /** Development affordance: forget everything and offer the tour again. */
  reset: () => void;
}

/** A resume older than this starts over instead. */
export const RESUME_WINDOW_DAYS = 7;

const EMPTY = {
  completedAt: null,
  dismissedAt: null,
  armed: false,
  armedFromStepId: null,
  armedScope: null,
  seenVersion: null,
  lastStepId: null,
  lastStepAt: null,
  registryVersion: null,
} as const;

export const useGuideStore = create<GuideState>()(
  persist(
    (set) => ({
      ...EMPTY,

      arm: (options) => {
        set({
          armed: true,
          armedFromStepId: options?.fromStepId ?? null,
          armedScope: options?.scope ?? 'all',
        });
      },
      consumeArmed: () => {
        set({ armed: false, armedFromStepId: null, armedScope: null });
      },
      markUpdatesSeen: (version) => {
        set({ seenVersion: version });
      },
      dismiss: () => {
        set({
          dismissedAt: new Date().toISOString(),
          armed: false,
          armedFromStepId: null,
          armedScope: null,
        });
      },
      complete: (registryVersion) => {
        set({
          completedAt: new Date().toISOString(),
          armed: false,
          armedFromStepId: null,
          armedScope: null,
          lastStepId: null,
          lastStepAt: null,
          registryVersion,
        });
      },
      recordStep: (stepId, registryVersion) => {
        set({ lastStepId: stepId, lastStepAt: new Date().toISOString(), registryVersion });
      },
      clearResume: () => {
        set({ lastStepId: null, lastStepAt: null });
      },
      reset: () => {
        set({ ...EMPTY });
      },
    }),
    { name: 'vyuha.guide' },
  ),
);

/**
 * Whether the tour should offer itself without being asked.
 *
 * Deliberately not "has it been completed" — a person who said "Not now" has
 * answered the question, and asking again on every sign-in is the behaviour
 * this check exists to prevent.
 */
export function shouldOfferUnprompted(state: {
  completedAt: string | null;
  dismissedAt: string | null;
}): boolean {
  return state.completedAt === null && state.dismissedAt === null;
}
