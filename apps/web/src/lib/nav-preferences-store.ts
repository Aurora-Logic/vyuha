import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Which routes the phone's bottom bar shows.
 *
 * One list for the whole app (D-20): the bar is the person's, not the
 * module's, so it stays put under the thumb when a link crosses a module
 * boundary. Null means "never chosen", which lets the bar follow the active
 * module's defaults; an empty array is a state a person asked for.
 *
 * A UI preference, so localStorage is the right home for it -- it belongs to
 * this person on this device, and losing it costs nothing.
 */
interface NavPreferencesState {
  bottomNavRoutes: string[] | null;
  setBottomNavRoutes: (routes: string[]) => void;
  resetBottomNav: () => void;
}

/** Five plus More is the owner's ask (D-20); the short labels keep it honest at 360px. */
export const BOTTOM_NAV_SLOTS = 5;

export const useNavPreferencesStore = create<NavPreferencesState>()(
  persist(
    (set) => ({
      bottomNavRoutes: null,
      setBottomNavRoutes: (routes) => {
        set({ bottomNavRoutes: routes.slice(0, BOTTOM_NAV_SLOTS) });
      },
      resetBottomNav: () => {
        set({ bottomNavRoutes: null });
      },
    }),
    {
      name: 'vyuha.nav-preferences',
      version: 3,
      // v1 stored one flat array, v2 one list per module, v3 is flat again
      // (D-20). A v1 list carries over as-is; from v2 the first non-empty
      // list survives -- it is the one bar the person demonstrably chose.
      migrate: (persisted: unknown, version) => {
        if (typeof persisted !== 'object' || persisted === null) return { bottomNavRoutes: null };
        if (version < 2) {
          const old = (persisted as { bottomNavRoutes?: string[] | null }).bottomNavRoutes;
          return { bottomNavRoutes: Array.isArray(old) ? old : null };
        }
        if (version < 3) {
          const byModule = (persisted as { bottomNavByModule?: Record<string, string[]> }).bottomNavByModule ?? {};
          const first = Object.values(byModule).find((routes) => routes.length > 0);
          return { bottomNavRoutes: first ?? null };
        }
        return persisted as NavPreferencesState;
      },
    },
  ),
);
