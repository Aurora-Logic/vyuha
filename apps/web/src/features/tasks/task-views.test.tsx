import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';

import { TaskCalendar } from './task-calendar';
import { TaskGallery } from './task-gallery';
import { TaskTimeline } from './task-timeline';
import type { Task } from './types';

/**
 * The three new views actually rendering.
 *
 * Their arithmetic is covered by calendar-series and timeline-series, which
 * is the part worth reasoning about — but a pure function passing says
 * nothing about whether the component around it mounts. These are the cheap
 * check that it does, that every task reaches the screen, and that clicking
 * one opens it.
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
    dueDate: '2026-09-10',
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

const TODAY = '2026-09-10';

describe('TaskCalendar', () => {
  it('renders the month and lists what is due in it', () => {
    renderWithProviders(
      <TaskCalendar tasks={[task({ title: 'Quote the busbar job' })]} onOpen={() => {}} today={TODAY} />,
    );
    expect(screen.getByRole('grid')).toBeTruthy();
    expect(screen.getByText('Quote the busbar job')).toBeTruthy();
  });

  it('says how many tasks it could not place rather than dropping them silently', () => {
    renderWithProviders(
      <TaskCalendar
        tasks={[task({ id: 'a', dueDate: null }), task({ id: 'b', dueDate: null })]}
        onOpen={() => {}}
        today={TODAY}
      />,
    );
    expect(screen.getByText('2 tasks have no due date and are not on this grid.')).toBeTruthy();
  });
});

describe('TaskGallery', () => {
  it('shows a card per task, with every item named on it', () => {
    renderWithProviders(
      <TaskGallery
        tasks={[
          task({
            id: 'a',
            title: 'Quote the busbar job',
            partyName: 'S P Enterprises',
            items: [
              { itemId: 'i-1', itemName: 'MCCB 100A 3P' },
              { itemId: 'i-2', itemName: 'Contactor 25A' },
            ],
          }),
        ]}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('S P Enterprises')).toBeTruthy();
    expect(screen.getByText('MCCB 100A 3P')).toBeTruthy();
    expect(screen.getByText('Contactor 25A')).toBeTruthy();
  });

  it('opens the task it was clicked on', async () => {
    const onOpen = vi.fn();
    renderWithProviders(<TaskGallery tasks={[task({ id: 'a' })]} onOpen={onOpen} />);
    await userEvent.click(screen.getByText('Quote the busbar job'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });
});

describe('TaskTimeline', () => {
  it('draws a bar per dated task and can be clicked open', async () => {
    const onOpen = vi.fn();
    renderWithProviders(
      <TaskTimeline
        tasks={[task({ id: 'a', createdAt: '2026-09-01T00:00:00Z', dueDate: '2026-09-08' })]}
        onOpen={onOpen}
        today={TODAY}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Quote the busbar job/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('says there is nothing to draw rather than rendering an empty frame', () => {
    renderWithProviders(<TaskTimeline tasks={[task({ dueDate: null })]} onOpen={() => {}} today={TODAY} />);
    expect(screen.getByText('Nothing here has a due date, so there is no span to draw.')).toBeTruthy();
  });
});
