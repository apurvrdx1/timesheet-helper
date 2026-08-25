import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { checkInvariants } from './invariants';
import { scheduleAll } from './schedule';
import type { Model, Otl } from './types';

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

  it('holds for arbitrary allocations', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        person: fc.constantFrom('p1', 'p2'),
        otl: fc.constantFrom('P-1001', 'P-1002'),
        halves: fc.integer({ min: 0, max: 400 }),
      }), { maxLength: 8 }),
      (rows) => {
        const model: Model = {
          otls: [opex, capexOtl('P-1001'), capexOtl('P-1002')],
          people: [
            { id: 'mgr', name: 'M', role: 'MANAGER', managerId: null },
            { id: 'p1', name: 'A', role: 'REPORT', managerId: 'mgr' },
            { id: 'p2', name: 'B', role: 'REPORT', managerId: 'mgr' },
          ],
          statHolidays: [], leave: [], overrides: [],
          allocations: rows.map((r) => ({
            month: '2026-09', otlProjectCode: r.otl,
            personId: r.person, hours: r.halves * 0.5,
          })),
        };
        const result = scheduleAll(model, ['2026-09']);
        expect(checkInvariants(model, result, ['2026-09'])).toEqual([]);
      },
    ), { numRuns: 200 });
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
      (rows, halves) => {
        const model: Model = {
          otls: [
            opex, capexOtl('P-1001'), capexOtl('P-1002'),
            secondaryOpex('OPEX-TRAINING'), secondaryOpex('OPEX-SUPPORT'),
          ],
          people: [
            { id: 'mgr', name: 'M', role: 'MANAGER', managerId: null },
            { id: 'p1', name: 'A', role: 'REPORT', managerId: 'mgr' },
            { id: 'p2', name: 'B', role: 'REPORT', managerId: 'mgr' },
          ],
          statHolidays: [], leave: [],
          overrides: rows.map((r) => ({
            personId: r.person, date: r.date,
            otlProjectCode: r.otl, hours: r.halves * 0.5,
          })),
          allocations: [
            { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: halves * 0.5 },
            { month: '2026-09', otlProjectCode: 'P-1002', personId: 'p2', hours: halves * 0.5 },
          ],
        };
        const result = scheduleAll(model, ['2026-09']);
        expect(checkInvariants(model, result, ['2026-09'])).toEqual([]);
      },
    ), { numRuns: 300 });
  });

  it('holds when leave shrinks the week', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 5 }),
      (leaveDays) => {
        const model: Model = {
          otls: [opex, capexOtl('P-1001'), {
            projectCode: 'VAC-01', taskCode: 'T9', expenditureTypeCode: 'E9',
            timeReportingCode: 'R9', category: 'LEAVE', leaveSubtype: 'VACATION',
            isDefaultOpex: false, colorIndex: 0, active: true,
          }],
          people: [
            { id: 'mgr', name: 'M', role: 'MANAGER', managerId: null },
            { id: 'p1', name: 'A', role: 'REPORT', managerId: 'mgr' },
          ],
          statHolidays: [], overrides: [],
          leave: leaveDays === 0 ? [] : [{
            personId: 'p1', startDate: '2026-09-07',
            endDate: `2026-09-${String(6 + leaveDays).padStart(2, '0')}`,
            otlProjectCode: 'VAC-01',
          }],
          allocations: [{
            month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 60,
          }],
        };
        const result = scheduleAll(model, ['2026-09']);
        expect(checkInvariants(model, result, ['2026-09'])).toEqual([]);
      },
    ), { numRuns: 50 });
  });
});
