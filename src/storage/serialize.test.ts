import { describe, it, expect } from 'vitest';
import { modelToRows, rowsToModel } from './serialize';
import type { Model } from '../domain/types';

const model: Model = {
  otls: [{
    projectCode: 'P-1001', taskCode: 'T1', expenditureTypeCode: 'E1',
    timeReportingCode: 'R1', category: 'CAPEX', leaveSubtype: null,
    isDefaultOpex: false, colorIndex: 1, active: true,
  }],
  people: [{ id: 'p1', name: 'Alex', role: 'REPORT', managerId: 'mgr' }],
  statHolidays: [{ date: '2026-09-07', name: 'Labour Day', otlProjectCode: 'STAT-01' }],
  allocations: [
    { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 60 },
    { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 300 },
  ],
  leave: [{
    personId: 'p1', startDate: '2026-09-14', endDate: '2026-09-18',
    otlProjectCode: 'VAC-01',
  }],
  overrides: [{ personId: 'p1', date: '2026-09-01', otlProjectCode: 'P-1001', hours: 4 }],
};

describe('serialize', () => {
  it('round-trips a model without loss', () => {
    const { model: back, problems } = rowsToModel(modelToRows(model));
    expect(problems).toEqual([]);
    expect(back).toEqual(model);
  });

  it('writes a header row on every tab', () => {
    const rows = modelToRows(model);
    expect(rows.OTLs[0]?.[0]).toBe('projectCode');
    expect(rows.Allocations[0]).toContain('personId');
  });

  it('preserves a null personId as an empty cell, not the string "null"', () => {
    const rows = modelToRows(model);
    const totalRow = rows.Allocations.slice(1).find((r) => r[2] === '');
    expect(totalRow?.[3]).toBe('300');
  });

  it('reports a malformed row instead of throwing', () => {
    const { problems } = rowsToModel({
      OTLs: [['projectCode', 'taskCode'], ['P-1', 'T1']],
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  it('returns an empty model for empty input', () => {
    const { model: empty } = rowsToModel({});
    expect(empty.otls).toEqual([]);
    expect(empty.people).toEqual([]);
  });
});

describe('serialize: date and month validation', () => {
  // These are not in the brief. `Date.UTC` rolls invalid parts over into a
  // different-but-plausible date instead of producing NaN, so a merely
  // syntactic check ('does it look like YYYY-MM-DD') is not enough — every
  // date-shaped field must round-trip through Date.UTC to the exact values
  // it claims.

  it('rejects StatHoliday date "2026-13-45" (month and day both out of range)', () => {
    const { model, problems } = rowsToModel({
      StatHolidays: [
        ['date', 'name', 'otlProjectCode'],
        ['2026-13-45', 'Bad Day', 'STAT-01'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.statHolidays).toEqual([]);
  });

  it('rejects StatHoliday date "2026-02-30" (day does not exist in that month)', () => {
    const { model, problems } = rowsToModel({
      StatHolidays: [
        ['date', 'name', 'otlProjectCode'],
        ['2026-02-30', 'Bad Day', 'STAT-01'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.statHolidays).toEqual([]);
  });

  it('rejects StatHoliday date "2026-1-1" (not zero-padded)', () => {
    const { model, problems } = rowsToModel({
      StatHolidays: [
        ['date', 'name', 'otlProjectCode'],
        ['2026-1-1', 'Bad Day', 'STAT-01'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.statHolidays).toEqual([]);
  });

  it('rejects StatHoliday date "not-a-date"', () => {
    const { model, problems } = rowsToModel({
      StatHolidays: [
        ['date', 'name', 'otlProjectCode'],
        ['not-a-date', 'Bad Day', 'STAT-01'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.statHolidays).toEqual([]);
  });

  it('rejects LeaveRange startDate "2026-13-45"', () => {
    const { model, problems } = rowsToModel({
      Leave: [
        ['personId', 'startDate', 'endDate', 'otlProjectCode'],
        ['p1', '2026-13-45', '2026-09-18', 'VAC-01'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.leave).toEqual([]);
  });

  it('rejects LeaveRange startDate "2026-02-30"', () => {
    const { model, problems } = rowsToModel({
      Leave: [
        ['personId', 'startDate', 'endDate', 'otlProjectCode'],
        ['p1', '2026-02-30', '2026-09-18', 'VAC-01'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.leave).toEqual([]);
  });

  it('rejects LeaveRange startDate "2026-1-1"', () => {
    const { model, problems } = rowsToModel({
      Leave: [
        ['personId', 'startDate', 'endDate', 'otlProjectCode'],
        ['p1', '2026-1-1', '2026-09-18', 'VAC-01'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.leave).toEqual([]);
  });

  it('rejects LeaveRange startDate "not-a-date"', () => {
    const { model, problems } = rowsToModel({
      Leave: [
        ['personId', 'startDate', 'endDate', 'otlProjectCode'],
        ['p1', 'not-a-date', '2026-09-18', 'VAC-01'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.leave).toEqual([]);
  });

  it('rejects LeaveRange endDate "not-a-date" even when startDate is valid', () => {
    const { model, problems } = rowsToModel({
      Leave: [
        ['personId', 'startDate', 'endDate', 'otlProjectCode'],
        ['p1', '2026-09-14', 'not-a-date', 'VAC-01'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.leave).toEqual([]);
  });

  it('rejects Override date "2026-13-45"', () => {
    const { model, problems } = rowsToModel({
      Overrides: [
        ['personId', 'date', 'otlProjectCode', 'hours'],
        ['p1', '2026-13-45', 'P-1001', '4'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.overrides).toEqual([]);
  });

  it('rejects Override date "2026-02-30"', () => {
    const { model, problems } = rowsToModel({
      Overrides: [
        ['personId', 'date', 'otlProjectCode', 'hours'],
        ['p1', '2026-02-30', 'P-1001', '4'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.overrides).toEqual([]);
  });

  it('rejects Override date "2026-1-1"', () => {
    const { model, problems } = rowsToModel({
      Overrides: [
        ['personId', 'date', 'otlProjectCode', 'hours'],
        ['p1', '2026-1-1', 'P-1001', '4'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.overrides).toEqual([]);
  });

  it('rejects Override date "not-a-date"', () => {
    const { model, problems } = rowsToModel({
      Overrides: [
        ['personId', 'date', 'otlProjectCode', 'hours'],
        ['p1', 'not-a-date', 'P-1001', '4'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.overrides).toEqual([]);
  });

  it('rejects Allocation month "2026-13" (month out of range)', () => {
    const { model, problems } = rowsToModel({
      Allocations: [
        ['month', 'otlProjectCode', 'personId', 'hours'],
        ['2026-13', 'P-1001', 'p1', '60'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.allocations).toEqual([]);
  });

  it('rejects Allocation month "2026-00" (month zero)', () => {
    const { model, problems } = rowsToModel({
      Allocations: [
        ['month', 'otlProjectCode', 'personId', 'hours'],
        ['2026-00', 'P-1001', 'p1', '60'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.allocations).toEqual([]);
  });

  it('rejects Allocation month "2026-1" (not zero-padded)', () => {
    const { model, problems } = rowsToModel({
      Allocations: [
        ['month', 'otlProjectCode', 'personId', 'hours'],
        ['2026-1', 'P-1001', 'p1', '60'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.allocations).toEqual([]);
  });

  it('rejects Allocation month "not-a-month"', () => {
    const { model, problems } = rowsToModel({
      Allocations: [
        ['month', 'otlProjectCode', 'personId', 'hours'],
        ['not-a-month', 'P-1001', 'p1', '60'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.allocations).toEqual([]);
  });

  it('accepts the real leap-day 2024-02-29', () => {
    const { model, problems } = rowsToModel({
      StatHolidays: [
        ['date', 'name', 'otlProjectCode'],
        ['2024-02-29', 'Leap Day', 'STAT-01'],
      ],
    });
    expect(problems).toEqual([]);
    expect(model.statHolidays).toHaveLength(1);
  });

  it('rejects 2026-02-29 because 2026 is not a leap year', () => {
    const { model, problems } = rowsToModel({
      StatHolidays: [
        ['date', 'name', 'otlProjectCode'],
        ['2026-02-29', 'Not A Leap Day', 'STAT-01'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.statHolidays).toEqual([]);
  });

  it('accepts the valid boundary date 2026-02-28', () => {
    const { model, problems } = rowsToModel({
      StatHolidays: [
        ['date', 'name', 'otlProjectCode'],
        ['2026-02-28', 'End of Feb', 'STAT-01'],
      ],
    });
    expect(problems).toEqual([]);
    expect(model.statHolidays).toHaveLength(1);
  });
});

describe('serialize: malformed field validation (never throws, always reports)', () => {
  it('reports a row whose length does not match a correct header', () => {
    const { model, problems } = rowsToModel({
      OTLs: [
        [
          'projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode',
          'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active',
        ],
        ['P-1', 'T1', 'E1'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.otls).toEqual([]);
  });

  it('rejects an OTL row with a missing projectCode', () => {
    const { model, problems } = rowsToModel({
      OTLs: [
        [
          'projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode',
          'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active',
        ],
        ['', 'T1', 'E1', 'R1', 'CAPEX', '', 'FALSE', '1', 'TRUE'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.otls).toEqual([]);
  });

  it('rejects an OTL row with an invalid category', () => {
    const { model, problems } = rowsToModel({
      OTLs: [
        [
          'projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode',
          'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active',
        ],
        ['P-1', 'T1', 'E1', 'R1', 'NOT_A_CATEGORY', '', 'FALSE', '1', 'TRUE'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.otls).toEqual([]);
  });

  it('rejects an OTL row with an invalid leaveSubtype', () => {
    const { model, problems } = rowsToModel({
      OTLs: [
        [
          'projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode',
          'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active',
        ],
        ['P-1', 'T1', 'E1', 'R1', 'LEAVE', 'NOT_A_SUBTYPE', 'FALSE', '1', 'TRUE'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.otls).toEqual([]);
  });

  it('accepts an OTL row with a real, non-empty leaveSubtype', () => {
    const { model, problems } = rowsToModel({
      OTLs: [
        [
          'projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode',
          'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active',
        ],
        ['P-1', 'T1', 'E1', 'R1', 'LEAVE', 'VACATION', 'FALSE', '1', 'TRUE'],
      ],
    });
    expect(problems).toEqual([]);
    expect(model.otls[0]?.leaveSubtype).toBe('VACATION');
  });

  it('rejects an OTL row with an invalid isDefaultOpex boolean', () => {
    const { model, problems } = rowsToModel({
      OTLs: [
        [
          'projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode',
          'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active',
        ],
        ['P-1', 'T1', 'E1', 'R1', 'CAPEX', '', 'YES', '1', 'TRUE'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.otls).toEqual([]);
  });

  it('rejects an OTL row with a non-numeric colorIndex', () => {
    const { model, problems } = rowsToModel({
      OTLs: [
        [
          'projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode',
          'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active',
        ],
        ['P-1', 'T1', 'E1', 'R1', 'CAPEX', '', 'FALSE', 'not-a-number', 'TRUE'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.otls).toEqual([]);
  });

  it('rejects an OTL row with an empty colorIndex', () => {
    const { model, problems } = rowsToModel({
      OTLs: [
        [
          'projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode',
          'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active',
        ],
        ['P-1', 'T1', 'E1', 'R1', 'CAPEX', '', 'FALSE', '', 'TRUE'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.otls).toEqual([]);
  });

  it('rejects an OTL row with an invalid active boolean', () => {
    const { model, problems } = rowsToModel({
      OTLs: [
        [
          'projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode',
          'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active',
        ],
        ['P-1', 'T1', 'E1', 'R1', 'CAPEX', '', 'FALSE', '1', 'MAYBE'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.otls).toEqual([]);
  });

  it('rejects a Person row with a missing id', () => {
    const { model, problems } = rowsToModel({
      People: [
        ['id', 'name', 'role', 'managerId'],
        ['', 'Alex', 'REPORT', ''],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.people).toEqual([]);
  });

  it('rejects a Person row with an invalid role', () => {
    const { model, problems } = rowsToModel({
      People: [
        ['id', 'name', 'role', 'managerId'],
        ['p1', 'Alex', 'ADMIN', ''],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.people).toEqual([]);
  });

  it('accepts a Person row with a null managerId', () => {
    const { model, problems } = rowsToModel({
      People: [
        ['id', 'name', 'role', 'managerId'],
        ['p1', 'Alex', 'MANAGER', ''],
      ],
    });
    expect(problems).toEqual([]);
    expect(model.people[0]?.managerId).toBeNull();
  });

  it('rejects a StatHoliday row with a missing otlProjectCode', () => {
    const { model, problems } = rowsToModel({
      StatHolidays: [
        ['date', 'name', 'otlProjectCode'],
        ['2026-09-07', 'Labour Day', ''],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.statHolidays).toEqual([]);
  });

  it('rejects an Allocation row with a missing otlProjectCode', () => {
    const { model, problems } = rowsToModel({
      Allocations: [
        ['month', 'otlProjectCode', 'personId', 'hours'],
        ['2026-09', '', 'p1', '60'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.allocations).toEqual([]);
  });

  it('rejects an Allocation row with a non-numeric hours', () => {
    const { model, problems } = rowsToModel({
      Allocations: [
        ['month', 'otlProjectCode', 'personId', 'hours'],
        ['2026-09', 'P-1001', 'p1', 'not-a-number'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.allocations).toEqual([]);
  });

  it('rejects a Leave row with a missing personId', () => {
    const { model, problems } = rowsToModel({
      Leave: [
        ['personId', 'startDate', 'endDate', 'otlProjectCode'],
        ['', '2026-09-14', '2026-09-18', 'VAC-01'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.leave).toEqual([]);
  });

  it('rejects a Leave row with a missing otlProjectCode', () => {
    const { model, problems } = rowsToModel({
      Leave: [
        ['personId', 'startDate', 'endDate', 'otlProjectCode'],
        ['p1', '2026-09-14', '2026-09-18', ''],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.leave).toEqual([]);
  });

  it('rejects an Override row with a missing personId', () => {
    const { model, problems } = rowsToModel({
      Overrides: [
        ['personId', 'date', 'otlProjectCode', 'hours'],
        ['', '2026-09-01', 'P-1001', '4'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.overrides).toEqual([]);
  });

  it('rejects an Override row with a missing otlProjectCode', () => {
    const { model, problems } = rowsToModel({
      Overrides: [
        ['personId', 'date', 'otlProjectCode', 'hours'],
        ['p1', '2026-09-01', '', '4'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.overrides).toEqual([]);
  });

  it('rejects an Override row with a non-numeric hours', () => {
    const { model, problems } = rowsToModel({
      Overrides: [
        ['personId', 'date', 'otlProjectCode', 'hours'],
        ['p1', '2026-09-01', 'P-1001', 'not-a-number'],
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(model.overrides).toEqual([]);
  });
});
