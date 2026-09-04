import { describe, expect, it } from 'vitest';

import { dayLoads, tasksByDueDate, undated } from './calendar-series';
import type { Task } from './types';

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
    coverFileId: null,
    coverUrl: null,
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

describe('tasksByDueDate', () => {
  it('groups by the day, keying a timestamp by its date', () => {
    const grouped = tasksByDueDate([
      task({ id: 'a', dueDate: '2026-09-10' }),
      task({ id: 'b', dueDate: '2026-09-10T18:30:00Z' }),
      task({ id: 'c', dueDate: '2026-09-11' }),
    ]);
    expect(grouped.get('2026-09-10')?.map((t) => t.id)).toEqual(['a', 'b']);
    expect(grouped.get('2026-09-11')?.map((t) => t.id)).toEqual(['c']);
  });

  it('places nothing for a task with no due date', () => {
    expect(tasksByDueDate([task({ dueDate: null })]).size).toBe(0);
  });
});

describe('dayLoads', () => {
  it('counts open and closed separately, because a closed task is not a load', () => {
    const loads = dayLoads(
      [task({ id: 'a' }), task({ id: 'b', isClosed: true })],
      TODAY,
    );
    expect(loads.get('2026-09-10')).toMatchObject({ open: 1, closed: 1 });
  });

  it('calls a day late only once it is behind, never on the day itself', () => {
    // The distinction the whole screen turns on: due today is not late yet.
    const loads = dayLoads(
      [task({ id: 'a', dueDate: '2026-09-09' }), task({ id: 'b', dueDate: '2026-09-10' })],
      TODAY,
    );
    expect(loads.get('2026-09-09')?.overdue).toBe(1);
    expect(loads.get('2026-09-10')?.overdue).toBe(0);
  });

  it('never reports more overdue than open', () => {
    // A closed task on a past day is done, not late.
    const loads = dayLoads([task({ dueDate: '2026-09-01', isClosed: true })], TODAY);
    const load = loads.get('2026-09-01');
    expect(load?.open).toBe(0);
    expect(load?.overdue).toBe(0);
  });

  it('has nothing to draw for an empty month', () => {
    expect(dayLoads([], TODAY).size).toBe(0);
  });
});

describe('undated', () => {
  it('names the tasks a calendar cannot place, so they are not lost', () => {
    const rows = undated([task({ id: 'a', dueDate: null }), task({ id: 'b' })]);
    expect(rows.map((t) => t.id)).toEqual(['a']);
  });
});
