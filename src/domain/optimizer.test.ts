import { describe, it, expect } from 'vitest';
import { scheduleWeek, type WeekInput } from './optimizer';
import { weekDays } from './calendar';

const OPEX = 'OPEX-ADMIN';

function input(over: Partial<WeekInput> = {}): WeekInput {
  return {
    personId: 'p1',
    dates: weekDays('2026-09-07'),
    leaveDates: new Map(),
    overrides: [],
    demand: [],
    defaultOpexCode: OPEX,
    capexCodes: new Set(['P-1001', 'P-1002']),
    ...over,
  };
}

function totalFor(out: ReturnType<typeof scheduleWeek>, date: string): number {
  return out.entries.filter((e) => e.date === date)
    .reduce((s, e) => s + e.blocks, 0);
}

function blocksOn(out: ReturnType<typeof scheduleWeek>, otl: string): number {
  return out.entries.filter((e) => e.otlProjectCode === otl)
    .reduce((s, e) => s + e.blocks, 0);
}

describe('scheduleWeek', () => {
  it('fills a week with pure OPEX when there is no CAPEX demand', () => {
    const out = scheduleWeek(input());
    expect(blocksOn(out, OPEX)).toBe(75);
    for (const d of weekDays('2026-09-07')) expect(totalFor(out, d)).toBe(15);
    expect(out.violations).toEqual([]);
  });

  it('never places CAPEX beyond the 45-block ceiling', () => {
    const out = scheduleWeek(input({
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 999 }],
    }));
    expect(blocksOn(out, 'P-1001')).toBe(45); // 22.5h
    expect(blocksOn(out, OPEX)).toBe(30);     // exactly the 15.0h floor
  });

  it('lets CAPEX concentrate within a day rather than smearing', () => {
    const out = scheduleWeek(input({
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 30 }],
    }));
    const mon = out.entries.filter((e) => e.date === '2026-09-07');
    // Monday should be wholly one CAPEX code, not a 40/60 split.
    expect(mon.length).toBe(1);
    expect(mon[0]?.otlProjectCode).toBe('P-1001');
    expect(mon[0]?.blocks).toBe(15);
  });

  it('draws each day only from its own month budget', () => {
    // Week of Mon 31 Aug: Monday is August, Tue–Fri are September.
    const out = scheduleWeek(input({
      dates: weekDays('2026-08-31'),
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 45 }],
    }));
    const monday = out.entries.filter((e) => e.date === '2026-08-31');
    expect(monday.every((e) => e.otlProjectCode === OPEX)).toBe(true);
    expect(blocksOn(out, 'P-1001')).toBe(45);
  });

  it('scales the floor when a stat holiday shortens the week', () => {
    const out = scheduleWeek(input({
      leaveDates: new Map([['2026-09-07', 'STAT-01']]),
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 999 }],
    }));
    expect(blocksOn(out, 'STAT-01')).toBe(15);
    expect(blocksOn(out, 'P-1001')).toBe(36); // capexRoom(60)
    expect(blocksOn(out, OPEX)).toBe(24);     // ceil(0.4 * 60)
  });

  it('gives a leave day the whole 7.5h and zeroes everything else', () => {
    const out = scheduleWeek(input({
      leaveDates: new Map([['2026-09-09', 'VAC-01']]),
    }));
    const wed = out.entries.filter((e) => e.date === '2026-09-09');
    expect(wed).toHaveLength(1);
    expect(wed[0]).toMatchObject({ otlProjectCode: 'VAC-01', blocks: 15, source: 'LEAVE' });
  });

  it('honours an override and rebalances the rest of that day to 7.5h', () => {
    const out = scheduleWeek(input({
      overrides: [{ personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1002', hours: 4 }],
    }));
    const tue = out.entries.filter((e) => e.date === '2026-09-08');
    expect(tue.find((e) => e.otlProjectCode === 'P-1002'))
      .toMatchObject({ blocks: 8, source: 'OVERRIDE' });
    expect(totalFor(out, '2026-09-08')).toBe(15);
  });

  it('counts an overridden CAPEX cell against the ceiling', () => {
    const out = scheduleWeek(input({
      overrides: [{ personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1002', hours: 7.5 }],
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 999 }],
    }));
    expect(blocksOn(out, 'P-1002') + blocksOn(out, 'P-1001')).toBe(45);
  });

  it('reports how much of each allocation it actually placed', () => {
    const out = scheduleWeek(input({
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 20 }],
    }));
    expect(out.consumed.get('2026-09|P-1001')).toBe(20);
  });

  it('flags a floor breach caused by overrides instead of silently moving them', () => {
    // The user pins 5 full CAPEX days. Their overrides win; we report the conflict.
    const out = scheduleWeek(input({
      overrides: weekDays('2026-09-07').map((date) => ({
        personId: 'p1', date, otlProjectCode: 'P-1001', hours: 7.5,
      })),
    }));
    expect(blocksOn(out, 'P-1001')).toBe(75);
    expect(out.violations.some((v) => v.kind === 'OPEX_FLOOR_BREACHED')).toBe(true);
  });

  it('flags overrides that exceed a day', () => {
    const out = scheduleWeek(input({
      overrides: [
        { personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1001', hours: 5 },
        { personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1002', hours: 5 },
      ],
    }));
    expect(out.violations.some((v) => v.kind === 'OVER_CAPACITY')).toBe(true);
  });

  it('produces byte-identical output when run twice', () => {
    const args = input({
      demand: [
        { otlProjectCode: 'P-1001', month: '2026-09', blocks: 22 },
        { otlProjectCode: 'P-1002', month: '2026-09', blocks: 13 },
      ],
    });
    expect(JSON.stringify(scheduleWeek(args).entries))
      .toBe(JSON.stringify(scheduleWeek(args).entries));
  });

  it('emits no zero-block entries', () => {
    const out = scheduleWeek(input({
      demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 1 }],
    }));
    expect(out.entries.every((e) => e.blocks > 0)).toBe(true);
  });
});
