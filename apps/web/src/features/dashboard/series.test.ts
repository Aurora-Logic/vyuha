import { describe, expect, it } from 'vitest';

import type { AttendanceDay } from '@/features/attendance/types';

import {
  attendanceInsight,
  attendanceTrend,
  dateRange,
  lateArrivals,
  lateInsight,
  ownHours,
  teamHours,
  teamHoursInsight,
} from './series';

/**
 * The dashboard's series had no test at all, which is how it came to be the
 * one feature building charts nobody could check. Adding the team series is
 * the occasion to fix that rather than make it a fourth untested copy.
 */
function day(over: Partial<AttendanceDay> & { date: string; employeeId?: string }): AttendanceDay {
  const { employeeId = 'e1', ...rest } = over;
  return {
    id: `${over.date}:${employeeId}`,
    employee: { id: employeeId, name: employeeId },
    shiftName: null,
    scheduledIn: null,
    scheduledOut: null,
    firstIn: null,
    lastOut: null,
    status: 'PRESENT',
    workedMinutes: 0,
    otMinutes: 0,
    lateMinutes: 0,
    earlyExitMinutes: 0,
    earlyArrival: false,
    earlyStreak: 0,
    flags: [],
    ...rest,
  };
}

describe('dateRange', () => {
  it('gives every day inclusive of both ends', () => {
    expect(dateRange('2026-08-01', '2026-08-04')).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
    ]);
  });

  it('is empty rather than throwing on a reversed or unreadable range', () => {
    expect(dateRange('2026-08-04', '2026-08-01')).toEqual([]);
    expect(dateRange('not a date', '2026-08-01')).toEqual([]);
  });

  it('caps at a year, because a longer axis is unreadable anyway', () => {
    expect(dateRange('2020-01-01', '2026-01-01')).toHaveLength(366);
  });
});

describe('teamHours', () => {
  const dates = ['2026-08-01', '2026-08-02'];

  it('adds everyone up and counts who actually worked', () => {
    const points = teamHours(
      [
        day({ date: '2026-08-01', employeeId: 'a', workedMinutes: 480 }),
        day({ date: '2026-08-01', employeeId: 'b', workedMinutes: 240 }),
        day({ date: '2026-08-02', employeeId: 'a', workedMinutes: 600 }),
      ],
      dates,
    );
    expect(points[0]).toMatchObject({ hours: 12, people: 2, averageHours: 6 });
    expect(points[1]).toMatchObject({ hours: 10, people: 1, averageHours: 10 });
  });

  it('does not count a person who worked nothing as present in the average', () => {
    const points = teamHours(
      [
        day({ date: '2026-08-01', employeeId: 'a', workedMinutes: 480 }),
        day({ date: '2026-08-01', employeeId: 'b', status: 'ABSENT', workedMinutes: 0 }),
      ],
      dates,
    );
    // Eight hours over one person, not over two -- an absent day must not drag
    // the average to four.
    expect(points[0]).toMatchObject({ hours: 8, people: 1, averageHours: 8 });
  });

  it('gives every date a point even when nobody worked', () => {
    const points = teamHours([], dates);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ hours: 0, people: 0, averageHours: 0 });
  });

  it('ignores a day outside the range and a negative minute count', () => {
    const points = teamHours(
      [
        day({ date: '2026-07-30', workedMinutes: 480 }),
        day({ date: '2026-08-01', workedMinutes: -60 }),
      ],
      dates,
    );
    expect(points[0]?.hours).toBe(0);
  });
});

describe('ownHours', () => {
  it('keeps overtime beside worked minutes rather than stacking it', () => {
    const points = ownHours(
      [day({ date: '2026-08-01', workedMinutes: 480, otMinutes: 60 })],
      ['2026-08-01'],
    );
    expect(points[0]).toMatchObject({ hours: 8, workedMinutes: 480, otMinutes: 60 });
  });
});

describe('attendanceTrend', () => {
  it('bands each day by status group', () => {
    const points = attendanceTrend(
      [
        day({ date: '2026-08-01', status: 'PRESENT' }),
        day({ date: '2026-08-01', status: 'ON_LEAVE' }),
        day({ date: '2026-08-01', status: 'ABSENT' }),
        day({ date: '2026-08-01', status: 'WEEKLY_OFF' }),
      ],
      ['2026-08-01'],
    );
    expect(points[0]).toMatchObject({ work: 1, leave: 1, absent: 1, other: 1 });
  });
});

describe('lateArrivals', () => {
  it('counts people, not minutes, and treats an early arrival as not late', () => {
    const points = lateArrivals(
      [
        day({ date: '2026-08-01', lateMinutes: 30 }),
        day({ date: '2026-08-01', lateMinutes: 5 }),
        day({ date: '2026-08-01', lateMinutes: -20 }),
      ],
      ['2026-08-01'],
    );
    expect(points[0]).toMatchObject({ late: 2, minutes: 35 });
  });
});

describe('attendanceInsight', () => {
  const full = (date: string, work: number, absent: number) => ({ date, work, leave: 0, absent, other: 0 });

  it('refuses a pattern from too few days', () => {
    expect(attendanceInsight([full('2026-08-01', 5, 0)])).toBe(
      'Not enough days recorded in this period to read a pattern.',
    );
  });

  it('counts the days that ran thin', () => {
    const days = Array.from({ length: 6 }, (_, i) => full(`2026-08-0${String(i + 1)}`, i < 2 ? 5 : 9, i < 2 ? 5 : 1));
    expect(attendanceInsight(days)).toBe('2 of 6 days had under 70% of those due in at work.');
  });

  it('says so when every day held up', () => {
    const days = Array.from({ length: 6 }, (_, i) => full(`2026-08-0${String(i + 1)}`, 9, 1));
    expect(attendanceInsight(days)).toContain('every one of these 6 days');
  });

  it('ignores days with nothing recorded rather than counting them as thin', () => {
    const days = [...Array.from({ length: 5 }, (_, i) => full(`2026-08-0${String(i + 1)}`, 9, 1)), full('2026-08-06', 0, 0)];
    expect(attendanceInsight(days)).toContain('these 5 days');
  });

  it('has no sentence for an empty period', () => {
    expect(attendanceInsight([])).toBeNull();
  });
});

describe('lateInsight', () => {
  it('reports the count, the average and the worst day', () => {
    expect(
      lateInsight([
        { date: '2026-08-01', late: 1, minutes: 10 },
        { date: '2026-08-02', late: 3, minutes: 50 },
      ]),
    ).toBe('4 late arrivals, 15 minutes each on average; the worst day was 2 Aug.');
  });

  it('says so when nobody was late', () => {
    expect(lateInsight([{ date: '2026-08-01', late: 0, minutes: 0 }])).toBe(
      'Nobody arrived late in this period.',
    );
  });

  it('has no sentence with no days', () => {
    expect(lateInsight([])).toBeNull();
  });
});

describe('teamHoursInsight', () => {
  it('averages only the days somebody worked', () => {
    const points = teamHours(
      [
        day({ date: '2026-08-01', employeeId: 'a', workedMinutes: 480 }),
        day({ date: '2026-08-02', employeeId: 'a', workedMinutes: 240 }),
      ],
      ['2026-08-01', '2026-08-02', '2026-08-03'],
    );
    // Six hours across the two worked days, not four across three.
    expect(teamHoursInsight(points)).toContain('averaged 6 hours a person on the 2 days');
  });

  it('has no sentence when nobody worked', () => {
    expect(teamHoursInsight(teamHours([], ['2026-08-01']))).toBeNull();
  });
});
