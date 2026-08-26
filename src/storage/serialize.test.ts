import { describe, it, expect } from 'vitest';
import {
  modelToRows, rowsToModel,
  scheduleEntriesToRows, rowsToScheduleEntries,
  metaToRows, rowsToMeta,
  buildSheetPayload,
} from './serialize';
import type { Model, ScheduleEntry } from '../domain/types';

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

  it('rejects an OTLs header with columns in the wrong order, not just the wrong length', () => {
    // Same length, same column names, but projectCode/taskCode swapped —
    // exactly what dragging two columns in a spreadsheet produces. If this
    // regressed to a length-only check, every OTL would silently load with
    // its project code and task code transposed.
    const { model, problems } = rowsToModel({
      OTLs: [
        [
          'taskCode', 'projectCode', 'expenditureTypeCode', 'timeReportingCode',
          'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active',
        ],
        ['P-1', 'T1', 'E1', 'R1', 'CAPEX', '', 'FALSE', '1', 'TRUE'],
      ],
      People: [
        ['id', 'name', 'role', 'managerId'],
        ['p1', 'Alex', 'REPORT', ''],
      ],
    });
    expect(model.otls).toEqual([]);
    expect(problems.some((p) => /OTLs: header row does not match expected columns/.test(p))).toBe(true);
    // The whole OTLs tab is dropped, but the rest of the payload is unaffected.
    expect(model.people).toEqual([{ id: 'p1', name: 'Alex', role: 'REPORT', managerId: null }]);
  });

  it('rejects an OTL row with more columns than the header, not just fewer', () => {
    const { model, problems } = rowsToModel({
      OTLs: [
        [
          'projectCode', 'taskCode', 'expenditureTypeCode', 'timeReportingCode',
          'category', 'leaveSubtype', 'isDefaultOpex', 'colorIndex', 'active',
        ],
        ['P-1', 'T1', 'E1', 'R1', 'CAPEX', '', 'FALSE', '1', 'TRUE', 'EXTRA'],
        ['P-2', 'T2', 'E2', 'R2', 'OPEX', '', 'TRUE', '2', 'TRUE'],
      ],
    });
    expect(problems.some((p) => /OTLs row 2: expected 9 columns, got 10/.test(p))).toBe(true);
    // Only the malformed row is skipped; the next valid row in the same tab still loads.
    expect(model.otls).toHaveLength(1);
    expect(model.otls[0]?.projectCode).toBe('P-2');
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

// -----------------------------------------------------------------------
// Task 15: Schedule and Meta tabs.
// -----------------------------------------------------------------------

const scheduleEntries: ScheduleEntry[] = [
  {
    personId: 'p1', date: '2026-09-01', otlProjectCode: 'P-1001',
    blocks: 15, source: 'CALC', overrideBlocks: 0,
  },
  {
    // A pinned cell: `source` says "locked", `overrideBlocks` says the user
    // only pinned 4 of the 15 blocks — the optimizer topped the rest up to
    // fill the day. These must round-trip as two distinct numbers, not one.
    personId: 'p1', date: '2026-09-02', otlProjectCode: 'P-1002',
    blocks: 15, source: 'OVERRIDE', overrideBlocks: 4,
  },
  {
    personId: 'p2', date: '2026-09-01', otlProjectCode: 'LEAVE-01',
    blocks: 15, source: 'LEAVE', overrideBlocks: 0,
  },
];

describe('serialize: Schedule tab', () => {
  it('round-trips schedule entries without loss', () => {
    const { entries, problems } = rowsToScheduleEntries({
      Schedule: scheduleEntriesToRows(scheduleEntries),
    });
    expect(problems).toEqual([]);
    expect(entries).toEqual(scheduleEntries);
  });

  it('keeps overrideBlocks distinct from blocks and source through a round trip', () => {
    const { entries } = rowsToScheduleEntries({
      Schedule: scheduleEntriesToRows(scheduleEntries),
    });
    const pinned = entries.find((e) => e.date === '2026-09-02');
    // source says "locked" but only 4 of the 15 blocks were user input —
    // losing this distinction is exactly the bug the round trip must avoid.
    expect(pinned?.source).toBe('OVERRIDE');
    expect(pinned?.blocks).toBe(15);
    expect(pinned?.overrideBlocks).toBe(4);
  });

  it('writes a header row', () => {
    const rows = scheduleEntriesToRows(scheduleEntries);
    expect(rows[0]).toEqual([
      'personId', 'date', 'otlProjectCode', 'blocks', 'source', 'overrideBlocks',
    ]);
  });

  it('returns no entries for a missing Schedule tab', () => {
    const { entries, problems } = rowsToScheduleEntries({});
    expect(entries).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('reports a malformed Schedule row instead of throwing', () => {
    const { entries, problems } = rowsToScheduleEntries({
      Schedule: [
        ['personId', 'date', 'otlProjectCode', 'blocks', 'source', 'overrideBlocks'],
        ['p1', '2026-09-01', 'P-1001', 'not-a-number', 'CALC', '0'],
      ],
    });
    expect(entries).toEqual([]);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('rejects an invalid source enum value', () => {
    const { entries, problems } = rowsToScheduleEntries({
      Schedule: [
        ['personId', 'date', 'otlProjectCode', 'blocks', 'source', 'overrideBlocks'],
        ['p1', '2026-09-01', 'P-1001', '15', 'BOGUS', '0'],
      ],
    });
    expect(entries).toEqual([]);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('rejects an overrideBlocks that is not a number', () => {
    const { entries, problems } = rowsToScheduleEntries({
      Schedule: [
        ['personId', 'date', 'otlProjectCode', 'blocks', 'source', 'overrideBlocks'],
        ['p1', '2026-09-01', 'P-1001', '15', 'CALC', 'nope'],
      ],
    });
    expect(entries).toEqual([]);
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('serialize: Meta tab', () => {
  it('round-trips the model hash', () => {
    const { hash, problems } = rowsToMeta({ Meta: metaToRows('abc123') });
    expect(problems).toEqual([]);
    expect(hash).toBe('abc123');
  });

  it('returns null for a missing Meta tab', () => {
    const { hash, problems } = rowsToMeta({});
    expect(hash).toBeNull();
    expect(problems).toEqual([]);
  });

  it('writes a key/value header row', () => {
    const rows = metaToRows('abc123');
    expect(rows[0]).toEqual(['key', 'value']);
  });
});

describe('serialize: buildSheetPayload', () => {
  it('combines the model tabs with the Schedule and Meta tabs', () => {
    const payload = buildSheetPayload(model, scheduleEntries, 'abc123');
    expect(payload.OTLs).toEqual(modelToRows(model).OTLs);
    const { entries } = rowsToScheduleEntries(payload);
    expect(entries).toEqual(scheduleEntries);
    const { hash } = rowsToMeta(payload);
    expect(hash).toBe('abc123');
  });
});

describe('serialize: per-tab load health', () => {
  it('names the tab whose header did not parse, not just the problem', () => {
    const { model: parsed, problems, unreadableTabs } = rowsToModel({
      People: [['id', 'name', 'Role', 'managerId'], ['p1', 'Alex', 'MANAGER', '']],
    });
    expect(parsed.people).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(unreadableTabs).toEqual(['People']);
  });

  it('reports no unreadable tab for a row-level problem — the tab itself parsed', () => {
    const { problems, unreadableTabs } = rowsToModel({
      People: [['id', 'name', 'role', 'managerId'], ['p1', 'Alex', 'BOSS', '']],
    });
    expect(problems).toHaveLength(1);
    expect(unreadableTabs).toEqual([]);
  });

  it('names the Schedule and Meta tabs too', () => {
    expect(rowsToScheduleEntries({ Schedule: [['nope']] }).unreadableTabs).toEqual(['Schedule']);
    expect(rowsToMeta({ Meta: [['nope']] }).unreadableTabs).toEqual(['Meta']);
  });
});

describe('serialize: buildSheetPayload omitTabs', () => {
  it('leaves an omitted tab out of the payload entirely, rather than emptying it', () => {
    const payload = buildSheetPayload(model, scheduleEntries, 'abc123', ['People', 'Schedule']);
    expect('People' in payload).toBe(false);
    expect('Schedule' in payload).toBe(false);
    expect(payload.OTLs).toEqual(modelToRows(model).OTLs);
    expect(payload.Meta).toEqual(metaToRows('abc123'));
  });

  it('is the full payload when nothing is omitted', () => {
    expect(Object.keys(buildSheetPayload(model, scheduleEntries, 'abc123'))).toHaveLength(8);
  });
});
