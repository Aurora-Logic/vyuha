import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';

import { KanbanBoard, type KanbanLane } from './kanban-board';

/**
 * The board mounts in both layouts without throwing.
 *
 * This test exists because two defects reached a commit while `tsc` and the
 * Vite transform both stayed green, and each threw only when the component
 * actually drew itself: a prop added to the type but left out of the
 * destructuring ("stacked is not defined", which broke every board including
 * the deal pipeline), and a Base UI prop under the wrong name (`openMultiple`
 * where the primitive wants `multiple`, which crashed the stacked layout).
 * A render is the cheapest check that could have caught either.
 */

interface Item {
  readonly id: string;
  readonly laneId: string;
  readonly name: string;
}

const lanes: KanbanLane<Item>[] = [
  {
    id: 'todo',
    label: 'To do',
    title: 'To do',
    items: [{ id: 't1', laneId: 'todo', name: 'Call Acme' }],
    total: 1,
  },
  { id: 'done', label: 'Done', title: 'Done', items: [], total: 0, muted: true },
];

function board(stacked: boolean) {
  return (
    <KanbanBoard
      ariaLabel="Test board"
      stacked={stacked}
      lanes={lanes}
      itemKey={(item) => item.id}
      itemLaneId={(item) => item.laneId}
      itemLabel={(item) => item.name}
      renderItem={(item) => <span>{item.name}</span>}
      onOpen={vi.fn()}
    />
  );
}

describe('KanbanBoard', () => {
  it('mounts the stacked (phone) layout with every lane', () => {
    renderWithProviders(board(true));
    // The lane headers are the disclosure triggers, always rendered; reaching
    // these at all means the stacked Accordion mounted rather than throwing.
    expect(screen.getByText('To do')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it('mounts the horizontal (desktop) layout with its cards', () => {
    renderWithProviders(board(false));
    expect(screen.getByText('Call Acme')).toBeTruthy();
  });
});
