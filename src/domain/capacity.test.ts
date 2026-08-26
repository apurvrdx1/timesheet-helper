import { describe, it, expect } from 'vitest';
import { leaveDatesFor, weekCapacity, opexFloor, capexRoom } from './capacity';
import { weekDays } from './calendar';
import type { Model } from './types';

const emptyModel: Model = {
  otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
};

describe('opexFloor', () => {
  it('is 30 blocks (15.0h) for a full week', () => {
    expect(opexFloor(75)).toBe(30);
  });

  it('scales down with reduced capacity', () => {
    expect(opexFloor(60)).toBe(24); // one day off -> 12.0h
    expect(opexFloor(45)).toBe(18); // two days off -> 9.0h
  });

  it('uses ceiling so a stated minimum is never undershot', () => {
    // 0.4 * 15 = 6 exactly; 0.4 * 25 = 10 exactly; pick a case that is not whole
    expect(opexFloor(7)).toBe(3);  // 2.8 -> 3, not 2
    expect(opexFloor(13)).toBe(6); // 5.2 -> 6, not 5
  });

  it('is zero when there is no capacity', () => {
    expect(opexFloor(0)).toBe(0);
  });
});

describe('capexRoom', () => {
  it('is the complement of the floor', () => {
    expect(capexRoom(75)).toBe(45); // 22.5h
    expect(capexRoom(60)).toBe(36); // 18.0h
  });
});

describe('weekCapacity', () => {
  it('is 75 blocks with no leave', () => {
    expect(weekCapacity(new Map(), weekDays('2026-08-31'))).toBe(75);
  });

  it('drops 15 blocks per leave day', () => {
    const leave = new Map([['2026-09-01', 'STAT-01']]);
    expect(weekCapacity(leave, weekDays('2026-08-31'))).toBe(60);
  });

  it('is zero when the whole week is leave', () => {
    const leave = new Map(weekDays('2026-08-31').map((d) => [d, 'VAC-01']));
    expect(weekCapacity(leave, weekDays('2026-08-31'))).toBe(0);
  });
});

describe('leaveDatesFor', () => {
  it('applies stat holidays to everyone', () => {
    const model: Model = {
      ...emptyModel,
      statHolidays: [{ date: '2026-09-07', name: 'Labour Day', otlProjectCode: 'STAT-01' }],
    };
    const got = leaveDatesFor('p1', weekDays('2026-09-07'), model);
    expect(got.get('2026-09-07')).toBe('STAT-01');
    expect(got.size).toBe(1);
  });

  it('expands a personal leave range to weekdays', () => {
    const model: Model = {
      ...emptyModel,
      leave: [{
        personId: 'p1', startDate: '2026-09-14', endDate: '2026-09-18',
        otlProjectCode: 'VAC-01',
      }],
    };
    const got = leaveDatesFor('p1', weekDays('2026-09-14'), model);
    expect(got.size).toBe(5);
    expect(got.get('2026-09-16')).toBe('VAC-01');
  });

  it('ignores leave belonging to another person', () => {
    const model: Model = {
      ...emptyModel,
      leave: [{
        personId: 'p2', startDate: '2026-09-14', endDate: '2026-09-18',
        otlProjectCode: 'VAC-01',
      }],
    };
    expect(leaveDatesFor('p1', weekDays('2026-09-14'), model).size).toBe(0);
  });

  it('lets a stat holiday win over overlapping personal leave', () => {
    const model: Model = {
      ...emptyModel,
      statHolidays: [{ date: '2026-09-16', name: 'Stat', otlProjectCode: 'STAT-01' }],
      leave: [{
        personId: 'p1', startDate: '2026-09-14', endDate: '2026-09-18',
        otlProjectCode: 'VAC-01',
      }],
    };
    // You do not spend a vacation day on a day the company is closed.
    expect(leaveDatesFor('p1', weekDays('2026-09-14'), model).get('2026-09-16')).toBe('STAT-01');
  });

  it('lets the later range win on a day two personal leave ranges overlap', () => {
    // model.leave is iterated in array order and out.set() overwrites, so
    // whichever range is listed last claims the overlapping day.
    const model: Model = {
      ...emptyModel,
      leave: [
        {
          personId: 'p1', startDate: '2026-09-14', endDate: '2026-09-16',
          otlProjectCode: 'VAC-EARLY',
        },
        {
          personId: 'p1', startDate: '2026-09-16', endDate: '2026-09-18',
          otlProjectCode: 'VAC-LATE',
        },
      ],
    };
    const got = leaveDatesFor('p1', weekDays('2026-09-14'), model);
    expect(got.get('2026-09-16')).toBe('VAC-LATE');
    // The non-overlapping days each still belong to their own range.
    expect(got.get('2026-09-14')).toBe('VAC-EARLY');
    expect(got.get('2026-09-18')).toBe('VAC-LATE');
  });
});
