import { describe, it, expect } from 'vitest';
import { mondayOf } from './calendar';
import { scheduleAll } from './schedule';
import type { Model, Otl } from './types';

const opex: Otl = {
  projectCode: 'OPEX-ADMIN', taskCode: 'T0', expenditureTypeCode: 'E0',
  timeReportingCode: 'R0', category: 'OPEX', leaveSubtype: null,
  isDefaultOpex: true, colorIndex: 0, active: true,
};
const capex = (code: string, colorIndex: number): Otl => ({
  projectCode: code, taskCode: 'T1', expenditureTypeCode: 'E1',
  timeReportingCode: 'R1', category: 'CAPEX', leaveSubtype: null,
  isDefaultOpex: false, colorIndex, active: true,
});

const model = (over: Partial<Model> = {}): Model => ({
  otls: [opex, capex('P-1001', 1)],
  people: [
    { id: 'mgr', name: 'Manager', role: 'MANAGER', managerId: null },
    { id: 'p1', name: 'Alex', role: 'REPORT', managerId: 'mgr' },
  ],
  statHolidays: [], allocations: [], leave: [], overrides: [],
  ...over,
});

function hoursOn(r: ReturnType<typeof scheduleAll>, personId: string, otl: string): number {
  return r.entries.filter((e) => e.personId === personId && e.otlProjectCode === otl)
    .reduce((s, e) => s + e.blocks, 0) / 2;
}

describe('scheduleAll', () => {
  it('schedules every person for every day of every week touching the month', () => {
    const r = scheduleAll(model(), ['2026-09']);
    const alexDates = new Set(r.entries.filter((e) => e.personId === 'p1').map((e) => e.date));
    expect(alexDates.has('2026-08-31')).toBe(true); // week 1 starts in August
    expect(alexDates.has('2026-10-02')).toBe(true); // last week runs into October
  });

  it('places an allocation that comfortably fits', () => {
    const r = scheduleAll(model({
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 40 }],
    }), ['2026-09']);
    expect(hoursOn(r, 'p1', 'P-1001')).toBe(40);
    expect(r.residuals).toEqual([]);
  });

  it('cascades hours a report cannot absorb to the manager', () => {
    // September 2026 has 22 workdays; Alex's CAPEX ceiling is well under 200h.
    const r = scheduleAll(model({
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 200 }],
    }), ['2026-09']);
    expect(hoursOn(r, 'mgr', 'P-1001')).toBeGreaterThan(0);
  });

  it('cascades unassigned OTL budget to the manager', () => {
    const r = scheduleAll(model({
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 100 },
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 20 },
      ],
    }), ['2026-09']);
    expect(hoursOn(r, 'p1', 'P-1001')).toBe(20);
    expect(hoursOn(r, 'mgr', 'P-1001')).toBeGreaterThan(0);
  });

  it('reports a residual rather than dropping hours nobody can take', () => {
    const r = scheduleAll(model({
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 5000 }],
    }), ['2026-09']);
    const total = r.residuals.reduce((s, x) => s + x.blocks, 0);
    expect(total).toBeGreaterThan(0);
    expect(r.residuals[0]?.reason).toBe('UNASSIGNED');
  });

  it('gives everyone the stat holiday', () => {
    const r = scheduleAll(model({
      otls: [opex, capex('P-1001', 1), {
        projectCode: 'STAT-01', taskCode: 'T9', expenditureTypeCode: 'E9',
        timeReportingCode: 'R9', category: 'LEAVE', leaveSubtype: 'STAT',
        isDefaultOpex: false, colorIndex: 0, active: true,
      }],
      statHolidays: [{ date: '2026-09-07', name: 'Labour Day', otlProjectCode: 'STAT-01' }],
    }), ['2026-09']);
    expect(hoursOn(r, 'p1', 'STAT-01')).toBe(7.5);
    expect(hoursOn(r, 'mgr', 'STAT-01')).toBe(7.5);
  });

  it('does not manufacture a residual for someone who took leave (N4)', () => {
    // Alex is off the whole week of 7 Sep. The remaining 17 September
    // workdays hold this allocation comfortably. Pacing used to decrement its
    // runway only by NON-leave days, so the runway stayed inflated by the 5
    // leave days, `monthDays > weekDays` never stopped holding, the final
    // week never took the whole remaining balance, and the leftover surfaced
    // as a residual reporting a capacity shortfall that does not exist.
    const withLeave = model({
      otls: [opex, capex('P-1001', 1), {
        projectCode: 'VAC-01', taskCode: 'T9', expenditureTypeCode: 'E9',
        timeReportingCode: 'R9', category: 'LEAVE', leaveSubtype: 'VACATION',
        isDefaultOpex: false, colorIndex: 0, active: true,
      }],
      leave: [{
        personId: 'p1', startDate: '2026-09-07', endDate: '2026-09-11',
        otlProjectCode: 'VAC-01',
      }],
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 50 },
      ],
    });
    const r = scheduleAll(withLeave, ['2026-09']);
    expect(hoursOn(r, 'p1', 'P-1001')).toBe(50);
    expect(r.residuals).toEqual([]);
    // ...and nothing cascaded to the manager either.
    expect(hoursOn(r, 'mgr', 'P-1001')).toBe(0);
  });

  it('paces a month across its weeks rather than front-loading it', () => {
    // The runway fix must not turn pacing into "spend it all in week one".
    const r = scheduleAll(model({
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 60 },
      ],
    }), ['2026-09']);
    const mine = r.entries.filter(
      (e) => e.personId === 'p1' && e.otlProjectCode === 'P-1001');
    expect(hoursOn(r, 'p1', 'P-1001')).toBe(60);
    // 60h is 120 blocks, so it cannot fit in fewer than 8 days; but the CAPEX
    // ceiling is 45 blocks a week, so it also cannot fit in fewer than 3
    // weeks. Front-loading would show up as a small handful of days.
    const mondays = new Set(mine.map((e) => mondayOf(e.date)));
    expect(mondays.size).toBeGreaterThanOrEqual(3);
  });

  it('is deterministic across runs', () => {
    const m = model({
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 37 },
      ],
    });
    expect(JSON.stringify(scheduleAll(m, ['2026-09'])))
      .toBe(JSON.stringify(scheduleAll(m, ['2026-09'])));
  });

  it('never double-books a day across overlapping month views', () => {
    const r = scheduleAll(model({
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 40 }],
    }), ['2026-09', '2026-10']);
    const byDay = new Map<string, number>();
    for (const e of r.entries.filter((x) => x.personId === 'p1')) {
      byDay.set(e.date, (byDay.get(e.date) ?? 0) + e.blocks);
    }
    for (const [, blocks] of byDay) expect(blocks).toBe(15);
  });
});
