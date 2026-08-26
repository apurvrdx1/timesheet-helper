import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { checkInvariants } from './invariants';
import { scheduleAll } from './schedule';
import type { Model, Otl, Person, ScheduleResult } from './types';

const opex: Otl = {
  projectCode: 'OPEX-ADMIN', taskCode: 'T0', expenditureTypeCode: 'E0',
  timeReportingCode: 'R0', category: 'OPEX', leaveSubtype: null,
  isDefaultOpex: true, colorIndex: 0, active: true,
};
const capexOtl = (code: string): Otl => ({
  projectCode: code, taskCode: 'T1', expenditureTypeCode: 'E1',
  timeReportingCode: 'R1', category: 'CAPEX', leaveSubtype: null,
  isDefaultOpex: false, colorIndex: 1, active: true,
});

const secondaryOpex = (code: string): Otl => ({
  projectCode: code, taskCode: 'T2', expenditureTypeCode: 'E2',
  timeReportingCode: 'R2', category: 'OPEX', leaveSubtype: null,
  isDefaultOpex: false, colorIndex: 2, active: true,
});

const leaveOtl: Otl = {
  projectCode: 'VAC-01', taskCode: 'T9', expenditureTypeCode: 'E9',
  timeReportingCode: 'R9', category: 'LEAVE', leaveSubtype: 'VACATION',
  isDefaultOpex: false, colorIndex: 0, active: true,
};

/**
 * Manager cardinality is a generator dimension, not a fixture constant.
 * `Person.role` carries no cardinality constraint, and 0 and 2 are exactly
 * where the two critical defects hid: with no manager the leftover pools were
 * discarded unreported, and with two the second person was scheduled by
 * nobody. Pinning this at 1 made both unreachable.
 */
function peopleWith(managerCount: number): Person[] {
  const managers: Person[] = ['m1', 'm2'].slice(0, managerCount).map((id) => ({
    id, name: id.toUpperCase(), role: 'MANAGER', managerId: null,
  }));
  return [
    ...managers,
    { id: 'p1', name: 'A', role: 'REPORT', managerId: 'm1' },
    { id: 'p2', name: 'B', role: 'REPORT', managerId: 'm1' },
  ];
}

/** A slot index into "the people who exist, plus the OTL-total row". */
function personSlot(people: Person[], idx: number): string | null {
  const slots: (string | null)[] = [...people.map((p) => p.id), null];
  return slots[idx % slots.length] ?? null;
}

const weekOf7Sep = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];

const soloModel = (over: Partial<Model> = {}): Model => ({
  otls: [opex, capexOtl('P-1001')],
  people: [{ id: 'p1', name: 'A', role: 'REPORT', managerId: null }],
  statHolidays: [], leave: [], overrides: [], allocations: [],
  ...over,
});

const emptyResult: ScheduleResult = { entries: [], residuals: [], violations: [] };

describe('checkInvariants', () => {
  it('passes a clean schedule', () => {
    const model: Model = {
      otls: [opex, capexOtl('P-1001')],
      people: [
        { id: 'mgr', name: 'M', role: 'MANAGER', managerId: null },
        { id: 'p1', name: 'A', role: 'REPORT', managerId: 'mgr' },
      ],
      statHolidays: [], leave: [], overrides: [],
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 40 }],
    };
    const result = scheduleAll(model, ['2026-09']);
    expect(checkInvariants(model, result, ['2026-09'])).toEqual([]);
  });

  it('holds for arbitrary allocations, unassigned rows and manager counts', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        // A slot of null reaches the OTL-monthly-total row, which is what
        // drives the entire unassigned-cascade rule. It was never generated.
        slot: fc.integer({ min: 0, max: 4 }),
        otl: fc.constantFrom('P-1001', 'P-1002'),
        halves: fc.integer({ min: 0, max: 400 }),
      }), { maxLength: 8 }),
      fc.integer({ min: 0, max: 2 }),
      (rows, managerCount) => {
        const people = peopleWith(managerCount);
        const model: Model = {
          otls: [opex, capexOtl('P-1001'), capexOtl('P-1002')],
          people,
          statHolidays: [], leave: [], overrides: [],
          allocations: rows.map((r) => ({
            month: '2026-09', otlProjectCode: r.otl,
            personId: personSlot(people, r.slot), hours: r.halves * 0.5,
          })),
        };
        const result = scheduleAll(model, ['2026-09']);
        expect(checkInvariants(model, result, ['2026-09'])).toEqual([]);
      },
    ), { numRuns: 300 });
  });

  it('holds when overrides pin cells, secondary OPEX codes included', () => {
    // The generator deliberately reaches codes that are neither CAPEX nor the
    // default OPEX code: an override onto one of those consumes floor room
    // without being charged against the CAPEX ceiling, which is exactly the
    // shape that used to make the optimizer manufacture a floor breach.
    const weekDates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
    fc.assert(fc.property(
      fc.array(fc.record({
        person: fc.constantFrom('p1', 'p2'),
        date: fc.constantFrom(...weekDates),
        otl: fc.constantFrom(
          'P-1001', 'P-1002', 'OPEX-ADMIN', 'OPEX-TRAINING', 'OPEX-SUPPORT'),
        halves: fc.integer({ min: 1, max: 15 }),
      }), { maxLength: 6 }),
      fc.integer({ min: 0, max: 400 }),
      fc.integer({ min: 0, max: 2 }),
      (rows, halves, managerCount) => {
        const people = peopleWith(managerCount);
        const model: Model = {
          otls: [
            opex, capexOtl('P-1001'), capexOtl('P-1002'),
            secondaryOpex('OPEX-TRAINING'), secondaryOpex('OPEX-SUPPORT'),
          ],
          people,
          statHolidays: [], leave: [],
          overrides: rows.map((r) => ({
            personId: r.person, date: r.date,
            otlProjectCode: r.otl, hours: r.halves * 0.5,
          })),
          allocations: [
            { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: halves * 0.5 },
            { month: '2026-09', otlProjectCode: 'P-1002', personId: 'p2', hours: halves * 0.5 },
            // An unassigned monthly total, so the cascade rule is exercised
            // alongside the overrides rather than only in isolation.
            { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: halves },
          ],
        };
        const result = scheduleAll(model, ['2026-09']);
        expect(checkInvariants(model, result, ['2026-09'])).toEqual([]);
      },
    ), { numRuns: 300 });
  });

  it('holds when leave shrinks the week, at every manager count', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 5 }),
      fc.integer({ min: 0, max: 2 }),
      fc.integer({ min: 0, max: 15 }),
      (leaveDays, managerCount, pinHalves) => {
        const people = peopleWith(managerCount);
        const model: Model = {
          otls: [opex, capexOtl('P-1001'), leaveOtl],
          people,
          statHolidays: [],
          overrides: pinHalves === 0 ? [] : [{
            personId: 'p1', date: '2026-09-15',
            otlProjectCode: 'P-1001', hours: pinHalves * 0.5,
          }],
          leave: leaveDays === 0 ? [] : [{
            personId: 'p1', startDate: '2026-09-07',
            endDate: `2026-09-${String(6 + leaveDays).padStart(2, '0')}`,
            otlProjectCode: 'VAC-01',
          }],
          allocations: [
            { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 60 },
            { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 90 },
          ],
        };
        const result = scheduleAll(model, ['2026-09']);
        expect(checkInvariants(model, result, ['2026-09'])).toEqual([]);
      },
    ), { numRuns: 150 });
  });

  describe('the floor allowance comes from the model, not from the schedule (N1)', () => {
    it('catches a floor breach a merged OVERRIDE label used to excuse', () => {
      // The user pinned half an hour on each of five days: 5 blocks in total,
      // which excuses nothing, because the week has 45 blocks of non-OPEX
      // room. A regressed optimizer then filled all five days with the same
      // CAPEX code and merged into the pinned cells, so every cell reads
      // OVERRIDE and carries 15 blocks. Deriving the allowance from `source`
      // summed the merged cells to 75, excused the entire 30-block floor, and
      // waved a schedule with ZERO hours of OPEX straight through.
      const model = soloModel({
        overrides: weekOf7Sep.map((date) => ({
          personId: 'p1', date, otlProjectCode: 'P-1001', hours: 0.5,
        })),
        allocations: [{
          month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 37.5,
        }],
      });
      const regressed: ScheduleResult = {
        entries: weekOf7Sep.map((date) => ({
          personId: 'p1', date, otlProjectCode: 'P-1001',
          blocks: 15, source: 'OVERRIDE' as const, overrideBlocks: 1,
        })),
        residuals: [], violations: [],
      };
      const problems = checkInvariants(model, regressed, ['2026-09']);
      expect(problems.some(
        (v) => v.kind === 'OPEX_FLOOR_BREACHED' && v.scope === '2026-09-07')).toBe(true);
    });

    it('still excuses the shortfall the user genuinely forced', () => {
      // Now the user really does pin all five days in full. The optimizer has
      // nowhere left to put the floor, so this must NOT be reported.
      const model = soloModel({
        overrides: weekOf7Sep.map((date) => ({
          personId: 'p1', date, otlProjectCode: 'P-1001', hours: 7.5,
        })),
        allocations: [{
          month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 37.5,
        }],
      });
      const honest: ScheduleResult = {
        entries: weekOf7Sep.map((date) => ({
          personId: 'p1', date, otlProjectCode: 'P-1001',
          blocks: 15, source: 'OVERRIDE' as const, overrideBlocks: 15,
        })),
        residuals: [], violations: [],
      };
      // Scoped to the week the fixture actually covers: the other four weeks
      // touching September are empty in this hand-built result.
      expect(checkInvariants(model, honest, ['2026-09']).some(
        (v) => v.kind === 'OPEX_FLOOR_BREACHED' && v.scope === '2026-09-07')).toBe(false);
    });

    it('rejects a non-integer or non-positive block count', () => {
      const bad: ScheduleResult = {
        entries: [{
          personId: 'p1', date: '2026-09-07', otlProjectCode: 'P-1001',
          blocks: 2.5, source: 'CALC', overrideBlocks: 0,
        }],
        residuals: [], violations: [],
      };
      expect(checkInvariants(soloModel(), bad, ['2026-09'])
        .some((v) => v.kind === 'NEGATIVE' && v.message.includes('2.5 blocks'))).toBe(true);
    });

    it('rejects a leave day carrying anything other than one LEAVE entry', () => {
      const model = soloModel({
        otls: [opex, capexOtl('P-1001'), leaveOtl],
        leave: [{
          personId: 'p1', startDate: '2026-09-07', endDate: '2026-09-07',
          otlProjectCode: 'VAC-01',
        }],
      });
      const bad: ScheduleResult = {
        entries: [
          {
            personId: 'p1', date: '2026-09-07', otlProjectCode: 'VAC-01',
            blocks: 11, source: 'LEAVE', overrideBlocks: 0,
          },
          {
            personId: 'p1', date: '2026-09-07', otlProjectCode: 'P-1001',
            blocks: 4, source: 'CALC', overrideBlocks: 0,
          },
        ],
        residuals: [], violations: [],
      };
      expect(checkInvariants(model, bad, ['2026-09']).some(
        (v) => v.kind === 'DAY_NOT_FULL' && v.message.includes('holds 2 entries'))).toBe(true);
    });

    it('rejects an entry claiming more override blocks than it holds', () => {
      const bad: ScheduleResult = {
        entries: [{
          personId: 'p1', date: '2026-09-07', otlProjectCode: 'P-1001',
          blocks: 4, source: 'OVERRIDE', overrideBlocks: 9,
        }],
        residuals: [], violations: [],
      };
      expect(checkInvariants(soloModel(), bad, ['2026-09'])
        .some((v) => v.kind === 'NEGATIVE')).toBe(true);
    });
  });

  describe('conservation: nothing vanishes (N3)', () => {
    it('catches a budget that was neither placed nor carried', () => {
      // This is the shape C1 produced: the pools were computed and dropped.
      // Every day still totalled 7.5h because phase 4 tops up with OPEX
      // regardless of why CAPEX fell short, so no other check could see it.
      const model = soloModel({
        allocations: [{
          month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 20,
        }],
      });
      const dropped = checkInvariants(model, emptyResult, ['2026-09'])
        .find((v) => v.kind === 'HOURS_NOT_CONSERVED');
      expect(dropped).toBeDefined();
      expect(dropped?.scope).toBe('2026-09');
      expect(dropped?.message).toContain('20h vanished');
    });

    it('catches an unassigned monthly total that was silently discarded', () => {
      const model = soloModel({
        allocations: [{
          month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 12,
        }],
      });
      expect(checkInvariants(model, emptyResult, ['2026-09'])
        .some((v) => v.kind === 'HOURS_NOT_CONSERVED')).toBe(true);
    });

    it('accepts a budget split between placement and a residual', () => {
      const model = soloModel({
        allocations: [{
          month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 20,
        }],
      });
      const result: ScheduleResult = {
        entries: [{
          personId: 'p1', date: '2026-09-07', otlProjectCode: 'P-1001',
          blocks: 15, source: 'CALC', overrideBlocks: 0,
        }],
        residuals: [{
          personId: null, otlProjectCode: 'P-1001', month: '2026-09',
          blocks: 25, reason: 'UNABSORBED',
        }],
        violations: [],
      };
      expect(checkInvariants(model, result, ['2026-09'])
        .some((v) => v.kind === 'HOURS_NOT_CONSERVED')).toBe(false);
    });

    it('catches hours conjured out of a budget that never existed', () => {
      const result: ScheduleResult = {
        entries: [{
          personId: 'p1', date: '2026-09-07', otlProjectCode: 'P-1001',
          blocks: 10, source: 'CALC', overrideBlocks: 0,
        }],
        residuals: [], violations: [],
      };
      const conjured = checkInvariants(soloModel(), result, ['2026-09'])
        .find((v) => v.kind === 'HOURS_NOT_CONSERVED');
      expect(conjured).toBeDefined();
      expect(conjured?.message).toContain('does not account for');
    });

    it('lets a user override place blocks the budget does not cover', () => {
      // The user pinning 5h onto a code with no budget is a legitimate input,
      // not a scheduling bug, so the check gives exactly that much slack.
      const model = soloModel({
        overrides: [{
          personId: 'p1', date: '2026-09-07', otlProjectCode: 'P-1001', hours: 5,
        }],
      });
      const result: ScheduleResult = {
        entries: [{
          personId: 'p1', date: '2026-09-07', otlProjectCode: 'P-1001',
          blocks: 10, source: 'OVERRIDE', overrideBlocks: 10,
        }],
        residuals: [], violations: [],
      };
      expect(checkInvariants(model, result, ['2026-09'])
        .some((v) => v.kind === 'HOURS_NOT_CONSERVED')).toBe(false);
    });

    it('ignores the default OPEX code, which phase 4 tops up without a budget', () => {
      const result: ScheduleResult = {
        entries: [{
          personId: 'p1', date: '2026-09-07', otlProjectCode: 'OPEX-ADMIN',
          blocks: 15, source: 'CALC', overrideBlocks: 0,
        }],
        residuals: [], violations: [],
      };
      expect(checkInvariants(soloModel(), result, ['2026-09'])
        .some((v) => v.kind === 'HOURS_NOT_CONSERVED')).toBe(false);
    });

    it('ignores leave, which is capacity rather than budget', () => {
      const result: ScheduleResult = {
        entries: [{
          personId: 'p1', date: '2026-09-07', otlProjectCode: 'VAC-01',
          blocks: 15, source: 'LEAVE', overrideBlocks: 0,
        }],
        residuals: [], violations: [],
      };
      expect(checkInvariants(soloModel({ otls: [opex, capexOtl('P-1001'), leaveOtl] }),
        result, ['2026-09']).some((v) => v.kind === 'HOURS_NOT_CONSERVED')).toBe(false);
    });

    it('conserves a real schedule that has no manager to cascade to (C1)', () => {
      const model = soloModel({
        allocations: [
          { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 400 },
          { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 900 },
        ],
      });
      const result = scheduleAll(model, ['2026-09']);
      expect(checkInvariants(model, result, ['2026-09'])).toEqual([]);
      expect(result.residuals.length).toBeGreaterThan(0);
    });

    it('conserves budget spilling into the months either side of the window', () => {
      // Days in August and October are scheduled because their weeks touch
      // September, and they draw on their own month's budget. Those keys are
      // conserved on the same terms as September's.
      const model = soloModel({
        people: [
          { id: 'mgr', name: 'M', role: 'MANAGER', managerId: null },
          { id: 'p1', name: 'A', role: 'REPORT', managerId: 'mgr' },
        ],
        allocations: [
          { month: '2026-08', otlProjectCode: 'P-1001', personId: 'p1', hours: 30 },
          { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 30 },
          { month: '2026-10', otlProjectCode: 'P-1001', personId: 'p1', hours: 60 },
        ],
      });
      const result = scheduleAll(model, ['2026-09']);
      expect(checkInvariants(model, result, ['2026-09'])).toEqual([]);
      // Only 31 August and 1-2 October are in view, so neither month can
      // absorb its budget and the balance must show up as carried forward.
      expect(result.residuals.map((r) => r.month).sort())
        .toEqual(['2026-08', '2026-10']);
    });
  });
});
