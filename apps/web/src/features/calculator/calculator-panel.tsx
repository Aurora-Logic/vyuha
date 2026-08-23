import { useCallback, useEffect, useReducer, useRef, type KeyboardEvent } from 'react';
import {
  BackspaceIcon,
  CalculatorIcon,
  CopySimpleIcon,
  TextAlignRightIcon,
} from '@phosphor-icons/react';

import { HeaderTooltip } from '@/components/shared/header-tooltip';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { useIsMobile } from '@/hooks/use-mobile';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { cn } from '@/lib/utils';

import {
  INITIAL_STATE,
  hasMemory,
  reduce,
  type CalculatorAction,
  type CalculatorState,
} from './machine';
import { useCalculatorStore } from './store';

/**
 * REQ-N-03: the calculator panel, on any screen, without leaving it.
 *
 * Styled as the object rather than as a web widget -- a tape above a display
 * above a keypad, monospaced and right-aligned, with the totals ruled off the
 * way a printing calculator rules them. Every control is a shadcn `Button`
 * (CLAUDE.md §3 rule 1); the "keys" are buttons in a grid, not a canvas.
 *
 * ## Keys
 *
 * The panel handles its own keystrokes rather than registering twenty-odd
 * shortcuts. The registry throws on a duplicate key within a layer, and a
 * calculator claiming `1` through `9` globally would collide with the first
 * screen that wants a number key -- so only the toggle goes through the
 * registry, and the digits are a `keydown` on the panel itself, which can only
 * fire while the panel has focus.
 *
 * `Ctrl+N` is PRD §6.4's key and is reserved by every desktop browser (it opens
 * a window before the page sees it). §6.4 anticipates exactly this: register
 * both, show both. `Alt+N` is the documented alias and is the one that works in
 * a tab.
 *
 * Enter is `=` unless a keypad button has focus, where it has to stay the way
 * a keyboard user activates the button they tabbed to.
 */

interface KeyDefinition {
  readonly label: string;
  readonly action: CalculatorAction;
  readonly variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  readonly ariaLabel?: string;
  /** Columns the key covers; the GST keys take two so two of them fill the row. */
  readonly span?: number;
  /** A colour a variant does not carry — the GST keys' own tint. */
  readonly className?: string;
}

const KEYPAD: readonly (readonly KeyDefinition[])[] = [
  [
    { label: '+GST', action: { kind: 'gstAdd' }, variant: 'secondary', span: 2, className: 'bg-info text-white hover:bg-info/90', ariaLabel: 'Add GST (multiply by 1.18)' },
    { label: '−GST', action: { kind: 'gstReverse' }, variant: 'secondary', span: 2, className: 'bg-success text-white hover:bg-success/90', ariaLabel: 'Remove GST (divide by 1.18)' },
  ],
  [
    { label: 'MC', action: { kind: 'memoryClear' }, variant: 'ghost', ariaLabel: 'Memory clear' },
    { label: 'MR', action: { kind: 'memoryRecall' }, variant: 'ghost', ariaLabel: 'Memory recall' },
    {
      label: 'M−',
      action: { kind: 'memorySubtract' },
      variant: 'ghost',
      ariaLabel: 'Subtract from memory',
    },
    { label: 'M+', action: { kind: 'memoryAdd' }, variant: 'ghost', ariaLabel: 'Add to memory' },
  ],
  [
    { label: 'AC', action: { kind: 'clearAll' }, variant: 'secondary', ariaLabel: 'Clear all' },
    { label: '%', action: { kind: 'percent' }, variant: 'secondary', ariaLabel: 'Per cent' },
    { label: '⌫', action: { kind: 'backspace' }, variant: 'secondary', ariaLabel: 'Backspace' },
    {
      label: '÷',
      action: { kind: 'operator', operator: 'divide' },
      variant: 'default',
      ariaLabel: 'Divide',
    },
  ],
  [
    { label: '7', action: { kind: 'digit', digit: '7' }, variant: 'outline' },
    { label: '8', action: { kind: 'digit', digit: '8' }, variant: 'outline' },
    { label: '9', action: { kind: 'digit', digit: '9' }, variant: 'outline' },
    {
      label: '×',
      action: { kind: 'operator', operator: 'multiply' },
      variant: 'default',
      ariaLabel: 'Multiply',
    },
  ],
  [
    { label: '4', action: { kind: 'digit', digit: '4' }, variant: 'outline' },
    { label: '5', action: { kind: 'digit', digit: '5' }, variant: 'outline' },
    { label: '6', action: { kind: 'digit', digit: '6' }, variant: 'outline' },
    {
      label: '−',
      action: { kind: 'operator', operator: 'subtract' },
      variant: 'default',
      ariaLabel: 'Subtract',
    },
  ],
  [
    { label: '1', action: { kind: 'digit', digit: '1' }, variant: 'outline' },
    { label: '2', action: { kind: 'digit', digit: '2' }, variant: 'outline' },
    { label: '3', action: { kind: 'digit', digit: '3' }, variant: 'outline' },
    {
      label: '+',
      action: { kind: 'operator', operator: 'add' },
      variant: 'default',
      ariaLabel: 'Add',
    },
  ],
  [
    { label: '±', action: { kind: 'sign' }, variant: 'outline', ariaLabel: 'Change sign' },
    { label: '0', action: { kind: 'digit', digit: '0' }, variant: 'outline' },
    { label: '.', action: { kind: 'point' }, variant: 'outline', ariaLabel: 'Decimal point' },
    { label: '=', action: { kind: 'equals' }, ariaLabel: 'Equals' },
  ],
];

/** `event.key` to an action. Returns null for anything the panel does not own. */
function actionForKey(event: KeyboardEvent<HTMLDivElement>): CalculatorAction | null {
  const { key } = event;
  if (/^\d$/u.test(key)) return { kind: 'digit', digit: key };

  switch (key) {
    case '.':
    case ',':
      return { kind: 'point' };
    case '+':
      return { kind: 'operator', operator: 'add' };
    case '-':
      return { kind: 'operator', operator: 'subtract' };
    case '*':
    case 'x':
    case 'X':
      return { kind: 'operator', operator: 'multiply' };
    case '/':
      return { kind: 'operator', operator: 'divide' };
    case '=':
    case 'Enter':
      return { kind: 'equals' };
    case '%':
      return { kind: 'percent' };
    case 'Backspace':
      return { kind: 'backspace' };
    case 'Delete':
      return { kind: 'clearEntry' };
    default:
      return null;
  }
}

/**
 * Writes a value into a React-controlled input.
 *
 * Setting `.value` directly is invisible to React: the framework caches the
 * last value it rendered on the node, sees no change, and the next render puts
 * the old text back. Going through the prototype's setter and dispatching a
 * bubbling `input` event is what React's own synthetic event system listens
 * for, so the field's `onChange` runs exactly as if the value had been typed.
 */
function writeIntoField(field: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

  // `Reflect.set` with the element as the receiver runs the prototype's setter
  // with `this` bound to the element -- the same thing as pulling the setter
  // off the descriptor and calling it, without lifting a method off its object.
  if (!Reflect.set(prototype, 'value', value, field)) return false;

  field.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function Tape({ state }: { state: CalculatorState }) {
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [state.tape]);

  return (
    <ScrollArea className="h-20 border-b sm:h-28">
      <div className="flex flex-col px-3 py-2 font-mono text-xs tabular-nums">
        {state.tape.length === 0 ? (
          <p className="text-muted-foreground py-1 text-center font-sans">
            Nothing on the tape yet.
          </p>
        ) : (
          state.tape.map((line) => (
            <div
              key={line.id}
              className={cn(
                'flex items-baseline justify-end gap-2 py-0.5',
                line.total && 'border-t font-medium',
              )}
            >
              <span className="text-muted-foreground w-4 shrink-0 text-left">{line.marker}</span>
              <span className="min-w-0 truncate">{line.value}</span>
            </div>
          ))
        )}
        <div ref={end} />
      </div>
    </ScrollArea>
  );
}

function CalculatorBody({ onClose }: { onClose: () => void }) {
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE);
  const target = useCalculatorStore((s) => s.target);
  const display = useRef<HTMLDivElement>(null);

  // The display takes focus rather than a key, so Enter means "=" from the
  // moment the panel opens and no key looks pressed before anybody presses one.
  useEffect(() => {
    display.current?.focus();
  }, []);

  const putInField = useCallback(() => {
    if (target === null) return;
    if (!writeIntoField(target, state.display)) {
      toast.add({
        type: 'error',
        title: 'Could not fill the field',
        description: 'Copy the total instead.',
      });
      return;
    }
    onClose();
    // After the panel closes, so the field is not fighting the dialog for focus.
    requestAnimationFrame(() => {
      target.focus();
    });
    toast.add({ type: 'success', title: 'Total put in the field', description: state.display });
  }, [onClose, state.display, target]);

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(state.display)
      .then(() => {
        toast.add({ type: 'success', title: 'Total copied', description: state.display });
      })
      .catch((error: unknown) => {
        toast.add({
          type: 'error',
          title: 'Could not copy the total',
          description: error instanceof Error ? error.message : 'The clipboard refused.',
        });
      });
  }, [state.display]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.metaKey) return;

    if (event.ctrlKey) {
      // The one modifier combination the panel owns: send the total where the
      // person was working.
      if (event.key === 'Enter' && target !== null) {
        event.preventDefault();
        putInField();
      }
      return;
    }

    const onKeypadButton =
      event.target instanceof HTMLElement && event.target.closest('button') !== null;
    if (onKeypadButton && (event.key === 'Enter' || event.key === ' ')) return;

    const action = actionForKey(event);
    if (action === null) return;
    event.preventDefault();
    dispatch(action);
  }

  return (
    // The panel is the keyboard surface. Nothing here is only reachable by key:
    // every action it handles is also one of the buttons below, so a pointer or
    // a screen reader loses nothing by the handler existing.
    //
    // `min-w-0` is load-bearing: the footer's hint is the widest thing in here
    // by max-content, and without it the keypad grid sized itself to that text
    // and hung 85px off the right edge of the dialog. Seen in a screenshot, not
    // in the markup.
    <div className="flex min-w-0 flex-col" onKeyDown={onKeyDown}>
      <Tape state={state} />

      <div
        ref={display}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        aria-label="Calculator display"
        className="bg-muted/60 flex min-h-14 items-center justify-end gap-3 border-b px-3 outline-none"
      >
        {hasMemory(state) ? (
          <span className="text-muted-foreground shrink-0 font-mono text-xs">M</span>
        ) : null}
        <span
          className={cn(
            'min-w-0 truncate font-mono tabular-nums',
            state.error === null ? 'text-2xl' : 'text-destructive text-sm',
          )}
        >
          {state.display}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-1 p-2">
        {KEYPAD.flatMap((row, rowIndex) =>
          row.map((key) => (
            <Button
              key={`${String(rowIndex)}-${key.label}`}
              type="button"
              variant={key.variant ?? 'default'}
              // A taller key than the default so the keypad reads as a keypad.
              // The painted height already clears 44px, so the Button's own
              // coarse-pointer reach needs no help.
              className={cn(
                // 3D key: it stands raised on a soft shadow and sinks under the
                // finger. transform + shadow only, and 75ms, so a key pressed
                // fifty times a minute stays instant (emil-design-eng).
                'h-11 rounded-lg font-mono text-sm shadow-md transition-[transform,box-shadow] duration-75 active:translate-y-0.5 active:shadow-sm motion-reduce:transition-none motion-reduce:active:translate-y-0',
                key.span === 2 && 'col-span-2',
                key.className,
              )}
              aria-label={key.ariaLabel ?? key.label}
              onClick={(event) => {
                dispatch(key.action);
                // Focus goes back to the display after a *pointer* press, so
                // the next Enter is `=` rather than a second press of whichever
                // key the mouse left focused. `detail` is 0 when the click came
                // from Enter or Space on a focused button, and stealing focus
                // there would break tabbing through the keypad.
                if (event.detail > 0) display.current?.focus();
              }}
            >
              {key.label}
            </Button>
          )),
        )}
      </div>

      <div className="flex items-center gap-2 border-t p-2">
        <Button variant="ghost" size="sm" onClick={copy}>
          <CopySimpleIcon data-icon="inline-start" />
          Copy
        </Button>
        {target === null ? (
          <p className="text-muted-foreground min-w-0 truncate text-xs">
            Open from a field to insert there.
          </p>
        ) : (
          <Button variant="outline" size="sm" onClick={putInField}>
            <TextAlignRightIcon data-icon="inline-start" />
            Put in field
            <ShortcutHint keys="ctrl+enter" className="ml-1 hidden sm:inline-flex" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Backspace"
          onClick={(event) => {
            dispatch({ kind: 'backspace' });
            if (event.detail > 0) display.current?.focus();
          }}
        >
          <BackspaceIcon />
        </Button>
      </div>
    </div>
  );
}

/**
 * The header trigger, so the shortcut has a control to hang its hint chip on.
 *
 * PRD §6.4: "Every control with a shortcut renders a small hint chip showing
 * the key." A shortcut with no control anywhere has nowhere to put one -- it
 * would exist only in the Ctrl+F1 sheet, which is where you look once you
 * already suspect it is there. Drop this beside the Go To button in
 * `app/layout/app-shell.tsx`; it needs no props and drives the same store the
 * key does, so the two cannot disagree about whether the panel is up.
 */
export function CalculatorButton({ className }: { className?: string }) {
  const toggle = useCalculatorStore((s) => s.toggle);

  return (
    /*
     * The key is advertised in the tooltip rather than in a chip beside the
     * icon. Both keys still appear, as §6.4 requires for a browser-reserved
     * one — but permanently, the pair rendered five chips ("Ctrl N or Alt N")
     * next to a 20px icon and made this the widest control in a 56px header
     * at 154px. The tooltip is owned here rather than applied by the shell so
     * that the component still carries its own advertisement, and the test
     * that enforces §6.4 has something local to assert against.
     */
    <HeaderTooltip label="Calculator" keys="ctrl+n" alias="alt+n">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Calculator"
        className={cn(className)}
        onClick={toggle}
      >
        <CalculatorIcon />
      </Button>
    </HeaderTooltip>
  );
}

/**
 * Mount once, app-wide, beside `GoToPalette` and `ShortcutDialog` in
 * `app/layout/app-shell.tsx` -- outside the screen's `ShortcutLayer`, so the
 * toggle registers in the root layer and is reachable from every screen.
 */
export function CalculatorPanel() {
  const isMobile = useIsMobile();
  const open = useCalculatorStore((s) => s.open);
  const setOpen = useCalculatorStore((s) => s.setOpen);
  const toggle = useCalculatorStore((s) => s.toggle);

  useShortcut({
    id: 'global.calculator',
    keys: 'ctrl+n',
    alias: 'alt+n',
    label: 'Calculator',
    scope: 'global',
    run: toggle,
  });

  const close = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const body = open ? (
    // A layer of its own, so the screen underneath keeps its keys but stops
    // answering them while the calculator is up (PRD §6.4).
    <ShortcutLayer id="modal:calculator">
      <CalculatorBody onClose={close} />
    </ShortcutLayer>
  ) : null;

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="gap-0 p-0">
          <SheetTitle className="sr-only">Calculator</SheetTitle>
          <SheetDescription className="sr-only">
            A four-function calculator with a tape and memory keys. Type digits and operators.
          </SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* `block` rather than the DialogContent default of `grid`. A grid track
          sizes to its item's max-content, which no `max-width` on the popup
          clamps, so the keypad was drawn wider than the surface behind it.
          A block box constrains its child to the width it actually has. */}
      <DialogContent
        className="block max-w-[calc(100%-2rem)] overflow-hidden p-0 sm:max-w-xs"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Calculator</DialogTitle>
        <DialogDescription className="sr-only">
          A four-function calculator with a tape and memory keys. Type digits and operators.
        </DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}
