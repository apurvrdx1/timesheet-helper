import { describe, it, expect } from 'vitest';
import { assignmentBlocks, pacedDemand } from './demand';
import type { Model } from './types';

const base: Model = {
  otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
};

describe('assignmentBlocks', () => {
  it('keys per-person allocations by month and OTL', () => {
    const model: Model = {
      ...base,
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 60 },
        { month: '2026-09', otlProjectCode: 'P-1002', personId: 'p1', hours: 30 },
      ],
    };
    const got = assignmentBlocks('p1', model);
    expect(got.get('2026-09|P-1001')).toBe(120);
    expect(got.get('2026-09|P-1002')).toBe(60);
  });

  it('excludes OTL monthly total rows, which have a null personId', () => {
    const model: Model = {
      ...base,
      allocations: [
        { month: '2026-09', otlProjectCode: 'P-1001', personId: null, hours: 300 },
        { month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 60 },
      ],
    };
    expect(assignmentBlocks('p1', model).get('2026-09|P-1001')).toBe(120);
  });

  it('excludes other people', () => {
    const model: Model = {
      ...base,
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p2', hours: 60 }],
    };
    expect(assignmentBlocks('p1', model).size).toBe(0);
  });
});

describe('pacedDemand', () => {
  it('offers a proportional slice of the month, not the whole balance', () => {
    const remaining = new Map([['2026-09|P-1001', 120]]); // 60h left
    // 20 workdays left in the month, 5 of them in this week -> a quarter
    const got = pacedDemand(
      remaining, [], new Map([['2026-09', 20]]), new Map([['2026-09', 5]]),
    );
    expect(got).toEqual([{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 30 }]);
  });

  it('offers the entire balance in the final week of the month', () => {
    const remaining = new Map([['2026-09|P-1001', 40]]);
    const got = pacedDemand(
      remaining, [], new Map([['2026-09', 3]]), new Map([['2026-09', 3]]),
    );
    const item = got[0];
    expect(item?.blocks).toBe(40);
  });

  it('rounds a fractional slice up so the month finishes on time', () => {
    const remaining = new Map([['2026-09|P-1001', 10]]);
    const got = pacedDemand(
      remaining, [], new Map([['2026-09', 4]]), new Map([['2026-09', 3]]),
    );
    const item = got[0];
    expect(item?.blocks).toBe(8); // ceil(10 * 3/4)
  });

  it('drops exhausted allocations', () => {
    const remaining = new Map([['2026-09|P-1001', 0]]);
    expect(pacedDemand(remaining, [], new Map([['2026-09', 5]]), new Map([['2026-09', 5]]))).toEqual([]);
  });

  it('sorts descending by blocks then by code, for determinism', () => {
    const remaining = new Map([
      ['2026-09|P-1001', 20], ['2026-09|P-1003', 40], ['2026-09|P-1002', 40],
    ]);
    const got = pacedDemand(
      remaining, [], new Map([['2026-09', 5]]), new Map([['2026-09', 5]]),
    );
    expect(got.map((d) => d.otlProjectCode)).toEqual(['P-1002', 'P-1003', 'P-1001']);
  });
});
