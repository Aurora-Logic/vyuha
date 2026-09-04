import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';

import { TaskBoard } from './task-board';
import type { BoardResponse, Task } from './types';

/**
 * What the owner asked the card to say (1 Sep 2026): "card it shows just 3
 * items I want names of all the items", and "colour the priority".
 *
 * The card used to print "3 items", which is the one fact nobody opens a
 * board to learn -- they are looking to find out WHICH items -- and it
 * printed a chip only for High, so a low-priority task and a task nobody had
 * triaged looked identical.
 */

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    title: 'Quote the busbar job',
    description: '',
    subjectType: null,
    subjectId: null,
    subjectLabel: null,
    assigneeId: null,
    assigneeName: null,
    ownerId: null,
    ownerName: null,
    partyId: null,
    partyName: null,
    vendorId: null,
    vendorName: null,
    items: [],
    attachmentCount: 0,
    coverAttachmentId: null,
    dueDate: null,
    priority: 'MEDIUM',
    columnId: 'c-1',
    columnName: 'To do',
    isClosed: false,
    closedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

function board(one: Task): BoardResponse {
  return {
    lanes: [
      {
        column: { id: 'c-1', name: 'To do', sortOrder: 0, isDone: false },
        tasks: [one],
        total: 1,
      },
    ],
  };
}

function renderBoard(one: Task) {
  renderWithProviders(
    <TaskBoard board={board(one)} onOpen={() => {}} onMove={() => {}} moving={false} />,
  );
}

describe('the task card', () => {
  it('names every item, rather than counting them', () => {
    renderBoard(
      task({
        items: [
          { itemId: 'i-1', itemName: 'MCCB 100A 3P', quantity: '1', rate: null, discountPct: '0', amount: null },
          { itemId: 'i-2', itemName: 'Contactor 25A', quantity: '1', rate: null, discountPct: '0', amount: null },
          { itemId: 'i-3', itemName: 'Relay 240V', quantity: '1', rate: null, discountPct: '0', amount: null },
          { itemId: 'i-4', itemName: 'Busbar 400A', quantity: '1', rate: null, discountPct: '0', amount: null },
        ],
      }),
    );

    for (const name of ['MCCB 100A 3P', 'Contactor 25A', 'Relay 240V', 'Busbar 400A']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    // The count it used to print instead.
    expect(screen.queryByText('4 items')).toBeNull();
  });

  it('colours every priority, not only the urgent one', () => {
    // Each level gets its own hue, so "low" is visibly a decision somebody
    // made rather than the absence of one.
    const hues: Record<string, string> = {
      HIGH: 'text-destructive',
      MEDIUM: 'text-warning',
      LOW: 'text-info',
    };
    for (const [priority, hue] of Object.entries(hues)) {
      const { unmount } = renderWithProviders(
        <TaskBoard
          board={board(task({ priority: priority as Task['priority'] }))}
          onOpen={() => {}}
          onMove={() => {}}
          moving={false}
        />,
      );
      const label = priority === 'HIGH' ? 'High' : priority === 'MEDIUM' ? 'Medium' : 'Low';
      expect(screen.getByText(label).className).toContain(hue);
      unmount();
    }
  });
});

describe('the right-click menu', () => {
  const columns = [
    { id: 'c-1', name: 'To do', sortOrder: 0, isDone: false },
    { id: 'c-2', name: 'Done', sortOrder: 1, isDone: true },
  ];

  function boardWith(one: Task): BoardResponse {
    return {
      lanes: [
        { column: columns[0], tasks: [one], total: 1 },
        { column: columns[1], tasks: [], total: 0 },
      ],
    };
  }

  it('is not offered at all to somebody who may not change anything', () => {
    // No handlers means no menu, rather than a menu whose every item fails.
    renderWithProviders(
      <TaskBoard board={boardWith(task())} onOpen={() => {}} onMove={() => {}} moving={false} />,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: /Open Quote the busbar job/ }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers open, priority, move and delete on a right click', async () => {
    renderWithProviders(
      <TaskBoard
        board={boardWith(task())}
        onOpen={() => {}}
        onMove={() => {}}
        onSetPriority={() => {}}
        onDelete={() => {}}
        moving={false}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: /Open Quote the busbar job/ }));

    const menu = await screen.findByRole('menu');
    for (const label of ['Open', 'Priority', 'Move to', 'Mark done', 'Delete']) {
      expect(within(menu).getByText(label)).toBeTruthy();
    }
  });

  it('sets the priority it was asked for', async () => {
    const onSetPriority = vi.fn();
    renderWithProviders(
      <TaskBoard
        board={boardWith(task({ priority: 'LOW' }))}
        onOpen={() => {}}
        onMove={() => {}}
        onSetPriority={onSetPriority}
        onDelete={() => {}}
        moving={false}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: /Open Quote the busbar job/ }));
    await userEvent.click(await screen.findByText('Priority'));
    await userEvent.click(await screen.findByText('High'));

    expect(onSetPriority).toHaveBeenCalledWith(expect.objectContaining({ id: 't-1' }), 'HIGH');
  });

  it('routes delete through the caller rather than deleting on the spot', async () => {
    // The caller opens the same confirm dialog the sheet uses: a right click
    // is a shortcut to an action, never past the confirmation for a
    // destructive one.
    const onDelete = vi.fn();
    renderWithProviders(
      <TaskBoard
        board={boardWith(task())}
        onOpen={() => {}}
        onMove={() => {}}
        onSetPriority={() => {}}
        onDelete={onDelete}
        moving={false}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: /Open Quote the busbar job/ }));
    await userEvent.click(await screen.findByText('Delete'));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 't-1' }));
  });
});
