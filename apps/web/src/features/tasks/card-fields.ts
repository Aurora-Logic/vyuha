import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * REQ-V-13: which details a task card and a task row carry.
 *
 * A task now knows nine things about itself, and showing all nine on a card
 * turns a board into a wall of text — but which nine matter depends entirely
 * on the desk. Operations wants the supplier and the items; a manager wants
 * the assignee and the due date; nobody wants all of them at once, and no
 * default is right for both. So everything is shown, and anything can be
 * hidden.
 *
 * A UI preference, so localStorage — the same reasoning as the view-mode
 * store beside it: it belongs to this person on this device, and losing it
 * costs a few clicks rather than any work.
 *
 * The title is not in the list. A card with no title is not a card.
 */

export const TASK_CARD_FIELDS = [
  { key: 'priority', label: 'Priority' },
  { key: 'due', label: 'Due date' },
  { key: 'assignee', label: 'Assigned to' },
  { key: 'subject', label: 'Linked record' },
  { key: 'party', label: 'Customer' },
  { key: 'vendor', label: 'Supplier' },
  { key: 'items', label: 'Items' },
  { key: 'attachments', label: 'Attachments' },
] as const;

export type TaskCardField = (typeof TASK_CARD_FIELDS)[number]['key'];

/** Everything on, which is what "I want all the things I can view" asks for. */
const ALL_SHOWN: Record<TaskCardField, boolean> = {
  priority: true,
  due: true,
  assignee: true,
  subject: true,
  party: true,
  vendor: true,
  items: true,
  attachments: true,
};

interface TaskCardFieldState {
  readonly shown: Record<TaskCardField, boolean>;
  toggle: (field: TaskCardField) => void;
  showAll: () => void;
}

export const useTaskCardFields = create<TaskCardFieldState>()(
  persist(
    (set) => ({
      shown: ALL_SHOWN,
      toggle: (field) => {
        set((state) => ({ shown: { ...state.shown, [field]: !state.shown[field] } }));
      },
      showAll: () => {
        set({ shown: ALL_SHOWN });
      },
    }),
    {
      name: 'vyuha.task-card-fields',
      // A stored preference from before a field existed must not hide the new
      // one: the default is merged under whatever was saved, so an added
      // field arrives visible rather than silently off.
      merge: (persisted, current) => {
        const saved = (persisted as { shown?: Partial<Record<TaskCardField, boolean>> } | undefined)?.shown ?? {};
        return { ...current, shown: { ...ALL_SHOWN, ...saved } };
      },
    },
  ),
);
