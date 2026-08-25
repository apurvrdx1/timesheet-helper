import { describe, it, expect } from 'vitest';
import {
  mondayOf, weekDays, weeksTouchingMonth, monthOf,
  datesInRange, addDays, formatWeekRange,
} from './calendar';

describe('mondayOf', () => {
  it('returns the Monday of the containing week', () => {
    expect(mondayOf('2026-09-01')).toBe('2026-08-31'); // Tue -> prev Mon
    expect(mondayOf('2026-08-31')).toBe('2026-08-31'); // Mon -> itself
    expect(mondayOf('2026-09-04')).toBe('2026-08-31'); // Fri -> that Mon
  });

  it('treats Saturday and Sunday as belonging to the preceding week', () => {
    expect(mondayOf('2026-09-05')).toBe('2026-08-31'); // Sat
    expect(mondayOf('2026-09-06')).toBe('2026-08-31'); // Sun
  });
});

describe('weekDays', () => {
  it('returns exactly five weekdays', () => {
    expect(weekDays('2026-08-31')).toEqual([
      '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
    ]);
  });
});

describe('weeksTouchingMonth', () => {
  it('includes the week that starts in the previous month', () => {
    // Sept 2026 starts Tue 1st, so week 1 begins Mon Aug 31.
    const weeks = weeksTouchingMonth('2026-09');
    expect(weeks[0]).toBe('2026-08-31');
  });

  it('includes the week that runs into the next month', () => {
    // Sept 2026 ends Wed 30th; that week began Mon Sep 28.
    const weeks = weeksTouchingMonth('2026-09');
    expect(weeks[weeks.length - 1]).toBe('2026-09-28');
  });

  it('returns ascending Mondays with no duplicates', () => {
    const weeks = weeksTouchingMonth('2026-09');
    expect(weeks).toEqual([...weeks].sort());
    expect(new Set(weeks).size).toBe(weeks.length);
    expect(weeks.length).toBe(5);
  });
});

describe('monthOf', () => {
  it('assigns each day to its own calendar month', () => {
    expect(monthOf('2026-08-31')).toBe('2026-08');
    expect(monthOf('2026-09-01')).toBe('2026-09');
  });
});

describe('datesInRange', () => {
  it('expands a range to weekdays only', () => {
    expect(datesInRange('2026-09-14', '2026-09-18')).toEqual([
      '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
    ]);
  });

  it('drops weekends inside the range', () => {
    expect(datesInRange('2026-09-04', '2026-09-07')).toEqual([
      '2026-09-04', '2026-09-07',
    ]);
  });

  it('returns empty when end precedes start', () => {
    expect(datesInRange('2026-09-10', '2026-09-01')).toEqual([]);
  });
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31');
  });
});

describe('formatWeekRange', () => {
  it('spells out a straddling week', () => {
    expect(formatWeekRange('2026-08-31')).toBe('31 Aug – 4 Sep 2026');
  });

  it('omits the repeated month within one month', () => {
    expect(formatWeekRange('2026-09-07')).toBe('7 – 11 Sep 2026');
  });
});
