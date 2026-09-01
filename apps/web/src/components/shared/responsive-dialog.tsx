import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

/**
 * The fulfilment actions — pack, invoice, dispatch — each open a form over
 * the order sheet. A Dialog on a desktop; a bottom Sheet on a phone, where a
 * centred modal over a bottom sheet is two surfaces fighting for a thumb
 * (CLAUDE.md §3: pickers and modals open as a bottom sheet on small screens).
 * The header and footer stay pinned and only the body scrolls, on both.
 *
 * The body is remounted with the surface, so a form typed for one order is
 * never submitted against the next one somebody opens. The form owns its
 * state, so it also owns its buttons: `ResponsiveDialogActions` portals them
 * into the pinned footer the way TabsToolbarAction fills the tab strip's row,
 * rather than lifting every field into the dialog to render a footer prop.
 */

const SlotContext = createContext<HTMLDivElement | null>(null);

interface ResponsiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** The desktop width, e.g. `sm:max-w-lg`. */
  className?: string;
}

// `empty:hidden` so a body that renders no actions leaves no bordered band.
const FOOTER = 'shrink-0 flex-row flex-wrap justify-end gap-2 border-t empty:hidden';

export function ResponsiveDialog({ open, onOpenChange, title, description, children, className }: ResponsiveDialogProps) {
  const isMobile = useIsMobile();
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="max-h-[92vh] gap-0">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{title}</SheetTitle>
            {description === undefined ? null : <SheetDescription>{description}</SheetDescription>}
          </SheetHeader>
          {/* min-h-0 is load-bearing: a flex child defaults to min-height:auto and would push the footer off the sheet instead of scrolling. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <SlotContext.Provider value={slot}>{open ? children : null}</SlotContext.Provider>
          </div>
          <SheetFooter ref={setSlot} className={FOOTER} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('flex max-h-[90vh] flex-col gap-0 p-0', className)}>
        <DialogHeader className="shrink-0 border-b p-4">
          <DialogTitle>{title}</DialogTitle>
          {description === undefined ? null : <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <SlotContext.Provider value={slot}>{open ? children : null}</SlotContext.Provider>
        </div>
        <DialogFooter ref={setSlot} className={cn(FOOTER, 'p-4')} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Renders its children into the pinned footer. Null on the first render,
 * before the slot ref has resolved — the target is state, not a ref, so that
 * resolution is what schedules the re-render that fills it.
 */
export function ResponsiveDialogActions({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext);
  return slot ? createPortal(children, slot) : null;
}
