import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * REQ-V-05: which rendering of the task query opens by default is a per-user
 * preference. A UI preference, so localStorage — the same reasoning as the
 * bottom-bar store: it belongs to this person on this device and losing it
 * costs one click.
 */
export type TaskViewMode = 'list' | 'board' | 'calendar' | 'gallery' | 'timeline';

/** Every mode, in the order the switcher offers them. */
export const TASK_VIEW_MODES = ['list', 'board', 'calendar', 'gallery', 'timeline'] as const;

export function isTaskViewMode(value: string | null): value is TaskViewMode {
  return value !== null && (TASK_VIEW_MODES as readonly string[]).includes(value);
}

interface TaskViewState {
  defaultView: TaskViewMode;
  setDefaultView: (view: TaskViewMode) => void;
}

export const useTaskViewStore = create<TaskViewState>()(
  persist(
    (set) => ({
      // The list is the keyboard-complete rendering, and the one the phone
      // gets, so it is the default until the person says otherwise.
      defaultView: 'list',
      setDefaultView: (view) => {
        set({ defaultView: view });
      },
    }),
    { name: 'vyuha.task-view' },
  ),
);
