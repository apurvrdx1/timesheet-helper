import { describe, it, expect } from 'vitest';
import { hashModel } from './hash';
import type { Model } from './types';

const base: Model = {
  otls: [], people: [], statHolidays: [],
  allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 40 }],
  leave: [], overrides: [],
};

describe('hashModel', () => {
  it('is stable for identical input', () => {
    expect(hashModel(base)).toBe(hashModel({ ...base }));
  });

  it('ignores array ordering', () => {
    const a: Model = { ...base, people: [
      { id: 'p1', name: 'A', role: 'REPORT', managerId: 'm' },
      { id: 'p2', name: 'B', role: 'REPORT', managerId: 'm' },
    ] };
    const b: Model = { ...base, people: [...a.people].reverse() };
    expect(hashModel(a)).toBe(hashModel(b));
  });

  it('changes when an allocation changes', () => {
    const changed: Model = {
      ...base,
      allocations: [{ month: '2026-09', otlProjectCode: 'P-1001', personId: 'p1', hours: 40.5 }],
    };
    expect(hashModel(changed)).not.toBe(hashModel(base));
  });

  it('changes when an override is added', () => {
    const changed: Model = {
      ...base,
      overrides: [{ personId: 'p1', date: '2026-09-01', otlProjectCode: 'P-1001', hours: 4 }],
    };
    expect(hashModel(changed)).not.toBe(hashModel(base));
  });
});
