import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A tab strip that carries the active panel's actions on its own row.
 *
 * Every tabbed screen was spending two stacked bands to start: the strip, then
 * a toolbar underneath holding a single button. Measured with touch emulation
 * on, that second band costs 44px plus a 16px gap before any content appears,
 * and the strip beside it is only 179px wide on a 1024px screen -- the room was
 * already there, horizontally, and was going unused.
 *
 * The action cannot simply be hoisted to the page, because each panel owns the
 * sheet its button opens. It is portalled instead: Base UI unmounts an inactive
 * Tabs.Panel (keepMounted defaults to false), so exactly one panel's action is
 * mounted at a time and the slot never has to choose between them.
 *
 * The row wraps rather than shrinks. At 360px a 179px strip and a 110px button
 * do not fit across 328px of content width, so the action takes its own line
 * there -- which is the arrangement it had before, kept only where it is
 * actually needed.
 */

const SlotContext = createContext<HTMLDivElement | null>(null);

export function TabsToolbar({ list, children }: { list: ReactNode; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  return (
    <SlotContext.Provider value={slot}>
      <div data-guide="screen.tabs" className="flex flex-wrap items-center justify-between gap-2">
        {list}
        {/* display:contents so the portalled controls are flex items of the
            row itself, and a wrapped action lines up with the strip rather
            than indenting inside an extra box. */}
        <div ref={setSlot} className="contents" />
      </div>
      {children}
    </SlotContext.Provider>
  );
}

/**
 * Renders its children into the strip's row. Returns null on the first render,
 * before the slot ref has resolved -- the portal target is state, not a ref, so
 * that resolution is what schedules the re-render that fills it.
 */
export function TabsToolbarAction({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext);
  return slot ? createPortal(children, slot) : null;
}
