import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * REQ-V-11: which blocks the task dashboard shows, and in what order.
 *
 * Owner, 1 Sep 2026, asked for either more detail or the ability to
 * customise, and chose customising. The reason it is the better answer is
 * that "more detail" has no end: operations wants the board columns and who
 * is on shift, a manager wants flow and days-to-close, and the owner wants
 * two numbers and nothing else. A fixed page is wrong for two of those three
 * whatever is on it.
 *
 * The card-fields store beside this one already settled the shape of this
 * problem, so this follows it exactly rather than inventing a second one:
 * localStorage, because it belongs to this person on this device and losing
 * it costs a few clicks; and a merge that lets a block added later arrive
 * visible instead of silently off.
 *
 * Order is moved a step at a time rather than dragged. A drag needs a pointer
 * and this product is keyboard-first (CLAUDE.md section 3 rule 6) -- and a
 * menu of eight rows with two arrows each is a great deal less code than a
 * drag surface that then needs a keyboard alternative anyway.
 */

export const TASK_DASHBOARD_BLOCKS = [
  { key: 'open', label: 'Open' },
  { key: 'workingNow', label: 'Working now' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'priority', label: 'By priority' },
  { key: 'insights', label: 'What the numbers say' },
  { key: 'columns', label: 'Where work is sitting' },
  { key: 'load', label: 'Who is carrying it' },
  { key: 'flow', label: 'Raised and closed' },
] as const;

export type TaskDashboardBlock = (typeof TASK_DASHBOARD_BLOCKS)[number]['key'];

const DEFAULT_ORDER: TaskDashboardBlock[] = TASK_DASHBOARD_BLOCKS.map((block) => block.key);

const ALL_SHOWN = Object.fromEntries(DEFAULT_ORDER.map((key) => [key, true])) as Record<
  TaskDashboardBlock,
  boolean
>;

interface TaskDashboardState {
  readonly shown: Record<TaskDashboardBlock, boolean>;
  readonly order: readonly TaskDashboardBlock[];
  toggle: (block: TaskDashboardBlock) => void;
  /** One step up or down. Already at the end is a no-op, not a wrap. */
  move: (block: TaskDashboardBlock, direction: -1 | 1) => void;
  reset: () => void;
}

/** Exported for the test: the reordering is the only real logic here. */
export function moved(
  order: readonly TaskDashboardBlock[],
  block: TaskDashboardBlock,
  direction: -1 | 1,
): TaskDashboardBlock[] {
  const from = order.indexOf(block);
  const to = from + direction;
  // Off either end stays put. Wrapping would move a block the length of the
  // list from one click, which is never what the click meant.
  if (from === -1 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  const [lifted] = next.splice(from, 1);
  if (lifted === undefined) return [...order];
  next.splice(to, 0, lifted);
  return next;
}

/**
 * The stored order, reconciled with the blocks that actually exist.
 *
 * Exported so the test drives this rather than a copy of it: a saved layout
 * is the one thing here that outlives a deploy, and the bug it invites --
 * a block added later arriving hidden, or one removed lingering forever --
 * only shows up on somebody's machine weeks after the change.
 */
export function mergedOrder(saved: readonly string[] | undefined): TaskDashboardBlock[] {
  const known = (saved ?? []).filter((key): key is TaskDashboardBlock =>
    (DEFAULT_ORDER as string[]).includes(key),
  );
  return [...known, ...DEFAULT_ORDER.filter((key) => !known.includes(key))];
}

export const useTaskDashboardBlocks = create<TaskDashboardState>()(
  persist(
    (set) => ({
      shown: ALL_SHOWN,
      order: DEFAULT_ORDER,
      toggle: (block) => {
        set((state) => ({ shown: { ...state.shown, [block]: !state.shown[block] } }));
      },
      move: (block, direction) => {
        set((state) => ({ order: moved(state.order, block, direction) }));
      },
      reset: () => {
        set({ shown: ALL_SHOWN, order: DEFAULT_ORDER });
      },
    }),
    {
      name: 'vyuha.task-dashboard-blocks',
      merge: (persisted, current) => {
        const saved = persisted as
          | { shown?: Partial<Record<TaskDashboardBlock, boolean>>; order?: TaskDashboardBlock[] }
          | undefined;
        return {
          ...current,
          shown: { ...ALL_SHOWN, ...(saved?.shown ?? {}) },
          order: mergedOrder(saved?.order),
        };
      },
    },
  ),
);
