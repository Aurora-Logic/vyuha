import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { comboMatchesEvent, parseCombo, type KeyCombo } from './combo';

export type ShortcutScope = 'global' | 'screen' | 'modal' | 'field';

export interface ShortcutDefinition {
  id: string;
  /** TallyPrime key, e.g. "alt+g" (PRD §6.4). */
  keys: string;
  /**
   * Documented fallback for a key the browser reserves. PRD §6.4 requires
   * both to be registered and both to be shown on the hint: the Tally key
   * works in the installed PWA and wherever the browser permits, the alias
   * works everywhere.
   */
  alias?: string;
  label: string;
  scope: ShortcutScope;
  /** Permission or state gating. Re-evaluated on every keypress. */
  when?: () => boolean;
  /**
   * Technical design §9: shortcuts do not fire while a text input has focus,
   * except Ctrl+A, Esc, Alt+C, and Ctrl+N — matching Tally.
   */
  allowInInput?: boolean;
  run: (event: KeyboardEvent) => void;
}

export interface RegisteredShortcut {
  id: string;
  keys: string;
  alias?: string;
  label: string;
  scope: ShortcutScope;
  layerId: string;
  combos: KeyCombo[];
}

/**
 * Actions and state are separate contexts on purpose.
 *
 * With one combined value, `useShortcut` would depend on a context object that
 * changes every time any shortcut registers — so registering would re-render,
 * which would re-run the effect, which would register again. That is an
 * infinite loop, and it is not theoretical: it shipped in the first version of
 * this file and only showed up as "Maximum update depth exceeded" in the
 * browser console.
 *
 * The actions object is referentially stable for the life of the provider.
 * Only consumers that actually need the shortcut list subscribe to state.
 */
interface ShortcutActions {
  register: (entry: RegisteredShortcut, handlers: HandlerRef) => () => void;
  pushLayer: (layerId: string) => () => void;
}

interface ShortcutState {
  shortcuts: RegisteredShortcut[];
  activeLayerId: string;
}

interface HandlerRef {
  current: Pick<ShortcutDefinition, 'run' | 'when'>;
}

const ActionsContext = createContext<ShortcutActions | null>(null);
const StateContext = createContext<ShortcutState>({ shortcuts: [], activeLayerId: 'root' });
const LayerContext = createContext<string>('root');

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function ShortcutProvider({ children }: { children: ReactNode }) {
  // The map is the source of truth for the keydown handler, which must see the
  // latest registrations without re-subscribing on every change. The state
  // mirror exists so React consumers (the Ctrl+F1 sheet) re-render, and so
  // nothing has to read a ref during render.
  const entriesRef = useRef(new Map<string, { entry: RegisteredShortcut; handlers: HandlerRef }>());
  const layersRef = useRef<string[]>(['root']);
  const [state, setState] = useState<ShortcutState>({ shortcuts: [], activeLayerId: 'root' });

  const bump = useCallback(() => {
    setState({
      shortcuts: [...entriesRef.current.values()].map((v) => v.entry),
      activeLayerId: layersRef.current[layersRef.current.length - 1] ?? 'root',
    });
  }, []);

  const register = useCallback(
    (entry: RegisteredShortcut, handlers: HandlerRef) => {
      const map = entriesRef.current;

      if (import.meta.env.DEV) {
        for (const existing of map.values()) {
          if (
            existing.entry.id !== entry.id &&
            existing.entry.layerId === entry.layerId &&
            existing.entry.keys === entry.keys
          ) {
            // Technical design §9: a duplicate key in the same scope throws in
            // development. Two controls silently fighting over one key is the
            // failure mode this subsystem exists to prevent.
            throw new Error(
              `Shortcut "${entry.keys}" is already registered in layer "${entry.layerId}" ` +
                `by "${existing.entry.id}"; "${entry.id}" tried to take it.`,
            );
          }
        }
      }

      map.set(entry.id, { entry, handlers });
      bump();

      return () => {
        map.delete(entry.id);
        bump();
      };
    },
    [bump],
  );

  const pushLayer = useCallback(
    (layerId: string) => {
      layersRef.current = [...layersRef.current, layerId];
      bump();
      return () => {
        layersRef.current = layersRef.current.filter((l) => l !== layerId);
        bump();
      };
    },
    [bump],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat) return;

      const topLayer = layersRef.current[layersRef.current.length - 1] ?? 'root';
      const editable = isEditableTarget(event.target);

      for (const { entry, handlers } of entriesRef.current.values()) {
        // Only the top layer plus global shortcuts fire, so an open modal
        // suspends the screen underneath it.
        if (entry.scope !== 'global' && entry.layerId !== topLayer) continue;
        if (editable && !allowsInput(entry)) continue;
        if (!entry.combos.some((combo) => comboMatchesEvent(combo, event))) continue;
        if (handlers.current.when && !handlers.current.when()) continue;

        event.preventDefault();
        event.stopPropagation();
        handlers.current.run(event);
        return;
      }
    }

    // Capture phase, so a shortcut is not swallowed by a component that
    // stops propagation on its own container.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  const actions = useMemo<ShortcutActions>(
    () => ({ register, pushLayer }),
    [register, pushLayer],
  );

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ActionsContext.Provider>
  );
}

const INPUT_SAFE_KEYS = new Set(['ctrl+a', 'escape', 'esc', 'alt+c', 'ctrl+n', 'alt+n']);

function allowsInput(entry: RegisteredShortcut): boolean {
  return INPUT_SAFE_KEYS.has(entry.keys.toLowerCase());
}

function useActions(): ShortcutActions {
  const actions = useContext(ActionsContext);
  if (!actions) {
    throw new Error('useShortcut must be used inside a <ShortcutProvider>');
  }
  return actions;
}

/** Registers a shortcut for the lifetime of the calling component. */
export function useShortcut(definition: ShortcutDefinition): void {
  const { register } = useActions();
  const layerId = useContext(LayerContext);

  // `run` and `when` are re-read on every keypress, so a component may close
  // over fresh state without re-registering on every render. Updated in an
  // effect rather than during render — a ref write during render is a real
  // hazard under concurrent rendering, not a lint technicality.
  const handlers = useRef({ run: definition.run, when: definition.when });

  useEffect(() => {
    handlers.current = { run: definition.run, when: definition.when };
  });

  const { id, keys, alias, label, scope, allowInInput } = definition;

  useEffect(() => {
    const combos = [parseCombo(keys)];
    if (alias) combos.push(parseCombo(alias));

    const entry: RegisteredShortcut = { id, keys, label, scope, layerId, combos };
    if (alias) entry.alias = alias;

    return register(entry, handlers);
  }, [register, id, keys, alias, label, scope, layerId, allowInInput]);
}

/**
 * Pushes a scope onto the stack. Everything rendered inside registers into it,
 * and only the topmost layer's shortcuts fire.
 */
export function ShortcutLayer({ id, children }: { id: string; children: ReactNode }) {
  const { pushLayer } = useActions();

  useEffect(() => pushLayer(id), [pushLayer, id]);

  return <LayerContext.Provider value={id}>{children}</LayerContext.Provider>;
}

/** Every currently registered shortcut, for the Ctrl+F1 reference sheet. */
export function useRegisteredShortcuts(): RegisteredShortcut[] {
  return useContext(StateContext).shortcuts;
}
