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
    // .every() on an empty array is vacuously true, so pin the day's total.
    expect(totalFor(out, '2026-08-31')).toBe(15);
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
    // Each code separately: a bare sum of 45 is equally satisfied by the
    // override being ignored outright (45 + 0), which is the regression this
    // test exists to catch.
    expect(blocksOn(out, 'P-1002')).toBe(15);   // the pinned day
    expect(blocksOn(out, 'P-1001')).toBe(30);   // the ceiling, less the pin
    expect(blocksOn(out, OPEX)).toBe(30);       // the floor still stands
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

  describe('regressions', () => {
    it('does not manufacture a floor breach from an override on a secondary OPEX code', () => {
      // OPEX-TRAINING is neither a CAPEX code nor the default OPEX code. It
      // eats floor room, so it must be charged against the CAPEX ceiling;
      // otherwise CAPEX fills to 45 and the optimizer breaches its own floor
      // while blaming the user for it. A compliant schedule exists here.
      const out = scheduleWeek(input({
        overrides: [{
          personId: 'p1', date: '2026-09-08',
          otlProjectCode: 'OPEX-TRAINING', hours: 3,
        }],
        demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 999 }],
      }));
      expect(blocksOn(out, 'OPEX-TRAINING')).toBe(6);
      expect(blocksOn(out, 'P-1001')).toBe(39);   // 75 - 30 floor - 6 overridden
      expect(blocksOn(out, OPEX)).toBe(30);       // exactly the floor, no breach
      expect(out.violations).toEqual([]);
    });

    it('holds the floor for a whole week of secondary-OPEX overrides', () => {
      // 5 x 1h on an unclassified code: still comfortably schedulable.
      const out = scheduleWeek(input({
        overrides: weekDays('2026-09-07').map((date) => ({
          personId: 'p1', date, otlProjectCode: 'OPEX-TRAINING', hours: 1,
        })),
        demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 999 }],
      }));
      expect(blocksOn(out, OPEX)).toBeGreaterThanOrEqual(30);
      expect(out.violations.some((v) => v.kind === 'OPEX_FLOOR_BREACHED')).toBe(false);
    });

    it('does not let a leave entry on the default OPEX code pay for the floor', () => {
      // Monday is a stat holiday booked to the admin code — real orgs do this.
      // Capacity is 60 (leave excluded) so the floor is 24 blocks. The user
      // pins 51 blocks of CAPEX, leaving 9 blocks of genuine OPEX: a real
      // breach that the 15 leave blocks used to paper over (9 + 15 === 24).
      const out = scheduleWeek(input({
        leaveDates: new Map([['2026-09-07', OPEX]]),
        overrides: [
          { personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1001', hours: 7.5 },
          { personId: 'p1', date: '2026-09-09', otlProjectCode: 'P-1001', hours: 7.5 },
          { personId: 'p1', date: '2026-09-10', otlProjectCode: 'P-1001', hours: 7.5 },
          { personId: 'p1', date: '2026-09-11', otlProjectCode: 'P-1001', hours: 3 },
        ],
      }));
      const mon = out.entries.filter((e) => e.date === '2026-09-07');
      expect(mon).toHaveLength(1);
      expect(mon[0]).toMatchObject({ otlProjectCode: OPEX, blocks: 15, source: 'LEAVE' });
      expect(out.violations.some((v) => v.kind === 'OPEX_FLOOR_BREACHED')).toBe(true);
    });

    it('reports an override that lands on a leave day instead of dropping it', () => {
      const out = scheduleWeek(input({
        leaveDates: new Map([['2026-09-09', 'VAC-01']]),
        overrides: [{
          personId: 'p1', date: '2026-09-09', otlProjectCode: 'P-1001', hours: 4,
        }],
      }));
      const breach = out.violations.find((v) => v.kind === 'OVERRIDE_ON_LEAVE_DAY');
      expect(breach).toBeDefined();
      expect(breach?.scope).toBe('2026-09-09');
      expect(breach?.message).toContain('2026-09-09');
      expect(breach?.message).toContain('P-1001');
      // The day still belongs entirely to leave.
      expect(out.entries.filter((e) => e.date === '2026-09-09'))
        .toEqual([{
          personId: 'p1', date: '2026-09-09', otlProjectCode: 'VAC-01',
          blocks: 15, source: 'LEAVE',
        }]);
    });

    it('reports the fraction of an override that will not fit a half-hour block', () => {
      const out = scheduleWeek(input({
        overrides: [{
          personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1001', hours: 1.2,
        }],
      }));
      expect(out.entries.find((e) => e.otlProjectCode === 'P-1001')?.blocks).toBe(2);
      const dropped = out.violations.find((v) => v.kind === 'OVERRIDE_RESIDUAL_DROPPED');
      expect(dropped).toBeDefined();
      expect(dropped?.scope).toBe('2026-09-08');
      expect(dropped?.message).toContain('0.2');
    });

    it('reports an override too small to fill a single block', () => {
      const out = scheduleWeek(input({
        overrides: [{
          personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1001', hours: 0.2,
        }],
      }));
      expect(blocksOn(out, 'P-1001')).toBe(0);
      expect(out.violations.some((v) => v.kind === 'OVERRIDE_RESIDUAL_DROPPED')).toBe(true);
    });

    it('emits at most one row per (personId, date, otlProjectCode)', () => {
      const out = scheduleWeek(input({
        overrides: [
          // Two overrides sharing a date and a code.
          { personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1001', hours: 1 },
          { personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1001', hours: 1 },
        ],
        // ...and phase-3 demand landing on the same code and the same day.
        demand: [{ otlProjectCode: 'P-1001', month: '2026-09', blocks: 999 }],
      }));
      const keys = out.entries.map((e) => `${e.personId}|${e.date}|${e.otlProjectCode}`);
      expect(new Set(keys).size).toBe(keys.length);

      const tue = out.entries.filter((e) => e.date === '2026-09-08');
      const pinned = tue.find((e) => e.otlProjectCode === 'P-1001');
      // 2 + 2 override blocks merged with the calculated fill for that day...
      expect(pinned?.blocks).toBe(15);
      // ...and the merged cell still reads as user-set, because the UI locks on it.
      expect(pinned?.source).toBe('OVERRIDE');
      expect(totalFor(out, '2026-09-08')).toBe(15);
    });

    it('sorts on a key that is unique, so ordering never rides on sort stability', () => {
      const out = scheduleWeek(input({
        overrides: [
          { personId: 'p1', date: '2026-09-08', otlProjectCode: 'P-1002', hours: 2 },
          { personId: 'p1', date: '2026-09-08', otlProjectCode: 'OPEX-TRAINING', hours: 1 },
        ],
        demand: [
          { otlProjectCode: 'P-1001', month: '2026-09', blocks: 20 },
          { otlProjectCode: 'P-1002', month: '2026-09', blocks: 10 },
        ],
      }));
      const keys = out.entries.map((e) => `${e.date}|${e.otlProjectCode}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect([...keys]).toEqual([...keys].sort());
    });
  });
});
