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

  describe('manager cardinality', () => {
    it('still reports every unplaced hour when the model has no manager (C1)', () => {
      // The cascade-and-residual block used to be gated on a manager existing.
      // With none, both leftover pools were computed and then discarded: never
      // scheduled, never carried, never reported. Hours simply vanished.
      const noManager = model({
        people: [{ id: 'p1', name: 'Alex', role: 'REPORT', managerId: null }],
        allocations: [
          // Far more than one person can absorb, and an unassigned pool too.
          { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 400 },
          { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 900 },
        ],
      });
      const r = scheduleAll(noManager, ['2026-09']);

      // The report is still scheduled: a full 7.5h on every weekday.
      const byDay = new Map<string, number>();
      for (const e of r.entries.filter((x) => x.personId === 'p1')) {
        byDay.set(e.date, (byDay.get(e.date) ?? 0) + e.blocks);
      }
      expect(byDay.size).toBeGreaterThan(0);
      for (const [, blocks] of byDay) expect(blocks).toBe(15);

      // And every hour nobody could take is reported rather than dropped.
      const placed = hoursOn(r, 'p1', 'P-1001') * 2;
      const carried = r.residuals.reduce((s, x) => s + x.blocks, 0);
      expect(carried).toBeGreaterThan(0);
      // 900h total exceeds the 400h handed out, so the whole budget is 900h.
      expect(placed + carried).toBe(1800);
      expect(r.residuals.every((x) => x.blocks > 0)).toBe(true);
    });

    it('emits residuals with no manager even when nothing is over-assigned (C1)', () => {
      const noManager = model({
        people: [{ id: 'p1', name: 'Alex', role: 'REPORT', managerId: null }],
        allocations: [
          { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 20 },
        ],
      });
      const r = scheduleAll(noManager, ['2026-09']);
      // Nobody is assigned the 20h monthly total, and there is no manager to
      // absorb it, so all 40 blocks must be reported as unassigned.
      expect(r.residuals).toEqual([{
        personId: null, otlProjectCode: 'P-1001', month: '2026-09',
        blocks: 40, reason: 'UNASSIGNED',
      }]);
    });

    it('schedules BOTH managers rather than silently dropping the second (C2)', () => {
      const twoManagers = model({
        people: [
          { id: 'mgr', name: 'Manager', role: 'MANAGER', managerId: null },
          { id: 'mgr2', name: 'Other Manager', role: 'MANAGER', managerId: null },
          { id: 'p1', name: 'Alex', role: 'REPORT', managerId: 'mgr' },
        ],
        otls: [opex, capex('P-1001', 1), {
          projectCode: 'STAT-01', taskCode: 'T9', expenditureTypeCode: 'E9',
          timeReportingCode: 'R9', category: 'LEAVE', leaveSubtype: 'STAT',
          isDefaultOpex: false, colorIndex: 0, active: true,
        }],
        statHolidays: [{ date: '2026-09-07', name: 'Labour Day', otlProjectCode: 'STAT-01' }],
        allocations: [
          { month: '2026-09', otlProjectCode: 'P-1001', personId: 'mgr2', hours: 20 },
        ],
      });
      const r = scheduleAll(twoManagers, ['2026-09']);

      for (const id of ['mgr', 'mgr2', 'p1']) {
        const byDay = new Map<string, number>();
        for (const e of r.entries.filter((x) => x.personId === id)) {
          byDay.set(e.date, (byDay.get(e.date) ?? 0) + e.blocks);
        }
        expect(byDay.size).toBe(25);   // 5 weeks touch Sept 2026, 5 weekdays each
        for (const [, blocks] of byDay) expect(blocks).toBe(15);
        // The OPEX floor and the stat holiday reach the second manager too.
        expect(hoursOn(r, id, 'OPEX-ADMIN')).toBeGreaterThan(0);
        expect(hoursOn(r, id, 'STAT-01')).toBe(7.5);
      }
      // The second manager's own assignment is honoured, not cascaded away.
      expect(hoursOn(r, 'mgr2', 'P-1001')).toBe(20);
    });

    it('reports the surplus manager as a violation rather than throwing (C2)', () => {
      const r = scheduleAll(model({
        people: [
          { id: 'mgr', name: 'Manager', role: 'MANAGER', managerId: null },
          { id: 'mgr2', name: 'Other', role: 'MANAGER', managerId: null },
        ],
      }), ['2026-09']);
      const surplus = r.violations.filter((v) => v.kind === 'MULTIPLE_MANAGERS');
      expect(surplus).toHaveLength(1);
      expect(surplus[0]?.personId).toBe('mgr2');
      expect(surplus[0]?.message).toContain('mgr2');
    });

    it('picks the cascade target by id order, not by array order', () => {
      const people = [
        { id: 'b-mgr', name: 'B', role: 'MANAGER' as const, managerId: null },
        { id: 'a-mgr', name: 'A', role: 'MANAGER' as const, managerId: null },
      ];
      const forwards = scheduleAll(model({ people }), ['2026-09']);
      const backwards = scheduleAll(model({ people: [...people].reverse() }), ['2026-09']);
      // 'a-mgr' sorts first, so it is the cascade target either way.
      expect(forwards.violations[0]?.personId).toBe('b-mgr');
      expect(JSON.stringify(forwards)).toBe(JSON.stringify(backwards));
    });

    it('schedules a person whose role is neither MANAGER nor REPORT', () => {
      // Role has no cardinality or exhaustiveness guarantee at the data layer.
      // Whatever a row says, the human still needs a timesheet.
      const r = scheduleAll(model({
        people: [
          { id: 'mgr', name: 'M', role: 'MANAGER', managerId: null },
          { id: 'odd', name: 'O', role: 'CONTRACTOR' as unknown as 'REPORT', managerId: 'mgr' },
        ],
      }), ['2026-09']);
      expect(hoursOn(r, 'odd', 'OPEX-ADMIN')).toBeGreaterThan(0);
    });
  });

  it('reports an allocation whose hours do not fit a half-hour block', () => {
    const r = scheduleAll(model({
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 10.2 },
        { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 40.3 },
      ],
    }), ['2026-09']);
    const dropped = r.violations.filter((v) => v.kind === 'ALLOCATION_RESIDUAL_DROPPED');
    expect(dropped).toHaveLength(2);
    expect(dropped.some((v) => v.personId === null)).toBe(true);
    expect(dropped.some((v) => v.personId === 'p1')).toBe(true);
    expect(dropped.every((v) => v.scope === '2026-09')).toBe(true);
  });

  it('carries a sub-half-hour allocation remainder forward instead of dropping it (bug A)', () => {
    // 1.3h is not a multiple of 0.5: it floors to 1.0h (2 blocks) with a
    // 0.3h remainder that cannot be represented as a block at all. The
    // remainder must still show up somewhere, or it has silently vanished.
    const r = scheduleAll(model({
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 1.3 },
      ],
    }), ['2026-09']);

    const dropped = r.violations.filter((v) => v.kind === 'ALLOCATION_RESIDUAL_DROPPED');
    expect(dropped).toHaveLength(1);

    const remainder = r.residuals.filter((x) => x.reason === 'SUB_BLOCK_REMAINDER');
    expect(remainder).toHaveLength(1);
    expect(remainder[0]?.personId).toBe('p1');
    expect(remainder[0]?.otlProjectCode).toBe('P-1001');
    expect(remainder[0]?.month).toBe('2026-09');
    // Blocks is always a whole half-hour count; a sub-block remainder is by
    // definition less than one, so it can never be represented there.
    expect(remainder[0]?.blocks).toBe(0);
    expect(remainder[0]?.subBlockHours).toBeCloseTo(0.3, 10);

    // Nothing vanished: 1.0h placed + 0.3h carried as a residual = 1.3h.
    expect(hoursOn(r, 'p1', 'P-1001')).toBe(1);
  });

  it('does not let an allocation naming an unknown person reach nobody (bug B)', () => {
    const r = scheduleAll(model({
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'ghost', hours: 20 },
      ],
    }), ['2026-09']);

    const unknown = r.violations.filter((v) => v.kind === 'ALLOCATION_UNKNOWN_PERSON');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.personId).toBe('ghost');
    expect(unknown[0]?.message).toContain('ghost');

    // Nobody named 'ghost' exists, so nobody is ever scheduled for them —
    // but the 40 blocks (20h) must still reach the manager or a residual,
    // never nowhere.
    expect(r.entries.some((e) => e.personId === 'ghost')).toBe(false);
    const placedForOtl = r.entries
      .filter((e) => e.otlProjectCode === 'P-1001')
      .reduce((s, e) => s + e.blocks, 0);
    const residualForOtl = r.residuals
      .filter((x) => x.otlProjectCode === 'P-1001')
      .reduce((s, x) => s + x.blocks, 0);
    expect(placedForOtl + residualForOtl).toBe(40);
  });

  it('does not double-count an unknown-person row against a real monthly total (bug B)', () => {
    // The 20h named to 'ghost' is carved out of the 100h monthly total, not
    // additional to it. If the fix both grew the unassigned gap AND kept
    // adding the orphaned amount on top, this would over-count by 40 blocks.
    const r = scheduleAll(model({
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 100 },
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 10 },
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'ghost', hours: 20 },
      ],
    }), ['2026-09']);

    expect(hoursOn(r, 'p1', 'P-1001')).toBe(10);
    const placedForOtl = r.entries
      .filter((e) => e.otlProjectCode === 'P-1001')
      .reduce((s, e) => s + e.blocks, 0);
    const residualForOtl = r.residuals
      .filter((x) => x.otlProjectCode === 'P-1001')
      .reduce((s, x) => s + x.blocks, 0);
    expect(placedForOtl + residualForOtl).toBe(200); // 100h total, no more, no less
  });

  it('returns violations in a stable total order', () => {
    const m = model({
      people: [
        { id: 'mgr', name: 'M', role: 'MANAGER', managerId: null },
        { id: 'zz', name: 'Z', role: 'MANAGER', managerId: null },
        { id: 'aa', name: 'A', role: 'MANAGER', managerId: null },
      ],
      allocations: [
        { month: '2026-10', otlProjectCode: 'P-1001', personId: 'mgr', hours: 1.2 },
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'mgr', hours: 1.2 },
      ],
    });
    const r = scheduleAll(m, ['2026-09']);
    const keys = r.violations.map(
      (v) => `${v.personId ?? ''}|${v.scope}|${v.kind}|${v.message}`);
    expect([...keys]).toEqual([...keys].sort());
    expect(JSON.stringify(r.violations))
      .toBe(JSON.stringify(scheduleAll(m, ['2026-09']).violations));
  });

  it('refuses to schedule a model with no default OPEX code', () => {
    expect(() => scheduleAll(model({ otls: [capex('P-1001', 1)] }), ['2026-09']))
      .toThrow(/default OPEX/);
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
