import { describe, expect, it } from 'vitest';

import { addDays, daysBetween, timelineBars, timelineMonths, timelineWindow } from './timeline-series';
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

const TODAY = '2026-09-05';

describe('daysBetween and addDays', () => {
  it('counts whole days forwards and backwards', () => {
    expect(daysBetween('2026-09-01', '2026-09-10')).toBe(9);
    expect(daysBetween('2026-09-10', '2026-09-01')).toBe(-9);
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(0);
  });

  it('crosses a month and a year without drifting', () => {
    expect(daysBetween('2026-08-30', '2026-09-02')).toBe(3);
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('crosses a leap day', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('answers rather than throwing on a value that is not a date', () => {
    expect(daysBetween('not-a-date', '2026-09-01')).toBe(0);
    expect(addDays('not-a-date', 3)).toBe('not-a-date');
  });
});

describe('timelineWindow', () => {
  it('spans the earliest start to the latest due', () => {
    const window = timelineWindow(
      [
        task({ createdAt: '2026-09-01T00:00:00Z', dueDate: '2026-09-10' }),
        task({ createdAt: '2026-08-20T00:00:00Z', dueDate: '2026-09-30' }),
      ],
      TODAY,
    );
    expect(window).toMatchObject({ start: '2026-08-20', end: '2026-09-30' });
  });

  it('always contains today, so "now" is never off the edge of its own chart', () => {
    const window = timelineWindow([task({ createdAt: '2026-01-01T00:00:00Z', dueDate: '2026-01-05' })], '2026-06-01');
    expect(window?.start).toBe('2026-01-01');
    expect(window?.end).toBe('2026-06-01');
  });

  it('has no window at all when nothing has a due date', () => {
    expect(timelineWindow([task({ dueDate: null })], TODAY)).toBeNull();
  });
});

describe('timelineBars', () => {
  const window = { start: '2026-09-01', end: '2026-09-30', days: 30 };

  it('places a bar from when it was raised to when it is due', () => {
    const [bar] = timelineBars(
      [task({ createdAt: '2026-09-05T00:00:00Z', dueDate: '2026-09-08' })],
      window,
    );
    expect(bar?.offsetDays).toBe(4);
    // Inclusive of both ends: the 5th to the 8th is four days of work.
    expect(bar?.lengthDays).toBe(4);
  });

  it('draws a same-day task as one day rather than nothing', () => {
    const [bar] = timelineBars(
      [task({ createdAt: '2026-09-05T00:00:00Z', dueDate: '2026-09-05' })],
      window,
    );
    expect(bar?.lengthDays).toBe(1);
  });

  it('never draws a bar backwards when a task is due before it was raised', () => {
    // Somebody's typo, not a negative-length task.
    const [bar] = timelineBars(
      [task({ createdAt: '2026-09-20T00:00:00Z', dueDate: '2026-09-10' })],
      window,
    );
    expect(bar?.lengthDays).toBe(1);
    expect(bar?.offsetDays).toBe(9);
  });

  it('clips a task raised before the window rather than going negative', () => {
    const [bar] = timelineBars(
      [task({ createdAt: '2026-07-01T00:00:00Z', dueDate: '2026-09-03' })],
      window,
    );
    expect(bar?.offsetDays).toBe(0);
  });

  it('drops what it cannot place, and orders the rest by where they start', () => {
    const bars = timelineBars(
      [
        task({ id: 'late', createdAt: '2026-09-10T00:00:00Z', dueDate: '2026-09-12' }),
        task({ id: 'undated', dueDate: null }),
        task({ id: 'early', createdAt: '2026-09-02T00:00:00Z', dueDate: '2026-09-04' }),
      ],
      window,
    );
    expect(bars.map((bar) => bar.task.id)).toEqual(['early', 'late']);
  });
});

describe('timelineMonths', () => {
  it('labels each month the window touches, the first at the left edge', () => {
    const months = timelineMonths({ start: '2026-09-15', end: '2026-11-02', days: 49 });
    expect(months.map((m) => m.label)).toEqual(['Sep 26', 'Oct 26', 'Nov 26']);
    expect(months[0]?.offsetDays).toBe(0);
  });

  it('terminates on a window it cannot walk instead of spinning the tab', () => {
    expect(timelineMonths({ start: '2026-01-01', end: '2099-01-01', days: 1 }).length).toBeLessThanOrEqual(120);
  });
});
